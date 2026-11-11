// Render harness: renders the real chat-tree and side-chat panes with fixture chats to static HTML.
//
//   node dev/render.mjs        # writes dev/out/chat-tree.html, chat-tree-hover.html and side-chat.html
//
// Each pane runs its own factory (createChatTree, createSideChat) with stub SDK pieces and a fake
// host that answers from dev/fixtures/chats.json. register(ctx) runs as in Desktop, the async load
// settles, then react-dom/server renders the pane. No network, no model, no Hermes.
// chat-tree-hover.html is the chat tree with the pointer on the fixture's hover node: the harness
// sets the pane's $hover atom before the render. The pages load the CSS that Hermes Desktop ships
// (HERMES_CSS), not a CSS generator: a class works in a render only if it works in the app. Over
// it, THEME_VARS sets the variables of a real Hermes dark theme.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createElement, useSyncExternalStore } from 'react';
import { jsx, jsxs } from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { createChatTree } from '../chat-tree/src/chat-tree.js';
import { createSideChat } from '../side-chat/src/side-chat.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(readFileSync(join(root, 'dev/fixtures/chats.json'), 'utf8'));
const outDir = join(root, 'dev/out');

// The shipped Hermes Desktop CSS: $HERMES_CSS, else the built main-*.css of the local Hermes.
// Hermes builds Tailwind once over its own source, so only the classes it uses exist in this file.
function findHermesCss() {
  if (process.env.HERMES_CSS) return existsSync(process.env.HERMES_CSS) ? process.env.HERMES_CSS : null;
  const dir = join(homedir(), '.hermes/hermes-agent/apps/desktop/dist/assets');
  const name = existsSync(dir) ? readdirSync(dir).find((f) => /^main-.*\.css$/.test(f)) : null;
  return name ? join(dir, name) : null;
}
const HERMES_CSS = findHermesCss();

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

// Radix ScrollArea as Hermes ships it (components/ui/scroll-area.tsx): a viewport whose child is a
// display:table div with min-width 100%, which grows to its content's min-content width. The pane
// root must keep to the viewport's width inside it.
const ScrollArea = ({ children }) =>
  jsx('div', {
    'data-slot': 'scroll-area',
    style: { position: 'relative', overflow: 'hidden', width: '100%' },
    children: jsx('div', {
      'data-radix-scroll-area-viewport': '',
      style: { width: '100%', height: '100%', overflowX: 'hidden', overflowY: 'scroll' },
      children: jsx('div', { style: { minWidth: '100%', display: 'table' }, children }),
    }),
  });

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
  ScrollArea,
  MessageTextContent,
  setTimeout: () => 0,
  clearTimeout: () => {},
  now: () => Date.now(),
});

// file: the output name. pane: the fixture keys (focus, hover, expect) when they differ from file.
const PANES = [
  { file: 'chat-tree', title: 'Chat tree', create: (deps) => createChatTree(deps) },
  { file: 'chat-tree-hover', pane: 'chat-tree', hover: true, title: 'Chat tree', create: (deps) => createChatTree(deps) },
  // The merge pick at step How (no Popover in the harness: it shows under the graph), with the
  // pointer on a row so its icons show.
  { file: 'chat-tree-merge', pane: 'chat-tree', hover: true, merge: true, title: 'Chat tree', create: (deps) => createChatTree(deps) },
  // A narrow pane (260 px): a long label, the model pill, a long note (the chat is running) and a
  // failed merge line. No text may leave the pane.
  { file: 'chat-tree-narrow', pane: 'chat-tree', narrow: true, width: '260px', title: 'Chat tree', create: (deps) => createChatTree(deps) },
  { file: 'side-chat', title: 'Side chat', create: (deps) => createSideChat(deps) },
];

