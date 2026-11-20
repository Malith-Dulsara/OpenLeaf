'use strict';
/*
 * OpenLeaf — a local, Overleaf-style LaTeX editor.
 * Zero-dependency Node HTTP server: project/file management, latexmk compilation,
 * log parsing, SyncTeX, live file watching (Server-Sent Events), zip import/export.
 */
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { URL } = require('url');
const { createCollab, CollabError } = require('./collab.js');

const PORT = process.env.PORT !== undefined && process.env.PORT !== '' ? Number(process.env.PORT) : 5050;
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = __dirname;
const CLI_ARGS = process.argv.slice(2);
const PROJECTS_DIR = path.resolve(process.env.OPENLEAF_PROJECTS || process.env.TEXLOCAL_PROJECTS || CLI_ARGS.find((a) => !a.startsWith('--')) || path.join(ROOT, 'projects'));
const BUILD = '.build';
const META = '.openleaf.json';
const LEGACY_META = '.texlocal.json'; // written by versions released as TeXLocal
const TRASH = '.trash';
const COMPILE_TIMEOUT_MS = Number(process.env.OPENLEAF_TIMEOUT) * 1000 || 5 * 60 * 1000;
const IS_WIN = process.platform === 'win32';
const SERVER_ID = crypto.randomBytes(6).toString('hex'); // lets clients notice a server restart

const HIDDEN_NAMES = new Set([BUILD, META, LEGACY_META, TRASH, '.git', 'node_modules', '.DS_Store', 'Thumbs.db']);
const AUX_EXT = /\.(aux|log|fls|fdb_latexmk|synctex\.gz|synctex\(busy\)|synctex|out|toc|lof|lot|blg|bbl|xdv|nav|snm|vrb|bcf|run\.xml|idx|ilg|ind|glo|gls|glg|ist|acn|acr|alg|thm|loa|lol)$/i;
const TEXT_EXT = new Set(['.tex', '.bib', '.sty', '.cls', '.bst', '.bbx', '.cbx', '.lbx', '.dbx', '.def', '.cfg', '.clo', '.ltx', '.dtx', '.ins', '.fd',
  '.txt', '.md', '.csv', '.tsv', '.dat', '.json', '.yaml', '.yml', '.xml', '.svg', '.tikz', '.pgf', '.pgf-plot', '.gnuplot', '.py', '.r', '.m', '.lua',
  '.sh', '.bat', '.gitignore', '.latexmkrc', '.rnw', '.rtex', '.asy', '.mp', '.ist', '.cbx', '.html', '.css', '.js', '.bbl']);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.map': 'application/json',
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.eps': 'application/postscript',
  '.txt': 'text/plain; charset=utf-8', '.tex': 'text/plain; charset=utf-8', '.bib': 'text/plain; charset=utf-8',
  '.zip': 'application/zip', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.bcmap': 'application/octet-stream',
};

// ---------------------------------------------------------------- helpers

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const toPosix = (p) => p.split(path.sep).join('/');
const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
const exists = (p) => fsp.access(p).then(() => true, () => false);

function projectDir(id) {
  if (!id || !/^[\w.\- ]+$/.test(id) || id.startsWith('.')) throw new HttpError(400, 'Invalid project id');
  return path.join(PROJECTS_DIR, id);
}

/** Resolve a project-relative path, refusing anything that escapes the project. */
function safePath(projDir, rel, { allowRoot = false, forWrite = false } = {}) {
  rel = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel && !allowRoot) throw new HttpError(400, 'Path required');
  const abs = path.resolve(projDir, rel);
  if (abs !== projDir && !abs.startsWith(projDir + path.sep)) throw new HttpError(400, 'Path escapes project');
  const first = toPosix(path.relative(projDir, abs)).split('/')[0];
  if (forWrite && (first === BUILD || first === META || first === '.git')) throw new HttpError(400, 'Reserved path');
  return abs;
}

function slugify(name) {
  const s = String(name || 'Untitled').trim().replace(/[^\w\- ]+/g, '').replace(/\s+/g, '-').slice(0, 60);
  return s || 'project';
}

async function uniqueDir(base) {
  let id = base, n = 2;
  while (await exists(path.join(PROJECTS_DIR, id))) id = `${base}-${n++}`;
  return id;
}

function isTextFile(file, buf) {
  const ext = path.extname(file).toLowerCase();
  if (TEXT_EXT.has(ext) || TEXT_EXT.has(path.basename(file).toLowerCase())) return true;
  if (/\.(png|jpe?g|gif|pdf|eps|ps|zip|gz|webp|bmp|tiff?|ttf|otf|woff2?)$/i.test(file)) return false;
  if (!buf) return false;
  return !buf.subarray(0, 8000).includes(0);
}

function readBody(req, limit = 512 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const buf = await readBody(req, 10 * 1024 * 1024);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON'); }
}

