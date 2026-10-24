// Bounded process diagnostics for staging only. Never store argv/environment or
// replace the last completed copy receipt with an interrupted attempt.
import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import { performance } from 'node:perf_hooks';

const errorCode = error => String(error?.code || error?.name || 'unknown').slice(0, 80);

export async function runStorageCopyCommand({ file, args, log, save, getLogError = () => null,
  collect = false, timeoutMs = 12 * 3600_000, maxLogBytes = 1024 * 1024,
  maxOutputBytes = 2 * 1024 * 1024, logName = 'migration log' }) {
  const monotonicStart = performance.now();
  const diagnostic = { version: 1, executable: basename(file), controllerPid: process.pid,
    pid: null, phase: 'starting', startedAt: Date.now(), spawnedAt: null, endedAt: null, elapsedMs: null,
    exitCode: null, signal: null, timeoutMs, terminationReason: null,
    terminationRequestedAt: null, terminationSignal: null, terminationSent: null, terminationRequests: [],
    spawnErrorCode: null, processErrorCode: null, logErrorCode: null, journalErrorCode: null,
    outputBytes: 0, loggedBytes: 0 };
  let child, timer, closed = false, spawned = false, spawnError = null, processError = null, journalError = null;
  let logError = getLogError() || log.errored || null;
  let writes = Promise.resolve(), outstandingLogWrites = 0, logDrained;
  const chunks = [];

  // Serialize snapshots: a slow running/termination write must never land after
  // the terminal record. Failed diagnostics stop only this owned child.
  const persist = () => {
    const snapshot = structuredClone(diagnostic);
    writes = writes.then(() => save({ copyProcess: snapshot })).catch(error => {
      journalError ||= error;
      diagnostic.journalErrorCode = errorCode(error);
      terminate('journal-error', 'SIGTERM', false);
    });
    return writes;
  };
  function terminate(reason, signal, record = true) {
    if (!child || closed || child.exitCode !== null || child.signalCode !== null) return;
    // This attributes only signals requested here. An observed signal with no
    // terminationReason has an unknown origin, not an inferred OOM diagnosis.
    if (diagnostic.terminationRequests.some(request => request.reason === reason && request.signal === signal)) return;
    const request = { reason, signal, requestedAt: Date.now(), sent: false };
    try { request.sent = child.kill(signal); }
    catch (error) { request.errorCode = errorCode(error); }
    diagnostic.terminationRequests.push(request); // At most one per three internal reasons.
    if (!diagnostic.terminationReason) {
      diagnostic.terminationReason = reason;
      diagnostic.terminationRequestedAt = request.requestedAt;
      diagnostic.terminationSignal = signal;
      diagnostic.terminationSent = request.sent;
    }
    if (record) void persist();
  }
  const onLogError = error => {
    logError ||= error;
    diagnostic.logErrorCode = errorCode(logError);
    terminate('log-error', 'SIGTERM');
  };
  log.on('error', onLogError);
  const logWriteDone = error => {
    if (error) onLogError(error);
    if (--outstandingLogWrites === 0) logDrained?.();
  };
  const output = bytes => {
    diagnostic.outputBytes += bytes.length;
    if (!logError && diagnostic.loggedBytes < maxLogBytes) {
      const bounded = bytes.subarray(0, maxLogBytes - diagnostic.loggedBytes);
      diagnostic.loggedBytes += bounded.length;
      outstandingLogWrites++;
      try { log.write(bounded, logWriteDone); }
      catch (error) { logWriteDone(error); }
    }
    if (collect && diagnostic.outputBytes <= maxOutputBytes) chunks.push(bytes);
  };
  try {
    if (logError) diagnostic.logErrorCode = errorCode(logError);
    await persist();
    if (!logError && !journalError) {
      try { child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch (error) { spawnError = error; diagnostic.spawnErrorCode = errorCode(error); }
      if (child) {
        diagnostic.pid = child.pid || null;
        const completion = new Promise(resolve => {
          child.once('spawn', () => {
            spawned = true; diagnostic.phase = 'running'; diagnostic.spawnedAt = Date.now(); void persist();
          });
          child.on('error', error => {
            if (!spawned) { spawnError ||= error; diagnostic.spawnErrorCode = errorCode(error); }
            else { processError ||= error; diagnostic.processErrorCode = errorCode(error); }
          });
          child.once('close', (code, signal) => {
            closed = true; clearTimeout(timer);
            diagnostic.exitCode = code; diagnostic.signal = signal;
            diagnostic.endedAt = Date.now();
            diagnostic.elapsedMs = Math.max(0, Math.round(performance.now() - monotonicStart));
            resolve();
          });
        });
        child.stdout.on('data', output); child.stderr.on('data', output);
        timer = setTimeout(() => terminate('timeout', 'SIGKILL'), timeoutMs);
        await completion;
        // Writable errors may arrive after child close. Do not publish a
        // successful pass until every bounded log write has acknowledged.
        if (outstandingLogWrites) await new Promise(resolve => { logDrained = resolve; });
      }
    }
    diagnostic.phase = spawnError ? 'spawn-failed' : child ? 'exited' : 'not-started';
    diagnostic.endedAt ??= Date.now();
    diagnostic.elapsedMs ??= Math.max(0, Math.round(performance.now() - monotonicStart));
    await persist();

    let message;
    if (journalError) message = 'Migration diagnostics unavailable; copier stopped and originals retained: ' + errorCode(journalError);
    else if (logError) message = 'Migration log unavailable; copier stopped and originals retained: ' + errorCode(logError);
    else if (spawnError) message = `${diagnostic.executable} could not start (${errorCode(spawnError)}); data retained`;
    else if (processError) message = `${diagnostic.executable} process error (${errorCode(processError)}); data retained`;
    else if (diagnostic.exitCode !== 0) {
      const exit = diagnostic.signal ? 'with signal ' + diagnostic.signal : String(diagnostic.exitCode);
      const reason = diagnostic.terminationReason ? `; requested termination: ${diagnostic.terminationReason}` : '';
      message = `${diagnostic.executable} exited ${exit}${reason}; data retained; inspect ${logName}`;
    } else if (collect && diagnostic.outputBytes > maxOutputBytes) {
      message = 'Verification output exceeded its bound; source and destination retained';
    }
    if (message) throw Object.assign(Error(message), { exitCode: diagnostic.exitCode,
      signal: diagnostic.signal, childPid: diagnostic.pid, terminationReason: diagnostic.terminationReason });
    return Buffer.concat(chunks).toString();
  } finally {
    clearTimeout(timer);
    log.off('error', onLogError);
  }
}
