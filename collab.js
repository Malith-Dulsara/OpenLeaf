'use strict';
/*
 * Real-time collaboration for OpenLeaf.
 *
 * Every text file someone has open gets one shared Yjs document on the server. Clients send their
 * edits as Yjs updates over HTTP POST and receive everyone else's over the project's Server-Sent
 * Events stream. The server writes the merged text back to disk (debounced), so latexmk, the file
 * watcher and external editors keep working on plain files. Edits made on disk by other programs are
 * merged into the shared document as a minimal diff.
 *
 * Each server-side document has an `epoch`. If the server restarts (or a document is reloaded from
 * disk), the epoch changes and clients re-join instead of merging stale Yjs history, which would
 * otherwise duplicate text.
 */
const crypto = require('crypto');
const { Y, Awareness, encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates } = require('./lib/yjs.cjs');

const toB64 = (u8) => Buffer.from(u8).toString('base64');
const fromB64 = (s) => new Uint8Array(Buffer.from(String(s || ''), 'base64'));

// Shared documents always use \n; the editor (CodeMirror) indexes text that way too.
const normalizeEol = (t) => t.replace(/\r\n?/g, '\n');

/** Replace the text of `ytext` with `next` using one delete + one insert around the changed middle. */
function applyTextDiff(ytext, next, origin) {
  const old = ytext.toString();
  if (old === next) return false;
  let start = 0;
  const min = Math.min(old.length, next.length);
  while (start < min && old.charCodeAt(start) === next.charCodeAt(start)) start++;
  let endOld = old.length, endNew = next.length;
  while (endOld > start && endNew > start && old.charCodeAt(endOld - 1) === next.charCodeAt(endNew - 1)) { endOld--; endNew--; }
  // never split a surrogate pair
  if (start > 0 && start < old.length && /[\uD800-\uDBFF]/.test(old[start - 1])) start--;
  ytext.doc.transact(() => {
    if (endOld > start) ytext.delete(start, endOld - start);
    if (endNew > start) ytext.insert(start, next.slice(start, endNew));
  }, origin);
  return true;
}

class CollabError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/**
 * @param {object} io
 * @param {(projectId: string, msg: object) => void} io.broadcast  send an event to every client of a project
 * @param {(projectId: string, path: string) => Promise<string>} io.readText
 * @param {(projectId: string, path: string, text: string) => Promise<void>} io.writeText
 */