function send(res, status, body, headers = {}) {
  if (typeof body === 'object' && !Buffer.isBuffer(body)) {
    body = JSON.stringify(body);
    headers['Content-Type'] = headers['Content-Type'] || 'application/json; charset=utf-8';
  }
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

async function sendFile(req, res, file, extraHeaders = {}) {
  let st;
  try { st = await fsp.stat(file); } catch { return send(res, 404, { error: 'Not found' }); }
  if (!st.isFile()) return send(res, 404, { error: 'Not found' });
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', ...extraHeaders };
  const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : st.size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : st.size - 1;
    start = Math.max(0, start); end = Math.min(st.size - 1, end);
    if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { ...headers, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${st.size}` });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), error: err });
    });
  });
}

function tarBinary() {
  if (IS_WIN) {
    const sys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    if (fs.existsSync(sys)) return sys;
  }
  return 'bsdtar';
}

function killTree(proc) {
  if (!proc || proc.exitCode !== null) return;
  if (IS_WIN) spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
  else { try { process.kill(-proc.pid, 'SIGKILL'); } catch { proc.kill('SIGKILL'); } }
}

// ---------------------------------------------------------------- project model

async function walk(projDir, rel = '', out = []) {
  let entries;
  try { entries = await fsp.readdir(path.join(projDir, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (HIDDEN_NAMES.has(e.name)) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      out.push({ path: r, type: 'dir' });
      await walk(projDir, r, out);
    } else if (e.isFile()) {
      if (AUX_EXT.test(e.name)) continue;
      const st = await fsp.stat(path.join(projDir, r)).catch(() => null);
      if (st) out.push({ path: r, type: 'file', size: st.size, mtime: st.mtimeMs });
    }
  }
  return out;
}

async function detectMain(projDir) {
  const files = (await walk(projDir)).filter((f) => f.type === 'file' && /\.tex$/i.test(f.path));
  files.sort((a, b) => a.path.split('/').length - b.path.split('/').length || (/^main\.tex$/i.test(b.path) - /^main\.tex$/i.test(a.path)));
  for (const f of files) {
    const txt = await fsp.readFile(path.join(projDir, f.path), 'utf8').catch(() => '');
    if (/^[^%\n]*\\documentclass/m.test(txt)) return f.path;
  }
  return files[0] ? files[0].path : 'main.tex';
}

async function readMeta(id) {
  const dir = projectDir(id);
  const st = await fsp.stat(dir).catch(() => null);
  if (!st || !st.isDirectory()) throw new HttpError(404, 'Project not found');
  let meta = {};
  if (!(await exists(path.join(dir, META))) && (await exists(path.join(dir, LEGACY_META)))) {
    await fsp.rename(path.join(dir, LEGACY_META), path.join(dir, META)).catch(() => {});
  }
  try { meta = JSON.parse(await fsp.readFile(path.join(dir, META), 'utf8')); } catch { /* new / imported folder */ }
  let changed = false;
  if (!meta.name) { meta.name = id; changed = true; }
  if (!meta.main || !(await exists(path.join(dir, meta.main)))) { meta.main = await detectMain(dir); changed = true; }
  if (!meta.compiler) { meta.compiler = 'pdflatex'; changed = true; }
  if (!meta.created) { meta.created = st.birthtimeMs || Date.now(); changed = true; }
  if (changed) await writeMeta(id, meta);
  return { id, ...meta };
}
/** Metadata safe to send to clients: the invite token is replaced by a flag. */
function publicMeta(meta) {
  const { share, ...rest } = meta;
  return { ...rest, shared: !!(share && share.enabled) };
}

async function writeMeta(id, meta) {
  const { id: _omit, ...rest } = meta;
  await fsp.writeFile(path.join(projectDir(id), META), JSON.stringify(rest, null, 2));
}

async function lastModified(projDir) {
  let latest = 0;
  for (const f of await walk(projDir)) if (f.mtime > latest) latest = f.mtime;
  return latest;
}

async function listProjects() {
  await fsp.mkdir(PROJECTS_DIR, { recursive: true });
  const out = [];
  for (const e of await fsp.readdir(PROJECTS_DIR, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.') || !/^[\w.\- ]+$/.test(e.name)) continue;
    try {
      const meta = await readMeta(e.name);
      out.push({ ...publicMeta(meta), modified: await lastModified(projectDir(e.name)) || meta.created });
    } catch { /* skip unreadable */ }
  }
  return out.sort((a, b) => b.modified - a.modified);
}

const TEMPLATES = {
  blank: (name) => ({
    'main.tex': `\\documentclass{article}
\\usepackage[utf8]{inputenc}
\\usepackage{amsmath, amssymb, graphicx, hyperref}

\\title{${name}}
\\author{Your Name}
\\date{\\today}

\\begin{document}
\\maketitle

\\section{Introduction}
Start writing here.

\\end{document}
`,
  }),
  paper: (name) => ({
    'main.tex': `\\documentclass[11pt]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage[margin=1in]{geometry}
\\usepackage{amsmath, amssymb, amsthm}
\\usepackage{graphicx}
\\usepackage{booktabs}
\\usepackage{tikz}
\\usepackage[numbers]{natbib}
\\usepackage[colorlinks=true, linkcolor=blue, citecolor=teal]{hyperref}

\\newtheorem{theorem}{Theorem}

\\title{${name}}
\\author{First Author\\thanks{Affiliation, \\texttt{first@example.org}} \\and Second Author}
\\date{\\today}

\\begin{document}
\\maketitle

\\begin{abstract}
This is a template research paper. Edit the source on the left; the PDF on the
right recompiles automatically. Double-click anywhere in the PDF to jump to the
matching source line.
\\end{abstract}

\\input{sections/introduction}

\\section{Method}\\label{sec:method}
We minimise the loss
\\begin{equation}
  \\mathcal{L}(\\theta) = \\frac{1}{N}\\sum_{i=1}^{N} \\ell\\big(f_\\theta(x_i), y_i\\big) + \\lambda \\lVert \\theta \\rVert_2^2 .
  \\label{eq:loss}
\\end{equation}

\\begin{theorem}\\label{thm:convex}
If $\\ell$ is convex in its first argument and $f_\\theta$ is linear in $\\theta$, then \\eqref{eq:loss} is convex.
\\end{theorem}

\\section{Results}\\label{sec:results}
Table~\\ref{tab:results} and Figure~\\ref{fig:diagram} summarise our findings.

\\begin{table}[h]
  \\centering
  \\begin{tabular}{lcc}
    \\toprule
    Method & Accuracy (\\%) & Time (s) \\\\
    \\midrule
    Baseline \\cite{knuth1984} & 81.2 & 12.4 \\\\
    Ours                      & \\textbf{89.7} & 9.8 \\\\
    \\bottomrule
  \\end{tabular}
  \\caption{Main results.}
  \\label{tab:results}
\\end{table}

\\begin{figure}[h]
  \\centering
  \\begin{tikzpicture}[node distance=2.6cm, every node/.style={draw, rounded corners, minimum width=2cm, minimum height=0.8cm}]
    \\node (in) {Input};
    \\node (model) [right of=in] {Model};
    \\node (out) [right of=model] {Output};
    \\draw[->] (in) -- (model);
    \\draw[->] (model) -- (out);
  \\end{tikzpicture}
  \\caption{Pipeline overview.}
  \\label{fig:diagram}
\\end{figure}

\\section{Conclusion}
We presented a method; see Section~\\ref{sec:method}. \\LaTeX{} itself is described in \\cite{lamport1994}.

\\bibliographystyle{plainnat}
\\bibliography{references}

\\end{document}
`,
    'sections/introduction.tex': `\\section{Introduction}\\label{sec:intro}
Research papers are often split into several files. This section lives in
\\texttt{sections/introduction.tex} and is pulled in with \\verb|\\input|.
Typesetting with \\TeX{} goes back to \\citet{knuth1984}.
`,
    'references.bib': `@book{knuth1984,
  author    = {Donald E. Knuth},
  title     = {The {\\TeX}book},
  publisher = {Addison-Wesley},
  year      = {1984}
}

@book{lamport1994,
  author    = {Leslie Lamport},
  title     = {{\\LaTeX}: A Document Preparation System},
  publisher = {Addison-Wesley},
  edition   = {2nd},
  year      = {1994}
}
`,
  }),
};

async function createProject(name, template = 'paper') {
  name = String(name || 'Untitled Paper').trim() || 'Untitled Paper';
  const id = await uniqueDir(slugify(name));
  const dir = path.join(PROJECTS_DIR, id);
  await fsp.mkdir(dir, { recursive: true });
  const files = (TEMPLATES[template] || TEMPLATES.paper)(name.replace(/[\\{}$&#^_%~]/g, ''));
  for (const [rel, content] of Object.entries(files)) {
    await fsp.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fsp.writeFile(path.join(dir, rel), content);
  }
  await writeMeta(id, { name, main: 'main.tex', compiler: 'pdflatex', created: Date.now() });
  return readMeta(id);
}

async function copyDir(src, dst) {
  await fsp.mkdir(dst, { recursive: true });
  for (const e of await fsp.readdir(src, { withFileTypes: true })) {
    if (e.name === BUILD || e.name === '.git') continue;
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) await copyDir(s, d); else if (e.isFile()) await fsp.copyFile(s, d);
  }
}

async function importZip(buf, name) {
  const id = await uniqueDir(slugify(name || 'Imported'));
  const dir = path.join(PROJECTS_DIR, id);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(os.tmpdir(), `openleaf-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`);
  await fsp.writeFile(tmp, buf);
  const r = await run(tarBinary(), ['-xf', tmp, '-C', dir]);
  await fsp.unlink(tmp).catch(() => {});
  if (r.code !== 0) {
    await fsp.rm(dir, { recursive: true, force: true });
    throw new HttpError(400, `Could not extract zip: ${r.stderr || r.stdout}`);
  }
  // If the archive wraps everything in one top-level folder, flatten it.
  const top = (await fsp.readdir(dir, { withFileTypes: true })).filter((e) => e.name !== '__MACOSX');
  if (top.length === 1 && top[0].isDirectory()) {
    const inner = path.join(dir, top[0].name);
    for (const n of await fsp.readdir(inner)) await fsp.rename(path.join(inner, n), path.join(dir, n));
    await fsp.rmdir(inner).catch(() => {});
  }
  await fsp.rm(path.join(dir, '__MACOSX'), { recursive: true, force: true });
  let meta = {};
  try { meta = JSON.parse(await fsp.readFile(path.join(dir, META), 'utf8')); } catch { /* none */ }
  await writeMeta(id, { ...meta, name: name || meta.name || id, created: Date.now() });
  return readMeta(id);
}

// ---------------------------------------------------------------- live events (SSE) + file watching

const hubs = new Map(); // id -> { clients:Set<res>, watcher, timers:Map, hashes:Map }

function hub(id) {
  if (!hubs.has(id)) hubs.set(id, { clients: new Set(), watcher: null, timers: new Map(), hashes: new Map(), presence: new Map() });
  return hubs.get(id);
}

function broadcast(id, msg) {
  const h = hubs.get(id);
  if (!h) return;
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of h.clients) res.write(data);
}

function startWatching(id) {
  const h = hub(id);
  if (h.watcher) return;
  const dir = projectDir(id);
  try {
    h.watcher = fs.watch(dir, { recursive: true }, (_evt, filename) => {
      if (!filename) return;
      const rel = toPosix(String(filename));
      const first = rel.split('/')[0];
      if (HIDDEN_NAMES.has(first) || AUX_EXT.test(rel) || /(^|\/)(~|\.#)|\.swp$|\.tmp$/i.test(rel)) return;
      clearTimeout(h.timers.get(rel));
      h.timers.set(rel, setTimeout(async () => {
        h.timers.delete(rel);
        const abs = path.join(dir, rel);
        const st = await fsp.stat(abs).catch(() => null);
        if (st && st.isFile()) {
          const hash = sha1(await fsp.readFile(abs).catch(() => Buffer.alloc(0)));
          if (h.hashes.get(rel) === hash) return; // our own write echoing back
          h.hashes.set(rel, hash);
          if (collab.isOpen(id, rel)) await collab.diskChanged(id, rel, await fsp.readFile(abs, 'utf8').catch(() => ''));
          broadcast(id, { type: 'fs', path: rel, kind: 'change' });
        } else {
          h.hashes.delete(rel);
          if (!st) await collab.remove(id, rel);
          broadcast(id, { type: 'fs', path: rel, kind: st ? 'dir' : 'remove' });
        }
      }, 200));
    });
    h.watcher.on('error', () => { h.watcher = null; });
  } catch (e) {
    console.warn(`[watch] cannot watch ${dir}: ${e.message}`);
  }
}

function stopWatchingIfIdle(id) {
  const h = hubs.get(id);
  if (h && h.clients.size === 0 && h.watcher) { h.watcher.close(); h.watcher = null; }
}

function rememberWrite(id, rel, buf) { hub(id).hashes.set(rel, sha1(buf)); }

const collab = createCollab({
  broadcast,
  async readText(id, rel) {
    const abs = safePath(projectDir(id), rel);
    const buf = await fsp.readFile(abs);
    if (!isTextFile(rel, buf)) throw new HttpError(400, 'Not a text file');
    rememberWrite(id, rel, buf);
    return buf.toString('utf8');
  },
  async writeText(id, rel, text) {
    const abs = safePath(projectDir(id), rel, { forWrite: true });
    const buf = Buffer.from(text, 'utf8');
    rememberWrite(id, rel, buf);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, buf);
  },
});

function broadcastPresence(id) {
  const h = hubs.get(id);
  if (h) broadcast(id, { type: 'presence', users: [...h.presence.values()] });
}

// ---------------------------------------------------------------- compilation

const compiles = new Map(); // id -> { current, queued, proc, stopped }

function requestCompile(id, origin) {
  if (!compiles.has(id)) compiles.set(id, { current: null, queued: null, proc: null });
  const st = compiles.get(id);
  if (st.queued) return st.queued;
  const start = () => {
    st.queued = null;
    st.current = doCompile(id, st, origin).finally(() => { st.current = null; });
    return st.current;
  };
  if (st.current) { st.queued = st.current.catch(() => {}).then(start); return st.queued; }
  return start();
}

const ENGINE_FLAG = { pdflatex: '-pdf', xelatex: '-xelatex', lualatex: '-lualatex' };

async function doCompile(id, st, origin) {
  await collab.flush(id);
  const meta = await readMeta(id);
  const dir = projectDir(id);
  const mainAbs = safePath(dir, meta.main);
  if (!(await exists(mainAbs))) {
    return { status: 'failure', message: `Main document "${meta.main}" not found. Choose one in the project settings.`, errors: [], warnings: [], typesetting: [], log: '' };
  }
  const mainDir = path.dirname(mainAbs);
  const outDir = path.join(dir, BUILD);
  const base = path.basename(meta.main).replace(/\.tex$/i, '');
  // Mirror sub-folders so \include{chapters/x} can write its .aux into the output dir.
  await fsp.mkdir(outDir, { recursive: true });
  for (const f of await walk(dir)) {
    if (f.type !== 'dir') continue;
    const relToMain = path.relative(mainDir, path.join(dir, f.path));
    if (!relToMain.startsWith('..')) await fsp.mkdir(path.join(outDir, relToMain), { recursive: true }).catch(() => {});
  }
  const args = [
    ENGINE_FLAG[meta.compiler] || '-pdf', '-f', '-interaction=nonstopmode', '-file-line-error', '-synctex=1',
    `-outdir=${outDir}`, '-latexoption=-max-print-line=10000', path.basename(mainAbs),
  ];
  const started = Date.now();
  broadcast(id, { type: 'compile-start', origin });
  const output = [];
  const result = await new Promise((resolve) => {
    let proc;
    try {
      proc = spawn('latexmk', args, {
        cwd: mainDir, windowsHide: true, detached: !IS_WIN,
        env: {
          ...process.env, max_print_line: '10000', error_line: '254', half_error_line: '238',
          // Search the project before the TeX distribution (MiKTeX ships e.g. its own references.bib).
          BIBINPUTS: [mainDir, dir, process.env.BIBINPUTS || ''].join(path.delimiter),
          BSTINPUTS: [mainDir, dir, process.env.BSTINPUTS || ''].join(path.delimiter),
        },
      });
    } catch (e) { return resolve({ code: -1, spawnError: e }); }
    st.proc = proc; st.stopped = false;
    const timer = setTimeout(() => { st.timedOut = true; killTree(proc); }, COMPILE_TIMEOUT_MS);
    proc.stdout.on('data', (d) => output.push(d));
    proc.stderr.on('data', (d) => output.push(d));
    proc.stdin.end();
    proc.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, spawnError: e }); });
    proc.on('close', (code) => { clearTimeout(timer); resolve({ code }); });
  });
  st.proc = null;
  const stdout = Buffer.concat(output).toString('utf8');
  const timedOut = st.timedOut; st.timedOut = false;
  const stopped = st.stopped; st.stopped = false;

  if (result.spawnError) {
    return {
      status: 'failure', errors: [], warnings: [], typesetting: [], log: '', stdout: String(result.spawnError),
      message: result.spawnError.code === 'ENOENT'
        ? 'latexmk was not found on PATH. Install MiKTeX or TeX Live (with Perl) and restart OpenLeaf.'
        : `Could not start latexmk: ${result.spawnError.message}`,
    };
  }

  const pdfFile = path.join(outDir, `${base}.pdf`);
  const logFile = path.join(outDir, `${base}.log`);
  const pdfStat = await fsp.stat(pdfFile).catch(() => null);
  const log = await fsp.readFile(logFile, 'latin1').catch(() => '');
  const parsed = parseLog(log, dir, mainDir, (await walk(dir)).filter((f) => f.type === 'file').map((f) => f.path));
  const freshPdf = pdfStat && (pdfStat.mtimeMs >= started - 2000 || /up-to-date|Nothing to do/i.test(stdout));
  let status = 'success';
  if (stopped) status = 'stopped';
  else if (timedOut) status = 'timeout';
  else if (!freshPdf) status = 'failure';
  else if (parsed.errors.length) status = 'error';
  return {
    status, ...parsed, log, stdout,
    duration: Date.now() - started,
    pdf: pdfStat ? { url: `/api/projects/${encodeURIComponent(id)}/output.pdf`, version: Math.round(pdfStat.mtimeMs), size: pdfStat.size } : null,
    message: stopped ? 'Compilation stopped.' : timedOut ? `Compilation timed out after ${COMPILE_TIMEOUT_MS / 1000}s.`
      : !freshPdf ? 'No PDF was produced. Check the errors and the raw log.' : '',
  };
}

/** Parse a TeX .log into errors / warnings / bad boxes, attributing each to a project file and line. */
function parseLog(log, projDir, mainDir, files = []) {
  const errors = [], warnings = [], typesetting = [];
  const lines = log.split(/\r?\n/);
  const stack = [];
  const rel = (f) => (f ? recordedToProject(projDir, mainDir, f.replace(/^"|"$/g, ''), files) : null);
  const currentFile = () => { for (let i = stack.length - 1; i >= 0; i--) if (stack[i]) { const r = rel(stack[i]); if (r) return r; } return null; };
  const context = (i, n = 6) => {
    const out = [];
    for (let j = i + 1; j < Math.min(lines.length, i + 1 + n); j++) { if (lines[j] === '' && out.length) break; out.push(lines[j]); }
    return out.join('\n');
  };
  const fileLineRe = /^((?:[A-Za-z]:)?[^:]*?\.(?:tex|sty|cls|bib|bbl|ltx|dtx|def|cfg|clo|fd|tikz|pgf|aux|toc|out)):(\d+):\s*(.*)$/i;
  const pathRe = /^"?((?:[A-Za-z]:)?(?:\.{0,2}[\\/])?[^\s()"]*?\.[A-Za-z0-9_]+)"?/;
  const seen = new Set();
  const push = (arr, item) => {
    const key = `${item.level}|${item.file}|${item.line}|${item.message}`;
    if (seen.has(key)) return; seen.add(key); arr.push(item);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if ((m = fileLineRe.exec(line))) {
      const file = rel(m[1]);
      push(errors, { level: 'error', file, line: Number(m[2]), message: m[3], context: context(i) });
    } else if (line.startsWith('! ')) {
      let lineNo = null;
      for (let j = i + 1; j < Math.min(lines.length, i + 12); j++) { const l = /^l\.(\d+)/.exec(lines[j]); if (l) { lineNo = Number(l[1]); break; } }
      push(errors, { level: 'error', file: currentFile(), line: lineNo, message: line.slice(2), context: context(i) });
    } else if ((m = /^(?:(?:LaTeX|Package|Class|Module)\s*([\w-]*)\s*Warning|LaTeX Font Warning|pdfTeX warning(?: \([^)]*\))?)[:\s]\s*(.*)$/.exec(line))) {
      let msg = m[2] || line;
      const pkg = m[1];
      for (let j = i + 1; j < lines.length && j < i + 8; j++) {
        const l = lines[j];
        if (!l.trim()) break;
        if ((pkg && l.startsWith(`(${pkg})`)) || /^\s{4,}/.test(l) || /^\(Font\)/.test(l)) msg += ' ' + l.replace(/^\([\w-]+\)\s*/, '').trim();
        else break;
      }
      const ln = /on input line (\d+)/.exec(msg);
      push(warnings, { level: 'warning', file: currentFile(), line: ln ? Number(ln[1]) : null, message: msg.trim() });
    } else if ((m = /^((?:Over|Under)full \\[hv]box .*?)(?:in paragraph at lines (\d+)--\d+|in alignment at lines (\d+)--\d+|detected at line (\d+)|has occurred while \\output is active)?\s*$/.exec(line))) {
      const ln = m[2] || m[3] || m[4];
      push(typesetting, { level: 'typesetting', file: currentFile(), line: ln ? Number(ln) : null, message: line.trim() });
    }
    // Track which file TeX is currently reading via its "(file ... )" nesting.
    for (let k = 0; k < line.length; k++) {
      const c = line[k];
      if (c === '(') {
        const pm = pathRe.exec(line.slice(k + 1));
        if (pm && /[\\/.]/.test(pm[1]) && !/^\d/.test(pm[1])) { stack.push(pm[1]); k += pm[0].length; } else stack.push(null);
      } else if (c === ')') stack.pop();
    }
  }
  return { errors, warnings, typesetting };
}

// ---------------------------------------------------------------- SyncTeX

function parseSynctex(out) {
  const recs = []; let cur = null;
  for (const line of out.split(/\r?\n/)) {
    const m = /^(\w+):(.*)$/.exec(line.trim());
    if (!m) continue;
    const [, k, v] = m;
    if (k === 'Output' || (k === 'Page' && cur && 'Page' in cur) || (k === 'Input' && cur && 'Input' in cur)) { cur = {}; recs.push(cur); }
    if (!cur) { cur = {}; recs.push(cur); }
    cur[k] = v;
  }
  return recs.filter((r) => Object.keys(r).length > 1);
}

const normSlashes = (p) => String(p).replace(/\\/g, '/').replace(/\/\.\//g, '/');

/** Files TeX recorded in the .synctex.gz. These exact strings are what the synctex CLI matches on. */
function synctexInputs(dir, meta) {
  const gz = path.join(dir, BUILD, path.basename(meta.main).replace(/\.tex$/i, '.synctex.gz'));
  try {
    const txt = require('zlib').gunzipSync(fs.readFileSync(gz)).toString('utf8');
    return [...txt.matchAll(/^Input:\d+:(.*)$/gm)].map((m) => m[1].trim());
  } catch { return []; }
}

/** Map a TeX-recorded path to a project-relative path, tolerant of drive/virtualised prefixes. */
function recordedToProject(dir, mainDir, recorded, files) {
  const direct = toPosix(path.relative(dir, path.resolve(mainDir, recorded)));
  if (!direct.startsWith('..') && files.includes(direct)) return direct;
  const r = normSlashes(recorded).toLowerCase();
  let best = null;
  for (const f of files) if ((r === f.toLowerCase() || r.endsWith('/' + f.toLowerCase())) && (!best || f.length > best.length)) best = f;
  return best;
}

async function synctexForward(id, file, line, column) {
  const meta = await readMeta(id);
  const dir = projectDir(id);
  const mainDir = path.dirname(safePath(dir, meta.main));
  const pdf = path.join(dir, BUILD, path.basename(meta.main).replace(/\.tex$/i, '.pdf'));
  const rel = toPosix(path.relative(dir, safePath(dir, file)));
  const files = [rel];
  const inputs = synctexInputs(dir, meta).filter((r) => recordedToProject(dir, mainDir, r, files) === rel);
  for (const input of inputs.length ? inputs : [safePath(dir, file)]) {
    const r = await run('synctex', ['view', '-i', `${line}:${column || 0}:${input}`, '-o', pdf], { cwd: mainDir });
    const recs = parseSynctex(r.stdout).filter((x) => x.Page);
    if (recs.length) {
      const page = Number(recs[0].Page);
      return recs.filter((x) => Number(x.Page) === page).map((x) => ({
        page, h: Number(x.h), v: Number(x.v), width: Number(x.W), height: Number(x.H), x: Number(x.x), y: Number(x.y),
      }));
    }
  }
  return [];
}

async function synctexInverse(id, page, x, y) {
  const meta = await readMeta(id);
  const dir = projectDir(id);
  const mainDir = path.dirname(safePath(dir, meta.main));
  const pdf = path.join(dir, BUILD, path.basename(meta.main).replace(/\.tex$/i, '.pdf'));
  const r = await run('synctex', ['edit', '-o', `${page}:${x}:${y}:${pdf}`], { cwd: mainDir });
  const rec = parseSynctex(r.stdout).find((x) => x.Input);
  if (!rec) return null;
  const files = (await walk(dir)).filter((f) => f.type === 'file').map((f) => f.path);
  const file = recordedToProject(dir, mainDir, rec.Input, files);
  if (!file) return null;
  return { file, line: Number(rec.Line) || 1, column: Math.max(0, Number(rec.Column) || 0) };
}

// ---------------------------------------------------------------- symbols for autocomplete

async function projectSymbols(id) {
  const dir = projectDir(id);
  const files = await walk(dir);
  const labels = new Set(), cites = new Set(), commands = new Set();
  for (const f of files) {
    if (f.type !== 'file' || f.size > 4 * 1024 * 1024) continue;
    if (/\.(tex|sty|cls)$/i.test(f.path)) {
      const t = await fsp.readFile(path.join(dir, f.path), 'utf8').catch(() => '');
      for (const m of t.matchAll(/\\label\{([^}]+)\}/g)) labels.add(m[1]);
      for (const m of t.matchAll(/\\(?:re)?newcommand\*?\s*\{?\\([A-Za-z@]+)/g)) commands.add(m[1]);
      for (const m of t.matchAll(/\\DeclareMathOperator\*?\s*\{?\\([A-Za-z]+)/g)) commands.add(m[1]);
      for (const m of t.matchAll(/\\bibitem(?:\[[^\]]*\])?\{([^}]+)\}/g)) cites.add(m[1]);
    } else if (/\.bib$/i.test(f.path)) {
      const t = await fsp.readFile(path.join(dir, f.path), 'utf8').catch(() => '');
      for (const m of t.matchAll(/@(?!comment|string|preamble)\w+\s*\{\s*([^,\s]+)\s*,/gi)) cites.add(m[1]);
    }
  }
  return {
    labels: [...labels].sort(), cites: [...cites].sort(), commands: [...commands].sort(),
    files: files.filter((f) => f.type === 'file').map((f) => f.path),
  };
}

// ---------------------------------------------------------------- sharing with collaborators
// Collaborators reach the host through a second listener bound to all network interfaces. Every
// request on it is a "guest" request and must carry the project's invite token (set as a cookie by
// the /join link). The normal listener stays bound to localhost and is only used by the host.

let mainPort = null;
let shareServer = null;
let sharePort = null;
const tokenCookie = (id) => 'ol_' + sha1(id).slice(0, 16);

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function tokenMatches(given, expected) {
  if (!given || !expected || given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

async function guestCanAccess(req, id) {
  const meta = await readMeta(id).catch(() => null);
  return !!(meta && meta.share && meta.share.enabled && tokenMatches(parseCookies(req)[tokenCookie(id)], meta.share.token));
}

function listenOn(srv, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (e) => { srv.off('listening', onListening); reject(e); };
    const onListening = () => { srv.off('error', onError); resolve(srv.address().port); };
    srv.once('error', onError);
    srv.once('listening', onListening);
    srv.listen(port, host);
  });
}

async function ensureShareListener() {
  if (shareServer) return sharePort;
  const srv = http.createServer((req, res) => { req.isGuest = true; handle(req, res); });
  const wanted = process.env.OPENLEAF_SHARE_PORT ? Number(process.env.OPENLEAF_SHARE_PORT) : (mainPort ? mainPort + 1 : 0);
  const host = process.env.OPENLEAF_SHARE_HOST || '0.0.0.0';
  try { sharePort = await listenOn(srv, wanted, host); }
  catch (e) { if (e.code !== 'EADDRINUSE') throw e; sharePort = await listenOn(srv, 0, host); }
  shareServer = srv;
  console.log(`  Sharing enabled: collaborators connect on port ${sharePort}`);
  return sharePort;
}

async function stopShareListenerIfUnused() {
  if (!shareServer) return;
  if ((await listProjects()).some((p) => p.shared)) return;
  const srv = shareServer;
  shareServer = null; sharePort = null;
  srv.close();
  if (srv.closeAllConnections) srv.closeAllConnections();
}

function networkAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if ((a.family !== 'IPv4' && a.family !== 4) || a.internal || a.address.startsWith('169.254.')) continue;
      const [o1, o2] = a.address.split('.').map(Number);
      const tailscale = /tailscale/i.test(name) || (o1 === 100 && o2 >= 64 && o2 <= 127);
      const virtual = !tailscale && /vEthernet|Hyper-V|VirtualBox|vboxnet|VMware|WSL|docker|^br-|^veth|Loopback/i.test(name);
      out.push({ name, address: a.address, tailscale, virtual });
    }
  }
  return out.sort((x, y) => (x.virtual - y.virtual) || (x.tailscale - y.tailscale));
}

async function shareInfo(id) {
  const meta = await readMeta(id);
  const enabled = !!(meta.share && meta.share.enabled);
  const links = enabled && sharePort ? networkAddresses().map((a) => ({
    label: a.tailscale ? `Tailscale (${a.name})` : a.name,
    tailscale: a.tailscale, virtual: a.virtual,
    url: `http://${a.address}:${sharePort}/join/${encodeURIComponent(id)}/${meta.share.token}`,
  })) : [];
  return { enabled, port: sharePort, links };
}

