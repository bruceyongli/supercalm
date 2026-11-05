// A live disposable tree can remove npm temporary entries while du walks it.
// Accept only that exact diagnostic with a complete, valid total. All other
// errors, output truncation and the caller's disk/size limits still fail closed.
export function localBuildSize(result, root) {
  if (typeof root !== 'string' || !root.startsWith('/') || /[\r\n\0]/.test(root)) throw Error('Invalid local build size root');
  const output = String(result.stdout || '').trimEnd();
  const split = output.indexOf('\t');
  if (split < 1 || !/^\d+$/.test(output.slice(0, split)) || output.slice(split + 1) !== root) throw Error('Incomplete local build size total');
  const bytes = Number(output.slice(0, split)) * 1024;
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw Error('Invalid local build size total');
  const lines = String(result.stderr || '').trimEnd().split('\n').filter(Boolean);
  if (result.code !== undefined) {
    if (result.code !== 1 || result.signal || result.killed || !lines.length ||
        lines.some(line => !line.startsWith('du: ' + root + '/') || !line.endsWith(': No such file or directory')))
      throw result;
  } else if (lines.length) throw Error('Unexpected local build size diagnostic');
  return { bytes, vanishedDuringScan: lines.length };
}