function createCollab({ broadcast, readText, writeText }) {
  const docs = new Map(); // `${project}\0${path}` -> Promise<Entry>
  const key = (id, p) => `${id}\u0000${p}`;

  function load(id, p) {
    const k = key(id, p);
    const promise = (async () => {
      const raw = await readText(id, p);
      const ydoc = new Y.Doc();
      const ytext = ydoc.getText('content');
      ytext.insert(0, normalizeEol(raw));
      const awareness = new Awareness(ydoc);
      awareness.setLocalState(null); // the server itself is not a participant
      const e = {
        id, path: p, ydoc, ytext, awareness,
        epoch: crypto.randomBytes(8).toString('hex'),
        eol: raw.includes('\r\n') ? '\r\n' : '\n', // keep the file's own line endings on disk
        dirty: false, timer: null, writing: Promise.resolve(),
        owners: new Map(), // client connection id -> Set<awareness clientID>
      };
      ydoc.on('update', (update, origin) => {
        broadcast(e.id, { type: 'y', path: e.path, epoch: e.epoch, update: toB64(update), origin: typeof origin === 'string' ? origin : null });
        if (origin !== 'disk') schedulePersist(e);
      });
      awareness.on('update', ({ added, updated, removed }, origin) => {
        if (typeof origin === 'string' && origin !== 'disconnect' && origin !== 'timeout') {
          if (!e.owners.has(origin)) e.owners.set(origin, new Set());
          for (const c of [...added, ...updated]) e.owners.get(origin).add(c);
        }
        const changed = [...added, ...updated, ...removed];
        broadcast(e.id, { type: 'aw', path: e.path, epoch: e.epoch, update: toB64(encodeAwarenessUpdate(awareness, changed)), origin: typeof origin === 'string' ? origin : null });
      });
      return e;
    })();
    docs.set(k, promise);
    promise.catch(() => { if (docs.get(k) === promise) docs.delete(k); });
    return promise;
  }

  const getDoc = (id, p) => docs.get(key(id, p)) || load(id, p);

  async function loaded(id, p) {
    const pr = docs.get(key(id, p));
    return pr ? pr.catch(() => null) : null;
  }

  function schedulePersist(e) {
    e.dirty = true;
    clearTimeout(e.timer);
    e.timer = setTimeout(() => persist(e), 300);
  }

  function persist(e) {
    clearTimeout(e.timer);
    e.timer = null;
    if (!e.dirty) return e.writing;
    e.dirty = false;
    const text = e.eol === '\n' ? e.ytext.toString() : e.ytext.toString().replace(/\n/g, e.eol);
    const target = { id: e.id, path: e.path };
    e.writing = e.writing.then(() => writeText(target.id, target.path, text)).catch((err) => {
      console.warn(`[collab] could not save ${target.path}: ${err.message}`);
      e.dirty = true;
    });
    return e.writing;
  }

  async function entriesOf(id) {
    const out = [];
    for (const pr of docs.values()) {
      const e = await pr.catch(() => null);
      if (e && e.id === id) out.push(e);
    }
    return out;
  }

  function checkEpoch(e, epoch) {
    if (!e || e.epoch !== epoch) throw new CollabError(409, 'Document was reloaded; re-join');
  }

  function drop(e) {
    clearTimeout(e.timer);
    e.awareness.destroy();
    e.ydoc.destroy();
    docs.delete(key(e.id, e.path));
  }

  return {
    /** Join a document: returns the full state (or the diff for a given state vector) plus current cursors. */
    async join(id, p, stateVector) {
      const e = await getDoc(id, p);
      const sv = stateVector ? fromB64(stateVector) : undefined;
      return {
        epoch: e.epoch,
        update: toB64(Y.encodeStateAsUpdate(e.ydoc, sv)),
        awareness: toB64(encodeAwarenessUpdate(e.awareness, [...e.awareness.getStates().keys()])),
      };
    },

    async update(id, p, epoch, update, conn) {
      const e = await loaded(id, p);
      checkEpoch(e, epoch);
      Y.applyUpdate(e.ydoc, fromB64(update), conn || 'remote');
    },

    async awareness(id, p, epoch, update, conn) {
      const e = await loaded(id, p);
      checkEpoch(e, epoch);
      applyAwarenessUpdate(e.awareness, fromB64(update), conn || 'remote');
    },

    /** A client closed its event stream: remove its cursors everywhere in the project. */
    async disconnect(id, conn) {
      for (const e of await entriesOf(id)) {
        const ids = e.owners.get(conn);
        e.owners.delete(conn);
        if (ids && ids.size) removeAwarenessStates(e.awareness, [...ids], 'disconnect');
      }
    },

    /** The file changed on disk (external editor, upload, …): merge it into the live document. */
    async diskChanged(id, p, text) {
      const e = await loaded(id, p);
      if (e) applyTextDiff(e.ytext, normalizeEol(text), 'disk');
    },

    isOpen: (id, p) => docs.has(key(id, p)),

    /** Write every pending change of a project to disk (called before compiling). */
    async flush(id) {
      await Promise.all((await entriesOf(id)).map((e) => persist(e)));
    },

    /** Call after the file was renamed on disk; pending edits are then saved under the new name. */
    async rename(id, from, to) {
      for (const e of await entriesOf(id)) {
        if (e.path !== from && !e.path.startsWith(from + '/')) continue;
        docs.delete(key(id, e.path));
        e.path = to + e.path.slice(from.length);
        docs.set(key(id, e.path), Promise.resolve(e));
      }
    },

    async remove(id, p) {
      for (const e of await entriesOf(id)) if (e.path === p || e.path.startsWith(p + '/')) drop(e);
    },

    /** Write every pending change of every project (called on shutdown). */
    async flushAll() {
      const all = await Promise.all([...docs.values()].map((pr) => pr.catch(() => null)));
      await Promise.all(all.filter(Boolean).map((e) => persist(e)));
    },

    /** Save and drop every document (server shutdown). */
    async closeAll() {
      const all = await Promise.all([...docs.values()].map((pr) => pr.catch(() => null)));
      for (const e of all.filter(Boolean)) { await persist(e); drop(e); }
    },

    async closeProject(id) {
      for (const e of await entriesOf(id)) { await persist(e); drop(e); }
    },
  };
}

module.exports = { createCollab, applyTextDiff, CollabError };