function kickGuests(id) {
  const h = hubs.get(id);
  if (!h) return;
  for (const res of [...h.clients]) if (res.guest) res.end();
}

/** Decide whether this request may proceed. Throws an HttpError if not. */
async function authorize(req, pathname) {
  if (!req.isGuest) {
    // The host listener only answers to localhost names (blocks DNS-rebinding from web pages).
    const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
    if (host && !['localhost', '127.0.0.1', '[::1]'].includes(host)) throw new HttpError(403, 'Forbidden host');
    return;
  }
  if (!pathname.startsWith('/api/') || pathname === '/api/session') return; // static assets hold no project data
  const m = /^\/api\/projects\/([^/]+)(\/.*)?$/.exec(pathname);
  if (!m || m[1] === 'import') throw new HttpError(403, 'Only the host can do that');
  const id = decodeURIComponent(m[1]);
  const sub = m[2] || '';
  if ((sub === '' && req.method === 'DELETE') || /^\/(copy|reveal|share)$/.test(sub)) throw new HttpError(403, 'Only the host can do that');
  if (!(await guestCanAccess(req, id))) throw new HttpError(403, 'This invite link is no longer valid. Ask the host for a new one.');
}

const GUEST_PAGE = (title, text) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;background:#f4f5f7;color:#1f2329;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:16px}
div{background:#fff;border:1px solid #dfe2e7;border-radius:10px;padding:28px;max-width:440px;text-align:center}h1{font-size:19px;margin:0 0 8px}</style></head>
<body><div><h1>${title}</h1><p>${text}</p></div></body></html>`;

async function handleJoin(req, res, pathname) {
  const m = /^\/join\/([^/]+)\/([A-Za-z0-9_-]+)$/.exec(pathname);
  const id = m && decodeURIComponent(m[1]);
  const meta = id ? await readMeta(id).catch(() => null) : null;
  if (!meta || !meta.share || !meta.share.enabled || !tokenMatches(m[2], meta.share.token)) {
    return send(res, 403, GUEST_PAGE('Invite link not valid', 'This link has expired or sharing was turned off. Ask the host for a new link.'), { 'Content-Type': 'text/html; charset=utf-8' });
  }
  res.writeHead(302, {
    'Set-Cookie': `${tokenCookie(id)}=${encodeURIComponent(m[2])}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
    Location: `/project/${encodeURIComponent(id)}`, 'Cache-Control': 'no-store',
  });
  res.end();
}

