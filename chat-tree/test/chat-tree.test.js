import test from 'node:test';
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
} from '../src/chat-tree.js';

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
  const state = {
    focusedStoredSessionId: atom(stored),
    focusedSessionId: atom(runtime),
    activeSessionId: atom(null),
    focusedSessionOwner: atom(owner),
    connectionId: atom(active.connectionId),
    profile: atom(active.profile),
  };
  const host = {
    state,
    calls,
    opened,
    rows,
    agents,
    sessionsError: null,
    agentsError: null,
    openSession: async (id, opts) => void opened.push([id, opts]),
    revealPane: () => {},
    async listPersistedSessions(route, options) {
      calls.push(['listPersistedSessions', route, options]);
      if (host.sessionsError) throw host.sessionsError;
      return { sessions: host.rows, total: host.rows.length };
    },
    async request(method, params) {
      calls.push([method, params]);
      if (method !== 'subagent.list') throw new Error(`unexpected ${method}`);
      if (host.agentsError) throw host.agentsError;
      return { subagents: host.agents, delegations: [] };
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
  for (const a of [ctx.tree.$data, ctx.tree.$status]) {
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
  for (const s of states) {
    assert.equal(s.length, 5);
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
