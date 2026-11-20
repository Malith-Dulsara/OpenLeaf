/*
 * Browser side of OpenLeaf's real-time collaboration.
 *
 * A SharedFile keeps one CodeMirror document in sync with the server's Yjs document for that file:
 * local edits become Yjs updates (POSTed in small batches), remote updates arrive through the
 * project's event stream and are applied to CodeMirror as minimal edits. Cursor positions travel
 * as Yjs "awareness" state, stored as relative positions so they stay attached to the right text
 * while others type.
 */
import { Y, Awareness, encodeAwarenessUpdate, applyAwarenessUpdate } from '/vendor/yjs/yjs.mjs';

const CM = window.CodeMirror;

const toB64 = (u8) => {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromB64 = (b64) => {
  const s = atob(b64 || '');
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
};

export class SharedFile {
  /**
   * @param {object} o
   * @param {string} o.base       project API base URL
   * @param {string} o.path       project-relative file path
   * @param {Function} o.api      UI.api (adds the client id header)
   * @param {{name:string,color:string}} o.user
   * @param {string|null} o.mode  CodeMirror mode
   * @param {Function} o.onChange called after any text change (local or remote) with `remote` flag
   * @param {Function} o.onCursors called when collaborators' cursors change
   * @param {Function} o.onStatus  called when the sync state changes
   */
  constructor(o) {
    Object.assign(this, { base: o.base, path: o.path, api: o.api, user: o.user, onChange: o.onChange, onCursors: o.onCursors, onStatus: o.onStatus });
    this.cmDoc = null;
    this.mode = o.mode;
    this.epoch = null;
    this.queue = [];            // local Yjs updates not yet sent
    this.inflight = null;       // promise of the POST in progress
    this.error = null;
    this.backlog = [];          // remote messages that arrived before join finished
    this.joining = null;
    this.destroyed = false;
    this.cursor = null;
  }

  get pending() { return this.queue.length > 0 || !!this.inflight; }

  /** Join (or re-join) the server document. Local edits that were never acknowledged are kept. */
  async join() {
    if (this.joining) return this.joining;
    this.joining = (async () => {
      const unsentText = this.cmDoc && this.pending ? this.cmDoc.getValue() : null;
      const r = await this.api('POST', `${this.base}/collab/join`, { path: this.path });
      this.teardownYjs();
      this.epoch = r.epoch;
      this.queue = [];
      const ydoc = new Y.Doc();
      const ytext = ydoc.getText('content');
      Y.applyUpdate(ydoc, fromB64(r.update), 'server');
      this.ydoc = ydoc; this.ytext = ytext;
      this.undo = new Y.UndoManager(ytext, { trackedOrigins: new Set([this]), captureTimeout: 600 });

      const text = ytext.toString();
      if (!this.cmDoc) {
        this.cmDoc = CM.Doc(text, this.mode);
        this.cmDoc.on('change', (_d, ch) => this.onCmChange(ch));
      } else {
        this.replaceCmText(text);
      }

      ytext.observe((event, tr) => {
        if (tr.origin === this) return; // our own typing is already in CodeMirror
        this.applyDelta(event.delta);
        this.onChange && this.onChange(tr.origin !== this.undo); // undo/redo are our own edits

      });
      ydoc.on('update', (update, origin) => {
        if (origin === this || origin === this.undo) this.enqueue(update);
      });

      this.awareness = new Awareness(ydoc);
      this.awareness.setLocalState({ user: this.user, cursor: null });
      this.awareness.on('update', ({ added, updated, removed }, origin) => {
        if (origin === 'local') this.sendAwareness();
        else if (added.length || updated.length || removed.length) this.onCursors && this.onCursors();
      });
      if (r.awareness) applyAwarenessUpdate(this.awareness, fromB64(r.awareness), 'server');

      // re-apply local edits the server never received (e.g. it restarted mid-edit)
      if (unsentText !== null && unsentText !== text) this.replaceCmText(unsentText, true);

      for (const m of this.backlog.splice(0)) this.receive(m);
      this.error = null;
      this.status();
      this.onCursors && this.onCursors();
    })().finally(() => { this.joining = null; });
    return this.joining;
  }

  teardownYjs() {
    if (this.awareness) this.awareness.destroy();
    if (this.undo) this.undo.destroy();
    if (this.ydoc) this.ydoc.destroy();
    this.awareness = this.undo = this.ydoc = this.ytext = null;
  }

  destroy() {
    this.destroyed = true;
    clearTimeout(this.flushTimer); clearTimeout(this.awTimer);
    this.teardownYjs();
  }

  // ---------------------------------------------------------------- CodeMirror <-> Yjs

  onCmChange(change) {
    if (change.origin === 'remote' || !this.ytext) return;
    const doc = this.cmDoc;
    const index = doc.indexFromPos(change.from);
    const removed = change.removed.join('\n').length;
    const inserted = change.text.join('\n');
    this.ydoc.transact(() => {
      if (removed) this.ytext.delete(index, removed);
      if (inserted) this.ytext.insert(index, inserted);
    }, this);
    this.onChange && this.onChange(false);
  }

  applyDelta(delta) {
    const doc = this.cmDoc;
    const run = () => {
      let index = 0;
      for (const op of delta) {
        if (op.retain) index += op.retain;
        else if (op.insert) {
          const text = typeof op.insert === 'string' ? op.insert : '';
          doc.replaceRange(text, doc.posFromIndex(index), undefined, 'remote');
          index += text.length;
        } else if (op.delete) {
          doc.replaceRange('', doc.posFromIndex(index), doc.posFromIndex(index + op.delete), 'remote');
        }
      }
    };
    const ed = doc.getEditor && doc.getEditor();
    ed ? ed.operation(run) : run();
  }

  /** Replace CodeMirror's text with a minimal edit. `asLocal` also records it as our own Yjs change. */
  replaceCmText(next, asLocal = false) {
    const doc = this.cmDoc;
    const old = doc.getValue();
    if (old === next) return;
    let start = 0;
    const min = Math.min(old.length, next.length);
    while (start < min && old.charCodeAt(start) === next.charCodeAt(start)) start++;
    let endOld = old.length, endNew = next.length;
    while (endOld > start && endNew > start && old.charCodeAt(endOld - 1) === next.charCodeAt(endNew - 1)) { endOld--; endNew--; }
    doc.replaceRange(next.slice(start, endNew), doc.posFromIndex(start), doc.posFromIndex(endOld), asLocal ? '+input' : 'remote');
  }

  // ---------------------------------------------------------------- sending

  enqueue(update) {
    this.queue.push(update);
    this.status();
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flush(), 40);
  }

  /** Send everything queued; resolves once the server has it. */
  async flush() {
    clearTimeout(this.flushTimer);
    if (this.inflight) { await this.inflight.catch(() => {}); return this.queue.length ? this.flush() : undefined; }
    if (!this.queue.length || !this.ydoc) return;
    const updates = this.queue.splice(0);
    const merged = updates.length === 1 ? updates[0] : Y.mergeUpdates(updates);
    this.inflight = this.api('POST', `${this.base}/collab/update`, { path: this.path, epoch: this.epoch, update: toB64(merged) });
    this.status();
    try {
      await this.inflight;
      this.error = null;
    } catch (e) {
      this.inflight = null;
      if (/re-join|reloaded/i.test(e.message)) {
        this.queue.unshift(merged); // keeps `pending` true so join() re-applies our text
        await this.join();
      } else {
        this.queue.unshift(merged);
        this.error = e.message;
        clearTimeout(this.flushTimer);
        this.flushTimer = setTimeout(() => this.flush(), 2000);
      }
    } finally {
      this.inflight = null;
      this.status();
    }
    if (this.queue.length) return this.flush();
  }

  status() { this.onStatus && this.onStatus(this); }

  // ---------------------------------------------------------------- receiving

  /** Handle an event-stream message ({type:'y'|'aw', epoch, update}) for this file. */
  receive(msg) {
    if (this.joining || !this.ydoc) { this.backlog.push(msg); return; }
    if (msg.epoch !== this.epoch) { this.join().catch(() => {}); return; }
    if (msg.type === 'y') Y.applyUpdate(this.ydoc, fromB64(msg.update), 'server');
    else if (msg.type === 'aw') applyAwarenessUpdate(this.awareness, fromB64(msg.update), 'server');
  }

  // ---------------------------------------------------------------- cursors

  setCursor(anchorIndex, headIndex) {
    if (!this.awareness) return;
    const rel = (i) => Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(this.ytext, i));
    this.awareness.setLocalStateField('cursor', anchorIndex === null ? null : { anchor: rel(anchorIndex), head: rel(headIndex) });
  }

  setUser(user) {
    this.user = user;
    if (this.awareness) this.awareness.setLocalStateField('user', user);
  }

  sendAwareness() {
    clearTimeout(this.awTimer);
    this.awTimer = setTimeout(() => {
      if (!this.awareness) return;
      const update = encodeAwarenessUpdate(this.awareness, [this.ydoc.clientID]);
      this.api('POST', `${this.base}/collab/awareness`, { path: this.path, epoch: this.epoch, update: toB64(update) }).catch(() => {});
    }, 60);
  }

  /** Collaborators' cursors as absolute character indexes. */
  remoteCursors() {
    if (!this.awareness) return [];
    const out = [];
    const abs = (json) => {
      const pos = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(json), this.ydoc);
      return pos && pos.type === this.ytext ? pos.index : null;
    };
    for (const [clientID, st] of this.awareness.getStates()) {
      if (clientID === this.ydoc.clientID || !st || !st.cursor || !st.user) continue;
      const anchor = abs(st.cursor.anchor), head = abs(st.cursor.head);
      if (anchor === null || head === null) continue;
      out.push({ clientID, name: st.user.name, color: st.user.color, anchor, head });
    }
    return out;
  }
}
