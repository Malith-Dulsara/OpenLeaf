import * as pdfjs from '/vendor/pdfjs/build/pdf.min.mjs';
import { SharedFile } from '/collab-client.js';

pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/build/pdf.worker.min.mjs';
const pdfWorker = new pdfjs.PDFWorker(); // reused across reloads instead of one worker per compile

const { api, el, icon, prompt, confirm, toast, menu, modal, store, applyTheme, clientId } = window.UI;
const CM = window.CodeMirror;
const $ = (id) => document.getElementById(id);

const projectId = decodeURIComponent(location.pathname.split('/')[2] || '');
const base = `/api/projects/${encodeURIComponent(projectId)}`;
const pkey = (k) => `openleaf.${projectId}.${k}`;

// ------------------------------------------------------------------ state
const state = {
  meta: null,
  files: [],
  current: null,             // path of the open file
  selectedDir: '',           // folder used for "new file" / uploads
  expanded: new Set(store.get(pkey('expanded'), [])),
  docs: new Map(),           // path -> { doc, saved, saving, again, timer, dirty }
  lastResult: null,
  logFilter: 'all',
  showRaw: false,
  symbols: { labels: [], cites: [], commands: [], files: [] },
  settings: {
    autoCompile: store.get('openleaf.autoCompile', true),
    spellcheck: store.get('openleaf.spellcheck', true),
    fontSize: store.get('openleaf.fontSize', 14),
    autoCloseBrackets: store.get('openleaf.autoCloseBrackets', true),
  },
};

// ------------------------------------------------------------------ who am I (shown to collaborators)
const USER_COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#0aa5a5', '#d6338a', '#7a8b00', '#9a6324', '#2f4f8f'];
function me() {
  let u = store.get('openleaf.user', null);
  if (!u || !u.color) {
    u = { name: (u && u.name) || '', color: USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)] };
    store.set('openleaf.user', u);
  }
  return { name: u.name || 'Host', color: u.color };
}
function setMyName(name) {
  const u = { ...me(), name: name.trim().slice(0, 40) || 'Host' };
  store.set('openleaf.user', u);
  for (const e of state.docs.values()) if (e.shared) e.shared.setUser(u);
  api('POST', `${base}/presence`, { name: u.name }).catch(() => {});
}
state.presence = [];
state.serverId = null;

const TEXT_MODE = /\.(tex|sty|cls|ltx|dtx|bbx|cbx|def|cfg|clo|tikz|pgf)$/i;
const IMAGE_RE = /\.(png|jpe?g|gif|svg|webp|bmp)$/i;
const BINARY_RE = /\.(png|jpe?g|gif|webp|bmp|pdf|eps|ps|zip|gz|tiff?|ttf|otf|woff2?)$/i;

// ------------------------------------------------------------------ CodeMirror
document.documentElement.style.setProperty('--editor-font', state.settings.fontSize + 'px');
const cmTheme = () => (document.documentElement.dataset.theme === 'dark' ? 'material-darker' : 'default');
const cm = CM($('cmHost'), {
  value: '',
  mode: 'stex',
  theme: cmTheme(),
  lineNumbers: true,
  lineWrapping: true,
  matchBrackets: true,
  autoCloseBrackets: state.settings.autoCloseBrackets ? '()[]{}' : false,
  styleActiveLine: true,
  indentUnit: 2,
  tabSize: 2,
  indentWithTabs: false,
  inputStyle: 'contenteditable',
  spellcheck: state.settings.spellcheck,
  gutters: ['cm-errgutter', 'CodeMirror-linenumbers'],
  extraKeys: {
    'Ctrl-S': () => { saveAll().then(() => compile()); },
    'Cmd-S': () => { saveAll().then(() => compile()); },
    'Ctrl-Enter': () => compile(),
    'Cmd-Enter': () => compile(),
    'Ctrl-/': (c) => c.toggleComment({ lineComment: '%' }),
    'Cmd-/': (c) => c.toggleComment({ lineComment: '%' }),
    'Ctrl-B': () => wrapSelection('\\textbf{', '}'),
    'Cmd-B': () => wrapSelection('\\textbf{', '}'),
    'Ctrl-I': () => wrapSelection('\\textit{', '}'),
    'Cmd-I': () => wrapSelection('\\textit{', '}'),
    'Ctrl-F': 'findPersistent',
    'Cmd-F': 'findPersistent',
    'Ctrl-H': 'replace',
    'Ctrl-G': 'jumpToLine',
    'Ctrl-Space': (c) => c.showHint({ hint: latexHint, completeSingle: false }),
    'Ctrl-Alt-Right': () => syncForward(),
    Tab: (c) => (c.somethingSelected() ? c.indentSelection('add') : c.replaceSelection('  ')),
    'Shift-Tab': (c) => c.indentSelection('subtract'),
  },
});
cm.setOption('readOnly', 'nocursor');

// Undo/redo only your own edits, never a collaborator's.
const sharedFor = (c) => { const e = state.docs.get(state.current); return e && e.shared && e.doc === c.getDoc() ? e.shared : null; };
CM.commands.undo = (c) => { const s = sharedFor(c); if (s && s.undo) s.undo.undo(); else c.getDoc().undo(); };
CM.commands.redo = (c) => { const s = sharedFor(c); if (s && s.undo) s.undo.redo(); else c.getDoc().redo(); };

// Spell-check prose only: commands, arguments, math and comments are styled tokens, so opt those out.
cm.on('renderLine', (_c, _line, elt) => {
  for (const span of elt.querySelectorAll('span[class*="cm-"]')) span.spellcheck = false;
});

function wrapSelection(before, after) {
  if (cm.getOption('readOnly')) return;
  const sels = cm.listSelections();
  cm.operation(() => {
    for (const s of sels.slice().reverse()) {
      const from = CM.cmpPos(s.anchor, s.head) < 0 ? s.anchor : s.head;
      const to = from === s.anchor ? s.head : s.anchor;
      const text = cm.getRange(from, to);
      cm.replaceRange(before + text + after, from, to);
      if (!text) cm.setCursor({ line: from.line, ch: from.ch + before.length });
    }
  });
  cm.focus();
}

cm.on('cursorActivity', () => {
  const e = state.docs.get(state.current);
  if (e && e.shared && e.doc === cm.getDoc()) {
    const sel = cm.getDoc().listSelections()[0];
    e.shared.setCursor(cm.indexFromPos(sel.anchor), cm.indexFromPos(sel.head));
  }
  const c = cm.getCursor();
  $('cursorPos').textContent = `Ln ${c.line + 1}, Col ${c.ch + 1}`;
  highlightOutline();
});

// ------------------------------------------------------------------ autocomplete
const ENVIRONMENTS = ['abstract', 'align', 'align*', 'algorithm', 'algorithmic', 'array', 'bmatrix', 'cases', 'center', 'corollary', 'definition',
  'description', 'document', 'enumerate', 'equation', 'equation*', 'example', 'figure', 'figure*', 'flushleft', 'flushright', 'frame', 'gather',
  'gather*', 'itemize', 'lemma', 'lstlisting', 'matrix', 'minipage', 'multline', 'pmatrix', 'proof', 'proposition', 'quotation', 'quote', 'remark',
  'split', 'subequations', 'subfigure', 'table', 'table*', 'tabular', 'tabularx', 'thebibliography', 'theorem', 'tikzpicture', 'verbatim', 'vmatrix', 'wrapfigure'];
const COMMANDS = [
  'section{}', 'section*{}', 'subsection{}', 'subsection*{}', 'subsubsection{}', 'paragraph{}', 'chapter{}', 'part{}',
  'label{}', 'ref{}', 'eqref{}', 'autoref{}', 'cref{}', 'Cref{}', 'pageref{}', 'cite{}', 'citep{}', 'citet{}', 'nocite{}',
  'textbf{}', 'textit{}', 'emph{}', 'underline{}', 'texttt{}', 'textsc{}', 'textrm{}', 'textsf{}', 'footnote{}', 'caption{}',
  'includegraphics[width=\\linewidth]{}', 'input{}', 'include{}', 'begin{}', 'end{}', 'item', 'usepackage{}', 'usepackage[]{}', 'documentclass{}',
  'newcommand{}{}', 'renewcommand{}{}', 'DeclareMathOperator{}{}', 'title{}', 'author{}', 'date{}', 'maketitle', 'tableofcontents',
  'bibliography{}', 'bibliographystyle{}', 'addbibresource{}', 'printbibliography', 'url{}', 'href{}{}', 'hspace{}', 'vspace{}',
  'newline', 'newpage', 'clearpage', 'noindent', 'centering', 'today', 'LaTeX', 'TeX', 'hline', 'toprule', 'midrule', 'bottomrule',
  'multicolumn{}{}{}', 'multirow{}{}{}', 'frac{}{}', 'dfrac{}{}', 'sqrt{}', 'sum', 'prod', 'int', 'iint', 'oint', 'lim', 'infty', 'partial', 'nabla',
  'mathbf{}', 'mathrm{}', 'mathcal{}', 'mathbb{}', 'mathit{}', 'boldsymbol{}', 'text{}', 'operatorname{}', 'left', 'right', 'big', 'Big',
  'cdot', 'cdots', 'ldots', 'dots', 'times', 'div', 'pm', 'mp', 'leq', 'geq', 'neq', 'approx', 'equiv', 'sim', 'simeq', 'propto', 'in', 'notin',
  'subset', 'subseteq', 'cup', 'cap', 'forall', 'exists', 'rightarrow', 'leftarrow', 'Rightarrow', 'Leftrightarrow', 'mapsto', 'to',
  'hat{}', 'bar{}', 'tilde{}', 'vec{}', 'dot{}', 'ddot{}', 'overline{}', 'underbrace{}', 'overbrace{}', 'quad', 'qquad', 'mid', 'lVert', 'rVert',
  'alpha', 'beta', 'gamma', 'Gamma', 'delta', 'Delta', 'epsilon', 'varepsilon', 'zeta', 'eta', 'theta', 'Theta', 'vartheta', 'iota', 'kappa',
  'lambda', 'Lambda', 'mu', 'nu', 'xi', 'Xi', 'pi', 'Pi', 'rho', 'sigma', 'Sigma', 'tau', 'upsilon', 'phi', 'Phi', 'varphi', 'chi', 'psi', 'Psi',
  'omega', 'Omega', 'small', 'footnotesize', 'large', 'Large', 'textwidth', 'linewidth', 'appendix', 'thanks{}', 'and', 'verb||',
];

