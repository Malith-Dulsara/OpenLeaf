'use strict';
// Unit tests for the LaTeX log parser that powers the Logs panel and editor error markers.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

process.env.OPENLEAF_PROJECTS = fs.mkdtempSync(path.join(os.tmpdir(), 'openleaf-log-'));
const { parseLog } = require('../server.js');

const proj = path.join(os.tmpdir(), 'paper');
const files = ['main.tex', 'sections/intro.tex'];

const LOG = [
  'This is pdfTeX, Version 3.141592653-2.6-1.40.26 (MiKTeX 24.4) (preloaded format=pdflatex 2024.10.1)',
  '(./main.tex',
  'LaTeX2e <2024-06-01>',
  '(./sections/intro.tex',
  'LaTeX Warning: Citation `knuth1984\' on page 1 undefined on input line 4.',
  ')',
  './main.tex:30: Undefined control sequence.',
  'l.30 This line has a \\badcommand',
  '',
  'Overfull \\hbox (12.3pt too wide) in paragraph at lines 41--43',
  'Package hyperref Warning: Token not allowed in a PDF string (Unicode):',
  '(hyperref)                removing `math shift\' on input line 12.',
  ')',
].join('\n');

test('errors in file:line:message form are attributed to the right file and line', () => {
  const { errors } = parseLog(LOG, proj, proj, files);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].file, 'main.tex');
  assert.equal(errors[0].line, 30);
  assert.match(errors[0].message, /Undefined control sequence/);
  assert.match(errors[0].context, /badcommand/);
});

test('warnings use the file TeX was reading at the time', () => {
  const { warnings } = parseLog(LOG, proj, proj, files);
  const cite = warnings.find((w) => /Citation/.test(w.message));
  assert.equal(cite.file, 'sections/intro.tex');
  assert.equal(cite.line, 4);
});

test('multi-line package warnings are joined', () => {
  const { warnings } = parseLog(LOG, proj, proj, files);
  const hyper = warnings.find((w) => /Token not allowed/.test(w.message));
  assert.match(hyper.message, /removing `math shift'/);
  assert.equal(hyper.line, 12);
});

test('bad boxes are reported as typesetting issues', () => {
  const { typesetting } = parseLog(LOG, proj, proj, files);
  assert.equal(typesetting.length, 1);
  assert.equal(typesetting[0].line, 41);
});

test('a clean log produces no problems', () => {
  const r = parseLog('This is pdfTeX\n(./main.tex)\nOutput written on main.pdf (1 page).', proj, proj, files);
  assert.deepEqual([r.errors.length, r.warnings.length, r.typesetting.length], [0, 0, 0]);
});
