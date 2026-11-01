import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
export async function controllerModel(model, messages, options = {}) {
  const token = (await readFile(join(process.env.AIOS_EXECUTION_ROOT, 'control-token'), 'utf8')).trim();
  const response = await fetch(process.env.AIOS_EXECUTION_MODEL_URL, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-aios-node-id': process.env.AIOS_EXECUTION_NODE, 'x-aios-node-token': token },
    body: JSON.stringify({ model, messages, options }), signal: AbortSignal.timeout(120000),
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error || 'Controller model gateway unavailable');
  return result;
}