function hintItems(list, prefix, kind, from, to, transform) {
  const p = prefix.toLowerCase();
  const scored = [];
  for (const raw of list) {
    const name = raw.toLowerCase();
    const i = name.indexOf(p);
    if (i < 0) continue;
    scored.push({ raw, score: (i === 0 ? 0 : 100) + name.length });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, 60).map(({ raw }) => ({
    text: raw, displayText: raw, from, to,
    render: (elt) => { elt.append(document.createTextNode(transform ? transform.display(raw) : raw), el('span', { class: 'hint-kind' }, kind)); },
    hint: transform ? (c, data, item) => transform.apply(c, item) : undefined,
  }));
}

function latexHint(c) {
  const cur = c.getCursor();
  const before = c.getLine(cur.line).slice(0, cur.ch);
  const after = c.getLine(cur.line).slice(cur.ch);
  const rangeFor = (partial) => ({ from: CM.Pos(cur.line, cur.ch - partial.length), to: CM.Pos(cur.line, cur.ch) });
  let m, items = null, r;

  if ((m = /\\(?:[a-zA-Z]*ref|cref|Cref)\{([^}]*)$/.exec(before))) {
    const part = m[1].split(',').pop(); r = rangeFor(part);
    items = hintItems(state.symbols.labels, part, 'label', r.from, r.to);
  } else if ((m = /\\(?:[a-zA-Z]*cite[a-zA-Z]*|nocite)\*?(?:\[[^\]]*\])*\{([^}]*)$/.exec(before))) {
    const part = m[1].split(',').pop().trim(); r = rangeFor(part);
    items = hintItems(state.symbols.cites, part, 'bib', r.from, r.to);
  } else if ((m = /\\begin\{([^}]*)$/.exec(before))) {
    r = rangeFor(m[1]);
    const indent = /^\s*/.exec(c.getLine(cur.line))[0];
    items = hintItems(ENVIRONMENTS, m[1], 'env', r.from, r.to, {
      display: (e) => e,
      apply: (cc, item) => {
        const closing = after.startsWith('}') ? '' : '}';
        cc.replaceRange(`${item.text}${closing}\n${indent}  \n${indent}\\end{${item.text}}`, item.from, closing ? item.to : CM.Pos(item.to.line, item.to.ch + 1));
        cc.setCursor(CM.Pos(item.from.line + 1, indent.length + 2));
      },
    });
  } else if ((m = /\\end\{([^}]*)$/.exec(before))) {
    r = rangeFor(m[1]);
    items = hintItems(ENVIRONMENTS, m[1], 'env', r.from, r.to);
  } else if ((m = /\\(input|include|subfile)\{([^}]*)$/.exec(before))) {
    r = rangeFor(m[2]);
    const list = state.files.filter((f) => f.type === 'file' && /\.tex$/i.test(f.path)).map((f) => (m[1] === 'include' ? f.path.replace(/\.tex$/i, '') : f.path));
    items = hintItems(list, m[2], 'file', r.from, r.to);
  } else if ((m = /\\includegraphics(?:\[[^\]]*\])?\{([^}]*)$/.exec(before))) {
    r = rangeFor(m[1]);
    items = hintItems(state.files.filter((f) => f.type === 'file' && /\.(png|jpe?g|pdf|eps|svg)$/i.test(f.path)).map((f) => f.path), m[1], 'image', r.from, r.to);
  } else if ((m = /\\(?:bibliography|addbibresource)\{([^}]*)$/.exec(before))) {
    r = rangeFor(m[1]);
    items = hintItems(state.files.filter((f) => /\.bib$/i.test(f.path)).map((f) => f.path.replace(/\.bib$/i, /addbib/.test(before) ? '.bib' : '')), m[1], 'bib', r.from, r.to);
  } else if ((m = /\\([a-zA-Z]*)$/.exec(before))) {
    r = { from: CM.Pos(cur.line, cur.ch - m[1].length - 1), to: cur };
    const all = [...new Set([...COMMANDS, ...state.symbols.commands])];
    items = hintItems(all, m[1], 'cmd', r.from, r.to, {
      display: (s) => '\\' + s.replace(/\{\}|\[\]|\|\|/g, (x) => x[0] + '…' + x[1]),
      apply: (cc, item) => {
        const text = '\\' + item.text;
        cc.replaceRange(text, item.from, item.to);
        const hole = text.search(/\{\}|\[\]|\|\|/);
        if (hole >= 0) cc.setCursor(CM.Pos(item.from.line, item.from.ch + hole + 1));
        if (/^\\begin\{\}$/.test(text)) setTimeout(() => cc.showHint({ hint: latexHint, completeSingle: false }), 0);
      },
    });
    if (m[1].length === 0) items = items.slice(0, 40);
  }
  if (!items || !items.length) return null;
  return { list: items, from: items[0].from, to: items[0].to };
}

cm.on('inputRead', (c, change) => {
  if (change.origin !== '+input' || c.state.completionActive) return;
  const ch = change.text[change.text.length - 1].slice(-1);
  if (!/[\\\w{,:.\-/]/.test(ch)) return;
  const before = c.getLine(c.getCursor().line).slice(0, c.getCursor().ch);
  if (/\\[a-zA-Z]*$/.test(before) || /\\[a-zA-Z]+\*?(?:\[[^\]]*\])*\{[^}]*$/.test(before)) {
    c.showHint({ hint: latexHint, completeSingle: false, closeCharacters: /[\s()\[\]};>]/ });
  }
});

let symbolsTimer;
async function refreshSymbols(delay = 0) {
  clearTimeout(symbolsTimer);
  symbolsTimer = setTimeout(async () => { try { state.symbols = await api('GET', `${base}/symbols`); } catch { /* ignore */ } }, delay);
}

// ------------------------------------------------------------------ file tree
function buildTree(files) {
  const root = { name: '', path: '', type: 'dir', children: [] };
  const dirs = new Map([['', root]]);
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const ensureDir = (p) => {
    if (dirs.has(p)) return dirs.get(p);
    const parent = ensureDir(p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
    const node = { name: p.split('/').pop(), path: p, type: 'dir', children: [] };
    parent.children.push(node); dirs.set(p, node);
    return node;
  };
  for (const f of sorted) {
    if (f.type === 'dir') { ensureDir(f.path); continue; }
    const parent = ensureDir(f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '');
    parent.children.push({ name: f.path.split('/').pop(), path: f.path, type: 'file' });
  }
  const sortRec = (n) => { n.children.sort((a, b) => (a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name))); n.children.forEach((c) => c.children && sortRec(c)); };
  sortRec(root);
  return root;
}