// ---------------------------------------------------------------- HTTP routing

const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)\*?/g, (s, k) => { keys.push(k); return s.endsWith('*') ? '(.+)' : '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler });
};

route('GET', '/api/projects', async (req, res) => send(res, 200, await listProjects()));

route('POST', '/api/projects', async (req, res) => {
  const body = await readJson(req);
  send(res, 201, publicMeta(await createProject(body.name, body.template)));
});

route('POST', '/api/projects/import', async (req, res, p, url) => {
  const buf = await readBody(req);
  send(res, 201, publicMeta(await importZip(buf, url.searchParams.get('name'))));
});

route('GET', '/api/projects/:id', async (req, res, p) => {
  const meta = await readMeta(p.id);
  send(res, 200, { ...publicMeta(meta), files: await walk(projectDir(p.id)), dir: req.isGuest ? undefined : projectDir(p.id), guest: !!req.isGuest });
});

route('PATCH', '/api/projects/:id', async (req, res, p) => {
  const body = await readJson(req);
  const meta = await readMeta(p.id);
  if (typeof body.name === 'string' && body.name.trim()) meta.name = body.name.trim();
  if (typeof body.main === 'string') {
    if (!(await exists(safePath(projectDir(p.id), body.main)))) throw new HttpError(400, 'Main document does not exist');
    meta.main = body.main;
  }
  if (body.compiler && ENGINE_FLAG[body.compiler]) meta.compiler = body.compiler;
  await writeMeta(p.id, meta);
  broadcast(p.id, { type: 'meta', meta: publicMeta(meta), origin: req.headers['x-client-id'] });
  send(res, 200, publicMeta(meta));
});

