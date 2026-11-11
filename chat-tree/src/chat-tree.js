// Chat tree pane: the focused chat, its ancestors, all its branches, and its live subagents,
// as an indented outline. A click opens a node's chat in a tab.
// Plain ESM with no imports: the SDK pieces and timers are injected so it runs under node --test.
// Spec: docs/research/2026-11-11-chat-tree/spec-chat-tree.md

export const PLUGIN_ID = 'chat-tree';
export const PANE_ID = 'pane';
export const REFRESH_MS = 15_000;
export const LIST_LIMIT = 500;
export const SIDE_PREFIX = 'Side: ';

const SELECTABLE = { userSelect: 'text', WebkitUserSelect: 'text' };
const INDENT_PX = 14;

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const errorText = (error) => str(error?.message) || str(error) || 'Unknown error';

// ── Pure tree logic (ported from apps/desktop/src/lib/session-branch-tree.ts) ──────────────

// session-branch-tree.ts:28-40. `/new` and idle resets stamp `_reset_from`: a new conversation,
// not a fork. `/branch` writes `_branched_from`. Older forks only have `parent_session_id`.
export function forkParentId(row) {
  if (str(row?._reset_from)) return undefined;
  return str(row?._branched_from) || str(row?.parent_session_id) || undefined;
}

// session-branch-tree.ts:45-46. Rows that share this key are one conversation (compression).
export const lineageKey = (row) => `${str(row?.profile) || 'default'}::${str(row?._lineage_root_id) || row?.id}`;

// session-branch-tree.ts:53-82. One row per compression lineage: the row nothing in its lineage
// continues from, then the freshest (first in input on a tie).
export function collapseLineages(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = lineageKey(row);
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  if (groups.size === rows.length) return rows;
  const winners = new Set();
  for (const group of groups.values()) {
    const continued = new Set(group.map((row) => str(row.parent_session_id)));
    const score = (row) => (continued.has(row.id) ? -Infinity : Math.max(num(row.last_active), num(row.started_at)));
    winners.add(group.reduce((best, row) => (score(row) > score(best) ? row : best)));
  }
  return rows.filter((row) => winners.has(row));
}

// Children sort oldest first by started_at, else last_active (spec chat_tree_pane.behavior).
export const sortTime = (row) => num(row?.started_at) || num(row?.last_active);

// Every id a kept row answers to: its own id, its lineage root, and the ids of collapsed stale
// tips of its lineage (session-branch-tree.ts:93-116). The `_lineage_ids` chain goes beyond the
// sidebar rule on purpose: the server row of a compressed chat is its tip, with the chain
// root..tip in `_lineage_ids` (hermes_state_session_list.py:20-44). A /branch made from a middle
// segment names that segment; without the chain it would lose its parent and show as a root.
function indexRows(input, rows) {
  const byId = new Map();
  for (const row of rows) {
    byId.set(row.id, row);
    const root = str(row._lineage_root_id);
    if (root) byId.set(root, row);
  }
  const survivor = new Map(rows.map((row) => [lineageKey(row), row]));
  for (const row of [...rows, ...input]) {
    const keep = survivor.get(lineageKey(row));
    if (!keep) continue;
    if (!byId.has(row.id)) byId.set(row.id, keep);
    for (const id of Array.isArray(row._lineage_ids) ? row._lineage_ids : []) {
      if (typeof id === 'string' && id && !byId.has(id)) byId.set(id, keep);
    }
  }
  return byId;
}

// The parent row, or undefined. Compression ancestry is not a branch (session-branch-tree.ts:128-131).
function parentRow(row, byId) {
  const id = forkParentId(row);
  const parent = id ? byId.get(id) : undefined;
  if (!parent || parent === row || lineageKey(parent) === lineageKey(row)) return undefined;
  return parent;
}

// Walks the parent rule up. Stops at a row with no parent, a parent not in the list, or a row
// already visited (a cycle).
export function findRoot(row, byId) {
  const seen = new Set();
  let current = row;
  for (;;) {
    seen.add(current);
    const parent = parentRow(current, byId);
    if (!parent || seen.has(parent)) return current;
    current = parent;
  }
}