function renderTree() {
  const tree = $('tree');
  const root = buildTree(state.files);
  const frag = document.createDocumentFragment();
  const walkNode = (node, depth) => {
    for (const n of node.children) {
      const isDir = n.type === 'dir';
      const collapsed = isDir && !state.expanded.has(n.path);
      const row = el('div', {
        class: `node ${isDir ? 'dir' : 'file'}${collapsed ? ' collapsed' : ''}${n.path === state.current ? ' selected' : ''}`,
        style: { paddingLeft: 8 + depth * 14 + 'px' }, draggable: 'true', title: n.path, 'data-path': n.path,
      },
      el('span', { class: 'chev' }, isDir ? icon('chevron') : ''),
      el('span', { class: 'ico' }, icon(isDir ? 'folder' : 'file')),
      el('span', { class: 'nm' }, n.name),
      ...(isDir ? [] : state.presence.filter((u) => u.client !== clientId && u.file === n.path)
        .map((u) => el('span', { class: 'peer-dot', style: { background: u.color }, title: `${u.name} is here` }))),
      !isDir && state.meta && n.path === state.meta.main ? el('span', { class: 'main-badge', title: 'Main document' }, 'main') : null);
      row.addEventListener('click', () => {
        if (isDir) {
          state.selectedDir = n.path;
          collapsed ? state.expanded.add(n.path) : state.expanded.delete(n.path);
          store.set(pkey('expanded'), [...state.expanded]);
          renderTree();
        } else openFile(n.path);
      });
      row.addEventListener('contextmenu', (e) => { e.preventDefault(); nodeMenu(n, e.clientX, e.clientY); });
      row.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/x-openleaf-path', n.path); e.dataTransfer.effectAllowed = 'move'; });
      if (isDir) {
        row.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); row.classList.add('drop-target'); });
        row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
        row.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); row.classList.remove('drop-target'); handleDrop(e, n.path); });
      }
      frag.append(row);
      if (isDir && !collapsed) walkNode(n, depth + 1);
    }
  };
  walkNode(root, 0);
  tree.replaceChildren(frag);
}

const tree = $('tree');
tree.addEventListener('dragover', (e) => { e.preventDefault(); tree.classList.add('drop-root'); });
tree.addEventListener('dragleave', (e) => { if (e.target === tree) tree.classList.remove('drop-root'); });
tree.addEventListener('drop', (e) => { e.preventDefault(); tree.classList.remove('drop-root'); handleDrop(e, ''); });
tree.addEventListener('contextmenu', (e) => {
  if (e.target !== tree) return;
  e.preventDefault();
  menu(e.clientX, e.clientY, [
    { label: 'New file', action: () => newFile('') },
    { label: 'New folder', action: () => newFolder('') },
    { label: 'Upload files', action: () => upload('') },
  ]);
});

async function handleDrop(e, dir) {
  const moved = e.dataTransfer.getData('text/x-openleaf-path');
  if (moved) {
    const name = moved.split('/').pop();
    const to = dir ? `${dir}/${name}` : name;
    if (to === moved || to.startsWith(moved + '/')) return;
    await renamePath(moved, to);
  } else if (e.dataTransfer.files.length) {
    await uploadFiles([...e.dataTransfer.files], dir);
  }
}

function nodeMenu(n, x, y) {
  const isDir = n.type === 'dir';
  const parent = isDir ? n.path : (n.path.includes('/') ? n.path.slice(0, n.path.lastIndexOf('/')) : '');
  menu(x, y, [
    !isDir && { label: 'Open', action: () => openFile(n.path) },
    isDir && { label: 'New file here', action: () => newFile(n.path) },
    isDir && { label: 'New folder here', action: () => newFolder(n.path) },
    isDir && { label: 'Upload here', action: () => upload(n.path) },
    !isDir && /\.tex$/i.test(n.path) && n.path !== state.meta.main && { label: 'Set as main document', action: () => updateMeta({ main: n.path }) },
    { label: 'Rename / move', action: async () => {
      const to = await prompt(`Rename ${isDir ? 'folder' : 'file'}`, n.path, { ok: 'Rename', label: 'New path (use / to move into a folder)' });
      if (to && to !== n.path) renamePath(n.path, to);
    } },
    !isDir && { label: 'Duplicate', action: async () => {
      const dot = n.path.lastIndexOf('.');
      const to = await prompt('Duplicate file', dot > 0 ? `${n.path.slice(0, dot)}-copy${n.path.slice(dot)}` : `${n.path}-copy`, { ok: 'Duplicate' });
      if (!to) return;
      const blob = await (await fetch(`${base}/raw/${encodePath(n.path)}`)).blob();
      await api('POST', `${base}/upload?path=${encodeURIComponent(to)}`, blob);
      await refreshTree(); openFile(to);
    } },
    !isDir && { label: 'Download', action: () => { const a = el('a', { href: `${base}/raw/${encodePath(n.path)}`, download: n.name }); a.click(); } },
    '-',
    { label: 'Delete', danger: true, action: async () => {
      if (!(await confirm(`Delete ${n.name}?`, `${isDir ? 'This folder and everything in it' : 'This file'} will be moved to the projects/.trash folder.`, { ok: 'Delete', danger: true }))) return;
      try {
        await api('DELETE', `${base}/file?path=${encodeURIComponent(n.path)}`);
        for (const [p, e] of [...state.docs]) if (p === n.path || p.startsWith(n.path + '/')) { if (e.shared) e.shared.destroy(); state.docs.delete(p); }
        if (state.current && (state.current === n.path || state.current.startsWith(n.path + '/'))) { state.current = null; showNoFile(); }
        await refreshTree();
      } catch (e) { toast(e.message, { error: true }); }
    } },
  ].filter(Boolean));
  state.selectedDir = parent;
}

const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

async function newFile(dir = state.selectedDir) {
  const name = await prompt('New file', 'untitled.tex', { ok: 'Create', label: dir ? `In folder ${dir}/` : 'In the project root' });
  if (!name) return;
  const p = dir ? `${dir}/${name}` : name;
  if (state.files.some((f) => f.path === p)) return toast('A file with that name already exists', { error: true });
  try {
    await api('PUT', `${base}/file?path=${encodeURIComponent(p)}`, /\.tex$/i.test(p) ? `% ${name}\n` : '');
    if (dir) state.expanded.add(dir);
    await refreshTree(); openFile(p);
  } catch (e) { toast(e.message, { error: true }); }
}

async function newFolder(dir = state.selectedDir) {
  const name = await prompt('New folder', '', { ok: 'Create', placeholder: 'figures', label: dir ? `In folder ${dir}/` : 'In the project root' });
  if (!name) return;
  const p = dir ? `${dir}/${name}` : name;
  try { await api('POST', `${base}/folder`, { path: p }); state.expanded.add(p); if (dir) state.expanded.add(dir); await refreshTree(); }
  catch (e) { toast(e.message, { error: true }); }
}

let uploadTarget = '';
function upload(dir = state.selectedDir) { uploadTarget = dir; $('uploadInput').click(); }
$('uploadInput').addEventListener('change', async (e) => { const files = [...e.target.files]; e.target.value = ''; await uploadFiles(files, uploadTarget); });

async function uploadFiles(files, dir) {
  for (const f of files) {
    const p = dir ? `${dir}/${f.name}` : f.name;
    if (state.files.some((x) => x.path === p) && !(await confirm('Overwrite?', `${p} already exists. Replace it?`, { ok: 'Replace' }))) continue;
    try { await api('POST', `${base}/upload?path=${encodeURIComponent(p)}`, f); }
    catch (err) { toast(`${f.name}: ${err.message}`, { error: true }); }
  }
  if (dir) state.expanded.add(dir);
  await refreshTree();
  toast(`Uploaded ${files.length} file${files.length > 1 ? 's' : ''}`);
  refreshSymbols();
}

async function renamePath(from, to) {
  try {
    await api('POST', `${base}/rename`, { from, to });
    remapPaths(from, to);
    await refreshTree();
    state.meta = await api('GET', base).then(({ files, ...m }) => m);
    renderTree();
  } catch (e) { toast(e.message, { error: true }); }
}

function remapPaths(from, to) {
  for (const [p, entry] of [...state.docs]) {
    if (p === from || p.startsWith(from + '/')) {
      const np = to + p.slice(from.length);
      state.docs.delete(p); state.docs.set(np, entry);
      if (entry.shared) entry.shared.path = np;
    }
  }
  if (state.current && (state.current === from || state.current.startsWith(from + '/'))) {
    state.current = to + state.current.slice(from.length);
    $('filePath').textContent = state.current;
    store.set(pkey('lastFile'), state.current);
  }
}

async function refreshTree() {
  const data = await api('GET', base);
  const { files, ...meta } = data;
  state.files = files; state.meta = meta;
  renderTree();
}
let treeTimer;
const refreshTreeSoon = () => { clearTimeout(treeTimer); treeTimer = setTimeout(() => refreshTree().catch(() => {}), 250); };

$('newFileBtn').append(icon('file')); $('newFileBtn').onclick = () => newFile();
$('newFolderBtn').append(icon('folder')); $('newFolderBtn').onclick = () => newFolder();
$('uploadBtn').append(icon('upload')); $('uploadBtn').onclick = () => upload();

// ------------------------------------------------------------------ open / save files
function showNoFile() {
  cm.swapDoc(CM.Doc('', 'stex'));
  cm.setOption('readOnly', 'nocursor');
  $('filePath').textContent = '';
  $('binaryView').hidden = true; $('cmHost').hidden = false;
  renderOutline();
}

