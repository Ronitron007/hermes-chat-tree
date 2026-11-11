import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  createChatTree,
  buildTree,
  forkParentId,
  collapseLineages,
  routeFor,
  REFRESH_MS,
  LIST_LIMIT,
  isSideChat,
  rememberSideBranch,
} from '../src/chat-tree.js';
// New exports are read off the namespace so a missing one fails its own test, not the whole file.
import * as mod from '../src/chat-tree.js';

const MERGE_STAGED_TEXT =
  'The draft is in the main chat composer. Edit it and send. After sending, session.undo on an idle parent can drop that turn.';
const MERGE_HIDDEN_TEXT = "The main chat's composer is not visible. Open the main chat and try again.";
const MERGE_NO_COMPOSER_TEXT = 'The composer draft API is missing. Nothing was written.';
// The theme colours the pane maps roles to: Hermes variables with the old fixed colours as fallbacks.
const ACCENT = 'var(--dt-primary, #3B82F6)';
const MUTED = 'var(--dt-muted-foreground, #6B7280)';
const HOVER = 'var(--dt-foreground, currentColor)';

// Side ids live on globalThis (shared with side-chat); every test starts with none.
beforeEach(() => {
  globalThis.__hermesSideChatBranchIds?.clear?.();
});

const el = (type, props, key) => ({ type, props, key });

// nanostores-like atom: get, set, listen (no immediate call).
function atom(initial) {
  let value = initial;
  const subs = new Set();
  return {
    get: () => value,
    set(next) {
      value = next;
      subs.forEach((fn) => fn(value));
    },
    listen(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    listeners: () => subs.size,
  };
}

// Fake scoped timers, like ctx.setTimeout: each returns a cancel function.
function fakeClock() {
  let t = 0;
  let id = 0;
  const timers = new Map();
  return {
    setTimeout(fn, ms) {
      const key = ++id;
      timers.set(key, { at: t + ms, fn });
      return () => timers.delete(key);
    },
    pending: () => timers.size,
    async tick(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        t = due[1].at;
        due[1].fn();
        await flush();
      }
      t = end;
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 60; i++) await Promise.resolve();
};

const row = (id, extra = {}) => ({
  id,
  title: id,
  model: 'm1',
  message_count: 2,
  started_at: 100,
  last_active: 200,
  profile: 'default',
  ...extra,
});

// History messages: each pair is [user text, assistant text]; null skips the reply.
const msgs = (...pairs) =>
  pairs.flatMap(([user, reply]) => [{ role: 'user', text: user }, ...(reply === null ? [] : [{ role: 'assistant', text: reply }])]);
// Exchanges, as exchangesFromRows builds them, from the same pairs.
const exs = (...pairs) => mod.exchangesFromRows(msgs(...pairs));

// root -> b1 -> b2 (deep branch); root -> b3 (a side chat); r2 is a /new reset of root.
const ROWS = [
  row('root', { started_at: 10 }),
  row('b1', { _branched_from: 'root', parent_session_id: 'root', started_at: 20 }),
  row('b2', { _branched_from: 'b1', started_at: 30 }),
  row('b3', { parent_session_id: 'root', title: 'Side: what is x?', started_at: 15 }),
  row('r2', { parent_session_id: 'root', _reset_from: 'root', started_at: 40 }),
];
// root: q1 q2 q3. b3 copies q1, then asks its side question. b1 copies q1 q2, then b1q.
// b2 copies b1, then b2q.
const HIST = {
  root: msgs(['q1', 'a1'], ['q2', 'a2'], ['q3', 'a3']),
  b1: msgs(['q1', 'a1'], ['q2', 'a2'], ['b1q', 'b1a']),
  b2: msgs(['q1', 'a1'], ['q2', 'a2'], ['b1q', 'b1a'], ['b2q', 'b2a']),
  b3: msgs(['q1', 'a1'], ['what is x?', 'x is y']),
  r2: msgs(['fresh', 'start']),
};
// Depth-first, oldest child first, shared exchanges drawn once on the parent lane.
const MAIN_KEYS = ['root:0', 'b3:1', 'root:1', 'b1:2', 'b2:3', 'root:2'];

function fakeHost({
  rows = ROWS,
  stored = 'b2',
  runtime = 'rt-b2',
  owner = { connectionId: 'local', profile: 'default' },
  agents = [],
  active = { connectionId: 'local', profile: 'default' },
  history = HIST,
  backend = false,
} = {}) {
  const calls = [];
  const opened = [];
  const order = []; // open / draft / submit, in call order
  const drafts = [];
  const state = {
    focusedStoredSessionId: atom(stored),
    focusedSessionId: atom(runtime),
    activeSessionId: atom(null),
    focusedSessionOwner: atom(owner),
    connectionId: atom(active.connectionId),
    profile: atom(active.profile),
    busyBySession: atom({}),
  };
  // A method payload is a value, a function of the params, an Error to throw, or undefined
  // (the method is unknown on this Hermes).
  const answer = (method, value, params) => {
    if (value === undefined) throw new Error(`unknown method: ${method}`);
    if (value instanceof Error) throw value;
    return typeof value === 'function' ? value(params) : value;
  };
  const host = {
    state,
    calls,
    opened,
    order,
    drafts,
    rows,
    agents,
    sessionsError: null,
    agentsError: null,
    // Hermes v0.23 default: session.transcript is unknown, session.history is a complete snapshot.
    // transcript: { [id]: rows } turns session.transcript on. history: { [id]: messages }.
    transcript: null,
    history: { ...history },
    // plugin.chat-tree.history.read: backend false answers -32601 (the Python half is not enabled).
    // store: { [stored id]: rows } the session store; null reads host.history. historyReadError throws.
    backend,
    store: null,
    historyReadError: null,
    usage: undefined,
    stats: undefined,
    breakdown: undefined,
    // setDraft result: true, false, an Error to throw, or a function([id, text]).
    setDraftResult: true,
    // session.branch and prompt.submit results: a value, a function of the params, or an Error.
    branchResult: { session_id: 'nb-rt', stored_session_id: 'nb', title: 'b2 (branch)' },
    submitResult: { status: 'queued' },
    // true: an open moves focus to the opened chat, as the desktop does.
    moveFocusOnOpen: false,
    // plugin.chat-tree.digest.write: digestError throws; else it answers { job } and, when
    // digestEvent(params) gives { digest } or { error }, emits the digest event after the reply.
    // flatEvent: emit the fields at the top level instead of under payload.
    digestError: null,
    digestEvent: undefined,
    flatEvent: false,
    jobs: 0,
    emit: null,
    openSession: async (id, opts) => {
      opened.push([id, opts]);
      order.push(['open', id, opts]);
      if (host.moveFocusOnOpen) {
        state.focusedStoredSessionId.set(id);
        state.focusedSessionId.set(`rt-${id}`);
      }
    },
    revealPane: () => {},
    composer: {
      setDraft: async (id, text) => {
        drafts.push([id, text]);
        order.push(['draft', id, text]);
        return answer('setDraft', host.setDraftResult, [id, text]);
      },
      submit: async (...args) => {
        order.push(['submit', ...args]);
        return true;
      },
    },
    async listPersistedSessions(route, options) {
      calls.push(['listPersistedSessions', route, options]);
      if (host.sessionsError) throw host.sessionsError;
      return { sessions: host.rows, total: host.rows.length };
    },
    async request(method, params) {
      calls.push([method, params]);
      switch (method) {
        case 'subagent.list':
          if (host.agentsError) throw host.agentsError;
          return { subagents: host.agents, delegations: [] };
        case 'session.transcript':
          if (!host.transcript) throw new Error('unknown method: session.transcript');
          return { rows: host.transcript[params.session_id] ?? [], next_cursor: null };
        case 'session.history':
          return { messages: host.history[params.session_id] ?? [] };
        case 'plugin.chat-tree.history.read': {
          if (!host.backend) throw Object.assign(new Error('Method not found'), { code: -32601 });
          if (host.historyReadError) throw host.historyReadError;
          const store = host.store ?? host.history;
          const histories = {};
          const missing = [];
          for (const id of params.session_ids) {
            if (Object.hasOwn(store, id)) histories[id] = store[id];
            else missing.push(id);
          }
          return { histories, missing };
        }
        case 'config.set':
          return answer(method, host.configSet, params);
        case 'session.title':
          return answer(method, host.title ?? { ok: true }, params);
        case 'session.usage':
          return answer(method, host.usage, params);
        case 'session.stats':
          return answer(method, host.stats, params);
        case 'session.context_breakdown':
          return answer(method, host.breakdown, params);
        case 'session.branch':
          order.push(['branch', params]);
          return answer(method, host.branchResult, params);
        case 'prompt.submit':
          order.push(['prompt', params]);
          return answer(method, host.submitResult, params);
        case 'plugin.chat-tree.digest.write': {
          order.push(['digest', params]);
          if (host.digestError) throw host.digestError;
          const job = `job-${++host.jobs}`;
          const body = typeof host.digestEvent === 'function' ? host.digestEvent(params) : null;
          if (body) {
            const event = host.flatEvent
              ? { type: 'plugin.chat-tree.digest.written', job, ...body }
              : { type: 'plugin.chat-tree.digest.written', session_id: params.session_id, payload: { job, ...body } };
            Promise.resolve().then(() => host.emit?.('plugin.chat-tree.digest.written', event));
          }
          return { job };
        }
        default:
          throw new Error(`unexpected ${method}`);
      }
    },
  };
  return host;
}

// ctx.storage as the desktop gives it: synchronous JSON get/set.
function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    get: (key) => (map.has(key) ? structuredClone(map.get(key)) : undefined),
    set: (key, value) => map.set(key, structuredClone(value)),
  };
}

// Hermes's model picker as the SDK gives it, as plain element types. picker: false is an SDK without it.
const PICKER = {
  ModelCatalogMenu: 'ModelCatalogMenu',
  ModelMenuCloseContext: { Provider: 'ModelMenuClose' },
  DropdownMenu: 'DropdownMenu',
  DropdownMenuTrigger: 'DropdownMenuTrigger',
  DropdownMenuContent: 'DropdownMenuContent',
  reasoningEffortLabel: (effort) => ({ high: 'High', none: 'Off' })[effort] ?? effort,
};

// events: false gives a ctx with no onEvent (an older host).
function setup({ host = fakeHost(), clock = fakeClock(), useValue, storage = fakeStorage(), events = true, document, picker = true, deps = {} } = {}) {
  const registered = [];
  const disposers = [];
  // ctx.onEvent as the desktop gives it: listeners by type, a disposer back.
  const listeners = new Map();
  const onEvent = (type, fn) => {
    const set = listeners.get(type) ?? new Set();
    set.add(fn);
    listeners.set(type, set);
    return () => set.delete(fn);
  };
  host.emit = (type, event) => [...(listeners.get(type) ?? [])].forEach((fn) => fn(event));
  const tree = createChatTree({
    host,
    jsx: el,
    jsxs: el,
    atom,
    useValue: useValue ?? ((a) => a.get()),
    Button: 'Button',
    ScrollArea: 'ScrollArea',
    ...(picker ? PICKER : {}),
    ...(document ? { document } : {}),
    ...deps,
  });
  tree.register({
    register: (c) => registered.push(c),
    setTimeout: clock.setTimeout,
    onDispose: (fn) => disposers.push(fn),
    storage,
    ...(events ? { onEvent } : {}),
  });
  return {
    tree,
    host,
    clock,
    storage,
    listeners,
    registered,
    unload: () => disposers.forEach((fn) => fn()),
    pane: registered.find((c) => c.area === 'panes'),
  };
}

function findAll(node, pred, out = []) {
  if (Array.isArray(node)) node.forEach((n) => findAll(n, pred, out));
  else if (node && typeof node === 'object') {
    if (pred(node)) out.push(node);
    findAll(node.props?.children, pred, out);
  }
  return out;
}

const textOf = (node) =>
  findAll(node, () => true)
    .flatMap((n) => (Array.isArray(n.props?.children) ? n.props.children : [n.props?.children]))
    .filter((c) => typeof c === 'string')
    .join('\n');

const byAttr = (tree, name, value) =>
  findAll(tree, (n) => (value === undefined ? n.props?.[name] !== undefined : n.props?.[name] === value));
const nodeRows = (tree) => findAll(tree, (n) => n.props?.['data-node'] !== undefined);
const nodeKeys = (tree) => nodeRows(tree).map((n) => n.props['data-node']);
const nodeOf = (tree, key) => nodeRows(tree).find((n) => n.props['data-node'] === key);
const pills = (node) => byAttr(node, 'data-pill').map((p) => `${p.props['data-pill']}:${p.props.children}`);
// Depth-first chat ids with indent, from lineageChats.
const outline = (tree) => {
  const chats = mod.lineageChats(tree);
  const depth = new Map();
  return chats.map(({ row: r, parentId }) => {
    const d = parentId ? depth.get(parentId) + 1 : 0;
    depth.set(r.id, d);
    return `${'  '.repeat(d)}${r.id}`;
  });
};
// A test timeout cannot stop a synchronous endless loop; the vm watchdog can.
const bounded = (fn) => vm.runInNewContext('fn()', { fn }, { timeout: 2000 });
const listCalls = (host) => host.calls.filter(([m]) => m === 'listPersistedSessions').length;
const historyCalls = (host, id) => host.calls.filter(([m, p]) => m === 'session.history' && (id === undefined || p.session_id === id)).length;
// A plan straight from rows and histories, as the pane builds it.
const planFor = (rows, focusedId, history, options = {}) => {
  const tree = buildTree(rows, focusedId);
  const exchanges = Object.fromEntries(Object.entries(history).map(([id, m]) => [id, mod.exchangesFromRows(m)]));
  const lanes = mod.buildLanes(mod.lineageChats(tree), exchanges);
  return { lanes, plan: mod.planGraph(lanes, { focusedId: tree.focused.id, ...options }) };
};
const keysOf = (plan) => plan.rows.map((r) => r.key);
// The exchange rows only: every row but the name rows at the start of child lanes.
const exKeysOf = (plan) => plan.rows.filter((r) => r.kind !== 'name').map((r) => r.key);
const blueOf = (plan) => plan.rows.filter((r) => r.blue).map((r) => r.key);
const hoverOf = (plan) => plan.rows.filter((r) => r.hover).map((r) => r.key);
// The graph's circles of a rendered pane, by shape key, as [stroke, fill].
const circleColours = (tree) =>
  Object.fromEntries(findAll(byAttr(tree, 'data-graph', 'true')[0], (n) => n.type === 'circle').map((c) => [c.key, [c.props.stroke, c.props.fill]]));
const fakeEvent = (extra = {}) => ({
  stopped: 0,
  prevented: 0,
  stopPropagation() {
    this.stopped += 1;
  },
  preventDefault() {
    this.prevented += 1;
  },
  ...extra,
});

// ── Session tree (unchanged rules) ──────────────────────────────────────────────────────────

test('parent rule: _reset_from wins, then _branched_from, then parent_session_id', () => {
  assert.equal(forkParentId({ _reset_from: 'a', _branched_from: 'b', parent_session_id: 'c' }), undefined);
  assert.equal(forkParentId({ _branched_from: ' b ', parent_session_id: 'c' }), 'b');
  assert.equal(forkParentId({ parent_session_id: 'c' }), 'c');
  assert.equal(forkParentId({}), undefined);
});

test('a _reset_from row is a top-level root, not a child of its predecessor', () => {
  assert.deepEqual(outline(buildTree(ROWS, 'r2')), ['r2']);
  assert.ok(!outline(buildTree(ROWS, 'root')).some((line) => line.trim() === 'r2'));
});

// Server shape (hermes_state_session_list.py:20-44): one row per compression lineage. Its id is
// the tip, `_lineage_root_id` the root, `_lineage_ids` the chain root..tip.
const COMPRESSED = row('tip', {
  _lineage_root_id: 'seg0',
  _lineage_ids: ['seg0', 'seg1', 'tip'],
  continuation_kind: 'compression',
  started_at: 10,
});

test('a branch made from a middle compression segment nests under the lineage row', () => {
  const rows = [COMPRESSED, row('br', { _branched_from: 'seg1', started_at: 50 }), row('br0', { _branched_from: 'seg0', started_at: 40 })];
  assert.deepEqual(outline(buildTree(rows, 'br')), ['tip', '  br0', '  br']);
  // A focused id that is an older segment maps to the lineage row.
  assert.equal(buildTree(rows, 'seg1').focused.id, 'tip');
});

test('stale tips of one lineage in the desktop store collapse to one row', () => {
  const rows = [
    row('seg1', { _lineage_root_id: 'seg0', last_active: 100 }),
    row('seg2', { _lineage_root_id: 'seg0', parent_session_id: 'seg1', last_active: 300 }),
    row('br', { _branched_from: 'seg1', started_at: 50 }),
  ];
  assert.deepEqual(collapseLineages(rows).map((r) => r.id), ['seg2', 'br']);
  assert.deepEqual(outline(buildTree(rows, 'seg1')), ['seg2', '  br']);
});

test('the root walk goes up from a deep branch to the oldest ancestor', () => {
  const tree = buildTree(ROWS, 'b2');
  assert.equal(tree.root.row.id, 'root');
  assert.equal(tree.focused.id, 'b2');
  assert.deepEqual(outline(tree), ['root', '  b3', '  b1', '    b2']);
});

test('the walk stops at a parent that is not in the list, and marks the tree partial', () => {
  const rows = [row('orphan', { _branched_from: 'gone' }), row('kid', { _branched_from: 'orphan' })];
  const tree = buildTree(rows, 'kid');
  assert.deepEqual(outline(tree), ['orphan', '  kid']);
  assert.equal(tree.partial, true);
  assert.equal(buildTree(ROWS, 'b2').partial, false);
});

test('children sort oldest first, with last_active when started_at is missing', () => {
  const rows = [
    row('p', { started_at: 1 }),
    row('late', { _branched_from: 'p', started_at: 50 }),
    row('fallback', { _branched_from: 'p', started_at: 0, last_active: 30 }),
    row('early', { _branched_from: 'p', started_at: 10 }),
  ];
  assert.deepEqual(outline(buildTree(rows, 'p')), ['p', '  early', '  fallback', '  late']);
});

test('a parent cycle ends with no loop and shows each row once', { timeout: 2000 }, () => {
  const rows = [row('a', { _branched_from: 'c' }), row('b', { _branched_from: 'a' }), row('c', { _branched_from: 'b' })];
  const chats = bounded(() => mod.lineageChats(buildTree(rows, 'b')));
  assert.equal(chats.length, 3);
  assert.deepEqual(new Set(chats.map((c) => c.row.id)), new Set(['a', 'b', 'c']));
  const self = [row('s', { _branched_from: 's' })];
  assert.deepEqual(outline(bounded(() => buildTree(self, 's'))), ['s']);
});

test('the focused chat not in the list gives no tree', () => {
  assert.equal(buildTree(ROWS, 'nope'), null);
  assert.deepEqual(mod.lineageChats(null), []);
});

test('lineageChats keeps at most 30 chats, always with the path to the focused chat', () => {
  const rows = [row('p', { started_at: 1 })];
  for (let i = 0; i < 40; i++) rows.push(row(`c${i}`, { _branched_from: 'p', started_at: 10 + i }));
  rows.push(row('deep', { _branched_from: 'c39', started_at: 100 }));
  const chats = mod.lineageChats(buildTree(rows, 'deep'));
  assert.equal(chats.length, mod.MAX_CHATS);
  const ids = chats.map((c) => c.row.id);
  assert.deepEqual(ids.slice(0, 3), ['p', 'c0', 'c1']);
  assert.ok(ids.includes('c39') && ids.includes('deep'));
  // Depth first: deep follows its parent.
  assert.equal(ids.indexOf('deep'), ids.indexOf('c39') + 1);
  assert.equal(mod.lineageChats(buildTree(rows, 'deep'), Infinity).length, 42);
});

test('routeFor builds a full route from the owner; a missing connection id gives null', () => {
  assert.deepEqual(routeFor({ connectionId: 'local', profile: 'work' }), {
    connectionId: 'local',
    mode: 'local',
    profile: 'work',
    targetProfile: 'work',
  });
  assert.equal(routeFor({ connectionId: 'src-a', profile: 'p' }).mode, 'remote');
  assert.equal(routeFor({ connectionId: '', profile: 'p' }), null);
});

test('openOptions keeps owner routing for any intent', () => {
  assert.deepEqual(mod.openOptions({ connectionId: 'local', profile: 'w' }, 'in-place'), { intent: 'in-place', profile: 'w' });
  assert.deepEqual(mod.openOptions({ connectionId: 'src', profile: 'p' }, 'in-place'), {
    intent: 'in-place',
    route: { connectionId: 'src', mode: 'remote', profile: 'p', targetProfile: 'p' },
  });
  assert.deepEqual(mod.openOptions(null), { intent: 'tab' });
});

// ── Exchanges, fork points, merges ───────────────────────────────────────────────────────────

test('exchangesFromRows: one exchange per user message, tool and system rows skipped', () => {
  const rows = [
    { role: 'system', text: 'sys' },
    { role: 'assistant', text: 'orphan answer before any question' },
    { role: 'user', text: 'q1' },
    { role: 'tool', text: 'tool out' },
    { role: 'assistant', text: 'a1 part 1' },
    { role: 'assistant', text: '   ' },
    { role: 'assistant', content: [{ text: 'a1 part 2' }] },
    { role: 'user', content: 'q2\nsecond line' },
    { role: 'user', text: 'q3 still waiting' },
  ];
  assert.deepEqual(mod.exchangesFromRows(rows), [
    { user: 'q1', reply: 'a1 part 1\na1 part 2', label: 'q1', merge: null },
    { user: 'q2\nsecond line', reply: '', label: 'q2 second line', merge: null },
    { user: 'q3 still waiting', reply: '', label: 'q3 still waiting', merge: null },
  ]);
  assert.deepEqual(mod.exchangesFromRows(null), []);
});

test('shortLabel is one line, at most 60 characters, with an ellipsis when cut', () => {
  const long = `${'word '.repeat(30)}end`;
  const label = mod.shortLabel(long);
  assert.equal(label.length <= mod.LABEL_MAX, true);
  assert.ok(label.endsWith('…'));
  assert.doesNotMatch(label, /\n/);
  assert.equal(mod.shortLabel('  a\n\tb  '), 'a b');
  assert.equal(mod.shortLabel(''), '(no text)');
});