route('DELETE', '/api/projects/:id', async (req, res, p) => {
  const dir = projectDir(p.id);
  await readMeta(p.id);
  const trash = path.join(PROJECTS_DIR, TRASH);
  await fsp.mkdir(trash, { recursive: true });
  const h = hubs.get(p.id); if (h && h.watcher) { h.watcher.close(); h.watcher = null; }
  await collab.closeProject(p.id);
  await fsp.rename(dir, path.join(trash, `${p.id}-${new Date().toISOString().replace(/[:.]/g, '-')}`));
  send(res, 200, { ok: true, movedToTrash: true });
});

route('POST', '/api/projects/:id/copy', async (req, res, p) => {
  const body = await readJson(req);
  const meta = await readMeta(p.id);
  const name = body.name || `${meta.name} (copy)`;
  const id = await uniqueDir(slugify(name));
  await copyDir(projectDir(p.id), path.join(PROJECTS_DIR, id));
  const { share: _share, ...copied } = meta;
  await writeMeta(id, { ...copied, name, created: Date.now() });
  send(res, 201, publicMeta(await readMeta(id)));
});

route('GET', '/api/projects/:id/file', async (req, res, p, url) => {
  const dir = projectDir(p.id);
  const rel = url.searchParams.get('path');
  const abs = safePath(dir, rel);
  const st = await fsp.stat(abs).catch(() => null);
  if (!st || !st.isFile()) throw new HttpError(404, 'File not found');
  const buf = st.size < 16 * 1024 * 1024 ? await fsp.readFile(abs) : null;
  if (buf && isTextFile(rel, buf)) {
    rememberWrite(p.id, toPosix(path.relative(dir, abs)), buf);
    return send(res, 200, { type: 'text', path: rel, content: buf.toString('utf8'), mtime: st.mtimeMs });
  }
  send(res, 200, { type: 'binary', path: rel, size: st.size, mtime: st.mtimeMs, url: `/api/projects/${encodeURIComponent(p.id)}/raw/${rel.split('/').map(encodeURIComponent).join('/')}` });
});