async function openFile(p, { line, column } = {}) {
  if (BINARY_RE.test(p)) {
    state.current = p;
    const url = `${base}/raw/${encodePath(p)}?t=${Date.now()}`;
    const view = $('binaryView');
    view.replaceChildren(IMAGE_RE.test(p) ? el('img', { src: url, alt: p })
      : /\.pdf$/i.test(p) ? el('iframe', { src: url, title: p })
        : el('div', { class: 'msg' }, el('p', {}, 'This file cannot be edited here.'), el('a', { class: 'btn', href: url, download: p.split('/').pop() }, 'Download')));
    view.hidden = false; $('cmHost').hidden = true;
    $('filePath').textContent = p;
    renderTree(); renderOutline();
    return;
  }
  let entry = state.docs.get(p);
  if (!entry) {
    const shared = new SharedFile({
      base, path: p, api, user: me(),
      mode: TEXT_MODE.test(p) || /\.bib$/i.test(p) ? 'stex' : null,
      onChange: (remote) => onSharedChange(shared, remote),
      onCursors: () => { if (state.docs.get(state.current) && state.docs.get(state.current).shared === shared) renderRemoteCursorsSoon(); },
      onStatus: () => setSaveState(),
    });
    entry = { shared, doc: null, ready: shared.join() };
    state.docs.set(p, entry);
  }
  try {
    await entry.ready;
    entry.doc = entry.shared.cmDoc;
  } catch (e) {
    if (state.docs.get(p) === entry) state.docs.delete(p);
    entry.shared.destroy();
    if (/not a text file/i.test(e.message)) return openBinaryFallback(p, { url: `${base}/raw/${encodePath(p)}` });
    toast(e.message, { error: true });
    return;
  }
  const prev = state.docs.get(state.current);
  if (prev && prev !== entry && prev.shared) prev.shared.setCursor(null, null);
  state.current = p;
  state.selectedDir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
  // expand parent folders so the file is visible in the tree
  const parts = p.split('/'); for (let i = 1; i < parts.length; i++) state.expanded.add(parts.slice(0, i).join('/'));
  store.set(pkey('lastFile'), p);
  api('POST', `${base}/presence`, { file: p }).catch(() => {});
  $('binaryView').hidden = true; $('cmHost').hidden = false;
  if (cm.getDoc() !== entry.doc) cm.swapDoc(entry.doc);
  cm.setOption('readOnly', false);
  $('filePath').textContent = p;
  renderTree();
  renderOutline();
  updateWordCount();
  applyLintMarkers();
  renderRemoteCursors();
  if (line) {
    const pos = CM.Pos(line - 1, column || 0);
    cm.setCursor(pos);
    const h = cm.getScrollInfo().clientHeight;
    const coords = cm.charCoords(pos, 'local');
    cm.scrollTo(null, coords.top - h / 3);
    flashLine(line - 1);
  }
  cm.focus();
  cm.refresh();
}

function openBinaryFallback(p, data) {
  state.current = p;
  const view = $('binaryView');
  view.replaceChildren(el('div', { class: 'msg' }, el('p', {}, 'Binary file'), el('a', { class: 'btn', href: data.url, download: p.split('/').pop() }, 'Download')));
  view.hidden = false; $('cmHost').hidden = true;
  $('filePath').textContent = p;
  renderTree();
}

function flashLine(lineIdx) {
  const h = cm.addLineClass(lineIdx, 'background', 'cm-flash-line');
  setTimeout(() => cm.removeLineClass(h, 'background', 'cm-flash-line'), 1700);
}

function onSharedChange(shared, remote) {
  const p = shared.path;
  if (p === state.current) { scheduleOutline(); updateWordCountSoon(); renderRemoteCursorsSoon(); }
  if (!remote) {
    if (/\.(tex|bib|sty|cls)$/i.test(p)) refreshSymbols(2000);
    scheduleCompile(1200);
  }
}

/** Wait until every local edit has reached the server. */
async function saveAll() {
  await Promise.all([...state.docs.values()].map((e) => (e.shared ? e.shared.flush() : null)));
}

function setSaveState() {
  const s = $('saveState');
  const shared = [...state.docs.values()].map((e) => e.shared).filter(Boolean);
  if (shared.some((x) => x.error)) { s.textContent = 'Offline – retrying…'; s.className = 'save-state error'; return; }
  if (shared.some((x) => x.pending)) { s.textContent = 'Saving…'; s.className = 'save-state dirty'; return; }
  s.textContent = 'All changes saved'; s.className = 'save-state';
}

// ------------------------------------------------------------------ collaborators' cursors
let remoteMarks = [];
let cursorRaf = 0;
function renderRemoteCursorsSoon() {
  if (!cursorRaf) cursorRaf = requestAnimationFrame(() => { cursorRaf = 0; renderRemoteCursors(); });
}
function renderRemoteCursors() {
  for (const m of remoteMarks) m.clear();
  remoteMarks = [];
  const entry = state.docs.get(state.current);
  if (!entry || !entry.shared || !entry.doc || $('cmHost').hidden) return;
  const doc = entry.doc;
  for (const c of entry.shared.remoteCursors()) {
    const head = doc.posFromIndex(c.head), anchor = doc.posFromIndex(c.anchor);
    if (c.anchor !== c.head) {
      const [from, to] = c.anchor < c.head ? [anchor, head] : [head, anchor];
      remoteMarks.push(doc.markText(from, to, { css: `background-color: ${c.color}38`, title: c.name }));
    }
    const caret = el('span', { class: 'remote-caret', style: { borderLeftColor: c.color } },
      el('span', { class: 'remote-label', style: { background: c.color } }, c.name));
    remoteMarks.push(doc.setBookmark(head, { widget: caret, insertLeft: true }));
  }
}

// ------------------------------------------------------------------ who's online
function renderPeople() {
  const box = $('people');
  const seen = new Set();
  const others = state.presence.filter((u) => u.client !== clientId && !seen.has(u.client) && seen.add(u.client));
  box.replaceChildren(...others.slice(0, 6).map((u) => el('button', {
    class: 'avatar', style: { background: u.color },
    title: `${u.name}${u.guest ? '' : ' (host)'}${u.file ? ' — ' + u.file : ''}\nClick to open the same file`,
    onclick: () => { if (u.file && state.files.some((f) => f.path === u.file)) openFile(u.file); },
  }, initials(u.name))), others.length > 6 ? el('span', { class: 'avatar more' }, `+${others.length - 6}`) : '');
}
const initials = (name) => (String(name || '?').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2) || '?').toUpperCase();

// ------------------------------------------------------------------ sharing (host only)
async function openShareDialog() {
  let info;
  try { info = await api('GET', `${base}/share`); } catch (e) { toast(e.message, { error: true }); return; }
  modal((box, close) => {
    const nameInput = el('input', { type: 'text', value: store.get('openleaf.user', {}).name || '', placeholder: 'Host', maxlength: '40' });
    nameInput.addEventListener('change', () => setMyName(nameInput.value));
    const body = el('div');
    const update = async (patch) => {
      try { info = await api('POST', `${base}/share`, patch); render(); }
      catch (e) { toast(e.message, { error: true }); }
    };
    const linkRow = (l) => {
      const input = el('input', { type: 'text', value: l.url, readonly: true, onfocus: (e) => e.target.select() });
      return el('div', { class: 'share-link' },
        el('div', { class: 'share-link-label' }, l.label, l.tailscale ? el('span', { class: 'share-tag' }, 'works over the internet') : null),
        el('div', { class: 'share-link-row' }, input,
          el('button', { class: 'btn', onclick: async () => {
            try { await navigator.clipboard.writeText(l.url); } catch { input.select(); document.execCommand('copy'); }
            toast('Link copied');
          } }, icon('copy'), 'Copy')));
    };
    function render() {
      const toggle = el('input', { type: 'checkbox' });
      toggle.checked = info.enabled;
      toggle.onchange = () => update({ enabled: toggle.checked });
      const main = info.links.filter((l) => !l.virtual), other = info.links.filter((l) => l.virtual);
      body.replaceChildren(
        el('div', { class: 'settings-grid' },
          el('label', {}, 'Your name'), nameInput,
          el('label', {}, 'Invite with a link'), el('label', { class: 'switch' }, toggle, el('span'))),
        info.enabled ? el('div', { class: 'share-body' },
          main.length ? main.map(linkRow) : el('p', {}, 'No network connection found. Connect to Wi-Fi or a network, then reopen this dialog.'),
          other.length ? el('details', {}, el('summary', {}, 'Other network adapters'), other.map(linkRow)) : null,
          el('p', { class: 'share-note' }, 'Anyone with the link can edit this project while OpenLeaf is open on this computer. ',
            'They need to be on the same network. For people elsewhere, install ', el('a', { href: 'https://tailscale.com/download', target: '_blank', rel: 'noopener' }, 'Tailscale'),
            ' on both computers and send the Tailscale link.'),
          el('button', { class: 'btn small', onclick: () => update({ rotate: true }).then(() => toast('New link created — the old link no longer works')) }, 'Reset link'))
          : el('p', { class: 'share-note' }, 'Turn this on to get a link collaborators can open in their browser. No account or install needed.'),
      );
    }
    render();
    box.classList.add('wide');
    box.append(el('h3', {}, 'Share this project'), body,
      el('div', { class: 'actions' }, el('button', { class: 'btn primary', onclick: () => { setMyName(nameInput.value); close(); } }, 'Done')));
  });
}