// Builds { root, focused, partial } where each node is { row, children }. Each row is visited once.
// Returns null when the focused id is not in the list.
export function buildTree(input, focusedId) {
  const all = (Array.isArray(input) ? input : []).filter((row) => row && typeof row.id === 'string' && row.id);
  const rows = collapseLineages(all);
  const byId = indexRows(all, rows);
  const focusedRow = focusedId ? byId.get(focusedId) : undefined;
  if (!focusedRow) return null;

  const children = new Map();
  for (const row of rows) {
    const parent = parentRow(row, byId);
    if (!parent) continue;
    const list = children.get(parent) ?? [];
    list.push(row);
    children.set(parent, list);
  }
  for (const list of children.values()) list.sort((a, b) => sortTime(a) - sortTime(b));

  const seen = new Set();
  const visit = (row) => {
    seen.add(row);
    const nodes = [];
    for (const kid of children.get(row) ?? []) if (!seen.has(kid)) nodes.push(visit(kid));
    return { row, children: nodes };
  };
  const rootRow = findRoot(focusedRow, byId);
  // The top row names a parent that the page does not hold: older than the page, archived, or
  // hidden. The real root is above it.
  const missing = forkParentId(rootRow);
  return { root: visit(rootRow), focused: focusedRow, partial: Boolean(missing && !byId.has(missing)) };
}

// Depth-first, flat: [{ depth, kind: 'chat', row, focused } | { depth, kind: 'subagent', agent }].
// Live subagents go first under the focused chat.
export function flattenTree(tree, subagents = []) {
  if (!tree) return [];
  const out = [];
  const walk = (node, depth) => {
    const focused = node.row === tree.focused;
    out.push({ depth, kind: 'chat', row: node.row, focused });
    if (focused) for (const agent of subagents) out.push({ depth: depth + 1, kind: 'subagent', agent });
    for (const child of node.children) walk(child, depth + 1);
  };
  walk(tree.root, 0);
  return out;
}

export const isSideTitle = (title) => typeof title === 'string' && title.startsWith(SIDE_PREFIX);

// Session times are Unix seconds (SessionInfo.last_active).
export function timeText(seconds) {
  const s = num(seconds);
  return s ? new Date(s * 1000).toLocaleString() : '';
}

// subagent.list rows are untrusted: keep only well-typed fields.
function cleanAgent(a) {
  if (!a || typeof a !== 'object' || typeof a.subagent_id !== 'string') return null;
  const opt = (v) => (typeof v === 'string' && v ? v : null);
  return {
    subagent_id: a.subagent_id,
    goal: opt(a.goal),
    status: opt(a.status),
    model: opt(a.model),
    child_session_id: opt(a.child_session_id),
  };
}

// listPersistedSessions route from the focused chat's owner, shaped like the hermes-bots route
// (plugins/hermes-bots/routing.ts:64-71). The SDK reads only route.connectionId (sdk/index.ts:1457);
// an owner with no connection id uses null, the window's own route.
export function routeFor(owner) {
  const connectionId = str(owner?.connectionId);
  const profile = str(owner?.profile);
  if (!connectionId || !profile) return null;
  return { connectionId, mode: connectionId === 'local' ? 'local' : 'remote', profile, targetProfile: profile };
}

// openSession options for the owner (sdk/index.ts:836-850, 922-934): an explicit route dials the
// registry path, so a local owner passes only its profile, as the SDK's own local bot open does.
export function openOptions(owner) {
  const route = routeFor(owner);
  if (route && route.mode === 'remote') return { intent: 'tab', route };
  const profile = str(owner?.profile);
  return profile ? { intent: 'tab', profile } : { intent: 'tab' };
}

const profileKey = (v) => str(v) || 'default'; // store/profile.ts normalizeProfileKey