route('PUT', '/api/projects/:id/file', async (req, res, p, url) => {
  const dir = projectDir(p.id);
  const rel = url.searchParams.get('path');
  const abs = safePath(dir, rel, { forWrite: true });
  const buf = await readBody(req);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  const relN = toPosix(path.relative(dir, abs));
  rememberWrite(p.id, relN, buf);
  await fsp.writeFile(abs, buf);
  if (collab.isOpen(p.id, relN)) await collab.diskChanged(p.id, relN, buf.toString('utf8'));
  broadcast(p.id, { type: 'saved', path: relN, origin: req.headers['x-client-id'] });
  send(res, 200, { ok: true, mtime: Date.now() });
});

route('POST', '/api/projects/:id/upload', async (req, res, p, url) => {
  const dir = projectDir(p.id);
  const abs = safePath(dir, url.searchParams.get('path'), { forWrite: true });
  const buf = await readBody(req);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  const relN = toPosix(path.relative(dir, abs));
  rememberWrite(p.id, relN, buf);
  await fsp.writeFile(abs, buf);
  if (collab.isOpen(p.id, relN)) await collab.diskChanged(p.id, relN, buf.toString('utf8'));
  broadcast(p.id, { type: 'tree', origin: req.headers['x-client-id'] });
  broadcast(p.id, { type: 'saved', path: relN, origin: req.headers['x-client-id'] });
  send(res, 201, { ok: true, path: relN });
});

