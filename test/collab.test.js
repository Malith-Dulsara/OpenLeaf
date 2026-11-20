'use strict';
// End-to-end tests for real-time collaboration and invite-link access control.
// Starts a real OpenLeaf server on a free port with a temporary projects folder. No LaTeX needed.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openleaf-test-'));
process.env.OPENLEAF_PROJECTS = projectsDir;
process.env.OPENLEAF_SHARE_HOST = '127.0.0.1'; // keep the share listener local while testing
process.env.OPENLEAF_SHARE_PORT = '0';

const { startServer, stopServer } = require('../server.js');
const { Y } = require('../lib/yjs.cjs');

const b64 = (u) => Buffer.from(u).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(50); }
  return false;
};

let origin, project, projectDir;

async function api(method, url, body, headers = {}) {
  const res = await fetch(origin + url, {
    method, headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual',
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}

/** A minimal collaborator: joins a file over HTTP and listens to the event stream. */
async function collaborator(name, file) {
  const id = `${name}-${Math.random().toString(36).slice(2, 8)}`;
  const doc = new Y.Doc();
  const text = doc.getText('content');
  const ctrl = new AbortController();
  const events = await fetch(`${origin}/api/projects/${project}/events?client=${id}&name=${name}`, { signal: ctrl.signal });
  const people = new Set();
  (async () => {
    const dec = new TextDecoder(); let buf = '';
    try {
      for await (const chunk of events.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
          buf = buf.slice(i + 2);
          if (!line) continue;
          const msg = JSON.parse(line.slice(6));
          if (msg.type === 'y' && msg.path === file && msg.origin !== id) Y.applyUpdate(doc, unb64(msg.update), 'remote');
          if (msg.type === 'presence') { people.clear(); msg.users.forEach((u) => people.add(u.name)); }
        }
      }
    } catch { /* closed */ }
  })();
  const joined = (await api('POST', `/api/projects/${project}/collab/join`, { path: file }, { 'X-Client-Id': id })).data;
  Y.applyUpdate(doc, unb64(joined.update), 'remote');
  doc.on('update', (update, o) => {
    if (o !== 'remote') api('POST', `/api/projects/${project}/collab/update`, { path: file, epoch: joined.epoch, update: b64(update) }, { 'X-Client-Id': id });
  });
  return { text, people, epoch: joined.epoch, close: () => ctrl.abort() };
}

before(async () => {
  const port = await startServer({ port: 0, host: '127.0.0.1' });
  origin = `http://127.0.0.1:${port}`;
  const created = await api('POST', '/api/projects', { name: 'Collab Test', template: 'paper' });
  assert.equal(created.status, 201);
  project = created.data.id;
  projectDir = path.join(projectsDir, project);
});

after(async () => {
  await stopServer();
  fs.rmSync(projectsDir, { recursive: true, force: true });
});

test('simultaneous edits from two people merge and reach the disk', async () => {
  const file = 'sections/introduction.tex';
  const alice = await collaborator('Alice', file);
  const bob = await collaborator('Bob', file);
  assert.ok(await until(() => alice.people.has('Bob')), 'Alice sees Bob online');

  alice.text.insert(0, '% Alice was here\n');
  bob.text.insert(0, '% Bob was here\n');
  alice.text.insert(alice.text.length, 'A-end.');
  bob.text.insert(bob.text.length, 'B-end.');

  assert.ok(await until(() => alice.text.toString() === bob.text.toString() && alice.text.toString().includes('B-end.') && bob.text.toString().includes('A-end.')), 'documents converge');
  for (const s of ['Alice was here', 'Bob was here', 'A-end.', 'B-end.']) assert.ok(alice.text.toString().includes(s), `kept: ${s}`);
  assert.ok(await until(() => fs.readFileSync(path.join(projectDir, file), 'utf8') === alice.text.toString()), 'disk matches');
  alice.close(); bob.close();
});

test('edits made on disk by another program are merged into the live document', async () => {
  const file = 'main.tex';
  const alice = await collaborator('Alice', file);
  // the file watcher only runs while someone is connected, give it a moment to start
  await sleep(300);
  const disk = fs.readFileSync(path.join(projectDir, file), 'utf8');
  fs.writeFileSync(path.join(projectDir, file), disk.replace('\\section{Method}', '\\section{Methods}'));
  assert.ok(await until(() => alice.text.toString().includes('\\section{Methods}')), 'external edit arrived');
  alice.close();
});

test('Windows line endings are kept on disk', async () => {
  fs.writeFileSync(path.join(projectDir, 'crlf.tex'), 'one\r\ntwo\r\n');
  const c = await collaborator('Alice', 'crlf.tex');
  assert.ok(!c.text.toString().includes('\r'), 'shared text uses \\n');
  c.text.insert(c.text.toString().indexOf('two'), 'inserted\n');
  assert.ok(await until(() => fs.readFileSync(path.join(projectDir, 'crlf.tex'), 'utf8') === 'one\r\ninserted\r\ntwo\r\n'));
  c.close();
});

test('updates for a stale document version are rejected', async () => {
  const r = await api('POST', `/api/projects/${project}/collab/update`, { path: 'main.tex', epoch: 'stale', update: '' });
  assert.equal(r.status, 409);
});

test('invite links: guests need a valid token and cannot do host-only actions', async () => {
  const shared = await api('POST', `/api/projects/${project}/share`, { enabled: true });
  assert.equal(shared.status, 200);
  assert.ok(shared.data.enabled && shared.data.port);
  const token = (shared.data.links[0] || { url: '' }).url.split('/').pop()
    || JSON.parse(fs.readFileSync(path.join(projectDir, '.openleaf.json'), 'utf8')).share.token;
  const guest = `http://127.0.0.1:${shared.data.port}`;
  const get = (url, cookie, method = 'GET') => fetch(guest + url, { method, headers: cookie ? { Cookie: cookie } : {}, redirect: 'manual' });

  assert.equal((await api('GET', `/api/projects/${project}`)).data.share, undefined, 'token never sent to clients');
  assert.equal((await get(`/api/projects/${project}`)).status, 403, 'no invite');
  assert.equal((await get('/')).status, 403, 'guests cannot see the project list page');

  const join = await get(`/join/${project}/${token}`);
  assert.equal(join.status, 302);
  const cookie = join.headers.get('set-cookie').split(';')[0];
  assert.equal((await get(`/api/projects/${project}`, cookie)).status, 200, 'invite works');
  assert.equal((await get('/api/projects', cookie)).status, 403, 'cannot list other projects');
  assert.equal((await get(`/api/projects/${project}`, cookie, 'DELETE')).status, 403, 'cannot delete');
  assert.equal((await get(`/api/projects/${project}/reveal`, cookie, 'POST')).status, 403, 'cannot open folders');
  assert.equal((await get(`/api/projects/${project}/share`, cookie)).status, 403, 'cannot change sharing');

  await api('POST', `/api/projects/${project}/share`, { rotate: true });
  assert.equal((await get(`/api/projects/${project}`, cookie)).status, 403, 'old link stops working after reset');
  await api('POST', `/api/projects/${project}/share`, { enabled: false });
});

test('the host listener only answers to localhost names', async () => {
  // fetch() refuses to set Host, so use a raw request (this is what a DNS-rebinding page would send)
  const status = await new Promise((resolve, reject) => {
    const u = new URL(`${origin}/api/projects`);
    require('node:http').get({ hostname: u.hostname, port: u.port, path: u.pathname, headers: { Host: 'evil.example' } }, (res) => {
      res.resume(); resolve(res.statusCode);
    }).on('error', reject);
  });
  assert.equal(status, 403);
});