export function createChatTree(deps) {
  const { host, jsx, jsxs, atom, useValue, Button, ScrollArea } = deps;

  // rows: last good session rows. agents: last good subagents, for agentsFor (a runtime id).
  const $data = atom({ rows: [], agents: [], agentsFor: null });
  // note: why live subagents are not shown (not an error).
  const $status = atom({ loading: false, error: null, note: null });
  // Stand-in so the pane calls useValue the same number of times when host.state lacks an atom.
  const $none = atom(null);

  // Per-activation state. register() resets it: a disable then enable calls register() again on
  // the same module object (apps/desktop/src/contrib/runtime-loader.ts:499-512).
  let disposed = false;
  let generation = 0;
  let inFlight = 0;
  let activation = 0;
  let cancelTimer = null;
  let lastKey = null;
  let scopedTimeout = null;
  const unsubscribers = [];

  const atomOf = (name) => host?.state?.[name] ?? $none;
  const runtimeId = () => atomOf('focusedSessionId').get() ?? atomOf('activeSessionId').get() ?? null;
  // host.request goes to the active gateway only (sdk/index.ts:1507-1514). A chat owned by another
  // profile or connection would ask the wrong backend.
  const ownerIsActive = (owner) =>
    Boolean(owner) &&
    str(owner.connectionId) === str(atomOf('connectionId').get()) &&
    profileKey(owner.profile) === profileKey(atomOf('profile').get());

  function schedule(fn, ms) {
    if (scopedTimeout) return scopedTimeout(fn, ms);
    const set = deps.setTimeout ?? ((f, t) => globalThis.setTimeout(f, t));
    const clear = deps.clearTimeout ?? ((id) => globalThis.clearTimeout(id));
    const id = set(fn, ms);
    return () => clear(id);
  }

  // Reads both sources. Each failure shows its text and keeps that source's last good data.
  // A newer load wins: an older reply that lands late is dropped.
  async function load() {
    if (disposed) return;
    const mine = ++generation;
    const act = activation;
    inFlight += 1;
    try {
      await loadOnce(mine);
    } finally {
      // A load from an earlier activation must not touch this activation's count.
      if (act === activation) inFlight -= 1;
    }
  }

  async function loadOnce(mine) {
    const stored = atomOf('focusedStoredSessionId').get();
    const runtime = runtimeId();
    const owner = atomOf('focusedSessionOwner').get();
    if (!stored && !runtime) return $status.set({ loading: false, error: null, note: null });
    $status.set({ ...$status.get(), loading: true });
    const agentsOk = ownerIsActive(owner);

    const errors = [];
    const sessions = (async () => {
      const profile = str(owner?.profile);
      if (!profile) throw new Error('The profile of this chat is unknown.');
      if (typeof host?.listPersistedSessions !== 'function') throw new Error('This Hermes has no session list for plugins.');
      const result = await host.listPersistedSessions(routeFor(owner), { profile, limit: LIST_LIMIT });
      return Array.isArray(result?.sessions) ? result.sessions : [];
    })();
    const agents = (async () => {
      if (!runtime || !agentsOk) return [];
      const result = await host.request('subagent.list', { session_id: runtime });
      return (Array.isArray(result?.subagents) ? result.subagents : []).map(cleanAgent).filter(Boolean);
    })();
    const [rows, live] = await Promise.allSettled([sessions, agents]);
    if (disposed || mine !== generation) return;

    const next = { ...$data.get() };
    if (rows.status === 'fulfilled') next.rows = rows.value;
    else errors.push(`Sessions: ${errorText(rows.reason)}`);
    if (live.status === 'fulfilled') {
      next.agents = live.value;
      next.agentsFor = runtime;
    } else errors.push(`Subagents: ${errorText(live.reason)}`);
    $data.set(next);
    $status.set({
      loading: false,
      error: errors.length ? errors.join('\n') : null,
      note: agentsOk ? null : 'Subagents unavailable for this chat.',
    });
  }

  const reload = () => {
    load().then(null, (error) => {
      if (!disposed) $status.set({ loading: false, error: errorText(error) });
    });
  };

  // A tick never cuts off a load still in flight: a source slower than the period would else
  // never land (use-subagent-snapshot.ts:30 skips the same way). Focus changes still load.
  function tick() {
    if (disposed) return;
    if (inFlight === 0) reload();
    cancelTimer = schedule(tick, REFRESH_MS);
  }

  // Loads again only when the focused chat or its owner really changes; the owner atom is
  // recomputed on every session-list change.
  function onFocus() {
    const owner = atomOf('focusedSessionOwner').get();
    const key = JSON.stringify([
      atomOf('focusedStoredSessionId').get(),
      runtimeId(),
      str(owner?.connectionId),
      str(owner?.profile),
      str(atomOf('connectionId').get()),
      str(atomOf('profile').get()),
    ]);
    if (key === lastKey) return;
    lastKey = key;
    reload();
  }

  function openChat(id) {
    if (!id || typeof host?.openSession !== 'function') return;
    const options = openOptions(atomOf('focusedSessionOwner').get());
    Promise.resolve()
      .then(() => host.openSession(id, options))
      .then(null, () => {});
  }

  // A drag that selects text also fires click; do not open a tab then.
  const selecting = () => {
    try {
      return Boolean(str(globalThis.getSelection?.()?.toString?.()));
    } catch {
      return false;
    }
  };
  const onClickOpen = (id) => () => {
    if (!selecting()) openChat(id);
  };

  function chatLine(item) {
    const { row } = item;
    const parts = [str(row.model), `${num(row.message_count)} msgs`, timeText(row.last_active)].filter(Boolean);
    return jsxs('div', {
      key: `chat:${row.id}`,
      role: 'button',
      className: `flex flex-col rounded px-1 py-0.5 cursor-pointer hover:bg-muted${item.focused ? ' bg-muted' : ''}`,
      style: { ...SELECTABLE, paddingLeft: `${4 + item.depth * INDENT_PX}px` },
      'data-selectable-text': 'true',
      'data-session-id': row.id,
      onClick: onClickOpen(row.id),
      children: [
        jsxs('span', {
          className: `text-sm${item.focused ? ' font-semibold' : ''}`,
          style: SELECTABLE,
          children: [
            item.focused ? '● ' : '',
            str(row.title) || 'Untitled',
            isSideTitle(row.title) ? jsx('span', { className: 'ml-1 text-xs opacity-60', style: SELECTABLE, children: '[side]' }) : null,
          ].filter(Boolean),
        }),
        jsx('span', { className: 'text-xs opacity-60', style: SELECTABLE, children: parts.join(' · ') }),
      ],
    });
  }

  function agentLine(item) {
    const { agent } = item;
    const parts = [agent.status, agent.model].filter(Boolean);
    const id = agent.child_session_id;
    return jsxs('div', {
      key: `agent:${agent.subagent_id}`,
      className: `flex flex-col rounded px-1 py-0.5${id ? ' cursor-pointer hover:bg-muted' : ''}`,
      style: { ...SELECTABLE, paddingLeft: `${4 + item.depth * INDENT_PX}px` },
      'data-selectable-text': 'true',
      'data-subagent-id': agent.subagent_id,
      ...(id ? { role: 'button', onClick: onClickOpen(id) } : {}),
      children: [
        jsx('span', { className: 'text-sm', style: SELECTABLE, children: `↳ subagent: ${agent.goal ?? '(no goal)'}` }),
        jsx('span', { className: 'text-xs opacity-60', style: SELECTABLE, children: parts.join(' · ') }),
      ],
    });
  }

  // Hook order is fixed: five useValue calls, every render, before any branch (React error 300).
  // Render only reads state; loading happens on focus change and on the timer, in register().
  function renderPane() {
    const stored = useValue(atomOf('focusedStoredSessionId'));
    const focused = useValue(atomOf('focusedSessionId'));
    const active = useValue(atomOf('activeSessionId'));
    const data = useValue($data);
    const status = useValue($status);

    const runtime = focused ?? active ?? null;
    const tree = buildTree(data.rows, stored ?? runtime);
    const agents = runtime && data.agentsFor === runtime ? data.agents : [];
    const items = flattenTree(tree, agents);

    let notice = null;
    if (!stored && !runtime) notice = 'Open a chat to see its tree.';
    else if (!tree && !status.loading) {
      // The page is the newest LIST_LIMIT rows by creation (sdk/index.ts:1446-1455, offset fixed at 0).
      notice =
        data.rows.length >= LIST_LIMIT
          ? `This chat is older than the newest ${LIST_LIMIT} chats. Older chats are not loaded.`
          : 'This chat is not in the session list yet.';
    } else if (tree?.partial) {
      notice = `Partial tree: the parent of the top chat is not loaded (older than the newest ${LIST_LIMIT} chats, archived, or hidden).`;
    }

    return jsx(ScrollArea, {
      children: jsxs('div', {
        className: 'flex flex-col gap-1 p-3 text-sm',
        style: SELECTABLE,
        'data-selectable-text': 'true',
        children: [
          jsxs('div', {
            className: 'flex items-center gap-2',
            children: [
              jsx(Button, { type: 'button', disabled: disposed, onClick: reload, children: 'Refresh' }),
              status.loading ? jsx('span', { className: 'text-xs opacity-60', style: SELECTABLE, children: 'Loading...' }) : null,
            ].filter(Boolean),
          }),
          status.error
            ? jsx('pre', {
                className: 'text-xs text-destructive',
                style: { ...SELECTABLE, whiteSpace: 'pre-wrap', margin: 0, font: 'inherit' },
                children: status.error,
              })
            : null,
          notice ? jsx('p', { className: 'text-xs opacity-70', style: SELECTABLE, children: notice }) : null,
          status.note ? jsx('p', { className: 'text-xs opacity-70', style: SELECTABLE, children: status.note }) : null,
          ...items.map((item) => (item.kind === 'chat' ? chatLine(item) : agentLine(item))),
        ].filter(Boolean),
      }),
    });
  }

  // Stops the timer and every store listener. Wired to ctx.onDispose.
  function dispose() {
    disposed = true;
    generation += 1;
    if (typeof cancelTimer === 'function') cancelTimer();
    cancelTimer = null;
    for (const off of unsubscribers.splice(0)) {
      try {
        off();
      } catch {
        // A listener that is already gone needs no cleanup.
      }
    }
  }

  function register(ctx) {
    // A second register() (disable, then enable) starts clean: drop the old activation first.
    if (!disposed) dispose();
    disposed = false;
    generation += 1;
    activation += 1;
    inFlight = 0;
    lastKey = null;
    scopedTimeout = null;
    $status.set({ loading: false, error: null, note: null });
    // ctx.setTimeout: the host clears it on unload (apps/desktop/src/contrib/plugin.ts).
    if (typeof ctx?.setTimeout === 'function') scopedTimeout = (fn, ms) => ctx.setTimeout(fn, ms);
    if (typeof ctx?.onDispose === 'function') ctx.onDispose(dispose);
    for (const name of ['focusedStoredSessionId', 'focusedSessionId', 'activeSessionId', 'focusedSessionOwner', 'connectionId', 'profile']) {
      const store = host?.state?.[name];
      if (typeof store?.listen === 'function') unsubscribers.push(store.listen(onFocus));
    }
    onFocus();
    cancelTimer = schedule(tick, REFRESH_MS);
    ctx.register({
      id: PANE_ID,
      area: 'panes',
      title: 'Chat tree',
      data: { placement: 'right', width: '320px' },
      render: renderPane,
    });
    ctx.register({
      id: 'open-chat-tree',
      area: 'palette',
      data: {
        id: 'open-chat-tree',
        label: 'Open chat tree',
        keywords: ['tree', 'branch', 'subagent', 'lineage'],
        run: () => {
          if (typeof host?.revealPane === 'function') host.revealPane(`${PLUGIN_ID}:${PANE_ID}`);
        },
      },
    });
  }

  return { register, renderPane, load, openChat, dispose, $data, $status };
}
