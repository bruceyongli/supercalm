import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate config: scratch data dir + a nonexistent env file (so the repo's data/aios.env can't override
// SPARK_IP), and mark Spark configured. Env must be set BEFORE importing config.js/model_providers.js.
const dir = mkdtempSync(join(tmpdir(), 'aios-voice-mig-'));
process.env.AIOS_DATA = dir;
process.env.AIOS_ENV_FILE = join(dir, 'nonexistent.env');
process.env.SPARK_IP = '10.0.0.9';
process.env.SPARK_HOST = 'spark.test';

// Old v1 shape: user chose "GPT voice" (sparkDisabled + a cloud speech provider) and pinned STT to Codex.
writeFileSync(join(dir, 'model_providers.json'), JSON.stringify({
  providers: [],
  speech: { base_url: 'https://api.openai.com', enabled: true, stt_model: 'whisper-1' },
  voice: { spark: { ip: '10.0.0.9' }, sparkDisabled: true, sttSource: 'codex' },
}));

const m = await import('../src/model_providers.js');
const c = m.getVoiceConfig();

// sparkDisabled + a cloud provider present → TTS primary migrates to cloud (not browser).
assert.equal(c.tts.primary, 'cloud', 'tts.primary should migrate to cloud');
// pinned sttSource=codex → stt.primary=codex.
assert.equal(c.stt.primary, 'codex', 'stt.primary should migrate to codex');
assert.equal(c.version, 2);
// never auto-adds cloud to a fallback (privacy): cloud must not appear in either fallback list.
assert.ok(!c.tts.fallbacks.includes('cloud'), 'no auto-cloud in tts fallbacks');
assert.ok(!c.stt.fallbacks.includes('cloud'), 'no auto-cloud in stt fallbacks');

// persisted: v2 stamped, legacy kept, spark un-muted (mute meaning moved into tts.primary).
const raw = JSON.parse(readFileSync(join(dir, 'model_providers.json'), 'utf8'));
assert.equal(raw.voice.version, 2);
assert.ok(raw.voice._legacyVoice, 'legacy blob kept for one release');
assert.equal(raw.voice._legacyVoice.sttSource, 'codex');
assert.equal(raw.voice.sparkDisabled, false, 'spark un-muted so it can serve as a fallback');
// provider config preserved.
assert.equal(raw.voice.spark.ip, '10.0.0.9');

// idempotent: a second read does not re-migrate or change anything.
const c2 = m.getVoiceConfig();
assert.deepEqual(c2, c);

console.log('voice_migration.test ok');