route('POST', '/api/projects/:id/folder', async (req, res, p) => {
  const body = await readJson(req);
  await fsp.mkdir(safePath(projectDir(p.id), body.path, { forWrite: true }), { recursive: true });
  broadcast(p.id, { type: 'tree', origin: req.headers['x-client-id'] });
  send(res, 201, { ok: true });
});

route('POST', '/api/projects/:id/rename', async (req, res, p) => {
  const body = await readJson(req);
  const dir = projectDir(p.id);
  const from = safePath(dir, body.from, { forWrite: true });
  const to = safePath(dir, body.to, { forWrite: true });
  if (await exists(to)) throw new HttpError(409, 'A file with that name already exists');
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await collab.flush(p.id);
  await fsp.rename(from, to);
  const meta = await readMeta(p.id);
  const fromRel = toPosix(path.relative(dir, from)), toRel = toPosix(path.relative(dir, to));
  await collab.rename(p.id, fromRel, toRel);
  if (meta.main === fromRel || meta.main.startsWith(fromRel + '/')) { meta.main = toRel + meta.main.slice(fromRel.length); await writeMeta(p.id, meta); }
  broadcast(p.id, { type: 'tree', renamed: { from: fromRel, to: toRel }, origin: req.headers['x-client-id'] });
  send(res, 200, { ok: true });
});

route('DELETE', '/api/projects/:id/file', async (req, res, p, url) => {
  const dir = projectDir(p.id);
  const abs = safePath(dir, url.searchParams.get('path'), { forWrite: true });
  // Deleted files go to the project trash rather than being destroyed.
  const trash = path.join(PROJECTS_DIR, TRASH, p.id);
  await fsp.mkdir(trash, { recursive: true });
  await collab.remove(p.id, toPosix(path.relative(dir, abs)));
  await fsp.rename(abs, path.join(trash, `${Date.now()}-${path.basename(abs)}`));
  broadcast(p.id, { type: 'tree', origin: req.headers['x-client-id'] });
  send(res, 200, { ok: true });
});

route('GET', '/api/projects/:id/raw/:path*', async (req, res, p) => {
  const abs = safePath(projectDir(p.id), decodeURIComponent(p.path));
  await sendFile(req, res, abs);
});

route('POST', '/api/projects/:id/compile', async (req, res, p) => {
  const origin = req.headers['x-client-id'];
  const result = await requestCompile(p.id, origin);
  broadcast(p.id, { type: 'compiled', origin, result: { ...result, log: undefined, stdout: undefined } });
  send(res, 200, result);
});

route('POST', '/api/projects/:id/compile/stop', async (req, res, p) => {
  const st = compiles.get(p.id);
  if (st && st.proc) { st.stopped = true; killTree(st.proc); }
  send(res, 200, { ok: true });
});

route('DELETE', '/api/projects/:id/cache', async (req, res, p) => {
  await fsp.rm(path.join(projectDir(p.id), BUILD), { recursive: true, force: true });
  send(res, 200, { ok: true });
});

route('GET', '/api/projects/:id/output.pdf', async (req, res, p, url) => {
  const meta = await readMeta(p.id);
  const pdf = path.join(projectDir(p.id), BUILD, path.basename(meta.main).replace(/\.tex$/i, '.pdf'));
  const headers = url.searchParams.has('download') ? { 'Content-Disposition': `attachment; filename="${slugify(meta.name)}.pdf"` } : {};
  await sendFile(req, res, pdf, headers);
});

route('GET', '/api/projects/:id/output.log', async (req, res, p) => {
  const meta = await readMeta(p.id);
  await sendFile(req, res, path.join(projectDir(p.id), BUILD, path.basename(meta.main).replace(/\.tex$/i, '.log')), { 'Content-Type': 'text/plain; charset=utf-8' });
});

route('GET', '/api/projects/:id/synctex/forward', async (req, res, p, url) => {
  const q = url.searchParams;
  send(res, 200, await synctexForward(p.id, q.get('file'), Number(q.get('line')) || 1, Number(q.get('column')) || 0));
});

route('GET', '/api/projects/:id/synctex/inverse', async (req, res, p, url) => {
  const q = url.searchParams;
  send(res, 200, (await synctexInverse(p.id, Number(q.get('page')), Number(q.get('x')), Number(q.get('y')))) || {});
});

route('GET', '/api/projects/:id/symbols', async (req, res, p) => send(res, 200, await projectSymbols(p.id)));

route('GET', '/api/projects/:id/zip', async (req, res, p) => {
  const meta = await readMeta(p.id);
  const dir = projectDir(p.id);
  const tmp = path.join(os.tmpdir(), `openleaf-${Date.now()}.zip`);
  const r = await run(tarBinary(), ['-a', '-c', '-f', tmp, `--exclude=${BUILD}`, `--exclude=${META}`, '-C', dir, '.']);
  if (r.code !== 0) throw new HttpError(500, `zip failed: ${r.stderr}`);
  await sendFile(req, res, tmp, { 'Content-Disposition': `attachment; filename="${slugify(meta.name)}.zip"`, 'Content-Type': 'application/zip' });
  res.on('close', () => fsp.unlink(tmp).catch(() => {}));
});

route('POST', '/api/projects/:id/reveal', async (req, res, p) => {
  const dir = projectDir(p.id);
  const cmd = IS_WIN ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  spawn(cmd, [dir], { detached: true, stdio: 'ignore' }).unref();
  send(res, 200, { ok: true });
});