test('a merge message is a Merged node; its header runs to the first blank line', () => {
  assert.equal(mod.mergeHeader('From side chat: what is a monad?\n\nYou:\nwhat is a monad?'), 'what is a monad?');
  assert.equal(mod.mergeHeader('From side chat: line one\nline two\n  \nYou:\nq'), 'line one\nline two');
  assert.equal(mod.mergeHeader('From side chat: only a header'), 'only a header');
  assert.equal(mod.mergeHeader('from side chat: lower case'), null);
  assert.equal(mod.mergeHeader('Hello'), null);
  const [merged] = mod.exchangesFromRows([{ role: 'user', text: 'From side chat: line one\nline   two\n\nYou:\nx' }]);
  assert.equal(merged.merge, 'line one line two');
  assert.equal(merged.label, 'Merged: line one line two');
});

test('the fork point is the number of leading exchanges a child shares with its parent', () => {
  const parent = exs(['q1', 'a1'], ['q2', 'a2'], ['q3', 'a3']);
  assert.equal(mod.sharedExchangeCount(exs(['q1', 'a1'], ['q2', 'a2'], ['side', 's']), parent), 2);
  // The same question with a different answer is not shared.
  assert.equal(mod.sharedExchangeCount(exs(['q1', 'a1'], ['q2', 'other']), parent), 1);
  assert.equal(mod.sharedExchangeCount(exs(['x', 'y']), parent), 0);
  assert.equal(mod.sharedExchangeCount(parent, parent), 3);
  assert.equal(mod.sharedExchangeCount(null, parent), 0);
});

test('historyKey moves with the message count or last activity; no metadata means always read', () => {
  assert.equal(mod.historyKey(row('a')), '2:200');
  assert.notEqual(mod.historyKey(row('a', { message_count: 3 })), mod.historyKey(row('a')));
  assert.notEqual(mod.historyKey(row('a', { last_active: 201 })), mod.historyKey(row('a')));
  assert.equal(mod.historyKey({ id: 'a' }), null);
});

// ── Graph plan ──────────────────────────────────────────────────────────────────────────────

test('rows: oldest first, depth first, shared exchanges only on the parent lane', () => {
  const { lanes, plan } = planFor(ROWS, 'b2', HIST);
  assert.deepEqual(lanes.map((l) => [l.id, l.fork]), [['root', 0], ['b3', 1], ['b1', 2], ['b2', 3]]);
  assert.deepEqual(exKeysOf(plan), MAIN_KEYS);
  assert.deepEqual(keysOf(plan), ['root:0', 'name:b3', 'b3:1', 'root:1', 'name:b1', 'b1:2', 'name:b2', 'b2:3', 'root:2']);
  assert.deepEqual(plan.rows.map((r) => r.label), ['q1', 'Side: what is x?', 'what is x?', 'q2', 'b1', 'b1q', 'b2', 'b2q', 'q3']);
  // The first row of each lane carries the lane pills.
  assert.deepEqual(plan.rows.filter((r) => r.first).map((r) => r.key), ['root:0', 'b3:1', 'b1:2', 'b2:3']);
});

test('a fork leaves the parent lane at the last shared exchange', () => {
  const { plan } = planFor(ROWS, 'b2', HIST);
  const lane = (id) => plan.lanes.find((l) => l.id === id);
  // b3 shares q1 (root:0); b1 shares q1 q2 (root:1); b2 shares b1's three (b1:2).
  assert.equal(plan.rows[lane('b3').anchorRow].key, 'root:0');
  assert.equal(plan.rows[lane('b1').anchorRow].key, 'root:1');
  assert.equal(plan.rows[lane('b2').anchorRow].key, 'b1:2');
  assert.equal(lane('root').anchorRow, -1);
  // A child that shares less than its parent shares with the root forks off the root lane.
  const rows = [...ROWS.slice(0, 3), row('x', { _branched_from: 'b1', started_at: 50 })];
  const history = { ...HIST, x: msgs(['q1', 'a1'], ['x own', 'xa']) };
  const nested = planFor(rows, 'x', history).plan;
  const x = nested.lanes.find((l) => l.id === 'x');
  assert.equal(nested.rows[x.anchorRow].key, 'root:0');
  assert.equal(x.anchorCol, 0);
});

test('the blue path runs from the root first exchange through fork points to the open node', () => {
  const { plan } = planFor(ROWS, 'b2', HIST);
  assert.equal(plan.openKey, 'b2:3');
  assert.deepEqual(blueOf(plan), ['root:0', 'root:1', 'name:b1', 'b1:2', 'name:b2', 'b2:3']);
  // Main-chat rows after the fork and the side chat are grey.
  assert.equal(plan.rows.find((r) => r.key === 'root:2').blue, false);
  assert.equal(plan.rows.find((r) => r.key === 'b3:1').blue, false);
  assert.deepEqual(plan.rows.filter((r) => r.open).map((r) => r.key), ['b2:3']);
});

test('the open node defaults to the focused chat last exchange; a clicked node wins while its chat is focused', () => {
  assert.equal(planFor(ROWS, 'root', HIST).plan.openKey, 'root:2');
  assert.deepEqual(blueOf(planFor(ROWS, 'root', HIST).plan), ['root:0', 'root:1', 'root:2']);
  const clicked = planFor(ROWS, 'root', HIST, { open: { chatId: 'root', index: 1 } }).plan;
  assert.equal(clicked.openKey, 'root:1');
  assert.deepEqual(blueOf(clicked), ['root:0', 'root:1']);
  // A clicked node of another chat does not apply once focus moved on.
  assert.equal(planFor(ROWS, 'b1', HIST, { open: { chatId: 'root', index: 1 } }).plan.openKey, 'b1:2');
  // A focused fork with nothing of its own yet opens its stub, right after its fork node.
  const empty = planFor([...ROWS.slice(0, 3)], 'b2', { ...HIST, b2: HIST.b1 }).plan;
  assert.equal(empty.openKey, 'b2:3');
  assert.deepEqual(blueOf(empty), ['root:0', 'root:1', 'name:b1', 'b1:2', 'name:b2', 'b2:3']);
  assert.deepEqual(empty.rows.filter((r) => r.lane === 'b2').map((r) => [r.key, r.stub]), [['name:b2', undefined], ['b2:3', true]]);
});

test('a fork with no exchange of its own draws a stub node at its fork point, then a normal node', () => {
  // nb forks root after q2 and has asked nothing yet: its history is the copied prefix only.
  const rows = [...ROWS, row('nb', { _branched_from: 'root', started_at: 50, title: null })];
  const history = { ...HIST, nb: msgs(['q1', 'a1'], ['q2', 'a2']) };
  const { lanes, plan } = planFor(rows, 'b2', history);
  assert.deepEqual(exKeysOf(plan), ['root:0', 'b3:1', 'root:1', 'b1:2', 'b2:3', 'nb:2', 'root:2']);
  // The stub comes right after its lane's name row.
  assert.equal(keysOf(plan).indexOf('nb:2'), keysOf(plan).indexOf('name:nb') + 1);
  const stub = plan.rows.find((r) => r.key === 'nb:2');
  assert.deepEqual([stub.stub, stub.label, stub.branchable, stub.open], [true, mod.NEW_BRANCH_TEXT, false, false]);
  // Its fork elbow leaves root:1, the exact fork exchange, and runs to the stub.
  const lane = plan.lanes.find((l) => l.id === 'nb');
  assert.equal(plan.rows[lane.anchorRow].key, 'root:1');
  assert.equal(lane.firstRow, keysOf(plan).indexOf('name:nb'));
  const geo = mod.graphGeometry(plan);
  assert.ok(geo.paths.some((p) => p.key === 'fork:nb'));
  assert.ok(geo.circles.some((c) => c.key === 'nb:2'));
  // The Hermes title once it has one; hover on the stub runs to the root.
  const titled = planFor([...ROWS, row('nb', { _branched_from: 'root', started_at: 50, title: 'Why q2' })], 'nb', history, { hovered: 'nb:2' }).plan;
  const open = titled.rows.find((r) => r.key === 'nb:2');
  assert.deepEqual([open.label, open.open, open.hover], ['Why q2', true, true]);
  assert.deepEqual(hoverOf(titled), ['root:0', 'root:1', 'name:nb', 'nb:2']);
  // Its first exchange lands: the same key, now a normal node.
  const asked = planFor(rows, 'nb', { ...history, nb: msgs(['q1', 'a1'], ['q2', 'a2'], ['why?', null]) }).plan;
  const node = asked.rows.find((r) => r.key === 'nb:2');
  assert.deepEqual([node.stub, node.label, node.open], [false, 'why?', true]);
  // A child that shares nothing (an unread history) gets no stub.
  assert.equal(planFor(rows, 'b2', { ...HIST, nb: [] }).plan.rows.some((r) => r.lane === 'nb'), false);
  assert.ok(lanes.some((l) => l.id === 'nb'));
});

test('columns: siblings that fork at one exchange get separate lanes; a finished lane frees its column', () => {
  const rows = [
    row('p', { started_at: 1 }),
    row('c1', { _branched_from: 'p', started_at: 2 }),
    row('c2', { _branched_from: 'p', started_at: 3 }),
    row('c3', { _branched_from: 'p', started_at: 4 }),
  ];
  const history = {
    p: msgs(['q1', 'a1'], ['q2', 'a2'], ['q3', 'a3']),
    c1: msgs(['q1', 'a1'], ['c1 a', 'x'], ['c1 b', 'x']),
    c2: msgs(['q1', 'a1'], ['c2 a', 'x']),
    c3: msgs(['q1', 'a1'], ['q2', 'a2'], ['c3 a', 'x']),
  };
  const { plan } = planFor(rows, 'p', history);
  assert.deepEqual(keysOf(plan), ['p:0', 'name:c1', 'c1:1', 'c1:2', 'name:c2', 'c2:1', 'p:1', 'name:c3', 'c3:2', 'p:2']);
  const col = (id) => plan.lanes.find((l) => l.id === id).col;
  assert.deepEqual([col('p'), col('c1'), col('c2'), col('c3')], [0, 1, 2, 1]);
  assert.ok(plan.rows.every((r) => r.col === col(r.lane)));
});

// Main chat `par`, a side chat `sd` merged back into it, then one more main exchange.
const MERGE_TEXT = 'From side chat: what is a monad?\n\nYou:\nwhat is a monad?\n\nAssistant:\na burrito';
const MERGE_ROWS = [
  row('par', { title: 'Main', started_at: 10 }),
  row('sd', { title: 'Side: what is a monad?', _branched_from: 'par', started_at: 20 }),
];
const MERGE_HIST = {
  par: msgs(['main q', 'main a'], [MERGE_TEXT, 'noted'], ['next q', 'next a']),
  sd: msgs(['main q', 'main a'], ['what is a monad?', 'a burrito']),
};

test('a merge message links to the one child chat whose first own exchange is the side question', () => {
  const { plan } = planFor(MERGE_ROWS, 'par', MERGE_HIST);
  assert.deepEqual(keysOf(plan), ['par:0', 'name:sd', 'sd:1', 'par:1', 'par:2']);
  const merged = plan.rows[3];
  assert.equal(merged.label, 'Merged: what is a monad?');
  assert.equal(merged.mergeFrom, 'sd');
  assert.deepEqual(plan.merges, [{ from: 'sd', fromRow: 2, to: 'par', toRow: 3 }]);
  // The merged side chat is grey; the main path through the merge node is blue.
  assert.deepEqual(blueOf(plan), ['par:0', 'par:1', 'par:2']);
  // The side lane holds its column down to the merge node.
  assert.equal(plan.lanes.find((l) => l.id === 'sd').col, 1);
});

test('no merge curve on zero or several matches, a non-descendant, or a title-only match', () => {
  const noCurve = (rows, history) => {
    const { plan } = planFor(rows, 'par', history);
    const merged = plan.rows.find((r) => r.merge);
    assert.equal(merged.label, 'Merged: what is a monad?');
    assert.equal(merged.mergeFrom, null);
    assert.deepEqual(plan.merges, []);
  };
  // No chat asked that question.
  noCurve(MERGE_ROWS, { ...MERGE_HIST, sd: msgs(['main q', 'main a'], ['something else', 'x']) });
  // Two chats asked it: never guess.
  const twins = [...MERGE_ROWS, row('sd2', { title: 'Side: twin', _branched_from: 'par', started_at: 21 })];
  noCurve(twins, { ...MERGE_HIST, sd2: MERGE_HIST.sd });
  // The title matches the header but the first question does not: titles never count.
  const titled = [MERGE_ROWS[0], row('sd', { title: 'what is a monad?', _branched_from: 'par', started_at: 20 })];
  noCurve(titled, { ...MERGE_HIST, sd: msgs(['main q', 'main a'], ['monads?', 'x']) });
  // A chat with the question that is not below the merge node's chat.
  const rows = [row('top', { started_at: 1 }), row('par', { title: 'Main', _branched_from: 'top', started_at: 10 }), row('other', { _branched_from: 'top', started_at: 30 })];
  const history = {
    top: msgs(['t', 'ta']),
    par: msgs(['t', 'ta'], [MERGE_TEXT, 'noted']),
    other: msgs(['t', 'ta'], ['what is a monad?', 'a burrito']),
  };
  noCurve(rows, history);
});

test('a multi-line side question still links after whitespace normalization', () => {
  const history = {
    par: msgs(['main q', 'main a'], ['From side chat: first line\n  second   line\n\nYou:\n...', 'ok']),
    sd: msgs(['main q', 'main a'], ['first line\nsecond line', 'answer']),
  };
  const { plan } = planFor(MERGE_ROWS, 'par', history);
  assert.equal(plan.rows.find((r) => r.merge).mergeFrom, 'sd');
});

// root with ten exchanges.
const TEN = Array.from({ length: 10 }, (_, i) => [`q${i}`, `a${i}`]);

test('collapse: a run of 3 or more plain exchanges is one +N row; a click key expands it', () => {
  const rows = [row('root')];
  const { plan } = planFor(rows, 'root', { root: msgs(...TEN) });
  assert.deepEqual(keysOf(plan), ['root:0', 'more:root:1', 'root:9']);
  const more = plan.rows[1];
  assert.equal(more.kind, 'more');
  assert.equal(more.count, 8);
  assert.equal(more.runKey, 'root:1');
  assert.equal(more.blue, true);
  const open = planFor(rows, 'root', { root: msgs(...TEN) }, { expanded: { 'root:1': true } }).plan;
  assert.equal(open.rows.length, 10);
  assert.ok(open.rows.every((r) => r.kind === 'node'));
  // Two plain exchanges stay as they are.
  assert.deepEqual(keysOf(planFor(rows, 'root', { root: msgs(...TEN.slice(0, 4)) }).plan), ['root:0', 'root:1', 'root:2', 'root:3']);
});

test('collapse keeps fork points, merge nodes and the open node, and the blue path stays aligned', () => {
  const rows = [row('root', { started_at: 1 }), row('c', { _branched_from: 'root', started_at: 2 })];
  const history = { root: msgs(...TEN), c: msgs(...TEN.slice(0, 5), ['c5', 'x'], ['c6', 'x'], ['c7', 'x']) };
  const { plan } = planFor(rows, 'c', history);
  assert.deepEqual(keysOf(plan), ['root:0', 'more:root:1', 'root:4', 'name:c', 'c:5', 'c:6', 'c:7', 'more:root:5', 'root:9']);
  assert.deepEqual(blueOf(plan), ['root:0', 'more:root:1', 'root:4', 'name:c', 'c:5', 'c:6', 'c:7']);
  assert.equal(plan.rows[7].count, 4);
  // A clicked node in a run stays visible and splits the run.
  const clicked = planFor([row('root')], 'root', { root: msgs(...TEN) }, { open: { chatId: 'root', index: 3 } }).plan;
  assert.deepEqual(keysOf(clicked), ['root:0', 'root:1', 'root:2', 'root:3', 'more:root:4', 'root:9']);
  assert.deepEqual(blueOf(clicked), ['root:0', 'root:1', 'root:2', 'root:3']);
  // A merge node is never folded away.
  const merge = msgs(...TEN.slice(0, 4), [MERGE_TEXT, 'ok'], ...TEN.slice(5));
  const keys = keysOf(planFor([row('root')], 'root', { root: merge }).plan);
  assert.ok(keys.includes('root:4'));
  assert.deepEqual(keys, ['root:0', 'more:root:1', 'root:4', 'more:root:5', 'root:9']);
});

// ── Graph geometry ──────────────────────────────────────────────────────────────────────────

test('geometry: hollow nodes on rows, lane lines between them, rounded fork elbows, roles by path', () => {
  const geo = mod.graphGeometry(planFor(ROWS, 'b2', HIST).plan);
  assert.equal(geo.width, 58);
  // Six exchange rows and three name rows (b3, b1, b2).
  assert.equal(geo.height, 9 * 26);
  assert.deepEqual(
    geo.circles.map((c) => [c.key, c.cx, c.cy, c.role, c.filled]),
    [
      ['root:0', 8, 13, 'active', false],
      ['b3:1', 22, 65, 'inactive', false],
      ['root:1', 8, 91, 'active', false],
      ['b1:2', 22, 143, 'active', false],
      ['b2:3', 36, 195, 'active', true],
      ['root:2', 8, 221, 'inactive', false],
    ],
  );
  assert.ok(geo.circles.every((c) => c.r === 4));
  // Each fork elbow lands on its lane's name row (no circle there); the lane line runs on from it.
  assert.deepEqual(
    geo.paths.map((p) => [p.key, p.d, p.role]),
    [
      ['lane:root:0', 'M 8 17 V 87', 'active'],
      ['lane:root:3', 'M 8 95 V 217', 'inactive'],
      ['lane:b3:1', 'M 22 39 V 61', 'inactive'],
      ['fork:b3', 'M 12 13 H 17 A 5 5 0 0 1 22 18 V 39', 'inactive'],
      ['lane:b1:4', 'M 22 117 V 139', 'active'],
      ['fork:b1', 'M 12 91 H 17 A 5 5 0 0 1 22 96 V 117', 'active'],
      ['lane:b2:6', 'M 36 169 V 191', 'active'],
      ['fork:b2', 'M 26 143 H 31 A 5 5 0 0 1 36 148 V 169', 'active'],
    ],
  );
  // A small square marks each name row, centred on its lane, in its path colour.
  assert.deepEqual(
    geo.marks.map((m) => [m.key, m.x + m.size / 2, m.y + m.size / 2, m.role]),
    [
      ['name:b3', 22, 39, 'inactive'],
      ['name:b1', 22, 117, 'active'],
      ['name:b2', 36, 169, 'active'],
    ],
  );
  // Every shape stays inside the graph column: no line runs over the text.
  const xs = geo.paths.flatMap((p) => [...p.d.matchAll(/(?:M|H|A \d+ \d+ 0 0 [01]) (-?\d+(?:\.\d+)?)/g)].map((m) => Number(m[1])));
  assert.ok(xs.length >= geo.paths.length);
  assert.ok(xs.every((x) => x >= 0 && x <= geo.width));
  assert.ok(geo.circles.every((c) => c.cx + c.r <= geo.width));
});

test('geometry: a merge curve runs down from the side lane last node into the merge node, inactive', () => {
  const geo = mod.graphGeometry(planFor(MERGE_ROWS, 'par', MERGE_HIST).plan);
  const merge = geo.paths.find((p) => p.key.startsWith('merge:'));
  assert.equal(merge.d, 'M 22 69 V 86 A 5 5 0 0 1 17 91 H 12');
  assert.equal(merge.role, 'inactive');
  assert.equal(geo.circles.find((c) => c.key === 'par:2').filled, true);
});

test('geometry: a +N row has no node and the lane line passes through it', () => {
  const geo = mod.graphGeometry(planFor([row('root')], 'root', { root: msgs(...TEN) }).plan);
  assert.deepEqual(geo.circles.map((c) => c.key), ['root:0', 'root:9']);
  assert.deepEqual(geo.paths.map((p) => p.d), ['M 8 17 V 39', 'M 8 39 V 61']);
  assert.ok(geo.paths.every((p) => p.role === 'active'));
});

test('geometry roles: the hovered node path to the root is hover, the open path active, the rest inactive', () => {
  // b3:1 is hovered (the side chat), b2:3 is open. Both paths run through root:0: hover wins there.
  const { plan } = planFor(ROWS, 'b2', HIST, { hovered: 'b3:1' });
  assert.deepEqual(hoverOf(plan), ['root:0', 'name:b3', 'b3:1']);
  assert.deepEqual(blueOf(plan), ['root:0', 'root:1', 'name:b1', 'b1:2', 'name:b2', 'b2:3']);
  const geo = mod.graphGeometry(plan);
  assert.deepEqual(
    geo.circles.map((c) => [c.key, c.role]),
    [
      ['root:0', 'hover'],
      ['b3:1', 'hover'],
      ['root:1', 'active'],
      ['b1:2', 'active'],
      ['b2:3', 'active'],
      ['root:2', 'inactive'],
    ],
  );
  assert.deepEqual(
    geo.paths.map((p) => [p.key, p.role]),
    [
      ['lane:root:0', 'active'],
      ['lane:root:3', 'inactive'],
      ['lane:b3:1', 'hover'],
      ['fork:b3', 'hover'],
      ['lane:b1:4', 'active'],
      ['fork:b1', 'active'],
      ['lane:b2:6', 'active'],
      ['fork:b2', 'active'],
    ],
  );
  // Hover on a deep node runs through its fork elbows and lane lines up to the root's first exchange.
  const deep = mod.graphGeometry(planFor(ROWS, 'b3', HIST, { hovered: 'b2:3' }).plan);
  assert.deepEqual(deep.circles.filter((c) => c.role === 'hover').map((c) => c.key), ['root:0', 'root:1', 'b1:2', 'b2:3']);
  assert.deepEqual(deep.paths.filter((p) => p.role === 'hover').map((p) => p.key), ['lane:root:0', 'lane:b1:4', 'fork:b1', 'lane:b2:6', 'fork:b2']);
  assert.deepEqual(deep.circles.filter((c) => c.role === 'active').map((c) => c.key), ['b3:1']);
  // Hover on the open node: the whole open path is hover, the open node still filled.
  const same = planFor(ROWS, 'b2', HIST, { hovered: 'b2:3' }).plan;
  assert.deepEqual(hoverOf(same), blueOf(same));
  const sameGeo = mod.graphGeometry(same);
  assert.deepEqual(sameGeo.circles.filter((c) => c.role === 'active'), []);
  assert.equal(sameGeo.circles.find((c) => c.key === 'b2:3').filled, true);
  // A +N run on the hover path is hover too.
  const runs = planFor([row('root')], 'root', { root: msgs(...TEN) }, { hovered: 'root:9' }).plan;
  assert.deepEqual(hoverOf(runs), ['root:0', 'more:root:1', 'root:9']);
});

