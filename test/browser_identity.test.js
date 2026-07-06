import assert from 'node:assert/strict';
import { setDashboardBrowserIdentity, setSessionBrowserIdentity } from '../web/common.js';

function mockDocument() {
  const theme = { content: '', attrs: { name: 'theme-color' } };
  const head = {
    children: [],
    appendChild(el) {
      this.children.push(el);
    },
  };
  return {
    title: '',
    head,
    createElement(tag) {
      return {
        tagName: tag.toUpperCase(),
        attrs: {},
        setAttribute(name, value) {
          this.attrs[name] = value;
        },
      };
    },
    querySelector(selector) {
      if (selector === 'link[rel~="icon"][data-aios-dynamic]') {
        return head.children.find((el) => String(el.rel || '').split(/\s+/).includes('icon') && el.attrs['data-aios-dynamic']) || null;
      }
      if (selector === 'meta[name="theme-color"]') return theme;
      return null;
    },
  };
}

function renderedIconSvg() {
  const link = document.querySelector('link[rel~="icon"][data-aios-dynamic]');
  assert(link, 'dynamic favicon link is created');
  assert(link.href.startsWith('data:image/svg+xml,'), 'favicon uses an inline SVG data URL');
  return decodeURIComponent(link.href.slice('data:image/svg+xml,'.length));
}

globalThis.document = mockDocument();
setSessionBrowserIdentity({
  title: 'Fix supervisor goal narrowing issue',
  status: 'waiting',
  tool: 'codex',
  toolColor: '#58a6ff',
  project: { name: 'aios' },
});
assert.equal(document.title, '! Fix supervisor goal narrowing issue · aios · waiting');
assert.equal(document.head.children.length, 1, 'one dynamic favicon link is added');
let svg = renderedIconSvg();
assert(svg.includes('stroke="#d29922"'), 'waiting sessions use the amber status ring');
assert(svg.includes('>X</text>'), 'codex sessions use the X favicon label');
assert(svg.includes('>!</text>'), 'waiting sessions include an alert glyph');

setSessionBrowserIdentity({
  title: 'Fix supervisor goal narrowing issue',
  status: 'working',
  tool: 'codex',
  toolColor: '#58a6ff',
  project: { name: 'aios' },
});
assert.equal(document.title, '> Fix supervisor goal narrowing issue · aios · working');
assert.equal(document.head.children.length, 1, 'waiting to working reuses the same dynamic favicon link');
svg = renderedIconSvg();
assert(svg.includes('stroke="#3fb950"'), 'working sessions use the green status ring');
assert.equal(svg.includes('>!</text>'), false, 'working sessions drop the waiting alert glyph');

setSessionBrowserIdentity({
  title: 'Finished work',
  status: 'exited',
  tool: 'claude',
  toolColor: 'url(javascript:bad)',
  project: { name: 'aios' },
});
assert.equal(document.title, 'x Finished work · aios · exited');
assert.equal(document.head.children.length, 1, 'dynamic favicon link is reused');
svg = renderedIconSvg();
assert(svg.includes('stroke="#8b949e"'), 'exited sessions use the gray status ring');
assert(svg.includes('fill="#58a6ff">C</text>'), 'invalid accent colors fall back to the default blue');
assert(svg.includes('>x</text>'), 'exited sessions include an x glyph');

globalThis.document = mockDocument();
setDashboardBrowserIdentity({ counts: { waiting: 2, working: 1, live: 4 } });
assert.equal(document.title, '! 2 waiting · Supercalm');
svg = renderedIconSvg();
assert(svg.includes('stroke="#d29922"'), 'dashboard shows waiting status first');

globalThis.document = mockDocument();
setDashboardBrowserIdentity({ counts: { working: 3, live: 3 } });
assert.equal(document.title, '3 working · 3 live · Supercalm');
svg = renderedIconSvg();
assert(svg.includes('stroke="#3fb950"'), 'dashboard shows working status when no sessions are waiting');

console.log('browser_identity.test ok');
