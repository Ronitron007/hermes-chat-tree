import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  createChatTree,
  buildTree,
  flattenTree,
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

// Merged ids live on globalThis (shared with the pane); every test starts with none.
beforeEach(() => {
  globalThis.__hermesSideChatMergedIds?.clear?.();
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
  for (let i = 0; i < 30; i++) await Promise.resolve();
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

// root -> b1 -> b2 (deep branch); root -> b3 (a side chat); r2 is a /new reset of root.
const ROWS = [
  row('root', { started_at: 10 }),
  row('b1', { _branched_from: 'root', parent_session_id: 'root', started_at: 20 }),
  row('b2', { _branched_from: 'b1', started_at: 30 }),
  row('b3', { parent_session_id: 'root', title: 'Side: what is x?', started_at: 15 }),
  row('r2', { parent_session_id: 'root', _reset_from: 'root', started_at: 40 }),
];

function fakeHost({ rows = ROWS, stored = 'b2', runtime = 'rt-b2', owner = { connectionId: 'local', profile: 'default' }, agents = [], active = { connectionId: 'local', profile: 'default' } } = {}) {
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
    history: {},
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

const chatNodes = (tree) => findAll(tree, (n) => n.props?.['data-session-id']);
const outline = (items) => items.map((i) => `${'  '.repeat(i.depth)}${i.kind === 'chat' ? i.row.id : `@${i.agent.subagent_id}`}`);
// A test timeout cannot stop a synchronous endless loop; the vm watchdog can.
const bounded = (fn) => vm.runInNewContext('fn()', { fn }, { timeout: 2000 });
const listCalls = (host) => host.calls.filter(([m]) => m === 'listPersistedSessions').length;

test('parent rule: _reset_from wins, then _branched_from, then parent_session_id', () => {
  assert.equal(forkParentId({ _reset_from: 'a', _branched_from: 'b', parent_session_id: 'c' }), undefined);
  assert.equal(forkParentId({ _branched_from: ' b ', parent_session_id: 'c' }), 'b');
  assert.equal(forkParentId({ parent_session_id: 'c' }), 'c');
  assert.equal(forkParentId({}), undefined);
});

test('a _reset_from row is a top-level root, not a child of its predecessor', () => {
  const resetTree = buildTree(ROWS, 'r2');
  assert.deepEqual(outline(flattenTree(resetTree)), ['r2']);
  const rootTree = buildTree(ROWS, 'root');
  assert.ok(!outline(flattenTree(rootTree)).some((line) => line.trim() === 'r2'));
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
  assert.deepEqual(outline(flattenTree(buildTree(rows, 'br'))), ['tip', '  br0', '  br']);
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
  assert.deepEqual(outline(flattenTree(buildTree(rows, 'seg1'))), ['seg2', '  br']);
});

test('the root walk goes up from a deep branch to the oldest ancestor', () => {
  const tree = buildTree(ROWS, 'b2');
  assert.equal(tree.root.row.id, 'root');
  assert.equal(tree.focused.id, 'b2');
  assert.deepEqual(outline(flattenTree(tree)), ['root', '  b3', '  b1', '    b2']);
});

test('the walk stops at a parent that is not in the list, and marks the tree partial', () => {
  const rows = [row('orphan', { _branched_from: 'gone' }), row('kid', { _branched_from: 'orphan' })];
  const tree = buildTree(rows, 'kid');
  assert.deepEqual(outline(flattenTree(tree)), ['orphan', '  kid']);
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
  assert.deepEqual(outline(flattenTree(buildTree(rows, 'p'))), ['p', '  early', '  fallback', '  late']);
});

test('a parent cycle ends with no loop and shows each row once', { timeout: 2000 }, () => {
  const rows = [row('a', { _branched_from: 'c' }), row('b', { _branched_from: 'a' }), row('c', { _branched_from: 'b' })];
  const items = bounded(() => flattenTree(buildTree(rows, 'b')));
  assert.equal(items.length, 3);
  assert.deepEqual(new Set(items.map((i) => i.row.id)), new Set(['a', 'b', 'c']));
  const self = [row('s', { _branched_from: 's' })];
  assert.deepEqual(outline(bounded(() => flattenTree(buildTree(self, 's')))), ['s']);
});

test('the focused chat not in the list gives no tree', () => {
  assert.equal(buildTree(ROWS, 'nope'), null);
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

test('register loads sessions for the owner profile and subagents for the runtime id', async () => {
  const owner = { connectionId: 'src-a', profile: 'work' };
  const ctx = setup({ host: fakeHost({ owner, active: owner }) });
  await flush();
  const [, route, options] = ctx.host.calls.find(([m]) => m === 'listPersistedSessions');
  assert.deepEqual(options, { profile: 'work', limit: LIST_LIMIT });
  assert.equal(route.connectionId, 'src-a');
  assert.deepEqual(ctx.host.calls.find(([m]) => m === 'subagent.list'), ['subagent.list', { session_id: 'rt-b2' }]);
  ctx.unload();
});

test('the pane shows the outline, the focused mark, the side mark, and node details', async () => {
  const ctx = setup();
  await flush();
  const tree = ctx.pane.render();
  assert.deepEqual(chatNodes(tree).map((n) => n.props['data-session-id']), ['root', 'b3', 'b1', 'b2']);
  const text = textOf(tree);
  assert.match(text, /● /);
  assert.match(text, /\[side\]/);
  assert.match(text, /m1 · 2 msgs/);
  const b2 = chatNodes(tree).find((n) => n.props['data-session-id'] === 'b2');
  assert.match(textOf(b2), /● /);
  const b1 = chatNodes(tree).find((n) => n.props['data-session-id'] === 'b1');
  assert.doesNotMatch(textOf(b1), /● /);
  ctx.unload();
});

test('an untitled row reads Untitled', async () => {
  const ctx = setup({ host: fakeHost({ rows: [row('u', { title: null })], stored: 'u' }) });
  await flush();
  assert.match(textOf(ctx.pane.render()), /Untitled/);
  ctx.unload();
});

test('live subagents appear under the focused chat', async () => {
  const agents = [
    { subagent_id: 'sa1', goal: 'find docs', status: 'running', model: 'm2', child_session_id: 'child-1' },
    { subagent_id: 'sa2', goal: 'idle one', status: 'queued', model: null, child_session_id: null },
  ];
  const ctx = setup({ host: fakeHost({ agents }) });
  await flush();
  const tree = ctx.pane.render();
  const ids = findAll(tree, (n) => n.props?.['data-session-id'] || n.props?.['data-subagent-id']).map(
    (n) => n.props['data-session-id'] ?? `@${n.props['data-subagent-id']}`,
  );
  assert.deepEqual(ids, ['root', 'b3', 'b1', 'b2', '@sa1', '@sa2']);
  const text = textOf(tree);
  assert.match(text, /find docs/);
  assert.match(text, /running · m2/);
  ctx.unload();
});

test('a click on a chat node opens it in a tab; a subagent opens its child session', async () => {
  const agents = [
    { subagent_id: 'sa1', goal: 'g', status: 'running', child_session_id: 'child-1' },
    { subagent_id: 'sa2', goal: 'g2', status: 'running', child_session_id: null },
  ];
  const ctx = setup({ host: fakeHost({ agents }) });
  await flush();
  const tree = ctx.pane.render();
  chatNodes(tree).find((n) => n.props['data-session-id'] === 'b1').props.onClick();
  const [sa1, sa2] = findAll(tree, (n) => n.props?.['data-subagent-id']);
  sa1.props.onClick();
  assert.equal(sa2.props.onClick, undefined);
  await flush();
  assert.deepEqual(ctx.host.opened, [
    ['b1', { intent: 'tab', profile: 'default' }],
    ['child-1', { intent: 'tab', profile: 'default' }],
  ]);
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
  assert.deepEqual(chatNodes(tree).map((n) => n.props['data-session-id']), ['root', 'b3', 'b1', 'b2']);
  ctx.host.sessionsError = null;
  ctx.host.rows = ROWS;
  await ctx.clock.tick(REFRESH_MS);
  assert.doesNotMatch(textOf(ctx.pane.render()), /gateway not ready/);
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
  const nodes = findAll(tree, (n) => n.props?.['data-session-id'] || n.props?.['data-subagent-id']);
  for (const n of nodes) {
    assert.equal(n.props.style.userSelect, 'text');
    assert.equal(n.props['data-selectable-text'], 'true');
  }
  for (const span of findAll(tree, (n) => n.type === 'span')) assert.equal(span.props.style.userSelect, 'text');
  ctx.unload();
});

test('render never writes state', async () => {
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
  ctx.pane.render();
  ctx.pane.render();
  assert.equal(sets, 0);
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

test('register after dispose (disable, then enable) works again', async () => {
  const host = fakeHost();
  const clock = fakeClock();
  const ctx = setup({ host, clock });
  await flush();
  ctx.unload();
  const disposers = [];
  ctx.tree.register({ register: () => {}, setTimeout: clock.setTimeout, onDispose: (fn) => disposers.push(fn) });
  await flush();
  const before = listCalls(host);
  host.state.focusedStoredSessionId.set('b1');
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

test('open passes the owner: a profile for a local owner, a route for a remote owner', async () => {
  const local = setup({ host: fakeHost({ owner: { connectionId: 'local', profile: 'work' }, active: { connectionId: 'local', profile: 'work' } }) });
  await flush();
  chatNodes(local.pane.render())[0].props.onClick();
  await flush();
  assert.deepEqual(local.host.opened, [['root', { intent: 'tab', profile: 'work' }]]);
  local.unload();
  const remote = setup({ host: fakeHost({ owner: { connectionId: 'src-a', profile: 'p' }, active: { connectionId: 'src-a', profile: 'p' } }) });
  await flush();
  chatNodes(remote.pane.render())[0].props.onClick();
  await flush();
  assert.deepEqual(remote.host.opened, [
    ['root', { intent: 'tab', route: { connectionId: 'src-a', mode: 'remote', profile: 'p', targetProfile: 'p' } }],
  ]);
  remote.unload();
});

test('a retitled side branch shows [side] only after its id is recorded', async () => {
  const titled = setup();
  await flush();
  const b3 = chatNodes(titled.pane.render()).find((n) => n.props['data-session-id'] === 'b3');
  assert.match(textOf(b3), /\[side\]/);
  assert.equal(isSideChat({ id: 'b3', title: 'Side: what is x?' }), true);
  titled.unload();

  const id = 'local-90c423bb';
  const ctx = setup({ host: fakeHost({ rows: [row(id, { title: 'Explain virtualenv' })], stored: id, runtime: 'rt-venv' }) });
  await flush();
  const before = chatNodes(ctx.pane.render()).find((n) => n.props['data-session-id'] === id);
  assert.equal(before.props['data-session-id'], id);
  assert.doesNotMatch(textOf(before), /\[side\]/);
  assert.equal(isSideChat({ id, title: 'Explain virtualenv' }), false);
  rememberSideBranch(id);
  const after = chatNodes(ctx.pane.render()).find((n) => n.props['data-session-id'] === id);
  assert.match(textOf(after), /\[side\]/);
  assert.equal(isSideChat({ id, title: 'Explain virtualenv' }), true);
  ctx.unload();
});

test('subagents of a chat on another profile or connection are not requested', async () => {
  const agents = [{ subagent_id: 'sa', goal: 'g', status: 'running' }];
  const ctx = setup({ host: fakeHost({ agents, owner: { connectionId: 'local', profile: 'other' } }) });
  await flush();
  assert.equal(ctx.host.calls.filter(([m]) => m === 'subagent.list').length, 0);
  const tree = ctx.pane.render();
  assert.match(textOf(tree), /Subagents unavailable for this chat/);
  assert.equal(findAll(tree, (n) => n.props?.['data-subagent-id']).length, 0);
  ctx.unload();
});

// ── Chat tree UI upgrade: marks, forks, breadcrumb, collapse, minimap, graph, merge-back ─────

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
const byAttr = (tree, name, value) =>
  findAll(tree, (n) => (value === undefined ? n.props?.[name] !== undefined : n.props?.[name] === value));
const rowOf = (tree, id) => chatNodes(tree).find((n) => n.props['data-session-id'] === id);
const idsOf = (tree) => chatNodes(tree).map((n) => n.props['data-session-id']);
// A click on a nested control also reaches the row unless the control stops it, as in the DOM.
const clickNested = (control, rowNode) => {
  const event = fakeEvent();
  const result = control.props.onClick(event);
  if (!event.stopped) rowNode.props.onClick(event);
  return { event, result };
};
const exactText = (tree, text) => findAll(tree, (n) => n.props?.children === text)[0];

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

test('rememberMergedBranch and isMergedChat share ids through globalThis', () => {
  assert.equal(mod.isMergedChat({ id: 'merge-unit-1' }), false);
  mod.rememberMergedBranch('merge-unit-1');
  mod.rememberMergedBranch('');
  mod.rememberMergedBranch(null);
  assert.equal(mod.isMergedChat({ id: 'merge-unit-1' }), true);
  assert.equal(mod.isMergedChat('merge-unit-1'), true);
  assert.equal(mod.isMergedChat({ id: '' }), false);
  assert.ok(globalThis.__hermesSideChatMergedIds instanceof Set);
  assert.ok(globalThis.__hermesSideChatMergedIds.has('merge-unit-1'));
  assert.equal(globalThis.__hermesSideChatMergedIds.size, 1);
});

test('pathToFocused gives the root-to-focused rows; flattenTree can hide collapsed subtrees', () => {
  const tree = buildTree(ROWS, 'b2');
  assert.deepEqual(mod.pathToFocused(tree).map((r) => r.id), ['root', 'b1', 'b2']);
  assert.deepEqual(mod.pathToFocused(null), []);
  const items = flattenTree(tree);
  assert.deepEqual(items.map((i) => i.childCount), [2, 0, 1, 0]);
  assert.deepEqual(outline(flattenTree(tree, [], (r) => r.id === 'b1')), ['root', '  b3', '  b1']);
  assert.deepEqual(outline(flattenTree(tree, [], (r) => r.id === 'root')), ['root']);
  // A collapsed focused chat with child chats hides its live subagents with the rest.
  const agent = { subagent_id: 'sa' };
  const focusB1 = buildTree(ROWS, 'b1');
  assert.deepEqual(outline(flattenTree(focusB1, [agent])), ['root', '  b3', '  b1', '    @sa', '    b2']);
  assert.deepEqual(outline(flattenTree(focusB1, [agent], (r) => r.id === 'b1')), ['root', '  b3', '  b1']);
  // A leaf has nothing to collapse: the flag is ignored and its subagents stay.
  assert.deepEqual(outline(flattenTree(tree, [agent], (r) => r.id === 'b2')), ['root', '  b3', '  b1', '    b2', '      @sa']);
});

test('graphGuides says which ancestor lanes run on past each row', () => {
  const guides = mod.graphGuides(flattenTree(buildTree(ROWS, 'b2')));
  assert.deepEqual(guides, [
    { continues: [], hasKids: true },
    { continues: [true], hasKids: false },
    { continues: [false], hasKids: true },
    { continues: [false, false], hasKids: false },
  ]);
});

test('side rows carry a clear [side] badge; a remembered id needs no Side: title', async () => {
  const ctx = setup();
  await flush();
  const tree = ctx.pane.render();
  const b3 = rowOf(tree, 'b3');
  const badge = byAttr(b3, 'data-kind', 'side')[0];
  assert.equal(badge.props.children, '[side]');
  assert.equal(b3.props['data-side'], 'true');
  assert.equal(byAttr(rowOf(tree, 'b1'), 'data-kind').length, 0);
  assert.equal(byAttr(rowOf(tree, 'b1'), 'data-side').length, 0);
  // The badge is a pill, not a faint suffix.
  assert.equal(badge.props.style.border !== undefined || /border/.test(badge.props.className), true);
  assert.doesNotMatch(badge.props.className ?? '', /opacity-60/);
  ctx.unload();

  const id = 'local-badge-9001';
  const plain = setup({ host: fakeHost({ rows: [row(id, { title: 'Explain virtualenv' })], stored: id, runtime: 'rt-v' }) });
  await flush();
  assert.equal(byAttr(plain.pane.render(), 'data-kind', 'side').length, 0);
  rememberSideBranch(id);
  const after = rowOf(plain.pane.render(), id);
  assert.equal(byAttr(after, 'data-kind', 'side')[0].props.children, '[side]');
  assert.doesNotMatch(textOf(after), /Side: /);
  plain.unload();
});

test('after rememberMergedBranch the row shows [merged] and is marked grey', async () => {
  const ctx = setup();
  await flush();
  assert.equal(byAttr(ctx.pane.render(), 'data-merged').length, 0);
  assert.doesNotMatch(textOf(ctx.pane.render()), /\[merged\]/);
  mod.rememberMergedBranch('b3');
  const tree = ctx.pane.render();
  const b3 = rowOf(tree, 'b3');
  assert.equal(b3.props['data-merged'], 'true');
  assert.match(textOf(b3), /\[merged\]/);
  assert.match(textOf(b3), /\[side\]/);
  assert.equal(byAttr(b3, 'data-kind', 'merged')[0].props.children, '[merged]');
  assert.ok(b3.props.style.opacity < 1);
  // Only the merged row is marked.
  assert.equal(byAttr(tree, 'data-merged').length, 1);
  assert.equal(rowOf(tree, 'b1').props.style.opacity, undefined);
  ctx.unload();
});

test('a node with child chats shows a fork label and count', async () => {
  const ctx = setup();
  await flush();
  const tree = ctx.pane.render();
  const label = (id) => byAttr(rowOf(tree, id), 'data-fork-count')[0];
  assert.equal(label('root').props['data-fork-count'], 2);
  assert.match(textOf(label('root')), /2 forks/);
  assert.equal(label('b1').props['data-fork-count'], 1);
  assert.match(textOf(label('b1')), /1 fork\b/);
  assert.equal(label('b2'), undefined);
  assert.equal(label('b3'), undefined);
  ctx.unload();
});

test('a breadcrumb above the list shows root · … · focused; each crumb opens its chat in a tab', async () => {
  const ctx = setup();
  await flush();
  const tree = ctx.pane.render();
  const [crumbs] = byAttr(tree, 'data-breadcrumb', 'true');
  assert.ok(crumbs);
  assert.equal(textOf(crumbs).replace(/\n/g, ''), 'root · b1 · b2');
  // It sits above the first chat row.
  assert.equal(findAll(tree, (n) => n.props?.['data-breadcrumb'] || n.props?.['data-session-id'])[0], crumbs);
  const buttons = findAll(crumbs, (n) => typeof n.props?.onClick === 'function');
  assert.deepEqual(buttons.map((b) => b.props.children), ['root', 'b1', 'b2']);
  buttons[1].props.onClick();
  buttons[0].props.onClick();
  await flush();
  assert.deepEqual(ctx.host.opened, [
    ['b1', { intent: 'tab', profile: 'default' }],
    ['root', { intent: 'tab', profile: 'default' }],
  ]);
  ctx.unload();

  // A remote owner gets the route, like a row click.
  const owner = { connectionId: 'src-a', profile: 'p' };
  const remote = setup({ host: fakeHost({ owner, active: owner }) });
  await flush();
  findAll(remote.pane.render(), (n) => n.props?.['data-breadcrumb'])
    .flatMap((nav) => findAll(nav, (n) => typeof n.props?.onClick === 'function'))[0]
    .props.onClick();
  await flush();
  assert.deepEqual(remote.host.opened, [
    ['root', { intent: 'tab', route: { connectionId: 'src-a', mode: 'remote', profile: 'p', targetProfile: 'p' } }],
  ]);
  remote.unload();
});

test('the breadcrumb is omitted when there is no tree', async () => {
  const none = setup({ host: fakeHost({ stored: null, runtime: null }) });
  await flush();
  assert.equal(byAttr(none.pane.render(), 'data-breadcrumb').length, 0);
  none.unload();
  const missing = setup({ host: fakeHost({ stored: 'nope' }) });
  await flush();
  assert.equal(byAttr(missing.pane.render(), 'data-breadcrumb').length, 0);
  missing.unload();
});

test('nodes with children start expanded; the disclosure collapses them without opening a chat', async () => {
  const ctx = setup();
  await flush();
  let tree = ctx.pane.render();
  const toggles = byAttr(tree, 'aria-expanded');
  assert.equal(toggles.length, 2); // root (b3, b1) and b1 (b2)
  assert.ok(toggles.every((t) => t.props['aria-expanded'] === true));
  assert.equal(byAttr(rowOf(tree, 'b2'), 'aria-expanded').length, 0);

  const toggle = byAttr(rowOf(tree, 'root'), 'aria-expanded')[0];
  const event = fakeEvent();
  toggle.props.onClick(event);
  await flush();
  assert.equal(event.stopped, 1);
  assert.deepEqual(ctx.host.opened, []);
  tree = ctx.pane.render();
  assert.deepEqual(idsOf(tree), ['root']);
  assert.equal(byAttr(rowOf(tree, 'root'), 'aria-expanded')[0].props['aria-expanded'], false);
  // A collapsed group row still shows its fork count.
  assert.match(textOf(rowOf(tree, 'root')), /2 forks/);

  byAttr(rowOf(tree, 'root'), 'aria-expanded')[0].props.onClick();
  assert.deepEqual(idsOf(ctx.pane.render()), ['root', 'b3', 'b1', 'b2']);
  assert.deepEqual(ctx.host.opened, []);
  ctx.unload();
});

test('ArrowLeft collapses and ArrowRight expands, without opening the chat', async () => {
  const ctx = setup();
  await flush();
  const b1Toggle = () => byAttr(rowOf(ctx.pane.render(), 'b1'), 'aria-expanded')[0];
  const left = fakeEvent({ key: 'ArrowLeft' });
  b1Toggle().props.onKeyDown(left);
  assert.equal(left.stopped, 1);
  assert.deepEqual(idsOf(ctx.pane.render()), ['root', 'b3', 'b1']);
  // ArrowLeft on a collapsed node keeps it collapsed.
  b1Toggle().props.onKeyDown(fakeEvent({ key: 'ArrowLeft' }));
  assert.deepEqual(idsOf(ctx.pane.render()), ['root', 'b3', 'b1']);
  const right = fakeEvent({ key: 'ArrowRight' });
  b1Toggle().props.onKeyDown(right);
  assert.equal(right.stopped, 1);
  assert.deepEqual(idsOf(ctx.pane.render()), ['root', 'b3', 'b1', 'b2']);
  // Other keys are left alone.
  const other = fakeEvent({ key: 'a' });
  b1Toggle().props.onKeyDown(other);
  assert.equal(other.stopped, 0);
  assert.deepEqual(idsOf(ctx.pane.render()), ['root', 'b3', 'b1', 'b2']);
  await flush();
  assert.deepEqual(ctx.host.opened, []);
  ctx.unload();
});

// root -> side (titled Side:) -> kid; root -> other.
const SIDE_TREE = [
  row('root', { started_at: 10 }),
  row('sd', { _branched_from: 'root', title: 'Side: why?', started_at: 20 }),
  row('kid', { _branched_from: 'sd', started_at: 30 }),
  row('other', { _branched_from: 'root', started_at: 40 }),
];

test('a merged side branch with children starts collapsed until expanded', async () => {
  const ctx = setup({ host: fakeHost({ rows: SIDE_TREE, stored: 'root', runtime: 'rt-root' }) });
  await flush();
  assert.deepEqual(idsOf(ctx.pane.render()), ['root', 'sd', 'kid', 'other']);
  mod.rememberMergedBranch('sd');
  let tree = ctx.pane.render();
  assert.deepEqual(idsOf(tree), ['root', 'sd', 'other']);
  const toggle = byAttr(rowOf(tree, 'sd'), 'aria-expanded')[0];
  assert.equal(toggle.props['aria-expanded'], false);
  // The collapsed row keeps its mark, label and count.
  assert.match(textOf(rowOf(tree, 'sd')), /\[merged\]/);
  assert.match(textOf(rowOf(tree, 'sd')), /1 fork\b/);
  toggle.props.onClick();
  tree = ctx.pane.render();
  assert.deepEqual(idsOf(tree), ['root', 'sd', 'kid', 'other']);
  assert.equal(byAttr(rowOf(tree, 'sd'), 'aria-expanded')[0].props['aria-expanded'], true);
  ctx.unload();
});

const wide = (kids) => [row('p', { started_at: 1 }), ...Array.from({ length: kids }, (_, i) => row(`c${i}`, { _branched_from: 'p', started_at: 10 + i }))];

test('no minimap under 40 rows; a minimap strip from 40 rows that scrolls our own row', async () => {
  const small = setup({ host: fakeHost({ rows: wide(38), stored: 'p', runtime: 'rt-p' }) }); // 39 rows
  await flush();
  assert.equal(idsOf(small.pane.render()).length, 39);
  assert.equal(byAttr(small.pane.render(), 'data-minimap').length, 0);
  small.unload();
  assert.equal(byAttr(setup().pane.render(), 'data-minimap').length, 0);

  const big = setup({ host: fakeHost({ rows: wide(39), stored: 'c3', runtime: 'rt-c3' }) }); // 40 rows
  await flush();
  const tree = big.pane.render();
  assert.equal(idsOf(tree).length, 40);
  const [strip] = byAttr(tree, 'data-minimap', 'true');
  assert.ok(strip);
  const ticks = byAttr(strip, 'data-tick');
  assert.equal(ticks.length, 40);
  assert.equal(ticks.filter((t) => t.props['data-tick'] === 'focused').length, 1);
  assert.equal(ticks.filter((t) => t.props['data-tick'] === 'other').length, 39);
  // A tick scrolls the row inside this pane, never the host.
  const scrolled = [];
  const scope = [];
  const currentTarget = {
    closest: (selector) => {
      scope.push(selector);
      return {
        querySelector: (query) => ({ scrollIntoView: (options) => scrolled.push([query, options]) }),
      };
    },
  };
  const event = fakeEvent({ currentTarget });
  ticks[5].props.onClick(event);
  assert.equal(event.stopped, 1);
  assert.deepEqual(scope, ['[data-chat-tree-root="true"]']);
  assert.equal(scrolled.length, 1);
  assert.equal(scrolled[0][0], '[data-session-id="c4"]');
  assert.deepEqual(big.host.opened, []);
  // A tick with no DOM to scroll does nothing and does not throw.
  assert.doesNotThrow(() => ticks[0].props.onClick(fakeEvent({ currentTarget: {} })));
  assert.doesNotThrow(() => ticks[0].props.onClick());
  big.unload();
});

test('minimap ticks mark side and merged rows', async () => {
  const rows = [
    row('p', { started_at: 1 }),
    row('s', { _branched_from: 'p', title: 'Side: q', started_at: 2 }),
    row('m', { _branched_from: 'p', title: 'Side: r', started_at: 3 }),
    ...Array.from({ length: 37 }, (_, i) => row(`c${i}`, { _branched_from: 'p', started_at: 10 + i })),
  ];
  mod.rememberMergedBranch('m');
  const ctx = setup({ host: fakeHost({ rows, stored: 'p', runtime: 'rt-p' }) });
  await flush();
  const kinds = byAttr(ctx.pane.render(), 'data-tick').map((t) => t.props['data-tick']);
  assert.equal(kinds.length, 40);
  assert.deepEqual([kinds[0], kinds[1], kinds[2]], ['focused', 'side', 'merged']);
  ctx.unload();
});

test('the default view is the outline; Graph adds an aria-hidden SVG and every row keeps its text', async () => {
  const ctx = setup();
  await flush();
  let tree = ctx.pane.render();
  const toggles = byAttr(tree, 'data-view-toggle');
  assert.deepEqual(toggles.map((t) => t.props.children), ['Outline', 'Graph']);
  const [outlineToggle, graphToggle] = toggles;
  assert.equal(outlineToggle.props['aria-pressed'], true);
  assert.equal(graphToggle.props['aria-pressed'], false);
  assert.equal(byAttr(tree, 'data-graph').length, 0);

  graphToggle.props.onClick();
  tree = ctx.pane.render();
  const graphs = byAttr(tree, 'data-graph');
  assert.ok(graphs.length >= 1);
  assert.ok(graphs.every((g) => g.props['aria-hidden'] === 'true'));
  assert.equal(byAttr(tree, 'data-view-toggle', 'graph')[0].props['aria-pressed'], true);
  assert.equal(byAttr(tree, 'data-view-toggle', 'outline')[0].props['aria-pressed'], false);
  // Text rows are still there: ids, titles, marks, details.
  assert.deepEqual(idsOf(tree), ['root', 'b3', 'b1', 'b2']);
  for (const id of ['root', 'b3', 'b1', 'b2']) assert.match(textOf(rowOf(tree, id)), new RegExp(id === 'b3' ? 'Side: what is x\\?' : id));
  assert.match(textOf(rowOf(tree, 'b3')), /\[side\]/);
  assert.match(textOf(tree), /m1 · 2 msgs/);
  // The graph is decoration: hollow nodes, no hit area of its own.
  const svg = graphs[0];
  assert.equal(svg.type, 'svg');
  assert.ok(findAll(svg, (n) => n.type === 'circle').every((c) => c.props.fill === 'none'));
  assert.equal(ctx.host.opened.length, 0);

  // Back to the outline.
  byAttr(tree, 'data-view-toggle', 'outline')[0].props.onClick();
  assert.equal(byAttr(ctx.pane.render(), 'data-graph').length, 0);
  ctx.unload();
});

test('the graph draws a double ring for a merged row and a curve for a fork', async () => {
  mod.rememberMergedBranch('b3');
  const ctx = setup();
  await flush();
  byAttr(ctx.pane.render(), 'data-view-toggle', 'graph')[0].props.onClick();
  const tree = ctx.pane.render();
  const circles = (id) => findAll(byAttr(rowOf(tree, id), 'data-graph'), (n) => n.type === 'circle');
  assert.equal(circles('b3').length, 2); // merged: double ring
  assert.equal(circles('b1').length, 1);
  assert.equal(circles('root').length, 1);
  assert.ok(findAll(byAttr(rowOf(tree, 'b1'), 'data-graph'), (n) => n.type === 'path').length >= 1);
  assert.equal(findAll(byAttr(rowOf(tree, 'root'), 'data-graph'), (n) => n.type === 'path').length, 0);
  ctx.unload();
});

test('the view and the collapse state are in memory only and reset on a new activation', async () => {
  const host = fakeHost();
  const clock = fakeClock();
  const ctx = setup({ host, clock });
  await flush();
  byAttr(ctx.pane.render(), 'data-view-toggle', 'graph')[0].props.onClick();
  byAttr(rowOf(ctx.pane.render(), 'root'), 'aria-expanded')[0].props.onClick();
  assert.equal(ctx.tree.$ui.get().view, 'graph');
  ctx.unload();
  ctx.tree.register({ register: () => {}, setTimeout: clock.setTimeout, onDispose: () => {} });
  assert.equal(ctx.tree.$ui.get().view, 'outline');
  assert.deepEqual(idsOf(ctx.pane.render()), ['root', 'b3', 'b1', 'b2']);
  ctx.tree.dispose();
});

test('the sixth hook is the UI atom, after the five, in every view', async () => {
  const log = [];
  const ctx = setup({
    useValue: (a) => {
      log.push(a);
      return a.get();
    },
  });
  await flush();
  const hooks = () => {
    log.length = 0;
    ctx.pane.render();
    return [...log];
  };
  const before = hooks();
  byAttr(ctx.pane.render(), 'data-view-toggle', 'graph')[0].props.onClick();
  const after = hooks();
  assert.equal(before.length, 6);
  assert.deepEqual(after, before);
  assert.equal(before[5], ctx.tree.$ui);
  ctx.unload();
});

// ── Merge-back ──────────────────────────────────────────────────────────────────────────────

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
const MERGE_ROWS = [
  row('par', { title: 'Main', started_at: 10 }),
  row('sd', { title: 'Side: what is a monad?', _branched_from: 'par', started_at: 20 }),
];

async function mergeCtx({ rows = MERGE_ROWS, stored = 'par', runtime = 'rt-par', prepare } = {}) {
  const host = fakeHost({ rows, stored, runtime });
  host.history = { par: SHARED, sd: SIDE_ROWS };
  host.usage = { context_used: 1000, context_max: 128000 };
  if (prepare) prepare(host);
  const ctx = setup({ host });
  await flush();
  return ctx;
}
const sideRow = (ctx, id = 'sd') => rowOf(ctx.pane.render(), id);
const mergeButton = (ctx, kind = 'asis', id = 'sd') => byAttr(sideRow(ctx, id), 'data-merge', kind)[0];
const fitOf = (ctx, id = 'sd') => byAttr(sideRow(ctx, id), 'data-token-fit')[0];
const sessionCalls = (host) => host.calls.filter(([m]) => m.startsWith('session.'));

test('the draft in the tests has 21 estimated tokens', () => {
  assert.equal(mod.estimateTokens(DRAFT), 21);
});

test('Merge as-is and a disabled Digest (later) show on side rows only', async () => {
  const ctx = await mergeCtx();
  const asis = mergeButton(ctx);
  assert.equal(asis.type, 'Button');
  assert.equal(asis.props.children, 'Merge as-is');
  const digest = mergeButton(ctx, 'digest');
  assert.equal(digest.type, 'Button');
  assert.equal(digest.props.children, 'Digest (later)');
  assert.equal(digest.props.disabled, true);
  // Not on a plain chat.
  assert.equal(byAttr(rowOf(ctx.pane.render(), 'par'), 'data-merge').length, 0);
  // A click on the disabled option stops at the button and does nothing.
  const event = fakeEvent();
  await digest.props.onClick(event);
  assert.equal(event.stopped, 1);
  assert.equal(sessionCalls(ctx.host).length, 0);
  assert.equal(ctx.host.opened.length, 0);
  ctx.unload();
});

test('rendering the pane does not read the parent context window', async () => {
  const ctx = await mergeCtx();
  ctx.pane.render();
  ctx.pane.render();
  assert.equal(sessionCalls(ctx.host).length, 0);
  assert.equal(ctx.host.drafts.length, 0);
  ctx.unload();
});

test('Merge as-is opens the parent in place and stages the side exchange verbatim, never sending', async () => {
  const ctx = await mergeCtx();
  const row0 = sideRow(ctx);
  const { event } = clickNested(mergeButton(ctx), row0);
  assert.equal(event.stopped, 1);
  await flush();
  assert.deepEqual(ctx.host.order, [
    ['open', 'par', { intent: 'in-place' }],
    ['draft', 'par', DRAFT],
  ]);
  assert.equal(ctx.host.drafts[0][1].includes('From side question:'), false);
  assert.equal(ctx.host.order.some(([kind]) => kind === 'submit'), false);
  // The side chat itself was not opened as a tab by that click.
  assert.deepEqual(ctx.host.opened, [['par', { intent: 'in-place' }]]);
  // Reads: transcript is unknown on v0.23, so history, side then parent, then the window.
  assert.deepEqual(sessionCalls(ctx.host).map(([m, p]) => [m, p.session_id]), [
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
  // The row is now a grey merged row.
  assert.equal(sideRow(ctx).props['data-merged'], 'true');
  assert.equal(mod.isMergedChat({ id: 'sd' }), true);
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
  assert.deepEqual(ctx.host.calls.find(([m]) => m === 'session.transcript'), ['session.transcript', { session_id: 'sd', order: 'oldest' }]);
  assert.equal(ctx.host.calls.some(([m]) => m === 'session.history'), false);
  assert.deepEqual(ctx.host.drafts, [['par', DRAFT]]);
  ctx.unload();
});

test('the merge target is the parent of the side chat, not the focused chat', async () => {
  // Focused on b2; b3 is a side chat of root. Its parent window and draft go to root.
  const host = fakeHost();
  host.history = {
    root: SHARED,
    b3: [...SHARED, { role: 'user', text: 'what is x?' }, { role: 'assistant', text: 'x is y' }],
  };
  host.usage = { context_used: 1000, context_max: 128000 };
  const ctx = setup({ host });
  await flush();
  await mergeButton(ctx, 'asis', 'b3').props.onClick(fakeEvent());
  assert.deepEqual(host.order, [
    ['open', 'root', { intent: 'in-place' }],
    ['draft', 'root', 'From side chat: Side: what is x?\n\nYou:\nwhat is x?\n\nAssistant:\nx is y'],
  ]);
  assert.deepEqual(host.calls.find(([m]) => m === 'session.usage'), ['session.usage', { session_id: 'root' }]);
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
  // Nothing was staged, so the row is not merged.
  assert.equal(sideRow(ctx).props['data-merged'], undefined);
  assert.equal(mod.isMergedChat({ id: 'sd' }), false);
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
    ctx.host.calls.filter(([m]) => /usage|stats|breakdown/.test(m)).map(([m, p]) => [m, p.session_id]),
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
  assert.match(notice.props.children, /estimated/);
  assert.match(notice.props.children, /window was not reported/);
  assert.equal(notice.props.style.userSelect, 'text');
  assert.equal(fitOf(ctx).props['data-token-fit'], 'unknown');
  assert.equal(sideRow(ctx).props['data-merged'], 'true');
  ctx.unload();
});

test('a missing composer draft API shows a notice, opens nothing and writes nothing', async () => {
  for (const strip of [(host) => (host.composer = {}), (host) => delete host.composer]) {
    const ctx = await mergeCtx({ prepare: strip });
    await assert.doesNotReject(async () => mergeButton(ctx).props.onClick(fakeEvent()));
    await flush();
    assert.deepEqual(ctx.host.opened, []);
    assert.deepEqual(ctx.host.order, []);
    assert.equal(sessionCalls(ctx.host).length, 0);
    const notice = exactText(ctx.pane.render(), MERGE_NO_COMPOSER_TEXT);
    assert.ok(notice);
    assert.equal(notice.props.style.userSelect, 'text');
    assert.equal(sideRow(ctx).props['data-merged'], undefined);
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
    // Nothing reached the composer, so the row is not marked merged.
    assert.equal(sideRow(ctx).props['data-merged'], undefined);
    ctx.unload();
  }
});

test('a setDraft that fails on the stored id but works on the runtime id stages the draft', async () => {
  const ctx = await mergeCtx({ prepare: (host) => (host.setDraftResult = ([id]) => id === 'rt-par') });
  await mergeButton(ctx).props.onClick(fakeEvent());
  assert.deepEqual(ctx.host.drafts.map(([id]) => id), ['par', 'rt-par']);
  assert.ok(exactText(ctx.pane.render(), MERGE_STAGED_TEXT));
  assert.equal(sideRow(ctx).props['data-merged'], 'true');
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
  assert.equal(sessionCalls(nothing.host).some(([m]) => /usage|stats|breakdown/.test(m)), false);
  nothing.unload();

  const orphan = await mergeCtx({ rows: [row('lone', { title: 'Side: alone' })], stored: 'lone', runtime: 'rt-lone' });
  await byAttr(rowOf(orphan.pane.render(), 'lone'), 'data-merge', 'asis')[0].props.onClick(fakeEvent());
  assert.match(textOf(orphan.pane.render()), /no parent chat/);
  assert.deepEqual(orphan.host.order, []);
  orphan.unload();

  const unreadable = await mergeCtx({
    prepare: (host) => {
      const base = host.request;
      host.request = async (method, params) => {
        if (method === 'session.history' && params.session_id === 'par') throw new Error('parent gone');
        return base(method, params);
      };
    },
  });
  await assert.doesNotReject(async () => mergeButton(unreadable).props.onClick(fakeEvent()));
  assert.match(textOf(unreadable.pane.render()), /Could not read the parent chat: parent gone/);
  assert.deepEqual(unreadable.host.order, []);
  unreadable.unload();
});

test('Merge as-is does not also open the side chat as a tab, and a double click stages once', async () => {
  const ctx = await mergeCtx();
  const a = mergeButton(ctx).props.onClick(fakeEvent());
  const b = mergeButton(ctx).props.onClick(fakeEvent());
  await Promise.all([a, b]);
  await flush();
  assert.equal(ctx.host.drafts.length, 1);
  assert.equal(ctx.host.opened.some(([id, options]) => id === 'sd' || options.intent === 'tab'), false);
  // The row itself still opens its chat in a tab.
  rowOf(ctx.pane.render(), 'sd').props.onClick();
  await flush();
  assert.deepEqual(ctx.host.opened.at(-1), ['sd', { intent: 'tab', profile: 'default' }]);
  ctx.unload();
});

test('merging a side branch with children collapses it, even when the user had expanded it', async () => {
  const ctx = await mergeCtx({
    rows: [...MERGE_ROWS, row('sdk', { _branched_from: 'sd', started_at: 30 })],
  });
  assert.deepEqual(idsOf(ctx.pane.render()), ['par', 'sd', 'sdk']);
  // The user expands it on purpose (collapse, then expand): an explicit choice.
  byAttr(sideRow(ctx), 'aria-expanded')[0].props.onClick();
  byAttr(sideRow(ctx), 'aria-expanded')[0].props.onClick();
  await mergeButton(ctx).props.onClick(fakeEvent());
  assert.deepEqual(idsOf(ctx.pane.render()), ['par', 'sd']);
  assert.equal(byAttr(sideRow(ctx), 'aria-expanded')[0].props['aria-expanded'], false);
  ctx.unload();
});

test('selectable text covers the badges, breadcrumb, fork label, graph view and merge notices', async () => {
  const ctx = await mergeCtx({ prepare: (host) => (host.usage = { context_used: 127990, context_max: 128000 }) });
  await mergeButton(ctx).props.onClick(fakeEvent());
  mod.rememberMergedBranch('sd');
  byAttr(ctx.pane.render(), 'data-view-toggle', 'graph')[0].props.onClick();
  const tree = ctx.pane.render();
  const holders = findAll(
    tree,
    (n) => n.type !== 'Button' && n.type !== 'ScrollArea' && n.props && [n.props.children].flat().some((c) => typeof c === 'string'),
  );
  // titles, details, both badges, fork label, notice and readout all hold text
  assert.ok(holders.length >= 9, `only ${holders.length} text nodes`);
  for (const n of holders) assert.equal(n.props.style?.userSelect, 'text', `${n.type} ${JSON.stringify(n.props.children)}`);
  for (const key of ['data-breadcrumb', 'data-fork-count', 'data-kind', 'data-merge-result']) {
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