async function askGuestName() {
  if (store.get('openleaf.user', {}).name) return;
  const name = await prompt('Join project', '', { ok: 'Join', label: 'Your name (shown to the other editors)', placeholder: 'e.g. Ana' });
  setMyName(name || 'Guest');
}

// ------------------------------------------------------------------ outline & word count
let outlineItems = [];
function renderOutline() {
  const box = $('outline');
  outlineItems = [];
  if (!state.current || !/\.tex$/i.test(state.current) || $('cmHost').hidden) {
    box.replaceChildren(el('div', { class: 'outline-empty' }, 'No outline for this file.'));
    return;
  }
  const levels = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5 };
  const doc = cm.getDoc();
  doc.eachLine((lh) => {
    const text = lh.text;
    const m = /^[^%]*?\\(part|chapter|section|subsection|subsubsection|paragraph)\*?\s*(?:\[[^\]]*\])?\s*\{(.*)$/.exec(text);
    if (!m) return;
    let depth = 0, title = '';
    for (const ch of m[2]) { if (ch === '{') depth++; if (ch === '}') { if (depth === 0) break; depth--; } title += ch; }
    outlineItems.push({ line: doc.getLineNumber(lh), level: levels[m[1]], title: title.replace(/\\[a-zA-Z]+\s*/g, '').replace(/[{}$]/g, '') || m[1] });
  });
  if (!outlineItems.length) { box.replaceChildren(el('div', { class: 'outline-empty' }, 'No sections in this file.')); return; }
  const minLevel = Math.min(...outlineItems.map((o) => o.level));
  box.replaceChildren(...outlineItems.map((o) => {
    const node = el('div', { class: 'outline-item', style: { paddingLeft: 12 + (o.level - minLevel) * 14 + 'px' }, title: o.title }, o.title);
    node.onclick = () => { cm.setCursor(o.line, 0); cm.scrollIntoView({ line: o.line, ch: 0 }, 120); flashLine(o.line); cm.focus(); };
    o.node = node;
    return node;
  }));
  highlightOutline();
}
let outlineTimer;
const scheduleOutline = () => { clearTimeout(outlineTimer); outlineTimer = setTimeout(renderOutline, 500); };
function highlightOutline() {
  const line = cm.getCursor().line;
  let cur = null;
  for (const o of outlineItems) if (o.line <= line) cur = o;
  outlineItems.forEach((o) => o.node && o.node.classList.toggle('current', o === cur));
}
$('outlineToggle').querySelector('.chev').append(icon('chevron'));
const outlineWrap = $('outlineWrap');
if (store.get('openleaf.outlineCollapsed', false)) outlineWrap.classList.add('collapsed');
$('outlineToggle').onclick = () => { outlineWrap.classList.toggle('collapsed'); store.set('openleaf.outlineCollapsed', outlineWrap.classList.contains('collapsed')); };