route('GET', '/api/projects/:id/events', async (req, res, p, url) => {
  await readMeta(p.id);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  res.write('retry: 2000\n\n');
  const h = hub(p.id);
  const q = url.searchParams;
  const client = String(q.get('client') || crypto.randomBytes(6).toString('hex')).slice(0, 64);
  res.guest = !!req.isGuest;
  h.clients.add(res);
  res.write(`data: ${JSON.stringify({ type: 'hello', serverId: SERVER_ID, guest: !!req.isGuest })}\n\n`);
  h.presence.set(client, {
    client, guest: !!req.isGuest, file: String(q.get('file') || '').slice(0, 500),
    name: String(q.get('name') || 'Anonymous').slice(0, 60), color: /^#[0-9a-f]{6}$/i.test(q.get('color') || '') ? q.get('color') : '#888888',
  });
  broadcastPresence(p.id);
  startWatching(p.id);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping); h.clients.delete(res); stopWatchingIfIdle(p.id);
    h.presence.delete(client);
    broadcastPresence(p.id);
    collab.disconnect(p.id, client).catch(() => {});
  });
});

route('GET', '/api/session', async (req, res) => send(res, 200, { guest: !!req.isGuest }));

route('GET', '/api/projects/:id/share', async (req, res, p) => send(res, 200, await shareInfo(p.id)));

route('POST', '/api/projects/:id/share', async (req, res, p) => {
  const body = await readJson(req);
  const meta = await readMeta(p.id);
  const share = meta.share || {};
  if (body.rotate || !share.token) { share.token = crypto.randomBytes(18).toString('base64url'); kickGuests(p.id); }
  if (typeof body.enabled === 'boolean') {
    share.enabled = body.enabled;
    if (!body.enabled) kickGuests(p.id);
  }
  meta.share = share;
  await writeMeta(p.id, meta);
  if (share.enabled) await ensureShareListener(); else await stopShareListenerIfUnused();
  broadcast(p.id, { type: 'meta', meta: publicMeta(meta), origin: req.headers['x-client-id'] });
  send(res, 200, await shareInfo(p.id));
});

// ---- collaboration (Yjs over HTTP + SSE)
route('POST', '/api/projects/:id/collab/join', async (req, res, p) => {
  const body = await readJson(req);
  const rel = toPosix(path.relative(projectDir(p.id), safePath(projectDir(p.id), body.path)));
  send(res, 200, await collab.join(p.id, rel, body.stateVector));
});

route('POST', '/api/projects/:id/collab/update', async (req, res, p) => {
  const body = await readJson(req);
  await collab.update(p.id, body.path, body.epoch, body.update, req.headers['x-client-id']);
  send(res, 200, { ok: true });
});

route('POST', '/api/projects/:id/collab/awareness', async (req, res, p) => {
  const body = await readJson(req);
  await collab.awareness(p.id, body.path, body.epoch, body.update, req.headers['x-client-id']);
  send(res, 200, { ok: true });
});

route('POST', '/api/projects/:id/presence', async (req, res, p) => {
  const body = await readJson(req);
  const h = hub(p.id);
  const me = h.presence.get(req.headers['x-client-id']);
  if (me) {
    if (typeof body.file === 'string') me.file = body.file.slice(0, 500);
    if (typeof body.name === 'string' && body.name.trim()) me.name = body.name.trim().slice(0, 60);
    if (/^#[0-9a-f]{6}$/i.test(body.color || '')) me.color = body.color;
    broadcastPresence(p.id);
  }
  send(res, 200, { ok: true });
});

route('GET', '/api/health', async (req, res) => {
  const which = async (bin) => (await run(bin, ['--version'])).code === 0;
  send(res, 200, { latexmk: await which('latexmk'), projectsDir: PROJECTS_DIR });
});

// Libraries are vendored into public/vendor (scripts/vendor.js); public/ serves everything.
const STATIC_ROOT = path.join(ROOT, 'public');

async function handle(req, res) {
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); } catch { return send(res, 400, 'Bad URL'); }
  const pathname = url.pathname;
  try {
    if (pathname.startsWith('/join/')) return await handleJoin(req, res, pathname);
    await authorize(req, pathname);
    if (pathname.startsWith('/api/')) {
      for (const r of routes) {
        if (r.method !== req.method && !(req.method === 'HEAD' && r.method === 'GET')) continue;
        const m = r.re.exec(pathname);
        if (!m) continue;
        const params = {};
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        if (r.keys.includes('path')) params.path = m[r.keys.indexOf('path') + 1];
        return await r.handler(req, res, params, url);
      }
      return send(res, 404, { error: 'Unknown API route' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    if (pathname === '/project' || pathname.startsWith('/project/')) return sendFile(req, res, path.join(ROOT, 'public', 'editor.html'));
    if (req.isGuest && (pathname === '/' || pathname === '/index.html')) {
      return send(res, 403, GUEST_PAGE('OpenLeaf', 'Open the invite link the host sent you to join their project.'), { 'Content-Type': 'text/html; charset=utf-8' });
    }
    const rel = decodeURIComponent(pathname.slice(1)) || 'index.html';
    const abs = path.resolve(STATIC_ROOT, rel);
    if (!abs.startsWith(STATIC_ROOT)) return send(res, 403, 'Forbidden');
    return sendFile(req, res, abs, { 'Cache-Control': pathname.startsWith('/vendor/') ? 'max-age=86400' : 'no-cache' });
  } catch (e) {
    const status = e.status || (e instanceof CollabError ? 409 : 500);
    if (status === 500) console.error(e);
    if (!res.headersSent) send(res, status, { error: e.message });
    else res.end();
  }
}

const server = http.createServer(handle);

/** Start listening. Resolves with the port actually bound (pass port 0 for any free port). */
async function startServer({ port = PORT, host = HOST } = {}) {
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
  mainPort = await listenOn(server, port, host);
  if ((await listProjects()).some((p) => p.shared)) {
    await ensureShareListener().catch((e) => console.warn(`[share] could not start sharing: ${e.message}`));
  }
  return mainPort;
}

if (require.main === module) {
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { shutdown().finally(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); });
  }
  startServer().then((port) => {
    console.log(`
  OpenLeaf is running at  http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${port}`);
    console.log(`  Projects folder:        ${PROJECTS_DIR}
`);
    if (CLI_ARGS.includes('--open')) {
      const url = `http://localhost:${port}`;
      const [cmd, args] = IS_WIN ? ['cmd', ['/c', 'start', '', url]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
      spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    }
  }, (e) => {
    if (e.code === 'EADDRINUSE') console.error(`Port ${PORT} is in use. Set PORT=xxxx to use another port.`);
    else console.error(e);
    process.exit(1);
  });
}

/** Save every shared document to disk; call before the process exits. */
const shutdown = () => collab.flushAll();

/** Stop listening and release everything (used by the test suite). */
async function stopServer() {
  for (const h of hubs.values()) {
    for (const res of h.clients) res.end();
    if (h.watcher) { h.watcher.close(); h.watcher = null; }
  }
  await collab.closeAll();
  if (shareServer) { shareServer.close(); if (shareServer.closeAllConnections) shareServer.closeAllConnections(); shareServer = null; sharePort = null; }
  await new Promise((resolve) => { server.close(() => resolve()); if (server.closeAllConnections) server.closeAllConnections(); });
}

module.exports = { startServer, stopServer, shutdown, parseLog, PROJECTS_DIR };
