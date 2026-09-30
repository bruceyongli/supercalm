import assert from 'node:assert/strict';
import { fileReferences, isFileReference, localFilePath } from '../web/file-reference.js';
import { renderMarkdown, renderLinkedText } from '../web/common.js';
import { safeLinkHref } from '../web/markdown-inline.js';

const host = 'box.example.test';
for (const [reference, path] of [
  ['/tmp/report.md:12:3', '/tmp/report.md'], ['docs/a.md#L20C4', 'docs/a.md'],
  ['docs/My%20report.md', 'docs/My report.md'], ['file:///tmp/My%20report.md', '/tmp/My report.md'],
  ['~/资料/报告.md', '~/资料/报告.md'], ['/tmp/report(final).html', '/tmp/report(final).html'],
  ['https://box.example.test/tmp/report.html', '/tmp/report.html'],
]) {
  assert.equal(localFilePath(reference, host), path);
  assert.ok(isFileReference(reference, host), reference);
}
for (const reference of ['https://box.example.test/aios/api/session/s/render/token/report.html',
  '/aios/api/session/s/file?path=docs/report.md&raw=1', 'api/session/s/render/token/report.html',
  'https://elsewhere.test/report.html', '#section', 'javascript:/tmp/evil.md:12']) {
  assert.equal(isFileReference(reference, host), false, reference);
}
for (const reference of ['/tmp/报告.md', '/tmp/report(final).html', 'docs/code.js:12', 'README',
  'https://example.test/a_(b)?x=1&y=2']) {
  assert.equal(fileReferences(`Result: (${reference}).`)[0]?.text, reference, reference);
}
assert.deepEqual(fileReferences('"/tmp/My report (final).md"').map(r => r.text), ['/tmp/My report (final).md']);
assert.deepEqual(fileReferences('v0.3.318 completed.')[0], undefined, 'versions are not file links');

const examples = [
  ['[Open](/tmp/report.html)', '/tmp/report.html'],
  ['[Open](</tmp/My report (final).html>)', '/tmp/My report (final).html'],
  ['[Open](/tmp/report(final).html "Report")', '/tmp/report(final).html'],
  ['[**Open**](/tmp/报告.md)', '/tmp/报告.md'],
  ['`/tmp/My report.md`', '/tmp/My report.md'],
  ['[Open][report]\n\n[report]: /tmp/report.html', '/tmp/report.html'],
  ['[report][]\n\n[report]: /tmp/report.html', '/tmp/report.html'],
  ['[report]\n\n[report]: /tmp/report.html', '/tmp/report.html'],
  ['<https://example.test/a_(b)>', 'https://example.test/a_(b)'],
];
for (const [markdown, href] of examples) {
  assert.ok(renderMarkdown(markdown).includes(`href="${href}"`), markdown);
}
const table = renderMarkdown('| Link | Notes |\n|---|---|\n| [Open](</tmp/My report.md>) | `a|b` and c\\|d |');
assert.match(table, /<td><a href="\/tmp\/My report.md"/);
assert.match(table, /<td><code>a\|b<\/code> and c\|d<\/td>/, 'literal pipes do not destroy table cells');
assert.equal((table.match(/<td>/g) || []).length, 2);
assert.match(renderMarkdown('- [Open](/tmp/report.md)\n\n> [Open](/tmp/report.md)'), /<blockquote>.*href=/s);
assert.match(renderLinkedText('Here: /tmp/report.md'), /href="\/tmp\/report.md"/);
assert.match(renderMarkdown('```html\n<a href="javascript:alert(1)">example</a>\n```'), /&lt;a href=/);
for (const href of ['javascript:alert(1)', 'javascript:/tmp/evil.md:12', 'data:text/html,x', 'vbscript:msgbox(1)', 'java\nscript:alert(1)', 'file://elsewhere/tmp/a.md']) {
  assert.equal(safeLinkHref(href), null, href);
  assert.doesNotMatch(renderMarkdown(`[bad](${href})`), /<a /, href);
}
const unsafe = renderMarkdown('[<img src=x onerror=alert(1)>](/tmp/report.md) <script>alert(1)</script>');
assert.doesNotMatch(unsafe, /<img|<script|href="javascript:/);
assert.equal((renderMarkdown('[Open `docs/a.md`](/tmp/b.md)').match(/<a /g) || []).length, 1, 'no nested anchors');
console.log('link_reference_matrix: paths, Markdown structures, web routes, and unsafe schemes passed');