function countWords(text) {
  const body = text.includes('\\begin{document}') ? text.slice(text.indexOf('\\begin{document}')) : text;
  const stripped = body
    .replace(/(^|[^\\])%.*$/gm, '$1')
    .replace(/\\begin\{(equation|align|gather|multline|tikzpicture|verbatim|lstlisting)\*?\}[\s\S]*?\\end\{\1\*?\}/g, ' ')
    .replace(/\$\$[\s\S]*?\$\$|\$[^$]*\$|\\\[[\s\S]*?\\\]/g, ' ')
    .replace(/\\(label|ref|eqref|cite\w*|includegraphics|usepackage|begin|end|input|include|bibliography\w*)(\[[^\]]*\])?\{[^}]*\}/g, ' ')
    .replace(/\\[a-zA-Z@]+\*?/g, ' ')
    .replace(/[{}\[\]~&\\]/g, ' ');
  const words = stripped.match(/[A-Za-z0-9À-ɏЀ-ӿ'’-]+/g);
  return words ? words.filter((w) => /[A-Za-z0-9À-ӿ]/.test(w)).length : 0;
}
function updateWordCount() {
  $('wordCount').textContent = state.current && /\.tex$/i.test(state.current) && !$('cmHost').hidden ? `${countWords(cm.getValue()).toLocaleString()} words` : '';
}
let wcTimer;
const updateWordCountSoon = () => { clearTimeout(wcTimer); wcTimer = setTimeout(updateWordCount, 800); };

// ------------------------------------------------------------------ compile
let compiling = false, compileAgain = false, compileTimer;
const compileBtn = $('compileBtn');
compileBtn.querySelector('.compile-icon').append(icon('refresh'));
$('compileMenuBtn').append(icon('chevron'));

function scheduleCompile(delay = 900) {
  if (!state.settings.autoCompile) return;
  clearTimeout(compileTimer);
  compileTimer = setTimeout(() => compile(), delay);
}

function setCompiling(on) {
  compileBtn.classList.toggle('compiling', on);
  compileBtn.querySelector('.lbl').textContent = on ? 'Compiling…' : 'Recompile';
  $('pdfViewport').classList.toggle('stale', on && !!pdfView.doc);
  if (on) { $('compileStatus').textContent = ''; $('compileStatus').className = 'compile-status'; }
}

async function compile() {
  clearTimeout(compileTimer);
  if (compiling) { compileAgain = true; return; }
  compiling = true;
  setCompiling(true);
  try {
    await saveAll();
    const r = await api('POST', `${base}/compile`);
    await applyCompileResult(r);
  } catch (e) {
    toast(`Compile failed: ${e.message}`, { error: true });
  } finally {
    compiling = false;
    setCompiling(false);
    if (compileAgain) { compileAgain = false; compile(); }
  }
}

async function stopCompile() {
  await api('POST', `${base}/compile/stop`).catch(() => {});
}

async function applyCompileResult(r) {
  state.lastResult = r;
  const errs = (r.errors || []).length, warns = (r.warnings || []).length;
  const badge = $('logBadge');
  if (errs || warns) {
    badge.hidden = false;
    badge.textContent = errs || warns;
    badge.className = 'badge' + (errs ? '' : ' warn');
  } else badge.hidden = true;
  const st = $('compileStatus');
  if (r.status === 'success') { st.textContent = `Compiled in ${(r.duration / 1000).toFixed(1)}s`; st.className = 'compile-status'; }
  else if (r.status === 'error') { st.textContent = `${errs} error${errs > 1 ? 's' : ''} — PDF may be incomplete`; st.className = 'compile-status error'; }
  else { st.textContent = r.message || 'Compilation failed'; st.className = 'compile-status error'; }
  renderLogs();
  applyLintMarkers();
  if (r.pdf) {
    // Not awaited: browsers pause rendering in hidden tabs, and that must not stall later compiles.
    pdfView.load(`${r.pdf.url}?v=${r.pdf.version}`, r.pdf.version).catch(() => {});
    $('downloadPdfBtn').href = `${r.pdf.url}?download`;
  }
  if (r.status === 'failure' || r.status === 'timeout') openLogs(true);
}

// gutter markers / line highlights for errors in the open file
let lintHandles = [];
function applyLintMarkers() {
  cm.operation(() => {
    cm.clearGutter('cm-errgutter');
    for (const h of lintHandles) cm.removeLineClass(h.handle, 'background', h.cls);
    lintHandles = [];
    const r = state.lastResult;
    if (!r || !state.current || $('cmHost').hidden) return;
    const items = [...(r.errors || []), ...(r.warnings || [])].filter((x) => x.file === state.current && x.line);
    const byLine = new Map();
    for (const it of items) { const prev = byLine.get(it.line); if (!prev || (prev.level !== 'error' && it.level === 'error')) byLine.set(it.line, it); }
    for (const [line, it] of byLine) {
      if (line - 1 >= cm.lineCount()) continue;
      const msgs = items.filter((x) => x.line === line).map((x) => x.message).join('\n');
      cm.setGutterMarker(line - 1, 'cm-errgutter', el('span', { class: `err-marker ${it.level}`, title: msgs }));
      if (it.level === 'error') { const cls = 'cm-error-line'; lintHandles.push({ handle: cm.addLineClass(line - 1, 'background', cls), cls }); }
    }
  });
}

// ------------------------------------------------------------------ logs panel
function openLogs(show) {
  const panel = $('logPanel');
  panel.hidden = show === undefined ? !panel.hidden : !show;
  $('logsBtn').classList.toggle('active', !panel.hidden);
  if (!panel.hidden) renderLogs();
}
$('logsBtn').onclick = () => openLogs();
$('closeLogBtn').onclick = () => openLogs(false);
$('rawLogBtn').onclick = () => { state.showRaw = !state.showRaw; renderLogs(); };
$('clearCacheBtn').onclick = async () => {
  await api('DELETE', `${base}/cache`);
  toast('Cached files cleared. Recompiling from scratch…');
  compile();
};

async function renderLogs() {
  const panel = $('logPanel');
  if (panel.hidden) return;
  const r = state.lastResult;
  const body = $('logBody');
  $('rawLogBtn').textContent = state.showRaw ? 'Hide raw logs' : 'Raw logs';
  if (!r) { $('logTabs').replaceChildren(); body.replaceChildren(el('div', { class: 'log-empty' }, 'No compile yet.')); return; }
  const groups = { error: r.errors || [], warning: r.warnings || [], typesetting: r.typesetting || [] };
  const tabs = [['all', `All (${groups.error.length + groups.warning.length + groups.typesetting.length})`], ['error', `Errors (${groups.error.length})`],
    ['warning', `Warnings (${groups.warning.length})`], ['typesetting', `Typesetting (${groups.typesetting.length})`]];
  $('logTabs').replaceChildren(...tabs.map(([k, label]) => el('button', { class: 'log-tab' + (state.logFilter === k ? ' active' : ''), onclick: () => { state.logFilter = k; renderLogs(); } }, label)));

  if (state.showRaw) {
    let raw = r.log;
    if (raw === undefined) raw = await fetch(`${base}/output.log`).then((x) => (x.ok ? x.text() : '')).catch(() => '');
    body.replaceChildren(el('pre', { class: 'raw-log' }, (r.stdout ? `${r.stdout}\n\n────────── .log ──────────\n\n` : '') + (raw || '(no log file)')));
    return;
  }
  const items = state.logFilter === 'all' ? [...groups.error, ...groups.warning, ...groups.typesetting] : groups[state.logFilter];
  const nodes = [];
  if (r.message) nodes.push(el('div', { class: `log-entry ${r.status === 'success' ? 'summary' : 'error'}` }, el('div', { class: 'msg' }, r.message)));
  for (const it of items) {
    const loc = it.file ? `${it.file}${it.line ? ':' + it.line : ''}` : null;
    nodes.push(el('div', { class: `log-entry ${it.level}` },
      el('div', { class: 'msg' }, it.message, loc ? el('span', { class: 'loc', onclick: () => openFile(it.file, { line: it.line || 1 }) }, loc) : null),
      it.context ? el('pre', {}, it.context) : null));
  }
  if (!items.length && !r.message) nodes.push(el('div', { class: 'log-empty' }, r.status === 'success' ? 'No problems — compiled cleanly.' : 'Nothing to show here. Open the raw logs for details.'));
  body.replaceChildren(...nodes);
}

// ------------------------------------------------------------------ compile menu & settings
$('compileBtn').onclick = () => compile();
$('compileMenuBtn').onclick = (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  menu(r.left, r.bottom + 4, [
    { label: 'Auto compile', checked: state.settings.autoCompile, action: () => setSetting('autoCompile', !state.settings.autoCompile) },
    '-',
    ...['pdflatex', 'xelatex', 'lualatex'].map((c) => ({ label: c, checked: state.meta.compiler === c, action: () => updateMeta({ compiler: c }).then(() => compile()) })),
    '-',
    { label: 'Stop compilation', action: stopCompile },
    { label: 'Recompile from scratch', action: () => $('clearCacheBtn').click() },
  ]);
};

function setSetting(k, v) {
  state.settings[k] = v;
  store.set('openleaf.' + k, v);
  if (k === 'spellcheck') cm.setOption('spellcheck', v);
  if (k === 'fontSize') { document.documentElement.style.setProperty('--editor-font', v + 'px'); cm.refresh(); }
  if (k === 'autoCloseBrackets') cm.setOption('autoCloseBrackets', v ? '()[]{}' : false);
  updateLiveState();
  if (k === 'autoCompile' && v) compile();
}

function updateLiveState() {
  const s = $('liveState');
  s.textContent = state.settings.autoCompile ? '● Auto compile on' : '○ Auto compile off';
  s.className = state.settings.autoCompile ? 'live-on' : '';
  s.style.cursor = 'pointer';
  s.title = 'Click to toggle auto compile';
}
$('liveState').onclick = () => setSetting('autoCompile', !state.settings.autoCompile);

async function updateMeta(patch) {
  try {
    const m = await api('PATCH', base, patch);
    state.meta = { ...state.meta, ...m };
    renderMeta(); renderTree();
  } catch (e) { toast(e.message, { error: true }); }
}

function renderMeta() {
  $('projName').textContent = state.meta.name;
  document.title = `${state.meta.name} – OpenLeaf`;
}

$('projName').onclick = async () => {
  const name = await prompt('Rename project', state.meta.name, { ok: 'Rename' });
  if (name) updateMeta({ name });
};

$('menuBtn').prepend(icon('gear'));
$('menuBtn').onclick = () => {
  modal((box, close) => {
    const toggle = (key) => {
      const input = el('input', { type: 'checkbox' }); input.checked = state.settings[key];
      input.onchange = () => setSetting(key, input.checked);
      return el('label', { class: 'switch' }, input, el('span'));
    };
    const mainSel = el('select', { onchange: (e) => updateMeta({ main: e.target.value }) },
      ...state.files.filter((f) => f.type === 'file' && /\.tex$/i.test(f.path)).map((f) => el('option', { value: f.path, selected: f.path === state.meta.main }, f.path)));
    const compSel = el('select', { onchange: (e) => updateMeta({ compiler: e.target.value }).then(() => compile()) },
      ...['pdflatex', 'xelatex', 'lualatex'].map((c) => el('option', { value: c, selected: c === state.meta.compiler }, c)));
    const fontSel = el('select', { onchange: (e) => setSetting('fontSize', Number(e.target.value)) },
      ...[11, 12, 13, 14, 15, 16, 18, 20].map((s) => el('option', { value: s, selected: s === state.settings.fontSize }, s + 'px')));
    box.append(
      el('h3', {}, 'Project settings'),
      el('div', { class: 'settings-grid' },
        el('label', {}, 'Compiler'), compSel,
        el('label', {}, 'Main document'), mainSel,
        el('label', {}, 'Auto compile'), toggle('autoCompile'),
        el('label', {}, 'Spell check'), toggle('spellcheck'),
        el('label', {}, 'Auto-close brackets'), toggle('autoCloseBrackets'),
        el('label', {}, 'Font size'), fontSel),
      el('div', { class: 'settings-actions' },
        el('a', { class: 'btn', href: `${base}/zip` }, icon('zip'), 'Download source (.zip)'),
        el('a', { class: 'btn', href: `${base}/output.pdf?download` }, icon('download'), 'Download PDF'),
        state.meta.guest ? null : el('button', { class: 'btn', onclick: () => api('POST', `${base}/reveal`) }, icon('folderOpen'), 'Open project folder'),
        el('button', { class: 'btn', onclick: () => { close(); showWordCount(); } }, icon('log'), 'Word count (whole project)'),
        el('button', { class: 'btn', onclick: () => { close(); showShortcuts(); } }, icon('edit'), 'Keyboard shortcuts')),
      el('div', { class: 'actions' }, el('button', { class: 'btn primary', onclick: () => close() }, 'Done')));
  });
};

async function showWordCount() {
  let total = 0; const rows = [];
  for (const f of state.files.filter((x) => x.type === 'file' && /\.tex$/i.test(x.path))) {
    const entry = state.docs.get(f.path);
    const text = entry && entry.doc ? entry.doc.getValue() : (await api('GET', `${base}/file?path=${encodeURIComponent(f.path)}`)).content;
    const n = countWords(text); total += n; rows.push([f.path, n]);
  }
  modal((box, close) => {
    box.append(el('h3', {}, 'Word count'),
      el('p', {}, 'Approximate count of prose words (math, commands and comments excluded).'),
      el('div', { class: 'settings-grid' }, ...rows.flatMap(([p, n]) => [el('label', {}, p), el('div', {}, n.toLocaleString())]),
        el('label', {}, el('b', {}, 'Total')), el('div', {}, el('b', {}, total.toLocaleString()))),
      el('div', { class: 'actions' }, el('button', { class: 'btn primary', onclick: () => close() }, 'Close')));
  });
}

function showShortcuts() {
  const list = [['Ctrl+S', 'Save & recompile'], ['Ctrl+Enter', 'Recompile'], ['Ctrl+Space', 'Autocomplete'], ['Ctrl+/', 'Toggle comment'],
    ['Ctrl+B / Ctrl+I', 'Bold / italic'], ['Ctrl+F', 'Find'], ['Ctrl+H', 'Find & replace'], ['Ctrl+G', 'Go to line'],
    ['Ctrl+Alt+→', 'Jump from code to PDF'], ['Double-click PDF', 'Jump from PDF to code'], ['Ctrl+Mouse wheel', 'Zoom PDF']];
  modal((box, close) => {
    box.append(el('h3', {}, 'Keyboard shortcuts'),
      el('div', { class: 'settings-grid' }, ...list.flatMap(([k, v]) => [el('label', {}, el('code', {}, k)), el('div', {}, v)])),
      el('div', { class: 'actions' }, el('button', { class: 'btn primary', onclick: () => close() }, 'Close')));
  });
}

// ------------------------------------------------------------------ PDF viewer
class PdfView {
  constructor(viewport, pagesEl) {
    this.viewport = viewport; this.pagesEl = pagesEl;
    this.doc = null; this.pages = []; this.version = null; this.loadToken = 0;
    this.mode = store.get('openleaf.zoom', 'page-width');
    this.scale = 1;
    let raf = 0;
    viewport.addEventListener('scroll', () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; this.renderVisible(); this.updateIndicator(); });
    });
    let rt;
    new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(() => { if (typeof this.mode === 'string') this.relayout(); }, 120); }).observe(viewport);
    viewport.addEventListener('wheel', (e) => {
      if (!e.ctrlKey || !this.doc) return;
      e.preventDefault();
      this.setZoom(Math.min(5, Math.max(0.25, this.scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1))));
    }, { passive: false });
  }

  computeScale() {
    if (!this.pages.length) return 1;
    const w = this.pages[0].w, h = this.pages[0].h;
    const availW = Math.max(100, this.viewport.clientWidth - 30);
    if (this.mode === 'page-width') return availW / w;
    if (this.mode === 'page-fit') return Math.min(availW / w, (this.viewport.clientHeight - 28) / h);
    return Number(this.mode) || 1;
  }

  anchor() {
    const top = this.viewport.scrollTop;
    for (const p of this.pages) {
      if (p.div.offsetTop + p.div.offsetHeight > top) {
        return { index: p.index, frac: (top - p.div.offsetTop) / p.div.offsetHeight, left: this.viewport.scrollLeft };
      }
    }
    return { index: 0, frac: 0, left: 0 };
  }

  restore(a) {
    const p = this.pages[Math.min(a.index, this.pages.length - 1)];
    if (!p) return;
    this.viewport.scrollTop = p.div.offsetTop + a.frac * p.div.offsetHeight;
    this.viewport.scrollLeft = a.left;
  }

  async load(url, version) {
    if (version && version === this.version) return;
    const token = ++this.loadToken;
    let doc;
    try {
      doc = await pdfjs.getDocument({
        url, worker: pdfWorker, isEvalSupported: false,
        cMapUrl: '/vendor/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
      }).promise;
    } catch (e) { if (token === this.loadToken) toast('Could not load PDF: ' + e.message, { error: true }); return; }
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const vp = page.getViewport({ scale: 1 });
      pages.push({ index: i - 1, page, w: vp.width, h: vp.height });
    }
    if (token !== this.loadToken) { doc.destroy(); return; }
    const a = this.pages.length ? this.anchor() : { index: 0, frac: 0, left: 0 };
    const oldDoc = this.doc;
    const oldPages = this.pages;
    this.doc = doc; this.version = version; this.pages = pages;
    this.scale = this.computeScale();
    for (const p of pages) {
      p.div = el('div', { class: 'pdf-page', 'data-page': p.index + 1 });
      p.canvas = el('canvas');
      p.div.append(p.canvas);
      p.div.style.width = `${p.w * this.scale}px`; p.div.style.height = `${p.h * this.scale}px`;
      p.div.addEventListener('dblclick', (e) => this.onDblClick(e, p));
    }
    // Render the pages that will be visible before swapping, so the preview never flashes blank.
    const est = this.estimateVisible(a);
    await Promise.all(est.map((i) => this.renderPage(pages[i])));
    if (token !== this.loadToken) return;
    oldPages.forEach((p) => p.task && p.task.cancel());
    this.pagesEl.replaceChildren(...pages.map((p) => p.div));
    $('pdfEmpty').hidden = true;
    this.restore(a);
    this.renderVisible();
    this.updateIndicator();
    $('pageCount').textContent = `/ ${doc.numPages}`;
    if (oldDoc) setTimeout(() => oldDoc.destroy(), 0);
  }

  estimateVisible(a) {
    const gap = 12, out = [];
    const vh = this.viewport.clientHeight || 800;
    let y = 0;
    const startIdx = Math.min(a.index, this.pages.length - 1);
    y -= a.frac * this.pages[startIdx].h * this.scale;
    for (let i = startIdx; i < this.pages.length && y < vh; i++) { out.push(i); y += this.pages[i].h * this.scale + gap; }
    return out;
  }

  visibleRange() {
    const top = this.viewport.scrollTop - 300, bottom = this.viewport.scrollTop + this.viewport.clientHeight + 300;
    return this.pages.filter((p) => p.div.offsetTop + p.div.offsetHeight > top && p.div.offsetTop < bottom);
  }

  renderVisible() { for (const p of this.visibleRange()) this.renderPage(p); }

  async renderPage(p) {
    const scale = this.scale;
    if (p.renderedScale === scale || p.renderingScale === scale) return;
    p.renderingScale = scale;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const vp = p.page.getViewport({ scale: scale * dpr });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
    if (p.task) p.task.cancel();
    const task = p.page.render({ canvasContext: canvas.getContext('2d'), viewport: vp });
    p.task = task;
    try { await task.promise; } catch { return; }
    if (p.renderingScale !== scale) return;
    p.canvas.replaceWith(canvas); p.canvas = canvas;
    p.renderedScale = scale; p.renderingScale = null; p.task = null;
  }

  relayout() {
    if (!this.pages.length) return;
    const a = this.anchor();
    this.scale = this.computeScale();
    for (const p of this.pages) { p.div.style.width = `${p.w * this.scale}px`; p.div.style.height = `${p.h * this.scale}px`; }
    this.restore(a);
    this.renderVisible();
    syncZoomSelect();
  }

  setZoom(mode) {
    this.mode = mode;
    store.set('openleaf.zoom', mode);
    this.relayout();
    syncZoomSelect();
  }

  updateIndicator() {
    const mid = this.viewport.scrollTop + this.viewport.clientHeight / 3;
    let cur = 1;
    for (const p of this.pages) if (p.div.offsetTop <= mid) cur = p.index + 1;
    if (document.activeElement !== $('pageInput')) $('pageInput').value = this.pages.length ? cur : 0;
  }

  goToPage(n) {
    const p = this.pages[Math.max(0, Math.min(this.pages.length - 1, n - 1))];
    if (p) this.viewport.scrollTop = p.div.offsetTop - 10;
  }

  onDblClick(e, p) {
    const rect = p.div.getBoundingClientRect();
    const x = (e.clientX - rect.left) / this.scale, y = (e.clientY - rect.top) / this.scale;
    syncInverse(p.index + 1, x, y);
  }

  highlight(rects) {
    if (!rects.length) return;
    const p = this.pages[rects[0].page - 1];
    if (!p) return;
    p.div.querySelectorAll('.hl').forEach((h) => h.remove());
    let minTop = Infinity;
    for (const r of rects) {
      const height = r.height > 0 ? r.height : 10;
      const top = (r.v - height) * this.scale;
      minTop = Math.min(minTop, top);
      p.div.append(el('div', { class: 'hl', style: { left: `${r.h * this.scale}px`, top: `${top}px`, width: `${Math.max(r.width, 20) * this.scale}px`, height: `${height * this.scale + 2}px` } }));
    }
    this.viewport.scrollTo({ top: p.div.offsetTop + minTop - this.viewport.clientHeight / 3, behavior: 'smooth' });
    setTimeout(() => p.div.querySelectorAll('.hl').forEach((h) => h.remove()), 2600);
  }

  centerPoint() {
    const mid = this.viewport.scrollTop + this.viewport.clientHeight / 2;
    for (const p of this.pages) {
      if (p.div.offsetTop + p.div.offsetHeight >= mid) {
        return { page: p.index + 1, x: p.w / 2, y: Math.max(0, (mid - p.div.offsetTop) / this.scale) };
      }
    }
    return null;
  }
}