test('geometry roles: no hover, or a key that is not a node, gives the plain roles', () => {
  const plain = mod.graphGeometry(planFor(ROWS, 'b2', HIST).plan);
  assert.ok([...plain.circles, ...plain.paths].every((s) => s.role !== 'hover'));
  for (const hovered of [null, undefined, '', 'b2', 'nope:1', 'b2:99', 'b2:-1', 'b2:x', 7]) {
    assert.deepEqual(mod.graphGeometry(planFor(ROWS, 'b2', HIST, { hovered }).plan), plain, String(hovered));
  }
});

test('geometry: more columns than fit in 58 px widen the graph column', () => {
  const rows = [row('p', { started_at: 1 })];
  const history = { p: msgs(['q', 'a'], ['q2', 'a2']) };
  for (let i = 0; i < 5; i++) {
    rows.push(row(`k${i}`, { _branched_from: 'p', started_at: 2 + i }));
    history[`k${i}`] = msgs(['q', 'a'], [`k${i}`, 'x']);
  }
  const geo = mod.graphGeometry(planFor(rows, 'p', history).plan);
  assert.equal(geo.width, 8 * 2 + 5 * 14);
  assert.ok(geo.circles.every((c) => c.cx + c.r <= geo.width));
});

// ── Pane ──────────────────────────────────────────────────────────────────────────────────────

test('register loads sessions for the owner profile, subagents for the runtime id, and each tree history once', async () => {
  const owner = { connectionId: 'src-a', profile: 'work' };
  const ctx = setup({ host: fakeHost({ owner, active: owner }) });
  await flush();
  const [, route, options] = ctx.host.calls.find(([m]) => m === 'listPersistedSessions');
  assert.deepEqual(options, { profile: 'work', limit: LIST_LIMIT });
  assert.equal(route.connectionId, 'src-a');
  assert.deepEqual(ctx.host.calls.find(([m]) => m === 'subagent.list'), ['subagent.list', { session_id: 'rt-b2' }]);
  for (const id of ['root', 'b1', 'b2', 'b3']) assert.equal(historyCalls(ctx.host, id), 1, id);
  assert.equal(historyCalls(ctx.host, 'r2'), 0);
  ctx.unload();
});

test('a history is not read again on refresh while its chat is unchanged; the open chat always is', async () => {
  const ctx = setup();
  await flush();
  assert.equal(historyCalls(ctx.host), 4);
  await ctx.clock.tick(REFRESH_MS * 2);
  assert.equal(listCalls(ctx.host), 3);
  for (const id of ['root', 'b1', 'b3']) assert.equal(historyCalls(ctx.host, id), 1, id);
  // The open chat skips the cache: its message count lags a live turn.
  assert.equal(historyCalls(ctx.host, 'b2'), 3);
  ctx.host.history.b2 = [...HIST.b2, { role: 'user', text: 'live question' }];
  await ctx.clock.tick(REFRESH_MS);
  assert.ok(nodeKeys(ctx.pane.render()).includes('b2:4'));
  // b1 got a new message: b1 is read again (and the open chat).
  ctx.host.rows = ROWS.map((r) => (r.id === 'b1' ? { ...r, message_count: 4 } : r));
  ctx.host.history.b1 = [...HIST.b1, { role: 'user', text: 'b1 more' }];
  await ctx.clock.tick(REFRESH_MS);
  assert.equal(historyCalls(ctx.host, 'b1'), 2);
  assert.equal(historyCalls(ctx.host, 'root'), 1);
  assert.ok(nodeKeys(ctx.pane.render()).includes('b1:3'));
  ctx.unload();
});

test('a tree event reloads once, 300 ms after the last of a burst, and reads the chats it names', async () => {
  const ctx = setup();
  await flush();
  for (const type of mod.RELOAD_EVENTS) assert.equal(ctx.listeners.get(type)?.size, 1, type);
  const lists = listCalls(ctx.host);
  ctx.host.emit('message.start', { type: 'message.start', session_id: 'rt-b2' });
  await ctx.clock.tick(200);
  ctx.host.emit('message.complete', { type: 'message.complete', session_id: 'b1' });
  ctx.host.emit('sessions.changed', { type: 'sessions.changed' });
  await ctx.clock.tick(mod.RELOAD_DEBOUNCE_MS - 1);
  assert.equal(listCalls(ctx.host), lists);
  await ctx.clock.tick(1);
  assert.equal(listCalls(ctx.host), lists + 1);
  // b1 was named: read again although its message count did not move. root and b3 were not.
  assert.equal(historyCalls(ctx.host, 'b1'), 2);
  assert.equal(historyCalls(ctx.host, 'root'), 1);
  assert.equal(historyCalls(ctx.host, 'b3'), 1);
  // A name is read once: the next load uses the cache for it again.
  ctx.host.emit('session.title', { type: 'session.title', payload: {} });
  await ctx.clock.tick(mod.RELOAD_DEBOUNCE_MS);
  assert.equal(listCalls(ctx.host), lists + 2);
  assert.equal(historyCalls(ctx.host, 'b1'), 2);
  // A new fork shows at once: the event's reload draws its stub at the fork point.
  ctx.host.rows = [...ROWS, row('nb', { _branched_from: 'b2', started_at: 50, title: null })];
  ctx.host.history.nb = HIST.b2;
  ctx.host.emit('sessions.changed', { type: 'sessions.changed' });
  await ctx.clock.tick(mod.RELOAD_DEBOUNCE_MS);
  const stub = nodeOf(ctx.pane.render(), 'nb:4');
  assert.equal(stub.props['data-stub'], 'true');
  assert.equal(stub.props.children[0].props.children, mod.NEW_BRANCH_TEXT);
  // After unload, events do nothing.
  ctx.unload();
  const after = listCalls(ctx.host);
  ctx.host.emit('sessions.changed', { type: 'sessions.changed' });
  await ctx.clock.tick(mod.RELOAD_DEBOUNCE_MS * 2);
  assert.equal(listCalls(ctx.host), after);
  for (const type of mod.RELOAD_EVENTS) assert.equal(ctx.listeners.get(type)?.size ?? 0, 0, type);
});

test('the pane draws one row per exchange with the lane pills and the open node', async () => {
  const ctx = setup();
  await flush();
  const tree = ctx.pane.render();
  assert.deepEqual(nodeKeys(tree), MAIN_KEYS);
  // The model pill is on the open node only; the side pill stays on a side lane's first row.
  assert.deepEqual(pills(nodeOf(tree, 'root:0')), []);
  assert.deepEqual(pills(nodeOf(tree, 'b3:1')), ['side:side']);
  assert.deepEqual(pills(nodeOf(tree, 'b1:2')), []);
  assert.deepEqual(pills(nodeOf(tree, 'root:1')), []);
  assert.deepEqual(pills(nodeOf(tree, 'b2:3')), ['model:m1']);
  // The open node: filled circle, row highlight, left accent.
  const open = nodeOf(tree, 'b2:3');
  assert.equal(open.props['data-open'], 'true');
  assert.ok(open.props.style.background);
  assert.match(open.props.style.boxShadow, /inset 2px 0 0/);
  assert.equal(nodeRows(tree).filter((n) => n.props['data-open']).length, 1);
  const svg = byAttr(tree, 'data-graph', 'true')[0];
  assert.equal(svg.props['aria-hidden'], 'true');
  assert.equal(svg.props.style.pointerEvents, 'none');
  const circles = findAll(svg, (n) => n.type === 'circle');
  assert.equal(circles.filter((c) => c.props.fill !== 'none').length, 1);
  // Rows are one line: fixed height, ellipsis, and the graph column as left padding.
  for (const n of nodeRows(tree)) {
    assert.equal(n.props.style.height, 26);
    assert.equal(n.props.style.paddingLeft, 60);
    const label = n.props.children[0];
    assert.equal(label.props.style.textOverflow, 'ellipsis');
    assert.equal(label.props.style.whiteSpace, 'nowrap');
  }
  // Two theme colours with no hover: every stroke and fill is a Hermes variable with a fallback.
  const shapes = findAll(svg, (n) => n.type === 'path' || n.type === 'circle');
  const colours = new Set(shapes.map((n) => n.props.stroke));
  assert.deepEqual([...colours].sort(), [ACCENT, MUTED].sort());
  for (const n of shapes) {
    assert.match(n.props.stroke, /^var\(--[a-z-]+, [^)]+\)$/);
    if (n.props.fill !== 'none') assert.match(n.props.fill, /^var\(--[a-z-]+, [^)]+\)$/);
  }
  assert.equal(circles.find((c) => c.props.fill !== 'none').props.fill, ACCENT);
  // The open row band and left accent are the theme accent too.
  assert.equal(open.props.style.background, `color-mix(in srgb, ${ACCENT} 14%, transparent)`);
  assert.equal(open.props.style.boxShadow, `inset 2px 0 0 ${ACCENT}`);
  ctx.unload();
});

test('the tooltip shows title · model, and side chat of X for a side chat', async () => {
  const ctx = setup();
  await flush();
  const tree = ctx.pane.render();
  assert.equal(nodeOf(tree, 'root:0').props.title, 'root · m1');
  assert.equal(nodeOf(tree, 'b3:1').props.title, 'Side: what is x? · m1\nside chat of root');
  ctx.unload();
  const untitled = setup({ host: fakeHost({ rows: [row('u', { title: null })], stored: 'u', history: { u: msgs(['hi', 'yo']) } }) });
  await flush();
  assert.equal(nodeOf(untitled.pane.render(), 'u:0').props.title, 'Untitled · m1');
  untitled.unload();
});

test('a click on a node makes it the open node and opens its chat in place for the owner', async () => {
  const ctx = setup();
  await flush();
  nodeOf(ctx.pane.render(), 'b1:2').props.onClick();
  await flush();
  assert.deepEqual(ctx.host.opened, [['b1', { intent: 'in-place', profile: 'default' }]]);
  assert.deepEqual(ctx.tree.$ui.get().open, { chatId: 'b1', index: 2 });
  // The host moves focus to b1: the clicked node is open, the path to it is blue.
  ctx.host.state.focusedStoredSessionId.set('b1');
  ctx.host.state.focusedSessionId.set('rt-b1');
  await flush();
  const tree = ctx.pane.render();
  assert.equal(nodeOf(tree, 'b1:2').props['data-open'], 'true');
  assert.deepEqual(nodeRows(tree).filter((n) => n.props['data-blue']).map((n) => n.props['data-node']), ['root:0', 'root:1', 'b1:2']);
  // Enter on a row acts like a click.
  const event = fakeEvent({ key: 'Enter' });
  nodeOf(tree, 'root:0').props.onKeyDown(event);
  await flush();
  assert.equal(event.prevented, 1);
  assert.deepEqual(ctx.host.opened.at(-1), ['root', { intent: 'in-place', profile: 'default' }]);
  ctx.unload();

  const owner = { connectionId: 'src-a', profile: 'p' };
  const remote = setup({ host: fakeHost({ owner, active: owner }) });
  await flush();
  nodeOf(remote.pane.render(), 'root:0').props.onClick();
  await flush();
  assert.deepEqual(remote.host.opened, [
    ['root', { intent: 'in-place', route: { connectionId: 'src-a', mode: 'remote', profile: 'p', targetProfile: 'p' } }],
  ]);
  remote.unload();
});

test('a +N row expands its run on click, without opening a chat', async () => {
  const ctx = setup({ host: fakeHost({ rows: [row('root')], stored: 'root', runtime: 'rt-root', history: { root: msgs(...TEN) } }) });
  await flush();
  let tree = ctx.pane.render();
  assert.deepEqual(nodeKeys(tree), ['root:0', 'root:9']);
  const more = byAttr(tree, 'data-more', 'root:1')[0];
  assert.match(textOf(more), /^\+8$/);
  assert.equal(more.props['aria-expanded'], false);
  more.props.onClick();
  tree = ctx.pane.render();
  assert.equal(nodeKeys(tree).length, 10);
  assert.equal(byAttr(tree, 'data-more').length, 0);
  await flush();
  assert.deepEqual(ctx.host.opened, []);
  ctx.unload();
});

test('a merged side chat shows a Merged node on the parent lane with a muted curve', async () => {
  const ctx = setup({ host: fakeHost({ rows: MERGE_ROWS, stored: 'par', runtime: 'rt-par', history: MERGE_HIST }) });
  await flush();
  const tree = ctx.pane.render();
  const merged = nodeOf(tree, 'par:1');
  assert.equal(merged.props['data-merge-node'], 'sd');
  assert.equal(merged.props.children[0].props.children, 'Merged: what is a monad?');
  const curve = findAll(byAttr(tree, 'data-graph', 'true')[0], (n) => n.type === 'path' && n.key === 'merge:sd:3')[0];
  assert.equal(curve.props.stroke, MUTED);
  ctx.unload();
});

test('the pointer on a row draws its path to the root in the hover colour; leaving restores it; nothing is read', async () => {
  const ctx = setup();
  await flush();
  const before = circleColours(ctx.pane.render());
  const rowsBefore = JSON.stringify(nodeRows(ctx.pane.render()));
  const calls = ctx.host.calls.length;
  assert.equal(ctx.tree.$hover.get().pointer, null);
  nodeOf(ctx.pane.render(), 'b3:1').props.onMouseEnter();
  const hovered = circleColours(ctx.pane.render());
  assert.deepEqual(hovered['c:b3:1'], [HOVER, 'none']);
  assert.deepEqual(hovered['c:root:0'], [HOVER, 'none']); // on both paths: hover wins
  assert.deepEqual(hovered['c:root:1'], [ACCENT, 'none']);
  assert.deepEqual(hovered['c:b2:3'], [ACCENT, ACCENT]);
  assert.deepEqual(hovered['c:root:2'], [MUTED, 'none']);
  const svg = byAttr(ctx.pane.render(), 'data-graph', 'true')[0];
  const fork = findAll(svg, (n) => n.key === 'fork:b3')[0];
  assert.equal(fork.props.stroke, HOVER);
  assert.equal(fork.props['data-role'], 'hover');
  // Only the SVG and the hovered row (its Branch button shows) changed, and nothing was read.
  const others = (rows) => JSON.stringify(rows.filter((r) => r.props['data-node'] !== 'b3:1'));
  assert.equal(others(nodeRows(ctx.pane.render())), others(JSON.parse(rowsBefore)));
  // A leave from another row keeps the hover; a leave from the hovered row clears it.
  nodeOf(ctx.pane.render(), 'root:2').props.onMouseLeave();
  assert.deepEqual(circleColours(ctx.pane.render()), hovered);
  nodeOf(ctx.pane.render(), 'b3:1').props.onMouseLeave();
  assert.deepEqual(circleColours(ctx.pane.render()), before);
  // Hovering the open node: the open fill takes the hover colour while the pointer is there.
  nodeOf(ctx.pane.render(), 'b2:3').props.onMouseEnter();
  assert.deepEqual(circleColours(ctx.pane.render())['c:b2:3'], [HOVER, HOVER]);
  nodeOf(ctx.pane.render(), 'b2:3').props.onMouseLeave();
  assert.deepEqual(circleColours(ctx.pane.render()), before);
  assert.equal(ctx.host.calls.length, calls);
  assert.deepEqual(ctx.host.opened, []);
  ctx.unload();
});

test('live subagents appear below the graph; a click opens a subagent child session in a tab', async () => {
  const agents = [
    { subagent_id: 'sa1', goal: 'find docs', status: 'running', model: 'm2', child_session_id: 'child-1' },
    { subagent_id: 'sa2', goal: 'idle one', status: 'queued', model: null, child_session_id: null },
  ];
  const ctx = setup({ host: fakeHost({ agents }) });
  await flush();
  const tree = ctx.pane.render();
  const ids = findAll(tree, (n) => n.props?.['data-node'] || n.props?.['data-subagent-id']).map(
    (n) => n.props['data-node'] ?? `@${n.props['data-subagent-id']}`,
  );
  assert.deepEqual(ids, [...MAIN_KEYS, '@sa1', '@sa2']);
  const text = textOf(tree);
  assert.match(text, /find docs/);
  assert.match(text, /running · m2/);
  const [sa1, sa2] = findAll(tree, (n) => n.props?.['data-subagent-id']);
  sa1.props.onClick();
  assert.equal(sa2.props.onClick, undefined);
  await flush();
  assert.deepEqual(ctx.host.opened, [['child-1', { intent: 'tab', profile: 'default' }]]);
  ctx.unload();
});

test('the pane loads again on focus change, every 15 s, and on Refresh', async () => {
  const ctx = setup();
  await flush();
  assert.equal(listCalls(ctx.host), 1);
  ctx.host.state.focusedStoredSessionId.set('b1');
  await flush();
  assert.equal(listCalls(ctx.host), 2);
  // An owner atom recomputed to an equal value does not load again.
  ctx.host.state.focusedSessionOwner.set({ connectionId: 'local', profile: 'default' });
  await flush();
  assert.equal(listCalls(ctx.host), 2);
  await ctx.clock.tick(REFRESH_MS);
  assert.equal(listCalls(ctx.host), 3);
  await ctx.clock.tick(REFRESH_MS * 2);
  assert.equal(listCalls(ctx.host), 5);
  byAttr(ctx.pane.render(), 'data-refresh')[0].props.onClick(fakeEvent());
  await flush();
  assert.equal(listCalls(ctx.host), 6);
  // The same tree: only the open chat (b1 since the focus change) was read again, once per load.
  for (const id of ['root', 'b2', 'b3']) assert.equal(historyCalls(ctx.host, id), 1, id);
  assert.equal(historyCalls(ctx.host, 'b1'), 6);
  ctx.unload();
});

test('one graph only: no breadcrumb, minimap, or disclosure (the view toggle is the only switch)', async () => {
  const ctx = setup();
  await flush();
  const tree = ctx.pane.render();
  for (const attr of ['data-view-toggle', 'data-breadcrumb', 'data-minimap', 'data-disclosure', 'data-fork-count', 'data-kind']) {
    assert.equal(byAttr(tree, attr).length, 0, attr);
  }
  ctx.unload();
});

test('timers and listeners stop after dispose', async () => {
  const ctx = setup();
  await flush();
  assert.equal(ctx.clock.pending(), 1);
  ctx.unload();
  assert.equal(ctx.clock.pending(), 0);
  const before = ctx.host.calls.length;
  await ctx.clock.tick(REFRESH_MS * 5);
  ctx.host.state.focusedStoredSessionId.set('b1');
  await flush();
  assert.equal(ctx.host.calls.length, before);
  assert.equal(ctx.host.state.focusedStoredSessionId.listeners(), 0);
  assert.equal(ctx.host.state.focusedSessionOwner.listeners(), 0);
});

test('a failed call shows the error text and keeps the last good tree', async () => {
  const ctx = setup();
  await flush();
  ctx.host.sessionsError = new Error('gateway not ready');
  ctx.host.rows = [];
  await ctx.clock.tick(REFRESH_MS);
  const tree = ctx.pane.render();
  assert.match(textOf(tree), /gateway not ready/);
  assert.deepEqual(nodeKeys(tree), MAIN_KEYS);
  ctx.host.sessionsError = null;
  ctx.host.rows = ROWS;
  await ctx.clock.tick(REFRESH_MS);
  assert.doesNotMatch(textOf(ctx.pane.render()), /gateway not ready/);
  ctx.unload();
});

test('a failed history read shows its error and keeps the last good exchanges', async () => {
  const ctx = setup();
  await flush();
  const base = ctx.host.request;
  ctx.host.request = async (method, params) => {
    if (method === 'session.history' && params.session_id === 'b1') throw new Error('b1 gone');
    return base(method, params);
  };
  ctx.host.rows = ROWS.map((r) => (r.id === 'b1' ? { ...r, message_count: 9 } : r));
  await ctx.clock.tick(REFRESH_MS);
  const tree = ctx.pane.render();
  assert.match(textOf(tree), /History of b1: b1 gone/);
  assert.deepEqual(nodeKeys(tree), MAIN_KEYS);
  ctx.unload();
});

test('an unknown owner profile shows an error and reads no sessions', async () => {
  const ctx = setup({ host: fakeHost({ owner: null }) });
  await flush();
  assert.equal(listCalls(ctx.host), 0);
  assert.match(textOf(ctx.pane.render()), /profile of this chat is unknown/);
  ctx.unload();
});

test('an older reply that lands after a newer one is dropped', async () => {
  const host = fakeHost();
  const base = host.listPersistedSessions;
  const pending = [];
  host.listPersistedSessions = (route, options) =>
    new Promise((resolve) => pending.push(() => resolve(base(route, options))));
  const ctx = setup({ host });
  host.state.focusedStoredSessionId.set('b1');
  host.rows = [row('b1')];
  pending[1]();
  await flush();
  host.rows = ROWS;
  pending[0]();
  await flush();
  assert.deepEqual(ctx.tree.$data.get().rows.map((r) => r.id), ['b1']);
  ctx.unload();
});

test('all pane text allows selection', async () => {
  const ctx = setup({ host: fakeHost({ agents: [{ subagent_id: 'sa', goal: 'g', status: 'running' }] }) });
  await flush();
  const tree = ctx.pane.render();
  const outer = tree.props.children;
  assert.equal(outer.props.style.userSelect, 'text');
  assert.equal(outer.props['data-selectable-text'], 'true');
  const nodes = findAll(tree, (n) => n.props?.['data-node'] || n.props?.['data-subagent-id']);
  for (const n of nodes) {
    assert.equal(n.props.style.userSelect, 'text');
    assert.equal(n.props['data-selectable-text'], 'true');
  }
  for (const span of findAll(tree, (n) => n.type === 'span')) assert.equal(span.props.style.userSelect, 'text');
  ctx.unload();
});