// Hermes Desktop dark-theme variables, as the app paints them. The seeds are the Catppuccin dark
// palette (hermes-agent apps/shared/src/theme-presets.ts, catppuccin.darkColors: foreground
// #cdd6f4, midground #cba6f7, primary #cba6f7, background #1e1e2e, card #181825), set as
// apps/desktop/src/themes/context.tsx:340-352 sets them, with the dark chrome mix and neutral of
// context.tsx:275-286. The derived tokens copy apps/desktop/src/styles.css (:root, lines 239-240,
// 297-301, 325-329, 364-366, 380-384, 421-426, 440).
const THEME_VARS = `
    --theme-foreground: #cdd6f4;
    --theme-midground: #cba6f7;
    --theme-primary: #cba6f7;
    --theme-background-seed: #1e1e2e;
    --theme-card-seed: #181825;
    --theme-neutral-chrome: #0d0d0e;
    --theme-mix-chrome: 74%;
    --ui-base: var(--theme-foreground);
    --ui-accent: var(--theme-midground);
    --dt-primary: var(--theme-primary);
    --ui-bg-chrome: color-mix(in srgb, var(--theme-background-seed) var(--theme-mix-chrome), var(--theme-neutral-chrome));
    --ui-bg-tertiary: color-mix(in srgb, var(--ui-accent) 8%, color-mix(in srgb, var(--ui-base) 5%, transparent));
    --ui-text-primary: color-mix(in srgb, var(--ui-base) 94%, transparent);
    --ui-text-tertiary: color-mix(in srgb, var(--ui-base) 54%, transparent);
    --ui-stroke-secondary: color-mix(in srgb, var(--ui-accent) 16%, color-mix(in srgb, var(--ui-base) 7%, transparent));
    --dt-background: var(--ui-bg-chrome);
    --dt-foreground: var(--ui-text-primary);
    --dt-muted: var(--ui-bg-tertiary);
    --dt-muted-foreground: var(--ui-text-tertiary);
    --dt-border: var(--ui-stroke-secondary);`;

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function page(title, width, markup) {
  return `<!doctype html>
<html lang="en" class="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${HERMES_CSS ? `<link rel="stylesheet" href="${escapeHtml(pathToFileURL(HERMES_CSS).href)}">` : '<!-- No Hermes CSS found: set HERMES_CSS. -->'}
<style>
  :root {${THEME_VARS}
  }
  /* The pane sits at the left edge and the body is exactly as wide as the pane, so a narrow
     headless screenshot (npm run render:png, 380 px) holds the whole pane. */
  html, body { margin: 0; padding: 0; background: var(--dt-background); }
  body { width: ${width}; color: var(--dt-foreground); font: 13px/1.4 ui-sans-serif, system-ui, -apple-system, sans-serif; }
  .pane { box-sizing: border-box; width: ${width}; min-height: 100vh; margin: 0; background: var(--dt-background); overflow-wrap: anywhere; }
  .pane-title { padding: 8px 12px; font-weight: 600; border-bottom: 1px solid var(--dt-border); }
  .pane button { border: 1px solid var(--dt-border); border-radius: 4px; padding: 1px 6px; background: var(--dt-muted); color: inherit; font: inherit; }
  .pane input { width: 100%; box-sizing: border-box; border: 1px solid var(--dt-border); border-radius: 4px; padding: 4px 6px; background: var(--dt-background); color: inherit; font: inherit; }
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
  const id = spec.pane ?? spec.file;
  const focusId = fixture.focus?.[id];
  // The narrow render asks the open chat a long question: its label must end in an ellipsis.
  const saved = fixture.history[focusId];
  if (spec.narrow && Array.isArray(saved)) {
    const lastUser = saved.map((m) => m.role).lastIndexOf('user');
    fixture.history[focusId] = saved.map((m, i) =>
      i === lastUser ? { ...m, content: `${m.content} and also explain how to scope a PyPI API token to a single project without breaking CI` } : m,
    );
  }
  const host = fakeHost(focusId);
  if (spec.narrow) host.state.busyBySession.set({ [focusId]: true });
  const plugin = spec.create(sdk(host));
  const { ctx, registered, dispose } = fakeCtx();
  plugin.register(ctx);
  await settle(host);
  const pane = registered.find((c) => c.area === 'panes');
  if (!pane || typeof pane.render !== 'function') throw new Error(`${spec.file}: register() added no pane`);
  // The hover render: the pointer on the fixture's hover node, as a mouseenter on its row sets it.
  const hoverKey = spec.hover ? fixture.hover?.[id] : null;
  if (spec.hover) {
    if (!hoverKey || typeof plugin.$hover?.set !== 'function') throw new Error(`${spec.file}: no hover node or no $hover atom`);
    plugin.$hover.set({ pointer: hoverKey, focus: null });
  }
  const parentId = fixture.sessions.find((row) => row.id === focusId)?.parent_session_id ?? null;
  if (spec.merge) {
    plugin.$ui.set({
      ...plugin.$ui.get(),
      pick: { rowKey: hoverKey, chatId: focusId, step: 'how', targetId: parentId, prep: { turns: 2, sideTokens: 3100, headroom: { available: 36000, used: 92000, max: 128000 } } },
    });
    plugin.$hover.set({ ...plugin.$hover.get(), target: parentId });
  }
  if (spec.narrow) {
    plugin.$ui.set({
      ...plugin.$ui.get(),
      result: { ok: false, kind: 'asis', anchor: null, targetId: parentId, title: 'Publish a Python package to PyPI', text: "The main chat's composer is not visible. Open the main chat and try again." },
    });
  }
  const markup = renderToStaticMarkup(createElement(pane.render));
  dispose();
  if (spec.narrow) fixture.history[focusId] = saved;
  if (!markup) throw new Error(`${spec.file}: the pane rendered nothing`);
  if (hoverKey && !(markup.includes(`data-node="${escapeHtml(hoverKey)}"`) && markup.includes('data-role="hover"'))) {
    throw new Error(`${spec.file}: the hover node ${hoverKey} drew no hover path`);
  }
  const width = spec.width ?? (typeof pane.data?.width === 'string' ? pane.data.width : '300px');
  const file = join(outDir, `${spec.file}.html`);
  writeFileSync(file, page(pane.title || spec.title, width, markup));
  const missing = (fixture.expect?.[id] ?? []).filter((text) => !markup.includes(escapeHtml(text)));
  console.log(`wrote ${file} (${markup.length} chars of markup, focus ${focusId}${hoverKey ? `, hover ${hoverKey}` : ''})`);
  if (missing.length) console.warn(`  ${spec.file}: not in the markup: ${missing.join(' | ')}`);
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
if (HERMES_CSS) console.log(`Hermes CSS: ${HERMES_CSS}`);
else console.warn('No Hermes Desktop CSS found (set HERMES_CSS): the pages render with no app classes.');
for (const spec of PANES) await renderPane(spec);
for (const [head, n] of repeats) if (n > 1) printError(`(the warning "${head}" repeated ${n - 1} more times)`);
