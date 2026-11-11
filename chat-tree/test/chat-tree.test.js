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
const BLUE = '#3B82F6';
const GREY = '#6B7280';

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
    usage: undefined,
    stats: undefined,
    breakdown: undefined,
    // setDraft result: true, false, an Error to throw, or a function([id, text]).
    setDraftResult: true,
    openSession: async (id, opts) => {
      opened.push([id, opts]);
      order.push(['open', id, opts]);
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
        case 'session.usage':
          return answer(method, host.usage, params);
        case 'session.stats':
          return answer(method, host.stats, params);
        case 'session.context_breakdown':
          return answer(method, host.breakdown, params);
        default:
          throw new Error(`unexpected ${method}`);
      }
    },
  };
  return host;
}

function setup({ host = fakeHost(), clock = fakeClock(), useValue } = {}) {
  const registered = [];
  const disposers = [];
  const tree = createChatTree({
    host,
    jsx: el,
    jsxs: el,
    atom,
    useValue: useValue ?? ((a) => a.get()),
    Button: 'Button',
    ScrollArea: 'ScrollArea',
  });
  tree.register({
    register: (c) => registered.push(c),
    setTimeout: clock.setTimeout,
    onDispose: (fn) => disposers.push(fn),
  });
  return {
    tree,
    host,
    clock,
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
const blueOf = (plan) => plan.rows.filter((r) => r.blue).map((r) => r.key);
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
  assert.deepEqual(keysOf(plan), MAIN_KEYS);
  assert.deepEqual(plan.rows.map((r) => r.label), ['q1', 'what is x?', 'q2', 'b1q', 'b2q', 'q3']);
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
  assert.deepEqual(blueOf(plan), ['root:0', 'root:1', 'b1:2', 'b2:3']);
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
  // A focused chat with nothing of its own opens the shared exchange on its parent lane.
  const empty = planFor([...ROWS.slice(0, 3)], 'b2', { ...HIST, b2: HIST.b1 }).plan;
  assert.equal(empty.openKey, 'b1:2');
  assert.equal(empty.rows.some((r) => r.lane === 'b2'), false);
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
  assert.deepEqual(keysOf(plan), ['p:0', 'c1:1', 'c1:2', 'c2:1', 'p:1', 'c3:2', 'p:2']);
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
  assert.deepEqual(keysOf(plan), ['par:0', 'sd:1', 'par:1', 'par:2']);
  const merged = plan.rows[2];
  assert.equal(merged.label, 'Merged: what is a monad?');
  assert.equal(merged.mergeFrom, 'sd');
  assert.deepEqual(plan.merges, [{ from: 'sd', fromRow: 1, to: 'par', toRow: 2 }]);
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
  assert.deepEqual(keysOf(plan), ['root:0', 'more:root:1', 'root:4', 'c:5', 'c:6', 'c:7', 'more:root:5', 'root:9']);
  assert.deepEqual(blueOf(plan), ['root:0', 'more:root:1', 'root:4', 'c:5', 'c:6', 'c:7']);
  assert.equal(plan.rows[6].count, 4);
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

test('geometry: hollow nodes on rows, lane lines between them, rounded fork elbows, colours by path', () => {
  const geo = mod.graphGeometry(planFor(ROWS, 'b2', HIST).plan);
  assert.equal(geo.width, 58);
  assert.equal(geo.height, 6 * 26);
  assert.deepEqual(
    geo.circles.map((c) => [c.key, c.cx, c.cy, c.color, c.filled]),
    [
      ['root:0', 8, 13, BLUE, false],
      ['b3:1', 22, 39, GREY, false],
      ['root:1', 8, 65, BLUE, false],
      ['b1:2', 22, 91, BLUE, false],
      ['b2:3', 36, 117, BLUE, true],
      ['root:2', 8, 143, GREY, false],
    ],
  );
  assert.ok(geo.circles.every((c) => c.r === 4));
  assert.deepEqual(
    geo.paths.map((p) => [p.key, p.d, p.color]),
    [
      ['lane:root:0', 'M 8 17 V 61', BLUE],
      ['lane:root:2', 'M 8 69 V 139', GREY],
      ['fork:b3', 'M 12 13 H 17 A 5 5 0 0 1 22 18 V 35', GREY],
      ['fork:b1', 'M 12 65 H 17 A 5 5 0 0 1 22 70 V 87', BLUE],
      ['fork:b2', 'M 26 91 H 31 A 5 5 0 0 1 36 96 V 113', BLUE],
    ],
  );
  // Every shape stays inside the graph column: no line runs over the text.
  const xs = geo.paths.flatMap((p) => [...p.d.matchAll(/(?:M|H|A \d+ \d+ 0 0 [01]) (-?\d+(?:\.\d+)?)/g)].map((m) => Number(m[1])));
  assert.ok(xs.length >= geo.paths.length);
  assert.ok(xs.every((x) => x >= 0 && x <= geo.width));
  assert.ok(geo.circles.every((c) => c.cx + c.r <= geo.width));
});

test('geometry: a merge curve runs down from the side lane last node into the merge node, grey', () => {
  const geo = mod.graphGeometry(planFor(MERGE_ROWS, 'par', MERGE_HIST).plan);
  const merge = geo.paths.find((p) => p.key.startsWith('merge:'));
  assert.equal(merge.d, 'M 22 43 V 60 A 5 5 0 0 1 17 65 H 12');
  assert.equal(merge.color, GREY);
  assert.equal(geo.circles.find((c) => c.key === 'par:2').filled, true);
});

test('geometry: a +N row has no node and the lane line passes through it', () => {
  const geo = mod.graphGeometry(planFor([row('root')], 'root', { root: msgs(...TEN) }).plan);
  assert.deepEqual(geo.circles.map((c) => c.key), ['root:0', 'root:9']);
  assert.deepEqual(geo.paths.map((p) => p.d), ['M 8 17 V 39', 'M 8 39 V 61']);
  assert.ok(geo.paths.every((p) => p.color === BLUE));
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

test('a history is not read again on refresh while its chat is unchanged', async () => {
  const ctx = setup();
  await flush();
  assert.equal(historyCalls(ctx.host), 4);
  await ctx.clock.tick(REFRESH_MS * 2);
  assert.equal(listCalls(ctx.host), 3);
  assert.equal(historyCalls(ctx.host), 4);
  // b1 got a new message: only b1 is read again.
  ctx.host.rows = ROWS.map((r) => (r.id === 'b1' ? { ...r, message_count: 4 } : r));
  ctx.host.history.b1 = [...HIST.b1, { role: 'user', text: 'b1 more' }];
  await ctx.clock.tick(REFRESH_MS);
  assert.equal(historyCalls(ctx.host), 5);
  assert.equal(historyCalls(ctx.host, 'b1'), 2);
  assert.ok(nodeKeys(ctx.pane.render()).includes('b1:3'));
  ctx.unload();
});

test('the pane draws one row per exchange with the lane pills and the open node', async () => {
  const ctx = setup();
  await flush();
  const tree = ctx.pane.render();
  assert.deepEqual(nodeKeys(tree), MAIN_KEYS);
  assert.deepEqual(pills(nodeOf(tree, 'root:0')), ['model:m1']);
  assert.deepEqual(pills(nodeOf(tree, 'b3:1')), ['model:m1', 'side:side']);
  assert.deepEqual(pills(nodeOf(tree, 'b1:2')), ['model:m1']);
  assert.deepEqual(pills(nodeOf(tree, 'root:1')), []);
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
  // Exactly two colours in the graph.
  const colours = new Set(findAll(svg, (n) => n.type === 'path' || n.type === 'circle').map((n) => n.props.stroke));
  assert.deepEqual([...colours].sort(), [BLUE, GREY].sort());
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

test('a merged side chat shows a Merged node on the parent lane with a grey curve', async () => {
  const ctx = setup({ host: fakeHost({ rows: MERGE_ROWS, stored: 'par', runtime: 'rt-par', history: MERGE_HIST }) });
  await flush();
  const tree = ctx.pane.render();
  const merged = nodeOf(tree, 'par:1');
  assert.equal(merged.props['data-merge-node'], 'sd');
  assert.match(textOf(merged), /^Merged: what is a monad\?$/);
  const curve = findAll(byAttr(tree, 'data-graph', 'true')[0], (n) => n.type === 'path' && n.key === 'merge:sd:2')[0];
  assert.equal(curve.props.stroke, GREY);
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
  findAll(ctx.pane.render(), (n) => n.type === 'Button' && n.props.children === 'Refresh')[0].props.onClick();
  await flush();
  assert.equal(listCalls(ctx.host), 6);
  // The same tree: no history was read twice.
  assert.equal(historyCalls(ctx.host), 4);
  ctx.unload();
});

test('one view only: no view toggle, breadcrumb, minimap, or disclosure', async () => {
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
  for (const a of [ctx.tree.$data, ctx.tree.$status, ctx.tree.$ui]) {
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
  host.sessionsError = new Error('x');
  await ctx.clock.tick(REFRESH_MS);
  states.push(order()); // error
  host.state.focusedStoredSessionId.set('missing');
  await flush();
  states.push(order()); // not in list
  // Five host/data atoms, then the in-memory UI atom ($ui) last.
  for (const s of states) {
    assert.equal(s.length, 6);
    assert.deepEqual(s, states[0]);
  }
  assert.equal(states[0][5], ctx.tree.$ui);
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
  assert.deepEqual(ctx.tree.$ui.get(), { open: null, expanded: {}, merge: {} });
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

test('turnsFromRows skips tool and system rows and joins assistant texts until the next user', () => {
  const rows = [
    { role: 'system', text: 'sys' },
    { role: 'assistant', text: 'orphan answer before any question' },
    { role: 'user', text: 'q1' },
    { role: 'tool', text: 'tool out' },
    { role: 'assistant', text: 'a1 part 1' },
    { role: 'assistant', text: '   ' },
    { role: 'assistant', content: [{ text: 'a1 part 2' }] },
    { role: 'user', text: 'q2' },
    { role: 'assistant', text: 'a2' },
    { role: 'user', text: 'q3 never answered' },
  ];
  assert.deepEqual(mod.turnsFromRows(rows), [
    { question: 'q1', answer: 'a1 part 1\na1 part 2' },
    { question: 'q2', answer: 'a2' },
  ]);
  assert.deepEqual(mod.turnsFromRows(null), []);
});

test('formatSideVerbatim writes the side-chat shape: blank lines after the header and between blocks', () => {
  assert.equal(
    mod.formatSideVerbatim('  Side: q  ', [
      { question: 'q1', answer: 'a1' },
      { question: 'q2', answer: 'a2' },
    ]),
    'From side chat: Side: q\n\nYou:\nq1\n\nAssistant:\na1\n\nYou:\nq2\n\nAssistant:\na2',
  );
  assert.equal(mod.formatSideVerbatim('', [{ question: 'q', answer: 'a' }]), 'From side chat: Side chat\n\nYou:\nq\n\nAssistant:\na');
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

test('rowsAfterSharedPrefix drops the shared start and keeps the side-only remainder', () => {
  const shared = [
    { role: 'user', text: 'main q' },
    { role: 'assistant', content: [{ text: 'main a' }] },
    { role: 'tool', text: '' },
  ];
  const side = [
    { role: 'user', content: ' main q ' },
    { role: 'assistant', text: 'main a' },
    { role: 'tool', text: '' },
    { role: 'user', text: 'side q' },
    { role: 'assistant', text: 'side a' },
  ];
  assert.deepEqual(mod.rowsAfterSharedPrefix(side, shared), side.slice(3));
  // The parent moved on after the fork: the walk stops at the first row that differs.
  const moved = [...shared, { role: 'user', text: 'parent kept going' }];
  assert.deepEqual(mod.rowsAfterSharedPrefix(side, moved), side.slice(3));
  // A same role with different text, and a same text with a different role, both end the prefix.
  assert.deepEqual(mod.rowsAfterSharedPrefix([{ role: 'user', text: 'x' }], [{ role: 'user', text: 'y' }]), [{ role: 'user', text: 'x' }]);
  assert.deepEqual(mod.rowsAfterSharedPrefix([{ role: 'user', text: 'x' }], [{ role: 'assistant', text: 'x' }]), [{ role: 'user', text: 'x' }]);
  assert.deepEqual(mod.rowsAfterSharedPrefix(side, []), side);
  assert.deepEqual(mod.rowsAfterSharedPrefix(shared, shared), []);
  assert.deepEqual(mod.rowsAfterSharedPrefix(null, null), []);
});

// ── Merge as-is (unchanged behaviour; the controls sit in the side chat list below the graph) ──

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
const DRAFT = 'From side chat: Side: what is a monad?\n\nYou:\nwhat is a monad?\n\nAssistant:\na burrito';

async function mergeCtx({ rows = MERGE_ROWS, stored = 'par', runtime = 'rt-par', prepare } = {}) {
  const host = fakeHost({ rows, stored, runtime, history: { par: SHARED, sd: SIDE_ROWS } });
  host.usage = { context_used: 1000, context_max: 128000 };
  if (prepare) prepare(host);
  const ctx = setup({ host });
  await flush();
  ctx.mark = host.calls.length;
  return ctx;
}
const sideEntry = (ctx, id = 'sd') => byAttr(ctx.pane.render(), 'data-side-entry', id)[0];
const mergeButton = (ctx, kind = 'asis', id = 'sd') => byAttr(sideEntry(ctx, id), 'data-merge', kind)[0];
const fitOf = (ctx, id = 'sd') => byAttr(sideEntry(ctx, id), 'data-token-fit')[0];
// session.* calls since the merge context was ready, so the tree's own history reads do not count.
const sessionCalls = (ctx) => ctx.host.calls.slice(ctx.mark).filter(([m]) => m.startsWith('session.'));
const exactText = (tree, text) => findAll(tree, (n) => n.props?.children === text)[0];

test('the draft in the tests has 21 estimated tokens', () => {
  assert.equal(mod.estimateTokens(DRAFT), 21);
});

test('Merge as-is and a disabled Digest (later) show for side chats only, below the graph', async () => {
  const ctx = await mergeCtx();
  const tree = ctx.pane.render();
  assert.deepEqual(byAttr(tree, 'data-side-entry').map((n) => n.props['data-side-entry']), ['sd']);
  assert.match(textOf(sideEntry(ctx)), /Side: what is a monad\?/);
  const asis = mergeButton(ctx);
  assert.equal(asis.type, 'Button');
  assert.equal(asis.props.children, 'Merge as-is');
  const digest = mergeButton(ctx, 'digest');
  assert.equal(digest.props.children, 'Digest (later)');
  assert.equal(digest.props.disabled, true);
  // Not inside the graph rows.
  assert.equal(byAttr(byAttr(tree, 'data-tree-graph', 'true')[0], 'data-merge').length, 0);
  const event = fakeEvent();
  await digest.props.onClick(event);
  assert.equal(event.stopped, 1);
  assert.equal(sessionCalls(ctx).length, 0);
  assert.equal(ctx.host.opened.length, 0);
  ctx.unload();
});

test('rendering the pane does not read the parent context window', async () => {
  const ctx = await mergeCtx();
  ctx.pane.render();
  ctx.pane.render();
  assert.equal(sessionCalls(ctx).length, 0);
  assert.equal(ctx.host.drafts.length, 0);
  ctx.unload();
});

test('Merge as-is opens the parent in place and stages the side exchange verbatim, never sending', async () => {
  const ctx = await mergeCtx();
  const event = fakeEvent();
  mergeButton(ctx).props.onClick(event);
  assert.equal(event.stopped, 1);
  await flush();
  assert.deepEqual(ctx.host.order, [
    ['open', 'par', { intent: 'in-place' }],
    ['draft', 'par', DRAFT],
  ]);
  assert.equal(ctx.host.order.some(([kind]) => kind === 'submit'), false);
  assert.deepEqual(ctx.host.opened, [['par', { intent: 'in-place' }]]);
  // Reads: transcript is unknown on v0.23, so history, side then parent, then the window.
  assert.deepEqual(sessionCalls(ctx).map(([m, p]) => [m, p.session_id]), [
    ['session.transcript', 'sd'],
    ['session.history', 'sd'],
    ['session.transcript', 'par'],
    ['session.history', 'par'],
    ['session.usage', 'par'],
  ]);
  const tree = ctx.pane.render();
  const fit = fitOf(ctx);
  assert.equal(fit.props['data-token-fit'], 'yes');
  const notice = exactText(tree, MERGE_STAGED_TEXT);
  assert.equal(notice.props.style.userSelect, 'text');
  assert.equal(notice.props['data-selectable-text'], 'true');
  assert.match(textOf(fit), /21/);
  assert.match(textOf(fit), /estimated/);
  assert.match(textOf(fit), /127,000/);
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

test('the merge target is the parent of the side chat, not the focused chat', async () => {
  // Focused on b2; b3 is a side chat of root. Its parent window and draft go to root.
  const host = fakeHost({
    history: { ...HIST, root: SHARED, b3: [...SHARED, { role: 'user', text: 'what is x?' }, { role: 'assistant', text: 'x is y' }] },
  });
  host.usage = { context_used: 1000, context_max: 128000 };
  const ctx = setup({ host });
  await flush();
  ctx.mark = host.calls.length;
  await mergeButton(ctx, 'asis', 'b3').props.onClick(fakeEvent());
  assert.deepEqual(host.order, [
    ['open', 'root', { intent: 'in-place' }],
    ['draft', 'root', 'From side chat: Side: what is x?\n\nYou:\nwhat is x?\n\nAssistant:\nx is y'],
  ]);
  assert.deepEqual(sessionCalls(ctx).find(([m]) => m === 'session.usage'), ['session.usage', { session_id: 'root' }]);
  ctx.unload();
});

test('a parent window with no room does not open, does not stage, and does not throw', async () => {
  const ctx = await mergeCtx({ prepare: (host) => (host.usage = { context_used: 127990, context_max: 128000 }) });
  await assert.doesNotReject(async () => mergeButton(ctx).props.onClick(fakeEvent()));
  await flush();
  assert.deepEqual(ctx.host.order, []);
  assert.deepEqual(ctx.host.opened, []);
  const tree = ctx.pane.render();
  const text = "Doesn't fit: side chat is 21 tokens (estimated), parent has 10 available (127,990 used of 128,000).";
  const notice = exactText(tree, text);
  assert.ok(notice);
  assert.equal(notice.props.style.userSelect, 'text');
  const fit = fitOf(ctx);
  assert.equal(fit.props['data-token-fit'], 'no');
  assert.match(textOf(fit), /21/);
  assert.match(textOf(fit), /10/);
  ctx.unload();
});

test('a window that fits exactly is allowed', async () => {
  const ctx = await mergeCtx({ prepare: (host) => (host.usage = { context_used: 127979, context_max: 128000 }) });
  await mergeButton(ctx).props.onClick(fakeEvent());
  assert.equal(ctx.host.drafts.length, 1);
  assert.equal(fitOf(ctx).props['data-token-fit'], 'yes');
  ctx.unload();
});

test('the window is read from usage, then stats, then context_breakdown, parent id first then the focused id', async () => {
  const ctx = await mergeCtx({
    prepare: (host) => {
      host.usage = new Error('no usage');
      host.stats = { calls: 1, total: 3 }; // no max: try on
      host.breakdown = (params) => (params.session_id === 'par' ? { calls: 0 } : { context_used: 100, context_max: 1000 });
    },
  });
  await mergeButton(ctx).props.onClick(fakeEvent());
  assert.deepEqual(
    sessionCalls(ctx).filter(([m]) => /usage|stats|breakdown/.test(m)).map(([m, p]) => [m, p.session_id]),
    [
      ['session.usage', 'par'],
      ['session.usage', 'rt-par'],
      ['session.stats', 'par'],
      ['session.stats', 'rt-par'],
      ['session.context_breakdown', 'par'],
      ['session.context_breakdown', 'rt-par'],
    ],
  );
  // 21 tokens against 900 available fits.
  assert.equal(fitOf(ctx).props['data-token-fit'], 'yes');
  assert.equal(ctx.host.drafts.length, 1);
  ctx.unload();
});

test('two side pairs after the shared prefix are both staged; copied parent rows and tool rows are not', async () => {
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
  assert.equal(
    draft,
    'From side chat: Side: what is a monad?\n\nYou:\nq1\n\nAssistant:\na1\n\nYou:\nq2\n\nAssistant:\na2 first\na2 second',
  );
  assert.doesNotMatch(draft, /main q|main a|TOOL-OUT/);
  ctx.unload();
});

test('when usage, stats and context_breakdown all throw, the draft is still staged and the notice says so', async () => {
  const ctx = await mergeCtx({
    prepare: (host) => {
      host.usage = new Error('usage down');
      host.stats = new Error('stats down');
      host.breakdown = new Error('breakdown down');
    },
  });
  await assert.doesNotReject(async () => mergeButton(ctx).props.onClick(fakeEvent()));
  assert.deepEqual(ctx.host.order, [
    ['open', 'par', { intent: 'in-place' }],
    ['draft', 'par', DRAFT],
  ]);
  const tree = ctx.pane.render();
  const notice = exactText(tree, mod.formatMissingWindowNotice(21));
  assert.ok(notice);
  assert.match(notice.props.children, /window was not reported/);
  assert.equal(notice.props.style.userSelect, 'text');
  assert.equal(fitOf(ctx).props['data-token-fit'], 'unknown');
  ctx.unload();
});

test('a missing composer draft API shows a notice, opens nothing and writes nothing', async () => {
  for (const strip of [(host) => (host.composer = {}), (host) => delete host.composer]) {
    const ctx = await mergeCtx({ prepare: strip });
    await assert.doesNotReject(async () => mergeButton(ctx).props.onClick(fakeEvent()));
    await flush();
    assert.deepEqual(ctx.host.opened, []);
    assert.deepEqual(ctx.host.order, []);
    assert.equal(sessionCalls(ctx).length, 0);
    const notice = exactText(ctx.pane.render(), MERGE_NO_COMPOSER_TEXT);
    assert.ok(notice);
    assert.equal(notice.props.style.userSelect, 'text');
    ctx.unload();
  }
});

test('a false or thrown setDraft retries the focused runtime id, then shows the hidden-composer notice', async () => {
  for (const result of [false, new Error('composer gone')]) {
    const ctx = await mergeCtx({ prepare: (host) => (host.setDraftResult = result) });
    await assert.doesNotReject(async () => mergeButton(ctx).props.onClick(fakeEvent()));
    await flush();
    assert.deepEqual(
      ctx.host.order.map((step) => step.slice(0, 2)),
      [['open', 'par'], ['draft', 'par'], ['draft', 'rt-par']],
    );
    assert.equal(ctx.host.order.some(([kind]) => kind === 'submit'), false);
    const notice = exactText(ctx.pane.render(), MERGE_HIDDEN_TEXT);
    assert.ok(notice);
    assert.equal(notice.props.style.userSelect, 'text');
    ctx.unload();
  }
});

test('a setDraft that fails on the stored id but works on the runtime id stages the draft', async () => {
  const ctx = await mergeCtx({ prepare: (host) => (host.setDraftResult = ([id]) => id === 'rt-par') });
  await mergeButton(ctx).props.onClick(fakeEvent());
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

test('a side chat with nothing new, no parent, or an unreadable parent writes nothing', async () => {
  const nothing = await mergeCtx({ prepare: (host) => (host.history.sd = SHARED) });
  await mergeButton(nothing).props.onClick(fakeEvent());
  assert.match(textOf(nothing.pane.render()), /Nothing to merge/);
  assert.deepEqual(nothing.host.order, []);
  assert.equal(sessionCalls(nothing).some(([m]) => /usage|stats|breakdown/.test(m)), false);
  nothing.unload();

  const orphan = await mergeCtx({
    rows: [row('lone', { title: 'Side: alone' })],
    stored: 'lone',
    runtime: 'rt-lone',
    prepare: (host) => (host.history.lone = msgs(['q', 'a'])),
  });
  await mergeButton(orphan, 'asis', 'lone').props.onClick(fakeEvent());
  assert.match(textOf(orphan.pane.render()), /no parent chat/);
  assert.deepEqual(orphan.host.order, []);
  orphan.unload();

  const unreadable = await mergeCtx({
    prepare: (host) => {
      const base = host.request;
      host.request = async (method, params) => {
        if (method === 'session.history' && params.session_id === 'par' && host.failParent) throw new Error('parent gone');
        return base(method, params);
      };
    },
  });
  unreadable.host.failParent = true;
  await assert.doesNotReject(async () => mergeButton(unreadable).props.onClick(fakeEvent()));
  assert.match(textOf(unreadable.pane.render()), /Could not read the parent chat: parent gone/);
  assert.deepEqual(unreadable.host.order, []);
  unreadable.unload();
});

test('Merge as-is does not also open the side chat, and a double click stages once', async () => {
  const ctx = await mergeCtx();
  const a = mergeButton(ctx).props.onClick(fakeEvent());
  const b = mergeButton(ctx).props.onClick(fakeEvent());
  await Promise.all([a, b]);
  await flush();
  assert.equal(ctx.host.drafts.length, 1);
  assert.equal(ctx.host.opened.some(([id]) => id === 'sd'), false);
  // The side chat's node still opens its chat in place.
  nodeOf(ctx.pane.render(), 'sd:1').props.onClick();
  await flush();
  assert.deepEqual(ctx.host.opened.at(-1), ['sd', { intent: 'in-place', profile: 'default' }]);
  ctx.unload();
});

test('selectable text covers the nodes, pills, side list and merge notices', async () => {
  const ctx = await mergeCtx({ prepare: (host) => (host.usage = { context_used: 127990, context_max: 128000 }) });
  await mergeButton(ctx).props.onClick(fakeEvent());
  const tree = ctx.pane.render();
  const holders = findAll(
    tree,
    (n) => n.type !== 'Button' && n.type !== 'ScrollArea' && n.props && [n.props.children].flat().some((c) => typeof c === 'string'),
  );
  assert.ok(holders.length >= 6, `only ${holders.length} text nodes`);
  for (const n of holders) assert.equal(n.props.style?.userSelect, 'text', `${n.type} ${JSON.stringify(n.props.children)}`);
  for (const key of ['data-pill', 'data-side-entry', 'data-merge-result']) {
    const nodes = byAttr(tree, key);
    assert.ok(nodes.length >= 1, key);
    for (const n of nodes) assert.equal(n.props.style.userSelect, 'text', key);
  }
  const noFit = exactText(tree, "Doesn't fit: side chat is 21 tokens (estimated), parent has 10 available (127,990 used of 128,000).");
  assert.equal(noFit.props['data-selectable-text'], 'true');
  ctx.unload();
});

test('the pane code never touches host transcript DOM, never sends, and has no imports', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/chat-tree.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /data-message-/);
  assert.doesNotMatch(src, /\.submit\b/);
  assert.doesNotMatch(src, /^import /m);
});