test('render never writes state and calls the host for nothing', async () => {
  const ctx = setup();
  await flush();
  let sets = 0;
  for (const a of [ctx.tree.$data, ctx.tree.$status, ctx.tree.$ui, ctx.tree.$hover]) {
    const orig = a.set;
    a.set = (v) => {
      sets += 1;
      orig(v);
    };
  }
  const before = ctx.host.calls.length;
  ctx.pane.render();
  ctx.pane.render();
  assert.equal(sets, 0);
  assert.equal(ctx.host.calls.length, before);
  ctx.unload();
});

test('each render calls the same hooks in the same order (React error 300)', async () => {
  const log = [];
  const useValue = (a) => {
    log.push(a);
    return a.get();
  };
  const host = fakeHost({ stored: null, runtime: null });
  const ctx = setup({ host, useValue });
  const order = () => {
    log.length = 0;
    ctx.pane.render();
    return [...log];
  };
  const states = [order()]; // no chat
  host.state.focusedStoredSessionId.set('b2');
  host.state.focusedSessionId.set('rt-b2');
  states.push(order()); // loading
  await flush();
  states.push(order()); // tree
  host.agents = [{ subagent_id: 'sa', goal: 'g' }];
  await ctx.clock.tick(REFRESH_MS);
  states.push(order()); // tree with a subagent
  byAttr(ctx.pane.render(), 'data-node', 'root:0')[0].props.onClick();
  states.push(order()); // a clicked node
  nodeOf(ctx.pane.render(), 'b3:1').props.onMouseEnter();
  states.push(order()); // a hovered node
  nodeOf(ctx.pane.render(), 'b1:2').props.onFocus({});
  states.push(order()); // a hovered node and a focused row
  nodeOf(ctx.pane.render(), 'b3:1').props.onMouseLeave();
  states.push(order()); // the pointer left
  host.sessionsError = new Error('x');
  await ctx.clock.tick(REFRESH_MS);
  states.push(order()); // error
  host.state.focusedStoredSessionId.set('missing');
  await flush();
  states.push(order()); // not in list
  // Four host atoms (busyBySession included), two data atoms, then the in-memory $ui and $hover atoms.
  for (const s of states) {
    assert.equal(s.length, 8);
    assert.deepEqual(s, states[0]);
  }
  assert.equal(states[0][3], host.state.busyBySession);
  assert.equal(states[0][6], ctx.tree.$ui);
  assert.equal(states[0][7], ctx.tree.$hover);
  ctx.unload();
});

test('a source slower than the refresh period still shows its tree', async () => {
  const host = fakeHost();
  const base = host.listPersistedSessions;
  const clock = fakeClock();
  host.listPersistedSessions = (route, options) =>
    new Promise((resolve) => clock.setTimeout(() => resolve(base(route, options)), 20_000));
  const ctx = setup({ host, clock });
  await clock.tick(55_000); // loads at 0-20 s and 30-50 s; the ticks at 15 s and 45 s are skipped
  assert.equal(ctx.tree.$data.get().rows.length, ROWS.length);
  assert.equal(ctx.tree.$status.get().loading, false);
  ctx.unload();
});

test('register after dispose (disable, then enable) works again with fresh UI state', async () => {
  const host = fakeHost({ rows: [row('root')], stored: 'root', runtime: 'rt-root', history: { root: msgs(...TEN) } });
  const clock = fakeClock();
  const ctx = setup({ host, clock });
  await flush();
  byAttr(ctx.pane.render(), 'data-more', 'root:1')[0].props.onClick();
  nodeOf(ctx.pane.render(), 'root:4').props.onClick();
  assert.deepEqual(ctx.tree.$ui.get().open, { chatId: 'root', index: 4 });
  ctx.unload();
  const disposers = [];
  ctx.tree.register({ register: () => {}, setTimeout: clock.setTimeout, onDispose: (fn) => disposers.push(fn) });
  await flush();
  assert.deepEqual(ctx.tree.$ui.get(), { open: null, expanded: {}, pick: null, result: null, branch: null, forkNotice: null, mode: 'exchanges', rename: null });
  assert.deepEqual(nodeKeys(ctx.pane.render()), ['root:0', 'root:9']);
  const before = listCalls(host);
  host.state.focusedStoredSessionId.set('root2');
  await flush();
  assert.equal(listCalls(host), before + 1);
  await clock.tick(REFRESH_MS);
  assert.equal(listCalls(host), before + 2);
  // One listener per atom, not two.
  assert.equal(host.state.focusedStoredSessionId.listeners(), 1);
  disposers.forEach((fn) => fn());
  assert.equal(clock.pending(), 0);
});

test('a focused chat missing from a full page says older chats are not loaded', async () => {
  const rows = Array.from({ length: LIST_LIMIT }, (_, i) => row(`n${i}`));
  const ctx = setup({ host: fakeHost({ rows, stored: 'old' }) });
  await flush();
  const text = textOf(ctx.pane.render());
  assert.match(text, /older than the newest 500/);
  assert.doesNotMatch(text, /not in the session list yet/);
  ctx.unload();
});

test('a tree whose top parent is missing shows a partial note', async () => {
  const rows = [row('orphan', { _branched_from: 'gone' }), row('kid', { _branched_from: 'orphan' })];
  const ctx = setup({ host: fakeHost({ rows, stored: 'kid' }) });
  await flush();
  assert.match(textOf(ctx.pane.render()), /Partial tree/);
  ctx.unload();
});

test('a tree with no messages says so', async () => {
  const ctx = setup({ host: fakeHost({ history: {} }) });
  await flush();
  assert.match(textOf(ctx.pane.render()), /No messages in this chat tree yet/);
  ctx.unload();
});

test('a retitled side branch shows the side pill only after its id is recorded', async () => {
  const titled = setup();
  await flush();
  assert.ok(pills(nodeOf(titled.pane.render(), 'b3:1')).includes('side:side'));
  assert.equal(isSideChat({ id: 'b3', title: 'Side: what is x?' }), true);
  titled.unload();

  const id = 'local-90c423bb';
  const ctx = setup({ host: fakeHost({ rows: [row(id, { title: 'Explain virtualenv' })], stored: id, runtime: 'rt-venv', history: { [id]: msgs(['q', 'a']) } }) });
  await flush();
  assert.deepEqual(pills(nodeOf(ctx.pane.render(), `${id}:0`)), ['model:m1']);
  assert.equal(isSideChat({ id, title: 'Explain virtualenv' }), false);
  rememberSideBranch(id);
  assert.deepEqual(pills(nodeOf(ctx.pane.render(), `${id}:0`)), ['model:m1', 'side:side']);
  assert.equal(isSideChat({ id, title: 'Explain virtualenv' }), true);
  ctx.unload();
});

test('subagents and histories of a chat on another profile or connection are not requested', async () => {
  const agents = [{ subagent_id: 'sa', goal: 'g', status: 'running' }];
  const ctx = setup({ host: fakeHost({ agents, owner: { connectionId: 'local', profile: 'other' } }) });
  await flush();
  assert.equal(ctx.host.calls.filter(([m]) => m === 'subagent.list').length, 0);
  assert.equal(historyCalls(ctx.host), 0);
  const tree = ctx.pane.render();
  assert.match(textOf(tree), /unavailable for a chat of another profile or connection/);
  assert.equal(findAll(tree, (n) => n.props?.['data-subagent-id']).length, 0);
  ctx.unload();
});

// ── Merge-back helpers (unchanged) ─────────────────────────────────────────────────────────

test('estimateTokens is the ASCII (len+3)//4 count and 0 for empty text', () => {
  assert.equal(mod.estimateTokens('abcd'), 1);
  assert.equal(mod.estimateTokens('abc'), 1);
  assert.equal(mod.estimateTokens('abcde'), 2);
  assert.equal(mod.estimateTokens(''), 0);
  assert.equal(mod.estimateTokens(undefined), 0);
});

test('parseContextHeadroom reads TUI usage, nested usage, and canonical stats', () => {
  assert.deepEqual(mod.parseContextHeadroom({ context_used: 1000, context_max: 128000 }), {
    used: 1000,
    max: 128000,
    available: 127000,
    estimated: false,
  });
  assert.equal(mod.parseContextHeadroom({ usage: { context_used: 5, context_max: 50 } }).available, 45);
  assert.equal(mod.parseContextHeadroom({ usage_stats: { context_used: 5, context_max: 50 } }).max, 50);
  assert.deepEqual(mod.parseContextHeadroom({ last_prompt_tokens: 500, context_length: 8000 }), {
    used: 500,
    max: 8000,
    available: 7500,
    estimated: false,
  });
  assert.equal(mod.parseContextHeadroom({ context_tokens: 7, context_length: 10 }).used, 7);
  assert.equal(mod.parseContextHeadroom({ context_used: 9000, context_max: 8000 }).available, 0);
  assert.equal(mod.parseContextHeadroom({ context_max: 100, context_estimated: true }).estimated, true);
  assert.equal(mod.parseContextHeadroom({ context_max: 100, context_source: 'rough' }).estimated, true);
  assert.equal(mod.parseContextHeadroom({ context_max: 100, context_source: 'provider_usage' }).estimated, false);
  // No positive max: no window.
  assert.equal(mod.parseContextHeadroom({ calls: 1, input: 2, output: 3, total: 5 }), null);
  assert.equal(mod.parseContextHeadroom({ context_max: 0, context_used: 1 }), null);
  assert.equal(mod.parseContextHeadroom(null), null);
});

test('rowText takes trimmed text, then string content, then joined part text', () => {
  assert.equal(mod.rowText({ text: '  hi  ' }), 'hi');
  assert.equal(mod.rowText({ content: ' c ' }), 'c');
  assert.equal(mod.rowText({ content: [{ text: 'a' }, { type: 'image' }, { text: 'b ' }] }), 'ab');
  assert.equal(mod.rowText({ text: '   ', content: 'fallback' }), 'fallback');
  assert.equal(mod.rowText(null), '');
});

test('formatNoFitNotice and formatMissingWindowNotice use the side-chat wording', () => {
  assert.equal(
    mod.formatNoFitNotice({ sideTokens: 12400, available: 3200, used: 124800, max: 128000, sideEstimated: true }),
    "Doesn't fit: side chat is 12,400 tokens (estimated), parent has 3,200 available (124,800 used of 128,000).",
  );
  assert.equal(
    mod.formatNoFitNotice({ sideTokens: 5, available: 1, used: 9, max: 10, sideEstimated: true, windowEstimated: true }),
    "Doesn't fit: side chat is 5 tokens (estimated), parent has 1 available (9 used of 10, estimated).",
  );
  assert.equal(
    mod.formatMissingWindowNotice(1234),
    `${MERGE_STAGED_TEXT} Side chat is about 1,234 tokens (estimated). The parent context window was not reported.`,
  );
});


test('formatNoFitNotice names the button and the target when given', () => {
  assert.equal(
    mod.formatNoFitNotice({ sideTokens: 20, available: 10, used: 127990, max: 128000, sideEstimated: true, mode: 'Digest', target: 'Main' }),
    "Doesn't fit (Digest): side chat is 20 tokens (estimated), Main has 10 available (127,990 used of 128,000).",
  );
});

test('stripConceptMarkup (copied from side-chat) keeps the plain sentence, and code as written', () => {
  assert.equal(mod.stripConceptMarkup('A [[monad|a type]] wraps values.'), 'A monad wraps values.');
  assert.equal(mod.stripConceptMarkup('::termline{v="Plain sentence." t="x"}'), 'Plain sentence.');
  assert.equal(mod.stripConceptMarkup('Use `[[ a || b ]]` here.'), 'Use `[[ a || b ]]` here.');
  assert.equal(mod.stripConceptMarkup(null), '');
});

// ── Branch here: the count mapping ──────────────────────────────────────────────────────────

test('branchCount: user and assistant rows with text, through the exchange last answer', () => {
  const rows = [
    { role: 'assistant', text: 'hello, how can I help?' }, // a greeting: the gateway keeps it
    { role: 'user', text: 'q1', row_id: 11 },
    { role: 'assistant', text: 'a1', row_id: 12 },
    { role: 'user', text: 'q2', row_id: 13 },
    { role: 'assistant', text: '', row_id: 14 }, // a tool call with no text
    { role: 'tool', text: 'tool out', row_id: 15 },
    { role: 'assistant', content: [{ text: 'a2' }], row_id: 16 },
    { role: 'system', text: 'note' },
    { role: 'user', text: '   ', row_id: 17 }, // an empty user row is an exchange, not a counted row
    { role: 'assistant', text: 'a3', row_id: 18 },
    { role: 'user', text: 'q4 never answered', row_id: 19 },
  ];
  assert.deepEqual(mod.branchCount(rows, 0), { count: 3, through: 12 });
  assert.deepEqual(mod.branchCount(rows, 1), { count: 5, through: 16 });
  assert.deepEqual(mod.branchCount(rows, 2), { count: 6, through: 18 });
  // No answer yet, past the end, or a bad index: no branch.
  assert.equal(mod.branchCount(rows, 3), null);
  assert.equal(mod.branchCount(rows, 4), null);
  assert.equal(mod.branchCount(rows, -1), null);
  assert.equal(mod.branchCount(rows, 1.5), null);
  // Exchange numbers match exchangesFromRows, so a node index maps to its rows.
  assert.equal(mod.exchangesFromRows(rows).length, 4);
  // Rows with no row_id give no row boundary; two answer rows count twice.
  const plain = msgs(['q1', 'a1'], ['q2', 'a2']);
  assert.deepEqual(mod.branchCount(plain, 1), { count: 4, through: null });
  assert.deepEqual(mod.branchCount([...msgs(['q', 'a']), { role: 'assistant', text: 'a more' }], 0), { count: 3, through: null });
});

test('branchCount: a branch_index from history.read gives the exact count; rows without one keep the rule', () => {
  // history.read leaves out a hidden [System: row that session.branch still counts (branch index 2).
  const rows = [
    { role: 'user', text: 'q1', row_id: 11, branch_index: 0 },
    { role: 'assistant', text: 'a1', row_id: 12, branch_index: 1 },
    { role: 'user', text: 'q2', row_id: 14, branch_index: 3 },
    { role: 'assistant', text: 'a2', row_id: 15, branch_index: 4 },
    { role: 'user', text: 'q3', row_id: 16, branch_index: 5 },
    { role: 'assistant', text: '', row_id: 17, branch_index: 6 }, // text emptied by the reply cap: still an answer
  ];
  assert.deepEqual(mod.branchCount(rows, 0), { count: 2, through: 12 });
  assert.deepEqual(mod.branchCount(rows, 1), { count: 5, through: 15 });
  assert.deepEqual(mod.branchCount(rows, 2), { count: 7, through: 17 });
  // The same rows with no branch_index: the old rule, which comes out one short at exchange 1.
  const plain = rows.map(({ branch_index, ...rest }) => rest);
  assert.deepEqual(mod.branchCount(plain, 1), { count: 4, through: 15 });
  assert.equal(mod.branchCount(plain, 2), null);
});

// ── Merge section ───────────────────────────────────────────────────────────────────────────

const SHARED = [
  { role: 'user', text: 'main q' },
  { role: 'assistant', text: 'main a' },
];
const SIDE_ROWS = [
  ...SHARED,
  { role: 'user', text: 'what is a monad?' },
  { role: 'tool', text: 'ls out' },
  { role: 'assistant', text: 'a burrito' },
];
// Header: the side chat's first own question. Body: its own pairs, tool rows skipped.
const DRAFT = 'From side chat: what is a monad?\n\nYou:\nwhat is a monad?\n\nAssistant:\na burrito';

// Focus on the side chat `sd`; its parent is `par` (title Main).
async function mergeCtx({ rows = MERGE_ROWS, stored = 'sd', runtime = 'rt-sd', prepare, events = true } = {}) {
  const host = fakeHost({ rows, stored, runtime, history: { par: SHARED, sd: SIDE_ROWS } });
  host.usage = { context_used: 1000, context_max: 128000 };
  if (prepare) prepare(host);
  const ctx = setup({ host, events });
  await flush();
  ctx.mark = host.calls.length;
  return ctx;
}
// The Merge into icon on a row of the open chat's lane: hovers the lane's first row when no row shows it.
function mergeIcon(ctx) {
  const tree = ctx.pane.render();
  const shown = byAttr(tree, 'data-merge-here')[0];
  if (shown) return shown;
  const slot = byAttr(tree, 'data-merge-slot')[0];
  if (!slot) return null;
  nodeOf(tree, slot.props['data-merge-slot']).props.onMouseEnter();
  return byAttr(ctx.pane.render(), 'data-merge-here')[0];
}
const pickOf = (ctx) => byAttr(ctx.pane.render(), 'data-merge-pick')[0];
// Opens the merge pick (no Popover in setup: the icon toggles the pick under the graph).
function openPickOf(ctx, event = fakeEvent()) {
  if (!pickOf(ctx)) mergeIcon(ctx).props.onClick(event);
  return pickOf(ctx);
}
// Step 'where' picks ctx.target (else the parent); step 'how' is then measured.
async function openHow(ctx, event) {
  const where = openPickOf(ctx, event);
  const items = byAttr(where, 'data-merge-target');
  (items.find((i) => i.props['data-merge-target'] === ctx.target) ?? items[0]).props.onClick(fakeEvent());
  await flush();
  return pickOf(ctx);
}
// The old Merge as-is / Digest buttons, as the popover runs them: icon, target, mode.
const mergeButton = (ctx, kind = 'asis') => ({
  props: {
    onClick: async (event = fakeEvent()) => {
      const how = await openHow(ctx, event);
      // Step 'how' measured the As-is merge; count the merge's own reads from here.
      if (typeof ctx.mark === 'number') ctx.mark = ctx.host.calls.length;
      byAttr(how, 'data-merge', kind)[0].props.onClick(fakeEvent());
      await flush();
    },
  },
});
const pickTarget = (ctx, id) => {
  ctx.target = id;
};
// The result line under the row: its readout lives in its tooltip (title).
const fitOf = (ctx) => byAttr(ctx.pane.render(), 'data-token-fit')[0];
const fitText = (ctx) => fitOf(ctx)?.props?.title ?? '';
// session.* calls since the merge context was ready, so the tree's own history reads do not count.
const sessionCalls = (ctx) => ctx.host.calls.slice(ctx.mark).filter(([m]) => m.startsWith('session.'));
// A line whose text is `text`, or the result line whose tooltip carries it.
const exactText = (tree, text) =>
  findAll(tree, (n) => n.props?.children === text || (typeof n.props?.title === 'string' && n.props.title.split('\n').includes(text)))[0];
const OPEN_HERE = { intent: 'in-place', profile: 'default' };

test('the draft in the tests has 20 estimated tokens', () => {
  assert.equal(mod.estimateTokens(DRAFT), 20);
});

test('the merge popover: step Where lists the ancestors, the parent first and preselected; step How measures As-is', async () => {
  const host = fakeHost(); // focus b2: parent b1, then root
  host.usage = { context_used: 1000, context_max: 128000 };
  const ctx = setup({ host });
  await flush();
  const tree = ctx.pane.render();
  const flat = (n) => textOf(n).replace(/\n/g, '');
  // No merge section below the graph any more.
  for (const attr of ['data-merge-section', 'data-merge-target-select', 'data-merge-targets']) assert.equal(byAttr(tree, attr).length, 0, attr);
  const icon = mergeIcon(ctx);
  assert.equal(icon.type, 'Button');
  assert.equal(icon.props['aria-label'], 'Merge into');
  assert.equal(icon.props.children.props.name ?? icon.props.children.type, 'svg'); // no Codicon in setup: the drawn icon
  const event = fakeEvent();
  icon.props.onClick(event);
  assert.equal(event.stopped, 1); // the row does not select its node
  const where = pickOf(ctx);
  assert.match(flat(byAttr(where, 'data-pick-head')[0]), /Merge "b2"1\/2 Where/);
  const items = byAttr(where, 'data-merge-target');
  assert.deepEqual(items.map((i) => [i.props['data-merge-target'], flat(i)]), [
    ['b1', 'b1default'],
    ['root', 'rootRoot'],
  ]);
  assert.equal(items[0].props.autoFocus, true); // Enter picks the parent
  assert.equal(items[0].props['data-default'], 'true');
  assert.match(flat(where), /Parent.*Older ancestors/);
  // The parent's lane lights up while the pick is open; hovering another target moves it.
  const roles = () => Object.fromEntries(findAll(byAttr(ctx.pane.render(), 'data-graph', 'true')[0], (n) => n.type === 'circle').map((c) => [c.key, c.props['data-role']]));
  assert.equal(roles()['c:b1:2'], 'hover');
  items[1].props.onMouseEnter();
  assert.equal(roles()['c:root:2'], 'hover');
  items[0].props.onClick(fakeEvent());
  let how = pickOf(ctx);
  assert.match(flat(byAttr(how, 'data-pick-head')[0]), /into "b1"2\/2 How/);
  assert.match(flat(byAttr(how, 'data-merge', 'asis')[0]), /Measuring/);
  await flush();
  how = pickOf(ctx);
  const asis = byAttr(how, 'data-merge', 'asis')[0];
  assert.match(flat(asis), /^As-is1 exchange · about \d+ tokens · fits \(127,000 free\)$/);
  assert.equal(asis.props.autoFocus, true);
  assert.equal(asis.props['data-fit'], 'yes');
  assert.match(flat(byAttr(how, 'data-merge', 'digest')[0]), /^Digesta summary by the digest model$/);
  // Back returns to step Where; a second click on the icon closes the pick and its preview.
  byAttr(how, 'data-pick-back')[0].props.onClick(fakeEvent());
  assert.ok(byAttr(pickOf(ctx), 'data-merge-target').length);
  mergeIcon(ctx).props.onClick(fakeEvent());
  assert.equal(pickOf(ctx), undefined);
  assert.ok(!Object.values(roles()).includes('hover') || roles()['c:b1:2'] !== 'hover');
  ctx.unload();
});

