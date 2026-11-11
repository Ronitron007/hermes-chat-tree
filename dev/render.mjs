// Render harness: renders the real chat-tree and side-chat panes with fixture chats to static HTML.
//
//   node dev/render.mjs        # writes dev/out/chat-tree.html and dev/out/side-chat.html
//
// Each pane runs its own factory (createChatTree, createSideChat) with stub SDK pieces and a fake
// host that answers from dev/fixtures/chats.json. register(ctx) runs as in Desktop, the async load
// settles, then react-dom/server renders the pane. No network, no model, no Hermes.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement, useSyncExternalStore } from 'react';
import { jsx, jsxs } from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { createChatTree } from '../chat-tree/src/chat-tree.js';
import { createSideChat } from '../side-chat/src/side-chat.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(readFileSync(join(root, 'dev/fixtures/chats.json'), 'utf8'));
const outDir = join(root, 'dev/out');

// nanostores-like atom, the shape the SDK atoms have: get, set, listen (changes only), subscribe
// (current value first, then changes).
function atom(initial) {
  let value = initial;
  const subs = new Set();
  return {
    get: () => value,
    set(next) {
      value = next;
      for (const fn of [...subs]) fn(value);
    },
    listen(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    subscribe(fn) {
      subs.add(fn);
      fn(value);
      return () => subs.delete(fn);
    },
  };
}

// The SDK useValue reads an atom inside React. Server rendering needs getServerSnapshot.
function useValue(store) {
  const get = () => store.get();
  return useSyncExternalStore((onChange) => store.listen(() => onChange()), get, get);
}

// Plain elements stand in for the SDK components.
const MessageTextContent = ({ text }) => jsx('div', { style: { whiteSpace: 'pre-wrap' }, children: text });

const unknown = (method) => Object.assign(new Error(`unknown method: ${method}`), { code: -32601 });

// A fake host for one pane: state atoms focused on `focusId`, and gateway reads from the fixture.
// Answers session.history and session.transcript both, so old and new pane code read the same chats.
function fakeHost(focusId) {
  let pending = 0;
  const track = async (work) => {
    pending += 1;
    try {
      return await work();
    } finally {
      pending -= 1;
    }
  };
  const messages = (id) => fixture.history[id] ?? [];
  const transcriptRows = (id) =>
    messages(id).map((m, i) => ({ row_id: i + 1, role: m.role, text: m.content, timestamp: m.timestamp }));
  const owner = fixture.owner;
  const host = {
    state: {
      focusedStoredSessionId: atom(focusId),
      focusedSessionId: atom(focusId),
      activeSessionId: atom(focusId),
      focusedSessionOwner: atom(owner),
      connectionId: atom(owner.connectionId),
      profile: atom(owner.profile),
      busyBySession: atom({}),
    },
    pending: () => pending,
    listPersistedSessions: (route, options) =>
      track(async () => {
        const limit = Number.isFinite(options?.limit) ? options.limit : fixture.sessions.length;
        const sessions = fixture.sessions.slice(0, limit);
        return { sessions, total: fixture.sessions.length };
      }),
    request: (method, params = {}) =>
      track(async () => {
        const id = params.session_id;
        switch (method) {
          case 'session.list':
            return { sessions: fixture.sessions, total: fixture.sessions.length };
          case 'session.history':
            return { session_id: id, messages: messages(id) };
          case 'session.transcript':
            return { rows: transcriptRows(id), next_cursor: null };
          case 'subagent.list':
            return { subagents: [], delegations: [] };
          default:
            throw unknown(method);
        }
      }),
    openSession: async () => {},
    revealPane: () => {},
    composer: { setDraft: async () => true },
  };
  return host;
}

// ctx as the Desktop loader passes it. Timers never fire: the render is one snapshot.
function fakeCtx() {
  const registered = [];
  const disposers = [];
  const store = new Map(Object.entries(fixture.storage ?? {}));
  const ctx = {
    register: (contribution) => registered.push(contribution),
    setTimeout: () => () => {},
    onDispose: (fn) => disposers.push(fn),
    storage: {
      get: (key) => (store.has(key) ? structuredClone(store.get(key)) : undefined),
      set: (key, value) => store.set(key, value),
    },
  };
  return { ctx, registered, dispose: () => disposers.splice(0).forEach((fn) => fn()) };
}

// Waits until the host has had no reads in flight for a few turns of the event loop.
async function settle(host) {
  let quiet = 0;
  for (let i = 0; i < 500 && quiet < 5; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    quiet = host.pending() === 0 ? quiet + 1 : 0;
  }
}

const sdk = (host) => ({
  host,
  jsx,
  jsxs,
  atom,
  useValue,
  Button: 'button',
  Input: 'input',
  ScrollArea: 'div',
  MessageTextContent,
  setTimeout: () => 0,
  clearTimeout: () => {},
  now: () => Date.now(),
});

const PANES = [
  { id: 'chat-tree', title: 'Chat tree', create: (deps) => createChatTree(deps) },
  { id: 'side-chat', title: 'Side chat', create: (deps) => createSideChat(deps) },
];

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function page(title, width, markup) {
  return `<!doctype html>
<html lang="en" class="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<script src="https://cdn.tailwindcss.com"></script>
<script>
  tailwind.config = { darkMode: 'class', theme: { extend: { colors: { muted: '#27272a', destructive: '#f87171' } } } };
</script>
<style>
  body { margin: 0; background: #09090b; color: #e4e4e7; font: 13px/1.4 ui-sans-serif, system-ui, -apple-system, sans-serif; }
  .pane { width: ${width}; min-height: 100vh; background: #18181b; border-left: 1px solid #27272a; margin-left: auto; }
  .pane-title { padding: 8px 12px; font-weight: 600; border-bottom: 1px solid #27272a; }
  button { border: 1px solid #3f3f46; border-radius: 4px; padding: 1px 6px; background: #27272a; color: inherit; font: inherit; }
  input { width: 100%; box-sizing: border-box; border: 1px solid #3f3f46; border-radius: 4px; padding: 4px 6px; background: #09090b; color: inherit; font: inherit; }
</style>
</head>
<body>
<div class="pane" data-render-harness="${escapeHtml(title)}">
<div class="pane-title">${escapeHtml(title)}</div>
${markup}
</div>
</body>
</html>
`;
}

async function renderPane(spec) {
  const focusId = fixture.focus?.[spec.id];
  const host = fakeHost(focusId);
  const plugin = spec.create(sdk(host));
  const { ctx, registered, dispose } = fakeCtx();
  plugin.register(ctx);
  await settle(host);
  const pane = registered.find((c) => c.area === 'panes');
  if (!pane || typeof pane.render !== 'function') throw new Error(`${spec.id}: register() added no pane`);
  const markup = renderToStaticMarkup(createElement(pane.render));
  dispose();
  if (!markup) throw new Error(`${spec.id}: the pane rendered nothing`);
  const width = typeof pane.data?.width === 'string' ? pane.data.width : '300px';
  const file = join(outDir, `${spec.id}.html`);
  writeFileSync(file, page(pane.title || spec.title, width, markup));
  const missing = (fixture.expect?.[spec.id] ?? []).filter((text) => !markup.includes(escapeHtml(text)));
  console.log(`wrote ${file} (${markup.length} chars of markup, focus ${focusId})`);
  if (missing.length) console.warn(`  ${spec.id}: not in the markup: ${missing.join(' | ')}`);
}

// React dev warnings repeat once per element. Print each distinct one in full once, then a count.
const repeats = new Map();
const printError = console.error.bind(console);
console.error = (...args) => {
  const head = String(args[0]).split('\n')[0];
  repeats.set(head, (repeats.get(head) ?? 0) + 1);
  if (repeats.get(head) === 1) printError(...args);
};

// Pane code reads these globals for side and merged marks (assembled plugins share them this way).
globalThis.__hermesSideChatBranchIds = new Set(fixture.sideBranchIds ?? []);
globalThis.__hermesSideChatMergedIds = new Set(fixture.mergedIds ?? []);

mkdirSync(outDir, { recursive: true });
for (const spec of PANES) await renderPane(spec);
for (const [head, n] of repeats) if (n > 1) printError(`(the warning "${head}" repeated ${n - 1} more times)`);