const pdfView = new PdfView($('pdfViewport'), $('pdfPages'));

function syncZoomSelect() {
  const sel = $('zoomSelect');
  const m = String(pdfView.mode);
  const opt = [...sel.options].find((o) => o.value === m);
  if (opt) { sel.value = m; sel.querySelector('[value="custom"]').hidden = true; }
  else { const c = sel.querySelector('[value="custom"]'); c.hidden = false; c.textContent = Math.round(pdfView.scale * 100) + '%'; sel.value = 'custom'; }
}
$('zoomSelect').onchange = (e) => { if (e.target.value !== 'custom') pdfView.setZoom(e.target.value); };
$('zoomInBtn').append(icon('plus')); $('zoomOutBtn').append(icon('minus'));
$('zoomInBtn').onclick = () => pdfView.setZoom(Math.min(5, +(pdfView.scale * 1.2).toFixed(3)));
$('zoomOutBtn').onclick = () => pdfView.setZoom(Math.max(0.25, +(pdfView.scale / 1.2).toFixed(3)));
$('downloadPdfBtn').append(icon('download'));
$('downloadPdfBtn').href = `${base}/output.pdf?download`;
$('pageInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { pdfView.goToPage(Number(e.target.value) || 1); e.target.blur(); } });
syncZoomSelect();

// ------------------------------------------------------------------ SyncTeX
async function syncForward() {
  if (!state.current || !/\.tex$/i.test(state.current) || !pdfView.doc) return;
  const c = cm.getCursor();
  try {
    const rects = await api('GET', `${base}/synctex/forward?file=${encodeURIComponent(state.current)}&line=${c.line + 1}&column=${c.ch + 1}`);
    if (rects.length) pdfView.highlight(rects); else toast('No matching location in the PDF (try recompiling).');
  } catch (e) { toast(e.message, { error: true }); }
}

async function syncInverse(page, x, y) {
  try {
    const r = await api('GET', `${base}/synctex/inverse?page=${page}&x=${x.toFixed(2)}&y=${y.toFixed(2)}`);
    if (r && r.file) {
      if (document.body.dataset.layout === 'pdf') setLayout('split');
      await openFile(r.file, { line: r.line, column: 0 });
    } else toast('No matching source location.');
  } catch (e) { toast(e.message, { error: true }); }
}

$('syncFwdBtn').append(icon('arrowRight')); $('syncFwdBtn').onclick = syncForward;
$('syncBackBtn').append(icon('arrowLeft'));
$('syncBackBtn').onclick = () => { const pt = pdfView.centerPoint(); if (pt) syncInverse(pt.page, pt.x, pt.y); };

// ------------------------------------------------------------------ layout, splitters, theme
function setLayout(l) {
  document.body.dataset.layout = l;
  store.set('openleaf.layout', l);
  document.querySelectorAll('.seg button').forEach((b) => b.classList.toggle('active', b.dataset.layout === l));
  setTimeout(() => { cm.refresh(); pdfView.relayout(); }, 30);
}
document.querySelectorAll('.seg button').forEach((b) => { b.onclick = () => setLayout(b.dataset.layout); });
setLayout(store.get('openleaf.layout', 'split'));

const sidebar = $('sidebar'), editorPane = $('editorPane');
sidebar.style.width = store.get('openleaf.sidebarWidth', 240) + 'px';
editorPane.style.flexBasis = store.get('openleaf.editorFrac', 50) + '%';
if (store.get('openleaf.sidebarHidden', innerWidth < 760)) document.body.classList.add('no-sidebar');
$('sidebarBtn').append(icon('sidebar'));
$('sidebarBtn').onclick = () => { document.body.classList.toggle('no-sidebar'); store.set('openleaf.sidebarHidden', document.body.classList.contains('no-sidebar')); setTimeout(() => cm.refresh(), 30); };

function dragGutter(gutter, onMove, onEnd) {
  gutter.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    e.preventDefault();
    gutter.setPointerCapture(e.pointerId);
    gutter.classList.add('dragging');
    document.body.style.userSelect = 'none';
    $('pdfViewport').style.pointerEvents = 'none';
    const move = (ev) => onMove(ev);
    const up = () => {
      gutter.classList.remove('dragging');
      document.body.style.userSelect = '';
      $('pdfViewport').style.pointerEvents = '';
      gutter.removeEventListener('pointermove', move); gutter.removeEventListener('pointerup', up);
      onEnd && onEnd();
    };
    gutter.addEventListener('pointermove', move); gutter.addEventListener('pointerup', up);
  });
}
dragGutter($('gutterSidebar'), (e) => {
  const w = Math.max(150, Math.min(500, e.clientX));
  sidebar.style.width = w + 'px';
}, () => { store.set('openleaf.sidebarWidth', parseInt(sidebar.style.width, 10)); cm.refresh(); pdfView.relayout(); });
dragGutter($('gutterEditor'), (e) => {
  const ws = $('workspace').getBoundingClientRect();
  const left = document.body.classList.contains('no-sidebar') ? ws.left : sidebar.getBoundingClientRect().right + 6;
  const total = ws.right - left;
  const frac = Math.max(15, Math.min(85, ((e.clientX - left) / total) * 100));
  editorPane.style.flexBasis = frac + '%';
  cm.refresh();
}, () => { store.set('openleaf.editorFrac', parseFloat(editorPane.style.flexBasis)); pdfView.relayout(); });