test('mergeTargets lists the ancestors parent first; selectedTarget defaults to the parent', () => {
  const { lanes } = planFor(ROWS, 'b2', HIST);
  const targets = mod.mergeTargets(lanes, 'b2');
  assert.deepEqual(targets, [
    { id: 'b1', title: 'b1' },
    { id: 'root', title: 'root' },
  ]);
  assert.deepEqual(mod.mergeTargets(lanes, 'root'), []);
  assert.equal(mod.selectedTarget(targets, null, 'b2').id, 'b1');
  assert.equal(mod.selectedTarget(targets, { chatId: 'b2', id: 'root' }, 'b2').id, 'root');
  // A pick made for another chat, or an id that is no ancestor, falls back to the parent.
  assert.equal(mod.selectedTarget(targets, { chatId: 'b1', id: 'root' }, 'b2').id, 'b1');
  assert.equal(mod.selectedTarget(targets, { chatId: 'b2', id: 'b3' }, 'b2').id, 'b1');
  assert.equal(mod.selectedTarget([], null, 'root'), null);
});

test('planGraph marks a merge target lane when asked', () => {
  const { plan } = planFor(ROWS, 'b2', HIST, { target: 'root' });
  assert.deepEqual(plan.lanes.filter((l) => l.target).map((l) => l.id), ['root']);
  assert.equal(planFor(ROWS, 'b2', HIST, { target: 'nope' }).plan.rows.some((r) => r.target), false);
});

test('on the root chat no row carries Merge into', async () => {
  const ctx = setup({ host: fakeHost({ stored: 'root', runtime: 'rt-root' }) });
  await flush();
  ctx.mark = ctx.host.calls.length;
  const tree = ctx.pane.render();
  assert.equal(byAttr(tree, 'data-merge-here').length + byAttr(tree, 'data-merge-slot').length, 0);
  assert.equal(sessionCalls(ctx).length, 0);
  ctx.unload();
});

test('Merge as-is stages the header and the own pairs into the parent, opens it in place, never sends', async () => {
  const ctx = await mergeCtx();
  const event = fakeEvent();
  const done = mergeButton(ctx).props.onClick(event);
  assert.equal(event.stopped, 1);
  await done;
  await flush();
  assert.deepEqual(ctx.host.order, [
    ['open', 'par', OPEN_HERE],
    ['draft', 'par', DRAFT],
  ]);
  assert.equal(ctx.host.order.some(([kind]) => kind === 'submit' || kind === 'prompt'), false);
  // Reads: this chat (transcript unknown on v0.23, so history), then the target's window.
  // The fork point comes from the parent as the tree loaded it: no fresh parent read.
  assert.deepEqual(sessionCalls(ctx).map(([m, p]) => [m, p.session_id]), [
    ['session.transcript', 'sd'],
    ['session.history', 'sd'],
    ['session.usage', 'par'],
  ]);
  const tree = ctx.pane.render();
  assert.equal(fitOf(ctx).props['data-token-fit'], 'yes');
  const notice = exactText(tree, MERGE_STAGED_TEXT);
  assert.equal(notice.props.style.userSelect, 'text');
  assert.equal(notice.props['data-selectable-text'], 'true');
  assert.match(fitText(ctx), /20/);
  assert.match(fitText(ctx), /127,000/);
  ctx.unload();
});

test('a merge into a grandparent uses the open chat own part and the grandparent window', async () => {
  const host = fakeHost();
  host.usage = { context_used: 1000, context_max: 128000 };
  const ctx = setup({ host });
  await flush();
  ctx.mark = host.calls.length;
  pickTarget(ctx, 'root');
  await mergeButton(ctx).props.onClick(fakeEvent());
  // b2 shares three exchanges with b1, so its own part is b2q only.
  assert.deepEqual(host.order, [
    ['open', 'root', OPEN_HERE],
    ['draft', 'root', 'From side chat: b2q\n\nYou:\nb2q\n\nAssistant:\nb2a'],
  ]);
  assert.deepEqual(sessionCalls(ctx).find(([m]) => m === 'session.usage'), ['session.usage', { session_id: 'root' }]);
  ctx.unload();
});

test('Digest asks the plugin RPC on the open chat session, waits for its event, then stages header + digest', async () => {
  for (const flat of [false, true]) {
    const ctx = await mergeCtx({
      prepare: (host) => {
        host.flatEvent = flat;
        host.digestEvent = () => ({ digest: 'A [[monad|a type]] is ::termline{v="a burrito." t="t"}' });
      },
    });
    // An event for another job changes nothing.
    ctx.host.emit('plugin.chat-tree.digest.written', { payload: { job: 'other', digest: 'wrong' } });
    await mergeButton(ctx, 'digest').props.onClick(fakeEvent());
    await flush();
    assert.deepEqual(ctx.host.order, [
      [
        'digest',
        {
          session_id: 'rt-sd',
          purpose: 'merge',
          title: 'Side: what is a monad?',
          exchanges: [{ question: 'what is a monad?', answer: 'a burrito' }],
        },
      ],
      ['open', 'par', OPEN_HERE],
      ['draft', 'par', 'From side chat: what is a monad?\n\nA monad is a burrito.'],
    ]);
    assert.ok(exactText(ctx.pane.render(), MERGE_STAGED_TEXT));
    ctx.unload();
  }
});

test('the digest request sends each question and answer with concept-link markup removed', async () => {
  assert.deepEqual(mod.digestRequest('fork', ' T ', [{ question: 'what is a [[monad|a type]]?', answer: '::termline{v="A burrito." t="x"}' }, {}]), {
    purpose: 'fork',
    title: 'T',
    exchanges: [
      { question: 'what is a monad?', answer: 'A burrito.' },
      { question: '', answer: '' },
    ],
  });
  const ctx = await mergeCtx({
    prepare: (host) => {
      host.history.sd = [...SHARED, { role: 'user', text: 'what is a [[monad|a type]]?' }, { role: 'assistant', text: 'A [[monad|a type]] is ::termline{v="a burrito." t="t"}' }];
      host.digestEvent = () => ({ digest: 'd' });
    },
  });
  await mergeButton(ctx, 'digest').props.onClick(fakeEvent());
  await flush();
  assert.deepEqual(ctx.host.order.find(([k]) => k === 'digest')[1].exchanges, [{ question: 'what is a monad?', answer: 'A monad is a burrito.' }]);
  ctx.unload();
});

test('digestResult reads the event payload, or a flat event, and checks it', () => {
  assert.deepEqual(mod.digestResult({ type: 't', payload: { job: 'j', digest: ' d ' } }), { job: 'j', ok: true, digest: 'd' });
  assert.deepEqual(mod.digestResult({ job: 7, digest: 'd' }), { job: '7', ok: true, digest: 'd' });
  assert.deepEqual(mod.digestResult({ payload: { job: 'j', error: 'no model' } }), { job: 'j', ok: false, error: 'no model' });
  assert.deepEqual(mod.digestResult({ payload: { job: 'j', digest: '' } }), { job: 'j', ok: false, error: 'The digest backend sent no digest.' });
  assert.equal(mod.digestResult(null).job, '');
});

test('Merge as-is also removes concept markup from the body and keeps the header on one line', () => {
  assert.equal(
    mod.formatMergeText('first line\n\n  second', mod.verbatimBody([{ question: 'q', answer: 'see [[monad|a type]]' }])),
    'From side chat: first line second\n\nYou:\nq\n\nAssistant:\nsee monad',
  );
  assert.equal(mod.mergeHeader(mod.formatMergeText('a\n\nb', 'body')), 'a b');
});

test('a digest failure shows a notice and stages nothing: an error event, -32601, a failed request, a bad event, 60 s of silence, no event stream', async () => {
  const notFound = Object.assign(new Error('Method not found: plugin.chat-tree.digest.write'), { code: -32601 });
  const cases = [
    [{ prepare: (host) => (host.digestEvent = () => ({ error: 'model down.' })) }, 'Digest failed: model down. Nothing was staged.'],
    [{ prepare: (host) => (host.digestError = notFound) }, mod.DIGEST_MISSING_TEXT],
    [{ prepare: (host) => (host.digestError = new Error('gateway hiccup')) }, 'Digest failed: gateway hiccup. Nothing was staged.'],
    [{ prepare: (host) => (host.digestEvent = () => ({ digest: 42 })) }, 'Digest failed: The digest backend sent no digest. Nothing was staged.'],
    [{}, `Digest failed: ${mod.DIGEST_TIMEOUT_TEXT.replace(/\.$/, '')}. Nothing was staged.`],
    [{ events: false }, mod.DIGEST_MISSING_TEXT],
  ];
  for (const [options, text] of cases) {
    const ctx = await mergeCtx(options);
    let done;
    await assert.doesNotReject(async () => {
      done = mergeButton(ctx, 'digest').props.onClick(fakeEvent());
      await done;
      await ctx.clock.tick(mod.DIGEST_TIMEOUT_MS);
      await flush();
    });
    await flush();
    assert.deepEqual(ctx.host.order.filter(([k]) => k !== 'digest'), [], text);
    assert.deepEqual(ctx.host.drafts, []);
    const notice = exactText(ctx.pane.render(), text);
    assert.ok(notice, text);
    assert.equal(notice.props.style.userSelect, 'text');
    ctx.unload();
  }
});

test('a mode that does not fit is greyed with its numbers and cannot be picked; nothing opens or stages', async () => {
  const ctx = await mergeCtx({ prepare: (host) => (host.usage = { context_used: 127990, context_max: 128000 }) });
  const how = await openHow(ctx);
  const asis = byAttr(how, 'data-merge', 'asis')[0];
  assert.equal(asis.props['aria-disabled'], 'true');
  assert.equal(asis.props['data-fit'], 'no');
  assert.match(textOf(asis), /about 20 tokens · does not fit \(10 free\)$/);
  assert.equal(asis.props.autoFocus, undefined); // the focus goes to Digest
  assert.equal(byAttr(how, 'data-merge', 'digest')[0].props.autoFocus, true);
  asis.props.onClick(fakeEvent());
  await flush();
  assert.deepEqual(ctx.host.order, []);
  assert.ok(pickOf(ctx)); // the pick stays open
  ctx.unload();
});

test('a failed merge shows in the destructive colour under its row and stays until Dismiss or the next merge', async () => {
  const ctx = await mergeCtx({ prepare: (host) => (host.composer.setDraft = async () => false) });
  await mergeButton(ctx).props.onClick(fakeEvent());
  const line = () => byAttr(ctx.pane.render(), 'data-merge-result')[0];
  assert.equal(line().props['data-merge-result'], 'error');
  assert.match(line().props.className, /text-destructive/);
  assert.equal(textOf(byAttr(line(), 'data-merge-notice')[0]), MERGE_HIDDEN_TEXT);
  // Under the merged chat's row: the next row in the graph is the result line.
  const graph = byAttr(ctx.pane.render(), 'data-tree-graph')[0];
  const kids = graph.props.children.filter((c) => c?.props);
  const at = kids.findIndex((c) => c.props['data-merge-result']);
  assert.ok(at > 0);
  assert.equal(kids[at - 1].props['data-chat-id'], 'sd');
  assert.equal(line().props.style.height, 2 * mod.ROW_H);
  await ctx.clock.tick(REFRESH_MS);
  assert.ok(line());
  byAttr(line(), 'data-result-dismiss')[0].props.onClick(fakeEvent());
  assert.equal(line(), undefined);
  // A staged merge: one line, an Open action, and it stays until Dismiss.
  ctx.host.composer.setDraft = async () => true;
  await mergeButton(ctx).props.onClick(fakeEvent());
  assert.equal(line().props['data-merge-result'], 'ok');
  assert.equal(textOf(byAttr(line(), 'data-merge-notice')[0]), '✓ Staged in the composer of "Main". Not sent.');
  assert.equal(line().props.style.height, mod.ROW_H);
  const opened = ctx.host.opened.length;
  byAttr(line(), 'data-result-open')[0].props.onClick(fakeEvent());
  await flush();
  assert.equal(ctx.host.opened.length, opened + 1);
  assert.equal(ctx.host.opened.at(-1)[0], 'par');
  assert.equal(ctx.host.opened.at(-1)[1].intent, 'in-place');
  await ctx.clock.tick(REFRESH_MS);
  assert.ok(line());
  ctx.unload();
});

test('a window that fits exactly is allowed', async () => {
  const ctx = await mergeCtx({ prepare: (host) => (host.usage = { context_used: 127980, context_max: 128000 }) });
  await mergeButton(ctx).props.onClick(fakeEvent());
  assert.equal(ctx.host.drafts.length, 1);
  assert.equal(fitOf(ctx).props['data-token-fit'], 'yes');
  ctx.unload();
});

test('the target window is read from usage, then stats, then context_breakdown, for the target id only', async () => {
  const ctx = await mergeCtx({
    prepare: (host) => {
      host.usage = new Error('no usage');
      host.stats = { calls: 1, total: 3 }; // no max: try on
      host.breakdown = { context_used: 100, context_max: 1000 };
    },
  });
  await mergeButton(ctx).props.onClick(fakeEvent());
  assert.deepEqual(
    sessionCalls(ctx).filter(([m]) => /usage|stats|breakdown/.test(m)).map(([m, p]) => [m, p.session_id]),
    [
      ['session.usage', 'par'],
      ['session.stats', 'par'],
      ['session.context_breakdown', 'par'],
    ],
  );
  assert.equal(fitOf(ctx).props['data-token-fit'], 'yes');
  assert.equal(ctx.host.drafts.length, 1);
  ctx.unload();
});

test('when no window is reported, the draft is still staged and the notice says so', async () => {
  const ctx = await mergeCtx({
    prepare: (host) => {
      host.usage = new Error('usage down');
      host.stats = new Error('stats down');
      host.breakdown = new Error('breakdown down');
    },
  });
  await mergeButton(ctx).props.onClick(fakeEvent());
  assert.deepEqual(ctx.host.order, [
    ['open', 'par', OPEN_HERE],
    ['draft', 'par', DRAFT],
  ]);
  assert.ok(exactText(ctx.pane.render(), mod.formatMissingWindowNotice(20)));
  assert.equal(fitOf(ctx).props['data-token-fit'], 'unknown');
  ctx.unload();
});

test('Merge as-is reads session.transcript with the oldest order when the host has it', async () => {
  const ctx = await mergeCtx({
    prepare: (host) => {
      host.transcript = { par: SHARED, sd: SIDE_ROWS };
      host.history = {};
    },
  });
  await mergeButton(ctx).props.onClick(fakeEvent());
  assert.deepEqual(sessionCalls(ctx).find(([m]) => m === 'session.transcript'), ['session.transcript', { session_id: 'sd', order: 'oldest' }]);
  assert.equal(sessionCalls(ctx).some(([m]) => m === 'session.history'), false);
  assert.deepEqual(ctx.host.drafts, [['par', DRAFT]]);
  ctx.unload();
});

test('two own pairs are both staged; copied parent rows and tool rows are not', async () => {
  const ctx = await mergeCtx({
    prepare: (host) => {
      host.history.sd = [
        ...SHARED,
        { role: 'user', text: 'q1' },
        { role: 'tool', text: 'TOOL-OUT' },
        { role: 'assistant', text: 'a1' },
        { role: 'user', text: 'q2' },
        { role: 'assistant', text: 'a2 first' },
        { role: 'assistant', text: 'a2 second' },
      ];
    },
  });
  await mergeButton(ctx).props.onClick(fakeEvent());
  const draft = ctx.host.drafts[0][1];
  assert.equal(draft, 'From side chat: q1\n\nYou:\nq1\n\nAssistant:\na1\n\nYou:\nq2\n\nAssistant:\na2 first\na2 second');
  assert.doesNotMatch(draft, /main q|main a|TOOL-OUT/);
  ctx.unload();
});

test('a missing composer draft API shows a notice, opens nothing and writes nothing', async () => {
  for (const strip of [(host) => (host.composer = {}), (host) => delete host.composer]) {
    const ctx = await mergeCtx({ prepare: strip });
    await assert.doesNotReject(async () => mergeButton(ctx).props.onClick(fakeEvent()));
    await flush();
    assert.deepEqual(ctx.host.order, []);
    assert.equal(sessionCalls(ctx).length, 0);
    assert.ok(exactText(ctx.pane.render(), MERGE_NO_COMPOSER_TEXT));
    ctx.unload();
  }
});

test('a false or thrown setDraft retries the target runtime id once focus is on the target, else shows the hidden notice', async () => {
  for (const result of [false, new Error('composer gone')]) {
    const ctx = await mergeCtx({ prepare: (host) => (host.setDraftResult = result) });
    ctx.host.moveFocusOnOpen = true;
    await mergeButton(ctx).props.onClick(fakeEvent());
    await flush();
    assert.deepEqual(ctx.host.order.filter(([k]) => k !== 'branch').map((step) => step.slice(0, 2)), [['open', 'par'], ['draft', 'par'], ['draft', 'rt-par']]);
    assert.ok(exactText(ctx.pane.render(), MERGE_HIDDEN_TEXT));
    ctx.unload();
  }
  // Focus still on the merged chat: never stage into it.
  const stay = await mergeCtx({ prepare: (host) => (host.setDraftResult = false) });
  await mergeButton(stay).props.onClick(fakeEvent());
  assert.deepEqual(stay.host.drafts.map(([id]) => id), ['par']);
  stay.unload();
});

test('a setDraft that works on the target runtime id stages the draft', async () => {
  const ctx = await mergeCtx({ prepare: (host) => (host.setDraftResult = ([id]) => id === 'rt-par') });
  ctx.host.moveFocusOnOpen = true;
  await mergeButton(ctx).props.onClick(fakeEvent());
  await flush();
  assert.deepEqual(ctx.host.drafts.map(([id]) => id), ['par', 'rt-par']);
  assert.ok(exactText(ctx.pane.render(), MERGE_STAGED_TEXT));
  ctx.unload();
});

test('a failed open does not stop the draft', async () => {
  const ctx = await mergeCtx({
    prepare: (host) => {
      host.openSession = async () => {
        throw new Error('no such tab');
      };
    },
  });
  await assert.doesNotReject(async () => mergeButton(ctx).props.onClick(fakeEvent()));
  assert.deepEqual(ctx.host.drafts, [['par', DRAFT]]);
  ctx.unload();
});

test('a chat with nothing of its own, or one that cannot be read, writes nothing', async () => {
  const nothing = await mergeCtx({ prepare: (host) => (host.history.sd = [...SHARED, { role: 'user', text: 'unanswered' }]) });
  await mergeButton(nothing).props.onClick(fakeEvent());
  assert.ok(exactText(nothing.pane.render(), mod.MERGE_NOTHING_TEXT));
  assert.deepEqual(nothing.host.order, []);
  assert.equal(sessionCalls(nothing).some(([m]) => /usage|stats|breakdown/.test(m)), false);
  nothing.unload();

  const unreadable = await mergeCtx();
  const base = unreadable.host.request;
  unreadable.host.request = async (method, params) => {
    if (method === 'session.history') throw new Error('chat gone');
    return base(method, params);
  };
  await assert.doesNotReject(async () => mergeButton(unreadable).props.onClick(fakeEvent()));
  assert.match(textOf(unreadable.pane.render()), /Could not read this chat: chat gone/);
  assert.deepEqual(unreadable.host.order, []);
  unreadable.unload();
});

test('Merge as-is never opens the merged chat itself, and a double click stages once', async () => {
  const ctx = await mergeCtx();
  const asis = byAttr(await openHow(ctx), 'data-merge', 'asis')[0];
  asis.props.onClick(fakeEvent());
  asis.props.onClick(fakeEvent());
  await flush();
  assert.equal(ctx.host.drafts.length, 1);
  assert.equal(ctx.host.opened.some(([id]) => id === 'sd'), false);
  ctx.unload();
});

// ── Branch here ─────────────────────────────────────────────────────────────────────────────

// The Branch button shows on the open row and under the pointer: point at the row first.
const branchButton = (ctx, key) => {
  nodeOf(ctx.pane.render(), key).props.onMouseEnter();
  return byAttr(nodeOf(ctx.pane.render(), key), 'data-branch-here', key)[0];
};
// Rows with a Branch button, shown or hidden in place.
const branchRows = (tree) =>
  nodeRows(tree)
    .filter((n) => byAttr(n, 'data-branch-here').length + byAttr(n, 'data-branch-slot').length > 0)
    .map((n) => n.props['data-node']);
const form = (ctx) => byAttr(ctx.pane.render(), 'data-branch-form')[0];
const formField = (ctx, key) => byAttr(form(ctx), 'data-branch-field', key)[0];
const typeInto = (ctx, key, value) => formField(ctx, key).props.onChange({ target: { value } });
const submitForm = (ctx) => byAttr(form(ctx), 'data-branch-submit', 'true')[0].props.onClick(fakeEvent());
// The model picker of the form: the ModelCatalogMenu element and its controller, and the trigger text.
const menuOf = (ctx) => findAll(form(ctx), (n) => n.type === 'ModelCatalogMenu')[0];
const controllerOf = (ctx) => menuOf(ctx).props.controller;
const modelButton = (ctx) => byAttr(form(ctx), 'data-branch-model', 'true')[0];
// A row pick as the menu commits it: select, then the preset with the profile default level.
const pickRow = (ctx, model, provider) => {
  controllerOf(ctx).select(model, provider);
  controllerOf(ctx).applyPreset({ effort: 'medium' }, { model, provider });
};
const promptOf = (host) => host.order.find(([k]) => k === 'prompt')[1];

