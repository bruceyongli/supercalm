import assert from 'node:assert/strict';
import { fitTerminalGrid } from '../web/terminal-layout.js';

const changes = [];
const term = { cols: 51, rows: 36, resize(cols, rows) { this.cols = cols; this.rows = rows; changes.push([cols, rows]); }, refresh() {} };
let width = 51, height = 36, addonCalls = 0;
const metrics = () => ({ colsCapacity: width, rowsCapacity: height, screenRatio: term.cols / width, cellWidth: 7.2, cellHeight: 14 });
const fit = { fit() { addonCalls++; term.resize(width - 3, height); } };

for (let tick = 0; tick < 10; tick++) fitTerminalGrid(term, fit, metrics);
assert.equal(addonCalls, 0, 'settled phone layout never shrinks then expands on observer/presence ticks');
assert.deepEqual(changes, []);

width = 40;
fitTerminalGrid(term, fit, metrics);
assert.equal(addonCalls, 1, 'a real width change still invokes the addon and padding correction');
assert.deepEqual([term.cols, term.rows], [40, 36]);
fitTerminalGrid(term, fit, metrics);
assert.equal(addonCalls, 1, 'the corrected layout remains stable');

height = 20;
fitTerminalGrid(term, fit, metrics);
assert.equal(addonCalls, 2, 'keyboard/height changes still resize the grid');
assert.deepEqual([term.cols, term.rows], [40, 20]);

fitTerminalGrid(term, fit, () => ({ ...metrics(), screenRatio: 0.7 }));
assert.equal(addonCalls, 3, 'stale screen measurements still go through layout recovery');
console.log('terminal_layout: passed');