$('homeBtn').append(icon('home'));
$('shareBtn').prepend(icon('share'));
$('shareBtn').onclick = openShareDialog;
const themeBtn = $('themeBtn');
const paintTheme = () => { themeBtn.replaceChildren(icon(document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon')); cm.setOption('theme', cmTheme()); };
themeBtn.onclick = () => { const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; store.set('openleaf.theme', t); applyTheme(t); paintTheme(); };
paintTheme();

$('boldBtn').onclick = () => wrapSelection('\\textbf{', '}');
$('italicBtn').onclick = () => wrapSelection('\\textit{', '}');
$('searchBtn').append(icon('search'));
$('searchBtn').onclick = () => { cm.focus(); cm.execCommand('findPersistent'); };

document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveAll().then(() => compile()); }
  else if (mod && e.key === 'Enter') { e.preventDefault(); compile(); }
});

window.addEventListener('beforeunload', (e) => {
  if ([...state.docs.values()].some((d) => d.shared && d.shared.pending)) { saveAll(); e.preventDefault(); e.returnValue = ''; }
});

// ------------------------------------------------------------------ live updates (other tabs / external editors)
function connectEvents() {
  const u = me();
  const q = new URLSearchParams({ client: clientId, name: u.name, color: u.color, file: state.current || '' });
  const es = new EventSource(`${base}/events?${q}`);
  es.onmessage = async (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    const mine = msg.origin === clientId;
    const entry = msg.path ? state.docs.get(msg.path) : null;
    switch (msg.type) {
      case 'hello':
        // After any reconnect we may have missed edits: re-join every open document.
        if (state.serverId) for (const e of state.docs.values()) if (e.shared) e.shared.join().catch(() => {});
        state.serverId = msg.serverId;
        $('saveState').title = '';
        api('POST', `${base}/presence`, { file: state.current || '', name: me().name }).catch(() => {});
        setSaveState();
        break;
      case 'y':
      case 'aw':
        if (!mine && entry && entry.shared) entry.shared.receive(msg);
        break;
      case 'presence':
        state.presence = msg.users || [];
        renderPeople(); renderTree();
        break;
      case 'saved':
        if (!mine) refreshTreeSoon();
        break;
      case 'fs':
        refreshTreeSoon();
        if (msg.kind === 'change' && /\.(tex|bib|sty|cls|png|jpe?g|pdf|eps|csv|dat)$/i.test(msg.path)) { refreshSymbols(1000); scheduleCompile(400); }
        break;
      case 'tree':
        if (!mine && msg.renamed) remapPaths(msg.renamed.from, msg.renamed.to);
        refreshTreeSoon();
        break;
      case 'meta':
        if (!mine) { state.meta = { ...state.meta, ...msg.meta }; renderMeta(); renderTree(); }
        break;
      case 'compiled':
        if (!mine && msg.result) applyCompileResult(msg.result);
        break;
      default: break;
    }
  };
  es.onerror = async () => {
    const s = $('saveState');
    s.textContent = state.meta.guest ? 'Disconnected from host – reconnecting…' : 'Reconnecting…';
    s.className = 'save-state error';
    if (state.meta.guest) {
      const r = await fetch(base).catch(() => null);
      if (r && r.status === 403) { es.close(); showAccessLost(); return; }
    }
    if (es.readyState === EventSource.CLOSED) { es.close(); setTimeout(connectEvents, 3000); }
  };
}

/** Guests: the host turned sharing off or reset the link. */
function showAccessLost() {
  for (const e of state.docs.values()) if (e.shared) e.shared.destroy();
  cm.setOption('readOnly', 'nocursor');
  modal((box) => {
    box.append(el('h3', {}, 'You no longer have access'),
      el('p', {}, 'The host stopped sharing this project or created a new invite link. Ask them for a new link to keep editing.'));
  });
}

// ------------------------------------------------------------------ boot
(async function boot() {
  if (!projectId) { location.href = '/'; return; }
  try { await refreshTree(); }
  catch (e) {
    document.body.replaceChildren(el('div', { style: { padding: '40px', textAlign: 'center' } }, el('h2', {}, 'Project not found'), el('a', { href: '/' }, 'Back to projects')));
    return;
  }
  if (state.meta.guest) {
    document.body.classList.add('guest');
    await askGuestName();
  }
  renderMeta();
  updateLiveState();
  setSaveState();
  const last = store.get(pkey('lastFile'), null);
  const start = last && state.files.some((f) => f.path === last) ? last : state.meta.main;
  if (state.files.some((f) => f.path === start)) await openFile(start); else showNoFile();
  refreshSymbols();
  connectEvents();
  // Show the existing PDF right away (if any), then compile so the preview is current.
  const head = await fetch(`${base}/output.pdf`, { method: 'HEAD' }).catch(() => null);
  if (head && head.ok) await pdfView.load(`${base}/output.pdf?v=${Date.now()}`, null);
  compile();
})();
// Send pending edits right away when the tab is hidden (browsers throttle timers in background tabs).
document.addEventListener('visibilitychange', () => { if (document.hidden) saveAll(); });
