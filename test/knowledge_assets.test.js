import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sessions = readFileSync(new URL('../src/sessions.js', import.meta.url), 'utf8');
const knowledge = readFileSync(new URL('../web/agents/knowledge.js', import.meta.url), 'utf8');
const sessionUi = readFileSync(new URL('../web/session.js', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../web/styles.css', import.meta.url), 'utf8');

assert.match(sessions, /route\('GET', '\/api\/project\/:id\/assets'/, 'project assets API must list uploaded files and wiki files');
assert.match(sessions, /route\('GET', '\/api\/project\/:id\/wiki\/raw'/, 'wiki raw route must support view/download links');
assert.match(sessions, /download = u\.searchParams\.get\('download'\) === '1'/, 'attachment route must support forced downloads');
assert.match(sessions, /\|\| \/\^text\\\/\//, 'text attachments must open inline for viewing');
assert.match(sessions, /ASSET_PREVIEW_CHARS/, 'asset API must include bounded text/wiki previews');
assert.match(sessions, /filePreviewSnippet/, 'text attachment previews must use bounded partial file reads');
assert.match(sessions, /preview: previewSnippet\(page\?\.content/, 'wiki assets must include a quick-identification preview');

assert.match(knowledge, /<h3>Uploaded Files<\/h3>/, 'Knowledge panel must show an Uploaded Files section');
assert.match(knowledge, /draggable="true"/, 'Knowledge file rows must be draggable');
assert.match(knowledge, /data-copy-asset/, 'Knowledge file rows must expose copy action');
assert.match(knowledge, /data-insert-asset/, 'Knowledge file rows must insert references into composer');
assert.match(knowledge, /api\/project\/\$\{pid\}\/assets\?session=/, 'Knowledge panel must load the project asset index');
assert.match(knowledge, /asset-card-image/, 'image assets must render thumbnail preview cards');
assert.match(knowledge, /asset-card-text/, 'text and wiki assets must render preview snippet cards');
assert.match(knowledge, /data-open-asset/, 'Knowledge asset previews must open a full detail view');
assert.match(knowledge, /asset-detail-meta/, 'Knowledge detail view must show asset metadata');
assert.match(knowledge, /kn-file-filter/, 'Knowledge uploaded files must support name/path filtering');
assert.match(knowledge, /kn-file-type/, 'Knowledge uploaded files must support type filtering');

assert.match(sessionUi, /application\/x-aios-reference/, 'composer must accept Knowledge reference drops');
assert.match(sessionUi, /aios:insert-reference/, 'composer must accept Knowledge insert events');
assert.match(sessionUi, /insertComposerReference/, 'composer reference insertion must be explicit');
assert.match(sessionUi, /asset-card attachment-chip/, 'composer attachments must use the shared preview card UX');
assert.match(sessionUi, /fillTextPreview/, 'composer text attachments must get quick-identification previews');
assert.match(sessionUi, /data-attachment-open/, 'composer attachment previews must open a full detail view');
assert.match(sessionUi, /source: 'paste'/, 'large pasted text must be marked as pasted for the preview badge');

assert.match(styles, /\.asset-card-actions[\s\S]*opacity: 0/, 'asset card actions must be hidden by default to save space');
assert.match(styles, /\.asset-card:hover \.asset-card-actions/, 'asset card actions must show on hover');
assert.match(styles, /--asset-card-size: 120px/, 'Knowledge and composer previews must use the compact Claude-style tile size');
assert.match(styles, /\.asset-card[\s\S]*aspect-ratio: 1/, 'asset preview cards must stay square');
assert.match(styles, /\.asset-card-name[\s\S]*clip-path: inset\(50%\)/, 'card metadata must move out of the visible tile and into the detail view');
assert.match(styles, /\.asset-detail-backdrop/, 'asset previews must have a full detail overlay');
assert.match(styles, /\.kn-file-filters/, 'Knowledge upload filters must be styled');
assert.match(styles, /@media \(hover: none\)/, 'asset actions must remain usable on touch devices');

console.log('knowledge_assets.test ok');
