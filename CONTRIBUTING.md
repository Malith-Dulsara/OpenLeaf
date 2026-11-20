# Contributing to OpenLeaf

Thanks for your interest in improving OpenLeaf! Bug reports, ideas, docs fixes and code are all welcome.

## Ways to help

- **Report a bug:** [open an issue](https://github.com/Maith-Dulsara/OpenLeaf/issues/new/choose) and include your OS, TeX distribution and, for compile problems, the raw log.
- **Suggest a feature:** open a feature request and describe the problem it solves.
- **Improve the docs:** typos, clearer explanations and translations all help.
- **Write code:** issues labelled [`good first issue`](https://github.com/Maith-Dulsara/OpenLeaf/labels/good%20first%20issue) are a good place to start.

## Development setup

You need **Node.js 20+** and a TeX distribution with `latexmk` (MiKTeX, TeX Live or MacTeX).

```bash
git clone https://github.com/Maith-Dulsara/OpenLeaf.git
cd OpenLeaf
npm install
```

| Command | What it does |
|---|---|
| `npm start` | Runs OpenLeaf in browser mode at <http://localhost:5050>. The fastest loop for UI and server work. |
| `npm run app` | Runs the desktop (Electron) app from source. |
| `npm test` | Runs the test suite. No LaTeX needed. |
| `npm run check` | Syntax-checks the server and desktop code. |
| `npm run vendor` | Rebuilds `public/vendor/` and `lib/` from `node_modules` after you upgrade a front-end library. |
| `npm run dist` | Builds the Windows installer and portable `.exe` into `dist/`. |

> **Windows tip:** NSIS can't handle very long paths. If `npm run dist` fails with `could not open file`, clone into a short path such as `C:\src\OpenLeaf`.

## How the code is organised

```
server.js            HTTP API, projects & files, latexmk compiles, log parsing, SyncTeX, sharing & access control
collab.js            Real-time collaboration: one Yjs document per open file, persisted back to disk
electron/main.js     Desktop app shell: window, menus, finds your TeX install, starts the server
public/
  index.html         Project dashboard
  editor.html/.css   Editor layout and styles
  editor.js          Editor: file tree, CodeMirror, compile, logs, PDF viewer, SyncTeX, presence, sharing UI
  collab-client.js   Browser side of collaboration: binds CodeMirror to Yjs, sends/receives edits & cursors
  common.js/.css     Shared UI helpers (dialogs, menus, toasts, icons, theme)
  vendor/            Bundled third-party libraries (CodeMirror 5, pdf.js, Yjs). Generated, don't edit.
lib/yjs.cjs          Yjs bundle for the server. Generated, don't edit.
scripts/vendor.js    Builds public/vendor and lib from node_modules
test/                node:test suites (collaboration, access control, log parser)
```

The server has **no runtime npm dependencies**. Everything the browser needs is bundled in `public/vendor/`, so `node server.js` works straight from a clone. Please keep it that way. If you add a library, bundle it through `scripts/vendor.js`.

## Pull requests

1. Fork the repo and create a branch from `main` (`git checkout -b fix/compile-timeout`).
2. Keep changes focused: one fix or feature per PR.
3. Match the surrounding style: 2-space indent, single quotes, small functions, comments that explain *why*.
4. Add or update tests when you change server or collaboration behaviour, and run `npm test`.
5. For UI changes, add before/after screenshots to the PR.
6. If your change touches collaboration, try it with two browser windows editing the same file at once.

CI runs the tests on Windows and Linux for every pull request.

## Code of conduct

Please be kind and constructive. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