test('Branch here sits on every answered exchange; another chat opens before its form', async () => {
  const ctx = setup({ host: fakeHost({ history: { ...HIST, b2: [...HIST.b2, { role: 'user', text: 'pending' }] } }) });
  await flush();
  const tree = ctx.pane.render();
  const rows = branchRows(tree);
  // b2 is open: its own path (root, b1, b2) plus the answered nodes of other chats (b3, root:2).
  for (const key of ['root:0', 'root:1', 'b1:2', 'b2:3']) assert.ok(rows.includes(key), key);
  assert.ok(rows.includes('b3:1') && rows.includes('root:2'));
  assert.ok(!rows.includes('b2:4'), 'the unanswered question is not branchable');
  // A node of another chat: the click opens that chat in place and shows no form yet.
  const other = fakeEvent();
  branchButton(ctx, 'b3:1').props.onClick(other);
  await flush();
  assert.ok(ctx.host.opened.some((o) => (Array.isArray(o) ? o[0] : o?.id ?? o) === 'b3' || JSON.stringify(o).includes('"b3"')), JSON.stringify(ctx.host.opened));
  assert.equal(byAttr(ctx.pane.render(), 'data-branch-form').length, 0);
  ctx.host.opened.length = 0;
  // A click opens the form and does not open the node's chat.
  const event = fakeEvent();
  branchButton(ctx, 'root:1').props.onClick(event);
  assert.equal(event.stopped, 1);
  await flush();
  assert.deepEqual(ctx.host.opened, []);
  assert.equal(form(ctx).props['data-branch-form'], 'b2:1');
  assert.match(textOf(form(ctx)), /Branch here: q2/);
  ctx.unload();
});

test('Branch shows on the open row and on the row under the pointer or keyboard focus only, with no layout shift', async () => {
  const ctx = setup();
  await flush();
  const shown = () => byAttr(ctx.pane.render(), 'data-branch-here').map((n) => n.props['data-branch-here']);
  const hidden = () => byAttr(ctx.pane.render(), 'data-branch-slot').map((n) => n.props['data-branch-slot']);
  const all = branchRows(ctx.pane.render());
  // No hover: only the open row has a Branch button.
  assert.deepEqual(shown(), ['b2:3']);
  assert.deepEqual(hidden(), all.filter((k) => k !== 'b2:3'));
  // The pointer on another branchable row shows exactly one more.
  nodeOf(ctx.pane.render(), 'root:1').props.onMouseEnter();
  assert.deepEqual(shown(), ['root:1', 'b2:3']);
  assert.deepEqual(hidden(), all.filter((k) => k !== 'root:1' && k !== 'b2:3'));
  // A hidden button keeps its place: the same element and style, only hidden and inert.
  const slot = byAttr(nodeOf(ctx.pane.render(), 'root:0'), 'data-branch-slot')[0];
  const button = byAttr(nodeOf(ctx.pane.render(), 'root:1'), 'data-branch-here')[0];
  assert.equal(slot.type, button.type);
  assert.equal(slot.key, button.key);
  assert.equal(textOf(slot), textOf(button));
  assert.deepEqual({ ...slot.props.style, visibility: undefined }, { ...button.props.style, visibility: undefined });
  assert.equal(slot.props.style.visibility, 'hidden');
  assert.equal(button.props.style.visibility, undefined);
  assert.equal(slot.props.tabIndex, -1);
  assert.equal(slot.props['aria-hidden'], 'true');
  assert.equal(slot.props.disabled, true);
  assert.equal(slot.props.onClick, undefined);
  // A node of another chat is branchable too: hovering it shows its button.
  nodeOf(ctx.pane.render(), 'root:1').props.onMouseLeave();
  nodeOf(ctx.pane.render(), 'b3:1').props.onMouseEnter();
  assert.deepEqual(branchRows(ctx.pane.render()), all);
  assert.deepEqual(shown(), ['b3:1', 'b2:3']);
  nodeOf(ctx.pane.render(), 'b3:1').props.onMouseLeave();
  // Keyboard focus shows it too, and draws no hover path.
  const before = circleColours(ctx.pane.render());
  nodeOf(ctx.pane.render(), 'b1:2').props.onFocus({});
  assert.deepEqual(shown(), ['b1:2', 'b2:3']);
  assert.deepEqual(circleColours(ctx.pane.render()), before);
  // Focus that moves onto the row's own button keeps it; focus that leaves the row hides it.
  const inside = {};
  nodeOf(ctx.pane.render(), 'b1:2').props.onBlur({ relatedTarget: inside, currentTarget: { contains: (n) => n === inside } });
  assert.deepEqual(shown(), ['b1:2', 'b2:3']);
  nodeOf(ctx.pane.render(), 'b1:2').props.onBlur({ relatedTarget: null, currentTarget: { contains: () => false } });
  assert.deepEqual(shown(), ['b2:3']);
  // Pointer and focus on two rows: both show.
  nodeOf(ctx.pane.render(), 'root:0').props.onFocus({});
  nodeOf(ctx.pane.render(), 'b1:2').props.onMouseEnter();
  assert.deepEqual(shown(), ['root:0', 'b1:2', 'b2:3']);
  assert.equal(ctx.host.opened.length, 0);
  ctx.unload();
});

test('Branch here: session.branch with the count and no name, prompt.submit with the picked model, open in place', async () => {
  const ctx = setup();
  await flush();
  ctx.mark = ctx.host.calls.length;
  branchButton(ctx, 'root:1').props.onClick(fakeEvent());
  // No free-text model field: the model comes from Hermes's picker, and nothing is picked yet.
  assert.equal(formField(ctx, 'model'), undefined);
  assert.equal(textOf(modelButton(ctx)), `${mod.MODEL_INHERIT_TEXT}\n▾`);
  typeInto(ctx, 'question', 'why q2?');
  pickRow(ctx, 'claude-x', 'anthropic');
  controllerOf(ctx).setOptions({ effort: 'high' }, { isActive: true, model: 'claude-x', provider: 'anthropic' });
  assert.match(textOf(modelButton(ctx)), /^anthropic: claude-x · High/);
  await submitForm(ctx);
  await flush();
  // b2's rows: q1 a1 q2 a2 b1q b1a b2q b2a. Exchange 1 ends at a2: four rows.
  const branch = ctx.host.order.find(([k]) => k === 'branch');
  assert.deepEqual(branch[1], { session_id: 'rt-b2', count: 4 });
  assert.equal('name' in branch[1], false);
  assert.deepEqual(promptOf(ctx.host), {
    session_id: 'nb-rt',
    text: 'why q2?',
    model_override: { model: 'claude-x', provider: 'anthropic', reasoning: 'high' },
  });
  assert.deepEqual(ctx.host.opened, [['nb', OPEN_HERE]]);
  // Order: read, branch, a reload right after the branch, ask, then the fork digest (after the open).
  const seq = ctx.host.calls.slice(ctx.mark).map(([m]) => m).filter((m) => m !== 'session.transcript');
  assert.deepEqual(seq.slice(0, 3), ['session.history', 'session.branch', 'listPersistedSessions']);
  assert.deepEqual(seq.filter((m) => ['session.branch', 'prompt.submit', mod.DIGEST_METHOD].includes(m)), [
    'session.branch',
    'prompt.submit',
    'plugin.chat-tree.digest.write',
  ]);
  assert.equal(form(ctx), undefined);
  // Stored: the branch ids (both). The model is never stored: the next form starts with nothing picked.
  assert.deepEqual(ctx.storage.map.get(mod.BRANCH_IDS_KEY), ['nb-rt', 'nb']);
  assert.deepEqual([...ctx.storage.map.keys()].filter((k) => !k.startsWith('digest:')), [mod.BRANCH_IDS_KEY]);
  branchButton(ctx, 'b2:3').props.onClick(fakeEvent());
  assert.deepEqual(controllerOf(ctx).current, { effort: '', fast: false, model: '', provider: '' });
  // The new branch, retitled by Hermes, shows the side pill from the stored ids.
  ctx.host.rows = [...ROWS, row('nb', { _branched_from: 'b2', title: 'Hermes named it', started_at: 50 })];
  ctx.host.history.nb = [...msgs(['q1', 'a1'], ['q2', 'a2']), ...msgs(['why q2?', 'because'])];
  ctx.host.state.focusedStoredSessionId.set('nb');
  ctx.host.state.focusedSessionId.set('nb-rt');
  await flush();
  assert.ok(pills(nodeOf(ctx.pane.render(), 'nb:2')).includes('side:side'));
  ctx.unload();

  // A reload reads the ids back from storage.
  const again = setup({ host: fakeHost({ rows: [...ROWS, row('nb', { _branched_from: 'b2', title: 'Hermes named it', started_at: 50 })], stored: 'nb', runtime: 'nb-rt', history: { ...HIST, nb: [...msgs(['q1', 'a1'], ['q2', 'a2']), ...msgs(['why q2?', 'because'])] } }), storage: ctx.storage });
  await flush();
  assert.ok(pills(nodeOf(again.pane.render(), 'nb:2')).includes('side:side'));
  again.unload();
});

test('Branch here counts with the branch_index of history.read rows: a hidden [System: row before the cut', async () => {
  const host = fakeHost({ backend: true });
  // b2 in the store: session.branch also counts a [System: row after a1 (branch index 2), which
  // history.read does not return. So q2 is 3 and a2 is 4.
  host.store = { ...HIST, b2: HIST.b2.map((r, i) => ({ ...r, branch_index: i < 2 ? i : i + 1 })) };
  const ctx = setup({ host });
  await flush();
  branchButton(ctx, 'root:1').props.onClick(fakeEvent());
  typeInto(ctx, 'question', 'why q2?');
  ctx.mark = ctx.host.calls.length;
  await submitForm(ctx);
  await flush();
  const branch = ctx.host.order.find(([k]) => k === 'branch');
  assert.deepEqual(branch[1], { session_id: 'rt-b2', count: 5 }); // the old rule gives 4
  const reads = ctx.host.calls.slice(ctx.mark).map(([m]) => m);
  assert.deepEqual(reads.slice(0, 2), [mod.HISTORY_METHOD, 'session.branch']);
  assert.equal(reads.includes('session.history'), false);
  ctx.unload();
});

test('Branch here sends through_message_id when the rows carry row ids, and no override for a blank model', async () => {
  const host = fakeHost();
  host.transcript = { b2: HIST.b2.map((m, i) => ({ ...m, row_id: 100 + i })) };
  const ctx = setup({ host });
  await flush();
  branchButton(ctx, 'b2:3').props.onClick(fakeEvent());
  typeInto(ctx, 'question', 'more?');
  await submitForm(ctx);
  await flush();
  assert.deepEqual(host.order.find(([k]) => k === 'branch')[1], { session_id: 'rt-b2', count: 8, through_message_id: 107 });
  assert.deepEqual(host.order.find(([k]) => k === 'prompt')[1], { session_id: 'nb-rt', text: 'more?' });
  ctx.unload();
});

test('the Branch form model picker is Hermes ModelCatalogMenu in a DropdownMenu, as the kanban plugin uses it', async () => {
  const ctx = setup();
  await flush();
  branchButton(ctx, 'b2:3').props.onClick(fakeEvent());
  const root = findAll(form(ctx), (n) => n.type === 'DropdownMenu')[0];
  assert.equal(root.props.open, false);
  const trigger = findAll(root, (n) => n.type === 'DropdownMenuTrigger')[0];
  assert.equal(trigger.props.asChild, true);
  assert.equal(trigger.props.children.type, 'Button');
  const content = findAll(root, (n) => n.type === 'DropdownMenuContent')[0];
  const close = findAll(content, (n) => n.type === 'ModelMenuClose')[0];
  assert.equal(close.props.children.type, 'ModelCatalogMenu');
  assert.equal(menuOf(ctx).props.profile, 'default');
  const controller = controllerOf(ctx);
  // Read-only against Hermes's presets, no fast or service tier.
  assert.deepEqual(controller.presetFor('anthropic', 'claude-x'), {});
  assert.equal(controller.allowSpeed, false);
  // The menu opens and closes through the form; a pick closes it through the close context.
  root.props.onOpenChange(true);
  assert.equal(findAll(form(ctx), (n) => n.type === 'DropdownMenu')[0].props.open, true);
  findAll(form(ctx), (n) => n.type === 'ModelMenuClose')[0].props.value();
  assert.equal(findAll(form(ctx), (n) => n.type === 'DropdownMenu')[0].props.open, false);
  ctx.unload();
});

test('model_override has only model, provider and reasoning; a key the user did not set is left out', async () => {
  // A row pick keeps the default level (no reasoning key); a set level sends it; fast edits are ignored.
  for (const [steps, override] of [
    [(ctx) => pickRow(ctx, 'claude-x', 'anthropic'), { model: 'claude-x', provider: 'anthropic' }],
    [
      (ctx) => {
        pickRow(ctx, 'claude-x', 'anthropic');
        controllerOf(ctx).setOptions({ fast: true }, { isActive: true, model: 'claude-x', provider: 'anthropic' });
        controllerOf(ctx).setOptions({ effort: 'none' }, { isActive: true, model: 'claude-x', provider: 'anthropic' });
      },
      { model: 'claude-x', provider: 'anthropic', reasoning: 'none' },
    ],
    [(ctx) => controllerOf(ctx).select('local-model', ''), { model: 'local-model' }],
  ]) {
    const ctx = setup();
    await flush();
    branchButton(ctx, 'b2:3').props.onClick(fakeEvent());
    typeInto(ctx, 'question', 'q?');
    steps(ctx);
    await submitForm(ctx);
    await flush();
    const sent = promptOf(ctx.host).model_override;
    assert.deepEqual(sent, override);
    assert.deepEqual(Object.keys(sent).filter((k) => !['model', 'provider', 'reasoning'].includes(k)), []);
    ctx.unload();
  }
  assert.equal(mod.modelOverride(mod.EMPTY_CHOICE), null);
  assert.equal(mod.modelOverride({ model: '  ', provider: 'p', effort: 'high' }), null);
  assert.equal(mod.modelOverride(undefined), null);
  assert.deepEqual(mod.modelOverride({ model: ' m ', provider: ' ', effort: '' }), { model: 'm' });
});

test('nothing picked, or Clear after a pick, sends no model_override', async () => {
  const ctx = setup();
  await flush();
  branchButton(ctx, 'b2:3').props.onClick(fakeEvent());
  typeInto(ctx, 'question', 'q?');
  assert.equal(byAttr(form(ctx), 'data-branch-model-clear').length, 0);
  pickRow(ctx, 'claude-x', 'anthropic');
  byAttr(form(ctx), 'data-branch-model-clear', 'true')[0].props.onClick(fakeEvent());
  assert.equal(textOf(modelButton(ctx)), `${mod.MODEL_INHERIT_TEXT}\n▾`);
  await submitForm(ctx);
  await flush();
  assert.deepEqual(promptOf(ctx.host), { session_id: 'nb-rt', text: 'q?' });
  ctx.unload();
});

test('an SDK without the model picker shows a note in the form and sends no model_override', async () => {
  const ctx = setup({ picker: false });
  await flush();
  branchButton(ctx, 'b2:3').props.onClick(fakeEvent());
  assert.equal(menuOf(ctx), undefined);
  assert.equal(formField(ctx, 'model'), undefined);
  const missing = byAttr(form(ctx), 'data-branch-model-missing', 'true')[0];
  assert.equal(missing.props.children, mod.MODEL_PICKER_MISSING_TEXT);
  assert.equal(missing.props.style.userSelect, 'text');
  typeInto(ctx, 'question', 'q?');
  await submitForm(ctx);
  await flush();
  assert.deepEqual(promptOf(ctx.host), { session_id: 'nb-rt', text: 'q?' });
  ctx.unload();
});

test('a failed session.branch shows its error in the form; nothing is asked or opened', async () => {
  const busy = Object.assign(new Error('session is busy'), { data: { reason: 'session_busy' } });
  for (const [result, text] of [
    [new Error('nothing to branch'), 'Branch failed: nothing to branch'],
    [busy, `${mod.BRANCH_BUSY_TEXT} session is busy`],
    [{}, 'Branch failed: the gateway returned no session.'],
  ]) {
    const host = fakeHost();
    host.branchResult = result;
    const ctx = setup({ host });
    await flush();
    branchButton(ctx, 'b2:3').props.onClick(fakeEvent());
    typeInto(ctx, 'question', 'q?');
    await assert.doesNotReject(async () => submitForm(ctx));
    await flush();
    const error = byAttr(form(ctx), 'data-branch-error', 'true')[0];
    assert.equal(error.props.children, text);
    assert.equal(error.props.style.userSelect, 'text');
    assert.equal(host.order.some(([k]) => k === 'prompt'), false);
    assert.deepEqual(host.opened, []);
    ctx.unload();
  }
  // An empty question is allowed: the branch is made and opened, and nothing is asked.
  const empty = setup();
  await flush();
  branchButton(empty, 'b2:3').props.onClick(fakeEvent());
  await submitForm(empty);
  await flush();
  assert.equal(empty.host.order.some(([k]) => k === 'branch'), true);
  assert.equal(empty.host.order.some(([k]) => k === 'prompt'), false);
  assert.ok(empty.host.opened.length >= 1);
  empty.unload();
});

test('Branch here is disabled with a reason while the open chat runs', async () => {
  const ctx = setup();
  await flush();
  branchButton(ctx, 'b2:3').props.onClick(fakeEvent());
  typeInto(ctx, 'question', 'q?');
  ctx.host.state.busyBySession.set({ 'rt-b2': true });
  const tree = ctx.pane.render();
  assert.ok(byAttr(tree, 'data-branch-here').length > 0);
  for (const b of byAttr(tree, 'data-branch-here')) {
    assert.equal(b.props.disabled, true);
    assert.equal(b.props.title, mod.BRANCH_BUSY_TEXT);
  }
  assert.equal(byAttr(form(ctx), 'data-branch-submit', 'true')[0].props.disabled, true);
  assert.equal(textOf(byAttr(form(ctx), 'data-branch-busy', 'true')[0]), mod.BRANCH_BUSY_TEXT);
  await byAttr(form(ctx), 'data-branch-submit', 'true')[0].props.onClick(fakeEvent());
  assert.equal(ctx.host.order.some(([k]) => k === 'branch'), false);
  // Without the form, the reason is one line below the graph.
  byAttr(form(ctx), 'data-branch-cancel', 'true')[0].props.onClick(fakeEvent());
  assert.equal(textOf(byAttr(ctx.pane.render(), 'data-branch-busy', 'true')[0]), mod.BRANCH_BUSY_TEXT);
  ctx.host.state.busyBySession.set({});
  assert.equal(byAttr(ctx.pane.render(), 'data-branch-busy').length, 0);
  ctx.unload();
});

test('the fork digest is requested after the branch, stored under digest:<chat>:<index>, and shown on that node', async () => {
  const host = fakeHost();
  host.digestEvent = () => ({ digest: 'Fixed: q1 and q2.' });
  const ctx = setup({ host });
  await flush();
  branchButton(ctx, 'root:1').props.onClick(fakeEvent());
  typeInto(ctx, 'question', 'why q2?');
  await submitForm(ctx);
  await flush();
  assert.deepEqual(ctx.host.opened, [['nb', OPEN_HERE]]);
  // After the branch opens, on the new branch's session (the window now views it).
  const kinds = host.order.map(([k]) => k);
  assert.ok(kinds.indexOf('digest') > kinds.indexOf('prompt'));
  assert.deepEqual(host.order.find(([k]) => k === 'digest')[1], {
    session_id: 'nb-rt',
    purpose: 'fork',
    title: 'b2',
    exchanges: [
      { question: 'q1', answer: 'a1' },
      { question: 'q2', answer: 'a2' },
    ],
  });
  assert.equal(ctx.storage.map.get('digest:b2:1'), 'Fixed: q1 and q2.');
  // b2's exchange 1 is drawn on root:1. The tooltip keeps title · model, then the digest.
  const node = nodeOf(ctx.pane.render(), 'root:1');
  assert.equal(node.props.title, 'root · m1\n\nFork digest:\nFixed: q1 and q2.');
  assert.equal(node.props['data-fork-digest'], 'true');
  ctx.unload();

  // Stored: a new activation reads it back on load.
  const again = setup({ storage: ctx.storage });
  await flush();
  assert.equal(nodeOf(again.pane.render(), 'root:1').props.title, 'root · m1\n\nFork digest:\nFixed: q1 and q2.');
  again.unload();
});

test('a failed fork digest shows a notice until Dismiss and never blocks the branch', async () => {
  for (const events of [true, false]) {
    const host = fakeHost();
    host.digestEvent = () => ({ error: 'no model' });
    const ctx = setup({ host, events });
    await flush();
    branchButton(ctx, 'b2:3').props.onClick(fakeEvent());
    typeInto(ctx, 'question', 'q?');
    await submitForm(ctx);
    await flush();
    assert.deepEqual(ctx.host.opened, [['nb', OPEN_HERE]]);
    assert.equal([...ctx.storage.map.keys()].some((k) => k.startsWith('digest:')), false);
    const held = byAttr(ctx.pane.render(), 'data-held-notice', 'fork')[0];
    assert.match(textOf(held), events ? /Fork digest failed: no model/ : /digest backend is not available/);
    byAttr(held, 'data-dismiss', 'fork')[0].props.onClick(fakeEvent());
    assert.equal(byAttr(ctx.pane.render(), 'data-held-notice', 'fork').length, 0);
    ctx.unload();
  }
});

test('exactly one model pill, on the open node, and it moves with the open node', async () => {
  const ctx = setup();
  await flush();
  const modelPills = () =>
    nodeRows(ctx.pane.render()).flatMap((n) => byAttr(n, 'data-pill', 'model').map((p) => [n.props['data-node'], p.props.children]));
  assert.deepEqual(modelPills(), [['b2:3', 'm1']]);
  // Focus moves to b1 after a click on its node: the pill moves to that node.
  nodeOf(ctx.pane.render(), 'b1:2').props.onClick();
  ctx.host.state.focusedStoredSessionId.set('b1');
  ctx.host.state.focusedSessionId.set('rt-b1');
  await flush();
  assert.deepEqual(modelPills(), [['b1:2', 'm1']]);
  // A click on an earlier node of the open chat moves it again.
  ctx.host.rows = ROWS.map((r) => (r.id === 'b1' ? { ...r, model: 'anthropic/claude-x' } : r));
  await ctx.clock.tick(REFRESH_MS);
  nodeOf(ctx.pane.render(), 'root:0').props.onClick();
  ctx.host.state.focusedStoredSessionId.set('root');
  ctx.host.state.focusedSessionId.set('rt-root');
  await flush();
  assert.deepEqual(modelPills(), [['root:0', 'm1']]);
  ctx.unload();
});

