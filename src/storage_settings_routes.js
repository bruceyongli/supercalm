import { route, json, readJson } from './server.js';
import { storageSettings } from './storage_settings.js';
const handle = action => async (req, res, params) => {
  res.setHeader('cache-control', 'no-store');
  try { json(res, 200, await action(req, params)); }
  catch (error) { json(res, error.status || 503, { error: error.status ? error.message : 'Storage settings are temporarily unavailable. Existing storage is unchanged.' }); }
};
route('GET', '/api/settings/storage', handle(() => storageSettings.snapshot()));
route('POST', '/api/settings/storage/devices', handle(async req => storageSettings.add(await readJson(req))));
route('POST', '/api/settings/storage/devices/:id/connect', handle((_req, { id }) => storageSettings.connect(id)));
route('POST', '/api/settings/storage/devices/:id/credentials', handle(async (req, { id }) => storageSettings.updateCredential(id, await readJson(req))));
route('POST', '/api/settings/storage/default', handle(async req => storageSettings.select((await readJson(req))?.device)));
