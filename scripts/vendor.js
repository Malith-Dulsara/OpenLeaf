'use strict';
// Copies/bundles the libraries OpenLeaf needs from node_modules into public/vendor (browser) and lib/ (server).
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'public', 'vendor');
const copies = [
  ['codemirror/lib', 'codemirror/lib'],
  ['codemirror/mode/stex', 'codemirror/mode/stex'],
  ['codemirror/addon/edit', 'codemirror/addon/edit'],
  ['codemirror/addon/selection', 'codemirror/addon/selection'],
  ['codemirror/addon/search', 'codemirror/addon/search'],
  ['codemirror/addon/dialog', 'codemirror/addon/dialog'],
  ['codemirror/addon/hint', 'codemirror/addon/hint'],
  ['codemirror/addon/comment', 'codemirror/addon/comment'],
  ['codemirror/theme/material-darker.css', 'codemirror/theme/material-darker.css'],
  ['codemirror/LICENSE', 'codemirror/LICENSE'],
  ['pdfjs-dist/build/pdf.min.mjs', 'pdfjs/build/pdf.min.mjs'],
  ['pdfjs-dist/build/pdf.worker.min.mjs', 'pdfjs/build/pdf.worker.min.mjs'],
  ['pdfjs-dist/cmaps', 'pdfjs/cmaps'],
  ['pdfjs-dist/standard_fonts', 'pdfjs/standard_fonts'],
  ['pdfjs-dist/LICENSE', 'pdfjs/LICENSE'],
];

fs.rmSync(out, { recursive: true, force: true });
for (const [from, to] of copies) {
  const src = path.join(root, 'node_modules', from);
  if (!fs.existsSync(src)) { console.error(`missing ${src} - run npm install first`); process.exit(1); }
  fs.cpSync(src, path.join(out, to), { recursive: true, filter: (f) => !f.endsWith('.map') });
}

// Yjs (collaborative editing): an ES module for the browser and a CommonJS file for the server.
const esbuild = require('esbuild');
const entry = path.join(__dirname, 'yjs-entry.js');
esbuild.buildSync({ entryPoints: [entry], bundle: true, minify: true, format: 'esm', platform: 'browser', target: 'es2020', outfile: path.join(out, 'yjs', 'yjs.mjs'), logLevel: 'warning' });
esbuild.buildSync({ entryPoints: [entry], bundle: true, minify: true, format: 'cjs', platform: 'node', target: 'node18', outfile: path.join(root, 'lib', 'yjs.cjs'), logLevel: 'warning' });
fs.copyFileSync(path.join(root, 'node_modules', 'yjs', 'LICENSE'), path.join(out, 'yjs', 'LICENSE'));

console.log(`vendored libraries into ${path.relative(root, out)} and lib/`);