test('selectable text covers the nodes, pills, the branch form, the merge pick and every notice', async () => {
  const ctx = await mergeCtx({ prepare: (host) => (host.usage = { context_used: 127990, context_max: 128000 }) });
  await mergeButton(ctx).props.onClick(fakeEvent());
  branchButton(ctx, 'sd:1').props.onClick(fakeEvent());
  ctx.host.branchResult = new Error('nothing to branch');
  await submitForm(ctx); // a failed branch: an error line in the form
  const tree = ctx.pane.render();
  const holders = findAll(
    tree,
    (n) => n.type !== 'Button' && n.type !== 'ScrollArea' && n.props && [n.props.children].flat().some((c) => typeof c === 'string'),
  );
  assert.ok(holders.length >= 8, `only ${holders.length} text nodes`);
  for (const n of holders) assert.equal(n.props.style?.userSelect, 'text', `${n.type} ${JSON.stringify(n.props.children)}`);
  for (const key of ['data-pill', 'data-branch-form', 'data-branch-error', 'data-merge-pick', 'data-pick-item', 'data-pick-detail', 'data-pick-head']) {
    const nodes = byAttr(tree, key);
    assert.ok(nodes.length >= 1, key);
    for (const n of nodes) {
      assert.equal(n.props.style.userSelect, 'text', key);
      assert.equal(n.props['data-selectable-text'], 'true', key);
    }
  }
  for (const input of byAttr(tree, 'data-branch-field')) assert.equal(input.props.style.userSelect, 'text');
  ctx.unload();
});

test('the pane touches host transcript DOM only to reveal a clicked exchange, never sends a draft, and has no imports', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/chat-tree.js', import.meta.url), 'utf8');
  // The one reach into the chat's markup is scrollToTurn (Rohan, 2026-11-12): it reads, scrolls, never writes.
  assert.equal(src.match(/data-message-/g).length, 1);
  assert.match(src, /function scrollToTurn[\s\S]*?\[data-message-id=/);
  assert.doesNotMatch(src, /\.(innerHTML|textContent|outerHTML)\s*=|\.click\(\)|removeChild|appendChild|setAttribute/);
  // The composer is only ever drafted. The one send is the branch question, by prompt.submit.
  assert.doesNotMatch(src, /composer\.submit|\.submit\(/);
  assert.equal(src.match(/'prompt\.submit'/g).length, 1);
  assert.doesNotMatch(src, /^import /m);
  // Hermes names branches: the branch call carries no name.
  assert.doesNotMatch(src, /session\.branch_whole|name: branchName/);
});

// ── Stored histories: plugin.chat-tree.history.read ──────────────────────────────────────────

const storeCalls = (host) => host.calls.filter(([m]) => m === mod.HISTORY_METHOD);

test('one history.read per refresh reads every tree chat by stored id, with no session.history', async () => {
  const ctx = setup({ host: fakeHost({ backend: true }) });
  await flush();
  const calls = storeCalls(ctx.host);
  assert.equal(calls.length, 1);
  const [, params] = calls[0];
  assert.deepEqual([...params.session_ids].sort(), ['b1', 'b2', 'b3', 'root']);
  assert.equal(params.session_id, 'rt-b2');
  assert.equal(historyCalls(ctx.host), 0);
  assert.equal(ctx.host.calls.filter(([m]) => m === 'session.transcript').length, 0);
  const tree = ctx.pane.render();
  assert.deepEqual(nodeKeys(tree), MAIN_KEYS);
  assert.doesNotMatch(textOf(tree), /Enable the chat-tree plugin backend/);
  ctx.unload();
});

test('history.read asks again only for the chats whose history key moved', async () => {
  const ctx = setup({ host: fakeHost({ backend: true }) });
  await flush();
  await ctx.clock.tick(REFRESH_MS * 2);
  // Nothing moved: each refresh asks for the open chat only (its key lags live turns).
  assert.deepEqual(storeCalls(ctx.host).slice(1).map(([, p]) => p.session_ids), [['b2'], ['b2']]);
  ctx.host.rows = ROWS.map((r) => (r.id === 'b1' ? { ...r, message_count: 4 } : r));
  ctx.host.history.b1 = [...HIST.b1, { role: 'user', text: 'b1 more' }];
  await ctx.clock.tick(REFRESH_MS);
  const calls = storeCalls(ctx.host);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[3][1].session_ids, ['b1', 'b2']);
  assert.equal(historyCalls(ctx.host), 0);
  assert.ok(nodeKeys(ctx.pane.render()).includes('b1:3'));
  ctx.unload();
});

test('without the Python half (-32601) the pane reads each chat with session.history and shows the backend note', async () => {
  const ctx = setup(); // fakeHost answers history.read with -32601 by default
  await flush();
  assert.equal(storeCalls(ctx.host).length, 1);
  for (const id of ['root', 'b1', 'b2', 'b3']) assert.equal(historyCalls(ctx.host, id), 1, id);
  const tree = ctx.pane.render();
  assert.deepEqual(nodeKeys(tree), MAIN_KEYS);
  assert.ok(textOf(tree).includes(mod.BACKEND_NOTE_TEXT));
  assert.equal(mod.BACKEND_NOTE_TEXT, 'Enable the chat-tree plugin backend to see other chats (hermes plugins enable chat-tree).');
  assert.doesNotMatch(textOf(tree), /Stored histories/);
  assert.equal(ctx.tree.$status.get().note, mod.BACKEND_NOTE_TEXT);
  ctx.unload();
});

test('ids: history.read gets stored ids only; the fallback reads the open chat by its runtime id when its stored id fails', async () => {
  const host = fakeHost();
  const history = { ...HIST, 'rt-b2': HIST.b2 };
  delete history.b2;
  host.history = history;
  const base = host.request;
  host.request = async (method, params) => {
    // A legacy gateway knows live chats by runtime id only.
    if (method === 'session.history' && params.session_id === 'b2') {
      host.calls.push([method, params]);
      throw Object.assign(new Error('session not found'), { code: 4001 });
    }
    return base(method, params);
  };
  const ctx = setup({ host });
  await flush();
  const [, params] = storeCalls(host)[0];
  assert.ok(!params.session_ids.includes('rt-b2'));
  assert.ok(params.session_ids.includes('b2'));
  assert.equal(historyCalls(host, 'rt-b2'), 1);
  assert.deepEqual(nodeKeys(ctx.pane.render()), MAIN_KEYS);
  assert.doesNotMatch(textOf(ctx.pane.render()), /History of b2/);
  ctx.unload();
});

test('a chat missing from the store is read with session.history; another history.read error shows its text', async () => {
  const host = fakeHost({ backend: true });
  host.store = { ...HIST };
  delete host.store.b3;
  const ctx = setup({ host });
  await flush();
  assert.equal(historyCalls(host), 1);
  assert.equal(historyCalls(host, 'b3'), 1);
  assert.deepEqual(nodeKeys(ctx.pane.render()), MAIN_KEYS);

  host.historyReadError = Object.assign(new Error('plugin_rpc_failed: OperationalError: locked'), { code: 4001 });
  host.rows = ROWS.map((r) => (r.id === 'root' ? { ...r, message_count: 7 } : r));
  await ctx.clock.tick(REFRESH_MS);
  const text = textOf(ctx.pane.render());
  assert.match(text, /Stored histories: plugin_rpc_failed: OperationalError: locked/);
  assert.doesNotMatch(text, /Enable the chat-tree plugin backend/);
  assert.equal(historyCalls(host, 'root'), 1); // the fallback read root the old way
  ctx.unload();
});

test('parseHistoryReply keeps list histories and string missing ids; no histories object is null', () => {
  const reply = mod.parseHistoryReply({ histories: { a: [{ role: 'user', text: 'q' }], b: 'bad' }, missing: ['c', 4] });
  assert.deepEqual([...reply.histories.keys()], ['a']);
  assert.deepEqual([...reply.missing], ['c']);
  assert.equal(mod.parseHistoryReply({}), null);
  assert.equal(mod.parseHistoryReply({ histories: [] }), null);
  assert.equal(mod.parseHistoryReply(null), null);
});


// ── Scroll to the clicked exchange ───────────────────────────────────────────────────────────

// Rows with row ids, as session.history and history.read give them: user rows 10, 12, 14 in b1.
const withRowIds = (list, first) => list.map((m, i) => ({ ...m, row_id: first + i }));
const HIST_ROWS = Object.fromEntries(Object.entries(HIST).map(([id, list], n) => [id, withRowIds(list, 10 + n * 100)]));

// The main chat's viewport, as the chat thread renders it: dispatchEvent reaches the reveal
// listener; querySelector finds the revealed message; closest finds its turn.
function fakeViewport({ answer } = {}) {
  const events = [];
  const scrolls = [];
  const turn = { getBoundingClientRect: () => ({ top: 500 }) };
  const message = { closest: (sel) => (sel === '[data-slot="aui_turn-pair"]' ? turn : null) };
  const viewport = {
    scrollTop: 100,
    events,
    scrolls,
    getBoundingClientRect: () => ({ top: 50 }),
    querySelector: (sel) => (sel.startsWith('[data-message-id=') ? message : null),
    scrollTo: (opts) => scrolls.push(opts),
    dispatchEvent(event) {
      events.push(event);
      if (answer) answer(event.detail);
      return true;
    },
  };
  return viewport;
}
const fakeDocument = (viewport) => {
  const asked = [];
  return { asked, querySelector: (sel) => (asked.push(sel), viewport ?? null) };
};

test('exchangesFromRows keeps the row id of each user row, and leaves it out when rows carry none', () => {
  const list = mod.exchangesFromRows(withRowIds(msgs(['q1', 'a1'], ['q2', 'a2']), 7));
  assert.deepEqual(list.map((e) => e.rowId), [7, 9]);
  assert.equal('rowId' in mod.exchangesFromRows(msgs(['q1', 'a1']))[0], false);
});

test('a node click reveals its exchange in the main chat and scrolls the turn into view', async () => {
  const viewport = fakeViewport({ answer: (d) => d.complete('msg-b1-2') });
  const document = fakeDocument(viewport);
  const ctx = setup({ host: fakeHost({ history: HIST_ROWS }), document });
  await flush();
  nodeOf(ctx.pane.render(), 'b1:2').props.onClick();
  await flush();
  // Not yet: the main chat still shows b2.
  await ctx.clock.tick(mod.REVEAL_POLL_MS);
  assert.equal(viewport.events.length, 0);
  ctx.host.state.focusedStoredSessionId.set('b1');
  await ctx.clock.tick(mod.REVEAL_POLL_MS + mod.REVEAL_SETTLE_MS);
  assert.ok(document.asked.includes(mod.WORKSPACE_VIEWPORT));
  assert.equal(viewport.events.length, 1);
  const [event] = viewport.events;
  assert.equal(event.type, mod.REVEAL_EVENT);
  // b1's third user row: rows 110..115, user rows 110, 112, 114.
  assert.equal(event.detail.rowId, 114);
  assert.equal(event.detail.id, 'history:114');
  assert.equal(typeof event.detail.complete, 'function');
  assert.equal(event.detail.signal.aborted, false);
  // scrollTop 100 + turn top 500 - viewport top 50 - 8.
  assert.deepEqual(viewport.scrolls, [{ top: 542, behavior: 'smooth' }]);
  ctx.unload();
});

test('a miss right after the switch is tried again, then given up', async () => {
  const viewport = fakeViewport({ answer: (d) => d.complete(false) });
  const ctx = setup({ host: fakeHost({ history: HIST_ROWS }), document: fakeDocument(viewport) });
  await flush();
  ctx.host.state.focusedStoredSessionId.set('b1');
  nodeOf(ctx.pane.render(), 'b1:2').props.onClick();
  await ctx.clock.tick(5_000);
  assert.equal(viewport.events.length, 1 + mod.REVEAL_RETRIES);
  assert.deepEqual(viewport.scrolls, []);
  ctx.unload();
});

test('no viewport, no row id, or a closed pane: the chat opens and nothing else happens', async () => {
  // No viewport ever: polling stops after REVEAL_WAIT_MS.
  const none = fakeDocument(null);
  const a = setup({ host: fakeHost({ history: HIST_ROWS }), document: none });
  await flush();
  a.host.state.focusedStoredSessionId.set('b1');
  nodeOf(a.pane.render(), 'b1:2').props.onClick();
  await a.clock.tick(mod.REVEAL_WAIT_MS * 2);
  assert.deepEqual(a.host.opened.at(-1), ['b1', { intent: 'in-place', profile: 'default' }]);
  assert.equal(none.asked.length, mod.REVEAL_WAIT_MS / mod.REVEAL_POLL_MS);
  a.unload();

  // Rows with no row_id: no event at all.
  const viewport = fakeViewport();
  const b = setup({ document: fakeDocument(viewport) });
  await flush();
  b.host.state.focusedStoredSessionId.set('b1');
  nodeOf(b.pane.render(), 'b1:2').props.onClick();
  await b.clock.tick(1_000);
  assert.equal(viewport.events.length, 0);
  b.unload();

  // Closed before the main chat switched: the reveal never fires.
  const late = fakeViewport();
  const c = setup({ host: fakeHost({ history: HIST_ROWS }), document: fakeDocument(late) });
  await flush();
  nodeOf(c.pane.render(), 'b1:2').props.onClick();
  c.unload();
  c.host.state.focusedStoredSessionId.set('b1');
  await c.clock.tick(1_000);
  assert.equal(late.events.length, 0);
});

test('a second click aborts the first reveal', async () => {
  const viewport = fakeViewport();
  const ctx = setup({ host: fakeHost({ history: HIST_ROWS }), document: fakeDocument(viewport) });
  await flush();
  ctx.host.state.focusedStoredSessionId.set('b1');
  nodeOf(ctx.pane.render(), 'b1:2').props.onClick();
  await ctx.clock.tick(mod.REVEAL_SETTLE_MS);
  const first = viewport.events[0].detail;
  nodeOf(ctx.pane.render(), 'root:0').props.onClick();
  assert.equal(first.signal.aborted, true);
  first.complete('late');
  ctx.host.state.focusedStoredSessionId.set('root');
  await ctx.clock.tick(mod.REVEAL_POLL_MS + mod.REVEAL_SETTLE_MS);
  assert.deepEqual(viewport.scrolls, []);
  // root's first user row.
  assert.equal(viewport.events.at(-1).detail.rowId, 10);
  ctx.unload();
});

test('shortLabel drops HTML comments and leading quote marks', () => {
  assert.equal(mod.shortLabel('<!-- reply 1 --> > Supabase Auth has its own schema'), 'Supabase Auth has its own schema');
  assert.equal(mod.shortLabel('> > quoted twice'), 'quoted twice');
  assert.equal(mod.shortLabel('a <!-- x --> b'), 'a b');
});

test('the active colour is the theme primary, not the neutral --ui-accent', () => {
  assert.equal(mod.ACCENT, 'var(--dt-primary, #3B82F6)');
  assert.notEqual(mod.ACCENT, mod.ROLE_COLOURS.hover);
});

test('treeFocus keeps the last listed chat when the focused chat is not in the session list', () => {
  const rows = [{ id: 'a', title: 'A' }, { id: 'b', title: 'B', parent_session_id: 'a' }];
  assert.equal(mod.treeFocus(rows, 'b', 'a'), 'b');
  assert.equal(mod.treeFocus(rows, 'sub', 'b'), 'b'); // a subagent's chat: hidden from the list
  assert.equal(mod.treeFocus(rows, 'sub', null), 'sub');
  assert.equal(mod.treeFocus(rows, 'sub', 'gone'), 'sub');
});

test('opening a subagent chat (not in the session list) keeps the last tree, read-only, with a note', async () => {
  const ctx = setup();
  await flush();
  const before = nodeKeys(ctx.pane.render());
  assert.ok(before.length > 0);
  ctx.host.state.focusedStoredSessionId.set('subagent-child');
  ctx.host.state.focusedSessionId.set('rt-subagent-child');
  await flush();
  await flush();
  const tree = ctx.pane.render();
  assert.deepEqual(nodeKeys(tree), before);
  assert.equal(byAttr(tree, 'data-unlisted-focus').length, 1);
  assert.equal(byAttr(tree, 'data-merge-section').length, 0);
  ctx.unload();
});

// ── Row icon actions, the merge popover, the refresh icon, a narrow pane ──────────────────────

const SDK_UI = { Popover: 'Popover', PopoverTrigger: 'PopoverTrigger', PopoverContent: 'PopoverContent', Tip: 'Tip', Codicon: 'Codicon' };
// The three icon slots of a node row, in order: branch, merge, tab.
const slotsOf = (node) =>
  node.props.children
    .filter((c) => c?.props)
    .slice(-3)
    .map((c) => {
      const p = findAll(c, (n) => n.props && Object.keys(n.props).some((k) => /^data-(branch|merge|tab|open-tab|empty)/.test(k)))[0]?.props ?? {};
      const k = Object.keys(p).find((key) => /^data-(branch-here|branch-slot|merge-here|merge-slot|open-tab|tab-slot|empty-slot)$/.test(key));
      return k === 'data-empty-slot' ? `empty:${p[k]}` : k?.replace('data-', '');
    });

test('row icons: Branch on branchable rows, Merge only on the open lane with a parent, Open in a tab on every row', async () => {
  const ctx = setup(); // focus b2, parent b1
  await flush();
  const tree = ctx.pane.render();
  const rows = nodeRows(tree);
  assert.ok(rows.length >= 4);
  for (const row of rows) {
    const slots = slotsOf(row);
    assert.equal(slots.length, 3, row.props['data-node']);
    const own = row.props['data-chat-id'] === 'b2';
    assert.ok(['branch-here', 'branch-slot', 'empty:branch'].includes(slots[0]));
    assert.equal(['merge-here', 'merge-slot'].includes(slots[1]), own, `${row.props['data-node']} ${slots[1]}`);
    if (!own) assert.equal(slots[1], 'empty:merge');
    assert.ok(['open-tab', 'tab-slot'].includes(slots[2]));
  }
  // A hidden slot is the same size as a shown icon: nothing moves when the icons show.
  const hidden = byAttr(tree, 'data-tab-slot')[0];
  assert.equal(hidden.props.style.visibility, 'hidden');
  assert.equal(hidden.props.style.width, 20);
  assert.equal(hidden.props.tabIndex, -1);
  // The pointer on a row shows its icons; each is an icon with an aria-label and a tooltip.
  const key = rows.find((r) => r.props['data-chat-id'] === 'root').props['data-node'];
  nodeOf(ctx.pane.render(), key).props.onMouseEnter();
  const row = nodeOf(ctx.pane.render(), key);
  const tab = byAttr(row, 'data-open-tab', key)[0];
  assert.equal(tab.props['aria-label'], 'Open in a tab');
  assert.equal(tab.props.title, 'Open in a tab'); // no Tip in this setup: the native title
  assert.equal(typeof tab.props.children, 'object'); // an icon, no text
  assert.equal(byAttr(row, 'data-merge-here').length, 0);
  const event = fakeEvent();
  tab.props.onClick(event);
  await flush();
  assert.equal(event.stopped, 1);
  assert.deepEqual(ctx.host.opened.at(-1), ['root', { intent: 'tab', profile: 'default' }]);
  // On the open lane, Merge shows too.
  const own = rows.find((r) => r.props['data-chat-id'] === 'b2').props['data-node'];
  nodeOf(ctx.pane.render(), own).props.onMouseEnter();
  assert.equal(byAttr(nodeOf(ctx.pane.render(), own), 'data-merge-here', own).length, 1);
  ctx.unload();
});

test('with the SDK Popover, Tip and Codicon: the pick is anchored at the row, icons carry tooltips', async () => {
  const host = fakeHost();
  host.usage = { context_used: 1000, context_max: 128000 };
  const ctx = setup({ host, deps: SDK_UI });
  await flush();
  const own = nodeRows(ctx.pane.render()).find((r) => r.props['data-chat-id'] === 'b2').props['data-node'];
  nodeOf(ctx.pane.render(), own).props.onMouseEnter();
  const root = () => findAll(nodeOf(ctx.pane.render(), own), (n) => n.type === 'Popover' && n.key === 'merge')[0];
  assert.equal(root().props.open, false);
  const tip = findAll(root(), (n) => n.type === 'Tip')[0];
  assert.equal(tip.props.label, 'Merge into…');
  const trigger = tip.props.children;
  assert.equal(trigger.type, 'PopoverTrigger');
  assert.equal(trigger.props.asChild, true);
  const icon = trigger.props.children;
  assert.equal(icon.props['aria-label'], 'Merge into');
  assert.equal(icon.props.title, undefined); // the Tip is the tooltip
  assert.equal(icon.props.children.type, 'Codicon');
  assert.equal(icon.props.children.props.name, 'git-merge');
  root().props.onOpenChange(true);
  const content = findAll(root(), (n) => n.type === 'PopoverContent')[0];
  assert.equal(root().props.open, true);
  assert.equal(content.props['data-merge-pick'], own);
  // A click or key in the content never reaches the row.
  const event = fakeEvent();
  content.props.onClick(event);
  assert.equal(event.stopped, 1);
  // No pick under the graph when the Popover holds it.
  const under = byAttr(ctx.pane.render(), 'data-merge-pick').filter((n) => n.type !== 'PopoverContent');
  assert.equal(under.length, 0);
  // Pick the parent, then As-is: the popover closes and the draft is staged.
  byAttr(content, 'data-merge-target', 'b1')[0].props.onClick(fakeEvent());
  await flush();
  byAttr(findAll(root(), (n) => n.type === 'PopoverContent')[0], 'data-merge', 'asis')[0].props.onClick(fakeEvent());
  await flush();
  assert.equal(ctx.host.drafts.length, 1);
  assert.equal(ctx.host.drafts[0][0], 'b1');
  assert.equal(byAttr(ctx.pane.render(), 'data-merge-result')[0].props['data-merge-result'], 'ok');
  // Refresh: an icon button with its name as aria-label and Tip.
  const refreshTip = findAll(ctx.pane.render(), (n) => n.type === 'Tip' && n.props.label === 'Refresh')[0];
  assert.equal(refreshTip.props.children.props['aria-label'], 'Refresh');
  assert.equal(refreshTip.props.children.props['data-refresh'], 'true');
  ctx.unload();
});

test('Refresh is an icon button with no text', async () => {
  const ctx = setup();
  await flush();
  const refresh = byAttr(ctx.pane.render(), 'data-refresh')[0];
  assert.equal(refresh.type, 'Button');
  assert.equal(refresh.props['aria-label'], 'Refresh');
  assert.equal(refresh.props.title, 'Refresh');
  assert.equal(findAll(refresh, (n) => n.type === 'svg').length, 1);
  assert.equal(findAll(ctx.pane.render(), (n) => n.props?.children === 'Refresh').length, 0);
  ctx.unload();
});

test('the merge pick and the result line keep the hook order (React error 300)', async () => {
  const log = [];
  const useValue = (a) => {
    log.push(a);
    return a.get();
  };
  const host = fakeHost();
  host.usage = { context_used: 1000, context_max: 128000 };
  const ctx = setup({ host, useValue });
  await flush();
  const order = () => {
    log.length = 0;
    ctx.pane.render();
    return [...log];
  };
  const states = [order()];
  openPickOf(ctx);
  states.push(order()); // step Where
  const how = await openHow(ctx);
  states.push(order()); // step How
  byAttr(how, 'data-merge', 'asis')[0].props.onClick(fakeEvent());
  states.push(order()); // the result line, busy
  await flush();
  assert.equal(byAttr(ctx.pane.render(), 'data-merge-result')[0].props['data-merge-result'], 'ok');
  states.push(order()); // the result line, staged
  for (const s of states) assert.deepEqual(s, states[0]);
  assert.equal(states[0].length, 8);
  ctx.unload();
});

test('withSpacer moves every row index past the spacer, so the lines run through it', () => {
  const { plan } = planFor(ROWS, 'b2', HIST);
  const spaced = mod.withSpacer(plan, 0, 2, { key: 'result' });
  assert.equal(spaced.rows.length, plan.rows.length + 2);
  assert.deepEqual(spaced.rows.slice(1, 3).map((r) => [r.kind, r.spanIndex, r.span]), [['spacer', 0, 2], ['spacer', 1, 2]]);
  for (let i = 0; i < plan.lanes.length; i++) {
    assert.deepEqual(spaced.lanes[i].rows, plan.lanes[i].rows.map((r) => (r > 0 ? r + 2 : r)));
  }
  const geo = mod.graphGeometry(spaced);
  assert.equal(geo.height, spaced.rows.length * mod.ROW_H);
  assert.equal(geo.circles.length, mod.graphGeometry(plan).circles.length);
  assert.equal(mod.withSpacer(plan, -1, 1), plan);
});

test('a narrow pane: rows, labels, pills and icons keep to the width; notes wrap', async () => {
  const host = fakeHost({ stored: 'b2', runtime: 'rt-b2' });
  host.agents = [{ subagent_id: 'sa', goal: 'a very long subagent goal '.repeat(8) }];
  const ctx = setup({ host });
  await flush();
  await ctx.clock.tick(REFRESH_MS);
  const tree = ctx.pane.render();
  const root = byAttr(tree, 'data-chat-tree-root')[0];
  assert.equal(root.props.style.width, 0); // Radix ScrollArea's display:table child cannot grow it
  assert.equal(root.props.style.minWidth, '100%');
  assert.equal(root.props.style.overflowX, 'hidden');
  assert.equal(root.props.style.boxSizing, 'border-box');
  const graph = byAttr(tree, 'data-tree-graph')[0];
  assert.equal(graph.props.style.width, '100%');
  assert.equal(graph.props.style.minWidth, 0);
  for (const row of nodeRows(tree)) {
    assert.equal(row.props.style.display, 'flex');
    assert.equal(row.props.style.width, '100%');
    assert.equal(row.props.style.minWidth, 0);
    const label = byAttr(row, 'data-label')[0];
    assert.deepEqual(
      [label.props.style.flex, label.props.style.minWidth, label.props.style.overflow, label.props.style.textOverflow, label.props.style.whiteSpace],
      ['1 1 auto', 0, 'hidden', 'ellipsis', 'nowrap'],
    );
    for (const c of row.props.children.filter((x) => x?.props && x !== label)) assert.equal(c.props.style?.flex ?? findAll(c, (n) => n.props?.style?.flex)[0]?.props.style.flex, '0 0 auto');
  }
  for (const pill of byAttr(tree, 'data-pill')) assert.equal(pill.props.style.flex, '0 0 auto');
  const notes = [...findAll(tree, (n) => n.type === 'p'), ...byAttr(tree, 'data-subagent-goal')];
  assert.ok(notes.length >= 2);
  for (const n of notes) {
    assert.equal(n.props.style.whiteSpace, 'normal');
    assert.equal(n.props.style.overflowWrap, 'anywhere');
    assert.equal(n.props.style.wordBreak, 'break-word');
  }
  ctx.unload();
});

test('with the SDK Popover, Branch here opens its form at the row; Escape or a click outside closes it', async () => {
  const ctx = setup({ deps: SDK_UI });
  await flush();
  const key = 'root:1';
  nodeOf(ctx.pane.render(), key).props.onMouseEnter();
  const root = () => findAll(nodeOf(ctx.pane.render(), key), (n) => n.type === 'Popover' && n.key === 'branch')[0];
  assert.equal(root().props.open, false);
  const tip = findAll(root(), (n) => n.type === 'Tip')[0];
  assert.equal(tip.props.label, 'Branch here');
  root().props.onOpenChange(true);
  assert.equal(root().props.open, true);
  const content = findAll(root(), (n) => n.type === 'PopoverContent')[0];
  assert.equal(content.props['data-branch-pick'], key);
  assert.equal(byAttr(content, 'data-branch-form').length, 1);
  // Not under the graph as well.
  assert.equal(byAttr(ctx.pane.render(), 'data-branch-form').length, 1);
  root().props.onOpenChange(false);
  assert.equal(ctx.tree.$ui.get().branch, null);
  ctx.unload();
});

// ── Branch names: a name row at each fork, and the Branches view ─────────────────────────────

const nameRows = (tree) => byAttr(tree, 'data-name-row');

test('name rows: one per child lane, right after its fork, with the Hermes title; the elbow lands on it', () => {
  const { lanes, plan } = planFor(ROWS, 'b2', HIST);
  const names = plan.rows.filter((r) => r.kind === 'name');
  // Every lane with a parent, none for the root.
  assert.deepEqual(names.map((r) => r.lane), ['b3', 'b1', 'b2']);
  for (const name of names) {
    const lane = lanes.find((l) => l.id === name.lane);
    const at = plan.rows.indexOf(name);
    const entry = plan.lanes.find((l) => l.id === name.lane);
    assert.equal(name.label, lane.title);
    assert.equal(name.model, lane.model);
    // Right after the fork node, right before the lane's first own exchange.
    assert.equal(entry.anchorRow, at - 1);
    assert.equal(entry.firstRow, at);
    assert.equal(plan.rows[at + 1].key, `${name.lane}:${name.index}`);
    assert.equal(name.col, entry.col);
  }
  // Not a node: no circle, a small square; the fork elbow ends at the name row's centre.
  const geo = mod.graphGeometry(plan);
  assert.ok(!geo.circles.some((c) => c.key.startsWith('name:')));
  assert.deepEqual(geo.marks.map((m) => m.key), ['name:b3', 'name:b1', 'name:b2']);
  const b1 = plan.lanes.find((l) => l.id === 'b1');
  assert.ok(geo.paths.find((p) => p.key === 'fork:b1').d.endsWith(`V ${b1.firstRow * 26 + 13}`));
  // The blue path and the hover path run through it in their colours.
  assert.deepEqual([names[1].blue, names[0].blue], [true, false]);
  const hovered = planFor(ROWS, 'b2', HIST, { hovered: 'name:b3' }).plan;
  assert.deepEqual(hoverOf(hovered), ['root:0', 'name:b3', 'b3:1']);
  // A stub lane gets its name row too; a lane with no rows of its own gets none.
  const rows = [...ROWS, row('nb', { _branched_from: 'root', started_at: 50, title: 'Why q2' }), row('dry', { _branched_from: 'root', started_at: 60 })];
  const stubbed = planFor(rows, 'b2', { ...HIST, nb: msgs(['q1', 'a1'], ['q2', 'a2']), dry: [] }).plan;
  const keys = keysOf(stubbed);
  assert.equal(keys.indexOf('nb:2'), keys.indexOf('name:nb') + 1);
  assert.equal(stubbed.rows.find((r) => r.key === 'name:nb').label, 'Why q2');
  assert.ok(!keys.includes('name:dry'));
});

test('collapse never takes a name row: a long child lane keeps it before its +N run', () => {
  const rows = [row('root', { started_at: 1 }), row('c', { _branched_from: 'root', started_at: 2, title: 'Long branch' })];
  const history = { root: msgs(...TEN.slice(0, 2)), c: msgs(...TEN.slice(0, 1), ...TEN.slice(1).map(([q, a]) => [`c ${q}`, a])) };
  const { plan } = planFor(rows, 'root', history);
  assert.deepEqual(keysOf(plan), ['root:0', 'name:c', 'c:1', 'more:c:2', 'c:9', 'root:1']);
  const geo = mod.graphGeometry(plan);
  // The lane line runs from the name row through the first node and the run.
  assert.deepEqual(geo.paths.filter((p) => p.key.startsWith('lane:c')).map((p) => p.d), ['M 22 39 V 61', 'M 22 69 V 91', 'M 22 91 V 113']);
});

test('a name row: 12 px muted title with the fork icon and model; a click opens its first exchange in place', async () => {
  const ctx = setup();
  await flush();
  const tree = ctx.pane.render();
  assert.deepEqual(nameRows(tree).map((n) => n.props['data-name-row']), ['b3', 'b1', 'b2']);
  const b1 = nameRows(tree).find((n) => n.props['data-name-row'] === 'b1');
  const label = byAttr(b1, 'data-label')[0];
  assert.equal(label.props.children, 'b1');
  assert.equal(label.props.style.fontSize, 12);
  assert.equal(label.props.style.color, MUTED);
  // Narrow-pane rules: the label ellipsizes, every other child keeps its size.
  assert.deepEqual([label.props.style.flex, label.props.style.minWidth, label.props.style.textOverflow, label.props.style.whiteSpace], ['1 1 auto', 0, 'ellipsis', 'nowrap']);
  for (const c of b1.props.children.filter((x) => x?.props && x !== label)) assert.equal(c.props.style.flex, '0 0 auto');
  assert.equal(byAttr(b1, 'data-name-model')[0].props.children, 'm1');
  assert.equal(byAttr(b1, 'data-name-glyph').length, 1);
  assert.equal(b1.props['data-selectable-text'], 'true');
  assert.equal(b1.props.style.userSelect, 'text');
  // Not a node: no Branch, Merge or tab icons.
  assert.equal(byAttr(b1, 'data-branch-slot').length + byAttr(b1, 'data-tab-slot').length, 0);
  b1.props.onClick();
  await flush();
  assert.deepEqual(ctx.host.opened, [['b1', { intent: 'in-place', profile: 'default' }]]);
  assert.deepEqual(ctx.tree.$ui.get().open, { chatId: 'b1', index: 2 });
  // The pointer on it lights its path in the hover colour.
  b1.props.onMouseEnter();
  assert.equal(ctx.tree.$hover.get().pointer, 'name:b1');
  assert.equal(circleColours(ctx.pane.render())['c:root:1'][0], HOVER);
  ctx.unload();
});

test('Branches view: one row per chat with its title, exchange count and merged; the open chat is open and active', () => {
  const { plan } = planFor(ROWS, 'b2', HIST, { mode: mod.BRANCHES_MODE });
  assert.deepEqual(keysOf(plan), ['name:root', 'name:b3', 'name:b1', 'name:b2']);
  assert.ok(plan.rows.every((r) => r.kind === 'name'));
  assert.deepEqual(plan.rows.map((r) => [r.label, r.count]), [['root', 3], ['Side: what is x?', 1], ['b1', 1], ['b2', 1]]);
  assert.deepEqual(plan.rows.filter((r) => r.open).map((r) => r.key), ['name:b2']);
  assert.deepEqual(blueOf(plan), ['name:root', 'name:b1', 'name:b2']);
  // Fork elbows connect the chat rows: each child leaves its parent's row.
  const lane = (id) => plan.lanes.find((l) => l.id === id);
  assert.deepEqual(['b3', 'b1', 'b2'].map((id) => plan.rows[lane(id).anchorRow].key), ['name:root', 'name:root', 'name:b1']);
  const geo = mod.graphGeometry(plan);
  assert.deepEqual(geo.paths.map((p) => [p.key, p.role]), [['fork:b3', 'inactive'], ['fork:b1', 'active'], ['fork:b2', 'active']]);
  // An outline: each child one column right of its parent; its elbow runs down the parent's column
  // and turns right into its row. Siblings share a column.
  assert.deepEqual(['root', 'b3', 'b1', 'b2'].map((id) => lane(id).col), [0, 1, 1, 2]);
  assert.equal(geo.paths.find((p) => p.key === 'fork:b1').d, 'M 8 13 V 60 A 5 5 0 0 0 13 65 H 22');
  assert.equal(geo.circles.length, 0);
  // merged: a merge node in an ancestor names the chat.
  const merged = planFor(MERGE_ROWS, 'par', MERGE_HIST, { mode: mod.BRANCHES_MODE }).plan;
  assert.deepEqual(merged.rows.map((r) => [r.key, r.merged, r.count]), [['name:par', false, 3], ['name:sd', true, 1]]);
});

test('the view toggle: Exchanges by default, Branches shows one row per chat, a click opens that chat, and back', async () => {
  const ctx = setup();
  await flush();
  let tree = ctx.pane.render();
  const toggle = byAttr(tree, 'data-mode-toggle')[0];
  assert.ok(toggle);
  const button = (t, mode) => byAttr(t, 'data-mode', mode)[0];
  assert.deepEqual([button(tree, 'exchanges').props['aria-pressed'], button(tree, 'branches').props['aria-pressed']], [true, false]);
  assert.deepEqual(nodeKeys(tree), MAIN_KEYS);
  button(tree, 'branches').props.onClick();
  tree = ctx.pane.render();
  assert.equal(ctx.tree.$ui.get().mode, 'branches');
  assert.equal(ctx.storage.map.get(mod.MODE_KEY), 'branches');
  assert.deepEqual(button(tree, 'branches').props['aria-pressed'], true);
  assert.deepEqual(nodeKeys(tree), []);
  assert.deepEqual(nameRows(tree).map((n) => n.props['data-name-row']), ['root', 'b3', 'b1', 'b2']);
  const open = nameRows(tree).find((n) => n.props['data-open']);
  assert.equal(open.props['data-name-row'], 'b2');
  assert.equal(open.props.style.background, `color-mix(in srgb, ${ACCENT} 14%, transparent)`);
  assert.match(textOf(nameRows(tree)[0]), /\(3 exchanges\)/);
  nameRows(tree).find((n) => n.props['data-name-row'] === 'b3').props.onClick();
  await flush();
  assert.deepEqual(ctx.host.opened, [['b3', { intent: 'in-place', profile: 'default' }]]);
  assert.equal(ctx.tree.$ui.get().open, null);
  button(ctx.pane.render(), 'exchanges').props.onClick();
  assert.deepEqual(nodeKeys(ctx.pane.render()), MAIN_KEYS);
  // The stored mode comes back on the next activation.
  ctx.unload();
  const again = setup({ storage: ctx.storage });
  await flush();
  assert.equal(again.tree.$ui.get().mode, 'exchanges');
  again.unload();
  ctx.storage.map.set(mod.MODE_KEY, 'branches');
  const third = setup({ storage: ctx.storage });
  await flush();
  assert.equal(third.tree.$ui.get().mode, 'branches');
  third.unload();
});

test('name rows and the Branches view keep the hook order (React error 300)', async () => {
  const log = [];
  const useValue = (a) => {
    log.push(a);
    return a.get();
  };
  const ctx = setup({ useValue });
  await flush();
  const order = () => {
    log.length = 0;
    ctx.pane.render();
    return [...log];
  };
  const states = [order()];
  nameRows(ctx.pane.render())[0].props.onMouseEnter();
  states.push(order()); // a hovered name row
  byAttr(ctx.pane.render(), 'data-mode', 'branches')[0].props.onClick();
  states.push(order()); // the Branches view
  nameRows(ctx.pane.render())[1].props.onMouseEnter();
  states.push(order());
  byAttr(ctx.pane.render(), 'data-mode', 'exchanges')[0].props.onClick();
  states.push(order()); // back
  for (const s of states) {
    assert.equal(s.length, 8);
    assert.deepEqual(s, states[0]);
  }
  ctx.unload();
});

test('a level edit whose row names no model keeps the picked model', async () => {
  const ctx = setup();
  await flush();
  branchButton(ctx, 'b2:3').props.onClick(fakeEvent());
  typeInto(ctx, 'question', 'q?');
  pickRow(ctx, 'claude-x', 'anthropic');
  controllerOf(ctx).setOptions({ effort: 'high' }, { isActive: true });
  controllerOf(ctx).setOptions({ effort: 'low' }, undefined);
  await submitForm(ctx);
  await flush();
  assert.deepEqual(promptOf(ctx.host).model_override, { model: 'claude-x', provider: 'anthropic', reasoning: 'low' });
  ctx.unload();
});

test('a picked model becomes the branch model through config.set, with or without a question', async () => {
  for (const question of ['', 'q?']) {
    const host = fakeHost();
    host.configSet = () => ({ ok: true });
    const ctx = setup({ host });
    await flush();
    branchButton(ctx, 'b2:3').props.onClick(fakeEvent());
    if (question) typeInto(ctx, 'question', question);
    pickRow(ctx, 'claude-x', 'anthropic');
    controllerOf(ctx).setOptions({ effort: 'high' }, { isActive: true, model: 'claude-x', provider: 'anthropic' });
    await submitForm(ctx);
    await flush();
    const sets = host.calls.filter(([m]) => m === 'config.set').map(([, p]) => p);
    assert.equal(sets.length, 2);
    assert.deepEqual({ ...sets[0], session_id: undefined }, { key: 'model', session_id: undefined, value: 'claude-x --provider anthropic --session' });
    assert.deepEqual({ ...sets[1], session_id: undefined }, { key: 'reasoning', session_id: undefined, value: 'high' });
    assert.ok(sets.every((p) => p.session_id && p.session_id !== 'rt-b2'), 'set on the new branch, not the open chat');
    const prompt = host.order.find(([k]) => k === 'prompt');
    if (question) assert.equal(prompt[1].model_override, undefined);
    else assert.equal(prompt, undefined);
    assert.ok(host.opened.length >= 1);
    ctx.unload();
  }
});

test('without config.set and without a question, a picked model shows a notice and the branch still opens', async () => {
  const ctx = setup();
  await flush();
  branchButton(ctx, 'b2:3').props.onClick(fakeEvent());
  pickRow(ctx, 'claude-x', 'anthropic');
  await submitForm(ctx);
  await flush();
  assert.ok(ctx.host.opened.length >= 1);
  assert.match(textOf(ctx.pane.render()), /did not take its model/);
  ctx.unload();
});

const nameRowOf = (tree, chatId) => findAll(tree, (n) => n.props?.['data-name-row'] === chatId)[0];
const nameLabelOf = (tree, chatId) => findAll(nameRowOf(tree, chatId), (n) => n.props?.['data-label'] === 'true')[0];
const renameInput = (tree, chatId) => findAll(tree, (n) => n.props?.['data-rename-input'] === chatId)[0];

test('double-click a branch name to rename it; Enter on the open chat calls session.title; Escape cancels', async () => {
  const ctx = setup(); // b2 is open (runtime rt-b2)
  await flush();
  nameLabelOf(ctx.pane.render(), 'b2').props.onDoubleClick(fakeEvent());
  const input = renameInput(ctx.pane.render(), 'b2');
  assert.ok(input, 'an input replaces the name');
  input.props.onChange({ target: { value: 'Token rotation' } });
  renameInput(ctx.pane.render(), 'b2').props.onKeyDown({ key: 'Enter', stopPropagation() {}, stopImmediatePropagation() {} });
  await flush();
  const call = ctx.host.calls.find(([m]) => m === 'session.title');
  assert.deepEqual(call[1], { session_id: 'rt-b2', title: 'Token rotation' });
  assert.equal(renameInput(ctx.pane.render(), 'b2'), undefined);
  // Escape leaves the name as it was and sends nothing.
  ctx.host.calls.length = 0;
  nameLabelOf(ctx.pane.render(), 'b2').props.onDoubleClick(fakeEvent());
  renameInput(ctx.pane.render(), 'b2').props.onChange({ target: { value: 'nope' } });
  renameInput(ctx.pane.render(), 'b2').props.onKeyDown({ key: 'Escape', stopPropagation() {}, stopImmediatePropagation() {} });
  await flush();
  assert.equal(ctx.host.calls.some(([m]) => m === 'session.title'), false);
  ctx.unload();
});

test('renaming a chat that is not open opens it first, then renames it once it is open; Branches mode too', async () => {
  const ctx = setup();
  await flush();
  ctx.tree.$ui.set({ ...ctx.tree.$ui.get(), mode: mod.BRANCHES_MODE });
  nameLabelOf(ctx.pane.render(), 'b1').props.onDoubleClick(fakeEvent());
  renameInput(ctx.pane.render(), 'b1').props.onChange({ target: { value: 'Setup questions' } });
  renameInput(ctx.pane.render(), 'b1').props.onKeyDown({ key: 'Enter', stopPropagation() {}, stopImmediatePropagation() {} });
  await flush();
  assert.equal(ctx.host.calls.some(([m]) => m === 'session.title'), false, 'not yet: b1 is not open');
  assert.ok(JSON.stringify(ctx.host.opened).includes('b1'));
  ctx.host.state.focusedStoredSessionId.set('b1');
  ctx.host.state.focusedSessionId.set('rt-b1');
  await flush();
  await flush();
  const call = ctx.host.calls.find(([m]) => m === 'session.title');
  assert.deepEqual(call?.[1], { session_id: 'rt-b1', title: 'Setup questions' });
  ctx.unload();
});
