import test from 'node:test';
import assert from 'node:assert/strict';
import * as sideChat from '../src/side-chat.js';
import {
  createSideChat,
  BUSY_TEXT,
  TIMEOUT_TEXT,
  TIMEOUT_MS,
  POLL_MS,
  PAGE_LIMIT,
  MAX_ENTRIES,
  MODEL_KEY,
  listKey,
  branchName,
  rowsAfterFence,
  digestFromRows,
  rowText,
  rememberSideBranch,
  isKnownSideBranch,
  MERGE_STAGED_TEXT,
  MERGE_HIDDEN_TEXT,
  MERGE_NO_COMPOSER_TEXT,
} from '../src/side-chat.js';

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

function asyncStorage(seed = {}) {
  const data = { ...seed };
  return { data, get: async (k) => data[k], set: async (k, v) => void (data[k] = v) };
}

// Desktop ctx.storage is synchronous (apps/desktop/src/contrib/plugin.ts createPluginStorage).
function syncStorage(seed = {}) {
  const data = { ...seed };
  return { data, get: (k) => data[k], set: (k, v) => void (data[k] = v) };
}

// Fake scoped timers and clock, like ctx.setTimeout: each returns a cancel function.
function fakeClock() {
  let t = 1_000_000;
  let id = 0;
  const timers = new Map();
  return {
    now: () => t,
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

const MAIN_ROWS = [
  { role: 'user', text: 'main question', row_id: 1 },
  { role: 'assistant', text: 'main answer', row_id: 2 },
];

// A fake gateway. Each branch transcript starts as a copy of `mainRows` (new row_ids, as a real
// copy gets). `script(n, branch)` runs before the n-th transcript read after prompt.submit and may
// push rows or set busy. Cursors are row offsets.
function fakeHost({
  runtime = 'rt-main',
  stored = 'st-main',
  mainRows = MAIN_ROWS,
  branchError,
  submitError,
  script = defaultScript,
} = {}) {
  const calls = [];
  const opened = [];
  const branches = new Map();
  let nextRowId = 100;
  const state = {
    focusedStoredSessionId: atom(stored),
    focusedSessionId: atom(runtime),
    activeSessionId: atom(null),
    busyBySession: atom({}),
  };
  const host = {
    state,
    calls,
    opened,
    branches,
    openSession: async (id, opts) => void opened.push([id, opts]),
    revealPane: () => {},
    async request(method, params) {
      calls.push([method, params]);
      if (method === 'session.branch_whole') {
        if (branchError) throw branchError;
        const id = `branch-${branches.size + 1}`;
        const rows = mainRows.map((r) => ({ ...r, row_id: ++nextRowId }));
        branches.set(id, { rows, reads: 0, submitted: false, question: null });
        return { session_id: id, stored_session_id: id, title: params.name, message_count: rows.length };
      }
      if (method === 'prompt.submit') {
        if (submitError) throw submitError;
        const b = branches.get(params.session_id);
        b.submitted = true;
        b.question = params.text;
        return { status: 'queued', session_id: params.session_id, admission_id: 'a1' };
      }
      if (method === 'session.transcript') {
        const b = branches.get(params.session_id);
        if (b.submitted) {
          b.reads += 1;
          script(b.reads, b, { add: (row) => b.rows.push({ ...row, row_id: ++nextRowId }), state });
        }
        const offset = params.cursor ? Number(params.cursor) : 0;
        const rows = b.rows.slice(offset, offset + params.limit);
        return { session_id: params.session_id, rows, next_cursor: String(offset + rows.length), reset: false };
      }
      // Generous parent window so merge tests still reach setDraft unless they override the host.
      if (method === 'session.usage' || method === 'session.stats' || method === 'session.context_breakdown') {
        return {
          calls: 1,
          input: 100,
          output: 50,
          total: 150,
          context_used: 1000,
          context_max: 128000,
        };
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  return host;
}

// The question lands on the first read; the answer on the second.
function defaultScript(n, b, { add }) {
  if (n === 1) add({ role: 'user', text: b.question });
  if (n === 2) add({ role: 'assistant', text: 'side answer' });
}

function setup({ host = fakeHost(), storage = asyncStorage(), clock = fakeClock(), useValue, MessageTextContent } = {}) {
  const registered = [];
  const disposers = [];
  const chat = createSideChat({
    host,
    jsx: el,
    jsxs: el,
    atom,
    useValue: useValue ?? ((a) => a.get()),
    Button: 'Button',
    Input: 'Input',
    ScrollArea: 'ScrollArea',
    MessageTextContent,
    now: clock.now,
  });
  chat.register({
    register: (c) => registered.push(c),
    storage,
    setTimeout: clock.setTimeout,
    onDispose: (fn) => disposers.push(fn),
  });
  return {
    chat,
    host,
    storage,
    clock,
    registered,
    unload: () => disposers.forEach((fn) => fn()),
    pane: registered.find((c) => c.area === 'panes'),
  };
}

// Expands function components (EntryRow) so tests see the whole tree.
function expand(node) {
  if (Array.isArray(node)) return node.map(expand);
  if (!node || typeof node !== 'object') return node;
  if (typeof node.type === 'function') return expand(node.type(node.props));
  const children = node.props?.children;
  return { ...node, props: { ...node.props, children: expand(children) } };
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
    .map((n) => n.props?.children)
    .filter((c) => typeof c === 'string')
    .join('\n');

const methods = (host) => host.calls.map(([m]) => m);
const entryOf = (ctx, chatId = 'st-main') => ctx.chat.$lists.get()[chatId]?.[0];

async function ask(ctx, question, { model = '', provider = '', chatId = 'st-main', runtimeId = 'rt-main' } = {}) {
  ctx.chat.$form.set({ question, model, provider });
  await ctx.chat.ask(chatId, runtimeId);
  await flush();
}

test('registers the pane and a palette command', () => {
  const { registered } = setup();
  assert.equal(registered.find((c) => c.area === 'panes').title, 'Side chat');
  assert.ok(registered.find((c) => c.area === 'palette'));
});

test('a question forks, submits on the branch, and polls the transcript until the answer', async () => {
  const ctx = setup();
  await ask(ctx, '  what is a monad?  ');
  const [branchCall] = ctx.host.calls;
  assert.equal(branchCall[0], 'session.branch_whole');
  assert.equal(branchCall[1].session_id, 'rt-main');
  assert.equal(branchCall[1].name, 'Side: what is a monad?');
  assert.ok(branchCall[1].idempotency_key);
  const submit = ctx.host.calls.find(([m]) => m === 'prompt.submit');
  assert.deepEqual(submit, ['prompt.submit', { session_id: 'branch-1', text: 'what is a monad?' }]);
  // Fence reads until an empty page, then submit, then polls; all on the branch, oldest order.
  assert.deepEqual(methods(ctx.host).slice(0, 4), [
    'session.branch_whole',
    'session.transcript',
    'session.transcript',
    'prompt.submit',
  ]);
  for (const [, p] of ctx.host.calls.filter(([m]) => m === 'session.transcript')) {
    assert.equal(p.session_id, 'branch-1');
    assert.equal(p.order, 'oldest');
  }
  await ctx.clock.tick(POLL_MS * 3);
  const entry = entryOf(ctx);
  assert.equal(entry.status, 'answered');
  assert.equal(entry.answer, 'side answer');
  // The first poll starts at the fence cursor (after the 2 copied rows).
  const polls = ctx.host.calls.slice(ctx.host.calls.findIndex(([m]) => m === 'prompt.submit') + 1);
  assert.equal(polls[0][1].cursor, '2');
  assert.ok(!ctx.host.calls.some(([m, p]) => m === 'prompt.submit' && p.session_id === 'rt-main'));
});

test('an identical earlier question in the main chat never returns its old answer', async () => {
  const mainRows = [
    { role: 'user', text: 'why?' },
    { role: 'assistant', text: 'OLD main-chat answer' },
  ];
  const ctx = setup({ host: fakeHost({ mainRows }) });
  await ask(ctx, 'why?');
  await ctx.clock.tick(POLL_MS * 4);
  assert.equal(entryOf(ctx).answer, 'side answer');
});

test('interim assistant text before a tool call is not the answer', async () => {
  const script = (n, b, { add, state }) => {
    if (n === 1) {
      add({ role: 'user', text: b.question });
      add({ role: 'assistant', text: 'Let me search for that.' });
      state.busyBySession.set({ 'branch-1': true });
    }
    if (n === 3) add({ role: 'tool', name: 'web_search' });
    if (n === 4) {
      add({ role: 'assistant', text: 'final answer' });
      state.busyBySession.set({ 'branch-1': false });
    }
  };
  const ctx = setup({ host: fakeHost({ script }) });
  await ask(ctx, 'q');
  await ctx.clock.tick(POLL_MS * 2);
  assert.equal(entryOf(ctx).status, 'asking');
  await ctx.clock.tick(POLL_MS * 3);
  assert.equal(entryOf(ctx).status, 'answered');
  assert.equal(entryOf(ctx).answer, 'final answer');
});

test('with no busy report, the answer must hold for two reads', async () => {
  const script = (n, b, { add }) => {
    if (n === 1) {
      add({ role: 'user', text: b.question });
      add({ role: 'assistant', text: 'interim' });
    }
    if (n === 2) add({ role: 'tool', name: 't' });
    if (n === 3) add({ role: 'assistant', text: 'done' });
  };
  const ctx = setup({ host: fakeHost({ script }) });
  await ask(ctx, 'q');
  await ctx.clock.tick(POLL_MS * 2);
  assert.equal(entryOf(ctx).status, 'asking');
  await ctx.clock.tick(POLL_MS * 3);
  assert.equal(entryOf(ctx).answer, 'done');
});

test('branch name keeps the first 50 characters of the question', () => {
  assert.equal(branchName('x'.repeat(80)), `Side: ${'x'.repeat(50)}`);
});

test('a blank model field sends no model_override', async () => {
  const ctx = setup();
  await ask(ctx, 'q', { model: '   ', provider: 'openai' });
  const submit = ctx.host.calls.find(([m]) => m === 'prompt.submit')[1];
  assert.equal('model_override' in submit, false);
});

test('a model field sends model_override with the model and the provider', async () => {
  const ctx = setup();
  await ask(ctx, 'q', { model: ' gpt-5.6-luna ', provider: ' openai-codex ' });
  const submit = ctx.host.calls.find(([m]) => m === 'prompt.submit')[1];
  assert.deepEqual(submit.model_override, { model: 'gpt-5.6-luna', provider: 'openai-codex' });
  assert.equal(entryOf(ctx).model, 'gpt-5.6-luna');
  assert.equal(entryOf(ctx).provider, 'openai-codex');
});

test('a model with no provider sends only the model', async () => {
  const ctx = setup();
  await ask(ctx, 'q', { model: 'm1' });
  const submit = ctx.host.calls.find(([m]) => m === 'prompt.submit')[1];
  assert.deepEqual(submit.model_override, { model: 'm1' });
});

test('a session_busy refusal (canonical mutation shape) shows the busy message, no prompt.submit', async () => {
  const error = Object.assign(new Error('session_busy'), { code: 4001, data: { reason: 'session_busy' } });
  const ctx = setup({ host: fakeHost({ branchError: error }) });
  await ask(ctx, 'q');
  assert.deepEqual(methods(ctx.host), ['session.branch_whole']);
  assert.equal(ctx.chat.$status.get()['st-main'].notice, BUSY_TEXT);
  assert.match(textOf(expand(ctx.pane.render())), /The main chat is busy/);
  assert.equal(entryOf(ctx), undefined);
});

test('another fork error shows its own text', async () => {
  const ctx = setup({ host: fakeHost({ branchError: new Error('nothing to branch — send a message first') }) });
  await ask(ctx, 'q');
  assert.deepEqual(methods(ctx.host), ['session.branch_whole']);
  assert.match(ctx.chat.$status.get()['st-main'].notice, /nothing to branch/);
});

test('a submit error marks the entry and stops', async () => {
  const ctx = setup({ host: fakeHost({ submitError: new Error('bad model') }) });
  await ask(ctx, 'q', { model: 'nope' });
  assert.equal(entryOf(ctx).status, 'error');
  assert.match(entryOf(ctx).error, /bad model/);
  await ctx.clock.tick(POLL_MS * 5);
  assert.equal(ctx.clock.pending(), 0);
});

test('the poll stops at the answer', async () => {
  const ctx = setup();
  await ask(ctx, 'q');
  await ctx.clock.tick(POLL_MS * 3);
  assert.equal(entryOf(ctx).status, 'answered');
  const reads = methods(ctx.host).filter((m) => m === 'session.transcript').length;
  assert.equal(ctx.clock.pending(), 0);
  await ctx.clock.tick(POLL_MS * 10);
  assert.equal(methods(ctx.host).filter((m) => m === 'session.transcript').length, reads);
});

test('the poll stops at the timeout with the timeout message', async () => {
  const ctx = setup({ host: fakeHost({ script: () => {} }) });
  await ask(ctx, 'q');
  await ctx.clock.tick(TIMEOUT_MS - POLL_MS);
  assert.equal(entryOf(ctx).status, 'asking');
  await ctx.clock.tick(POLL_MS * 2);
  assert.equal(entryOf(ctx).status, 'timeout');
  assert.equal(ctx.clock.pending(), 0);
  const reads = methods(ctx.host).filter((m) => m === 'session.transcript').length;
  assert.ok(reads > 100 && reads <= TIMEOUT_MS / POLL_MS + 2, `reads ${reads}`);
  assert.match(textOf(expand(ctx.pane.render())), new RegExp(TIMEOUT_TEXT.replace('.', '\\.')));
});

test('reset restarts the read, drops copied rows by row_id, and finds the new answer', async () => {
  const host = fakeHost({ script: () => {} });
  const base = host.request;
  let polls = 0;
  host.request = async (method, params) => {
    if (method !== 'session.transcript' || !host.branches.get(params.session_id)?.submitted) return base(method, params);
    host.calls.push([method, params]);
    polls += 1;
    if (polls === 1) return { rows: [{ role: 'user', text: 'q', row_id: 200 }], next_cursor: 'c1', reset: false };
    // A rewrite: the reply starts from the first page again, copied rows included.
    if (polls === 2) {
      return {
        rows: [
          { role: 'user', text: 'q', row_id: 101 },
          { role: 'assistant', text: 'copied old', row_id: 102 },
        ],
        next_cursor: 'r1',
        reset: true,
      };
    }
    return {
      rows: [
        { role: 'user', text: 'q', row_id: 200 },
        { role: 'assistant', text: 'after reset', row_id: 201 },
      ],
      next_cursor: 'r2',
      reset: false,
    };
  };
  const ctx = setup({ host });
  await ask(ctx, 'q');
  await ctx.clock.tick(POLL_MS);
  assert.equal(entryOf(ctx).status, 'asking');
  await ctx.clock.tick(POLL_MS * 3);
  assert.equal(entryOf(ctx).answer, 'after reset');
  const cursors = host.calls
    .slice(host.calls.findIndex(([m]) => m === 'prompt.submit') + 1)
    .map(([, p]) => p.cursor);
  assert.deepEqual(cursors.slice(0, 3), ['2', 'c1', 'r1']);
});

test('the fence reads every page of a long copied history', async () => {
  const mainRows = Array.from({ length: PAGE_LIMIT + 10 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `m${i}` }));
  const ctx = setup({ host: fakeHost({ mainRows }) });
  await ask(ctx, 'q');
  const fenceReads = ctx.host.calls.slice(1, ctx.host.calls.findIndex(([m]) => m === 'prompt.submit'));
  // A full page, a short page, then the empty page that ends the fence.
  assert.equal(fenceReads.length, 3);
  await ctx.clock.tick(POLL_MS * 3);
  assert.equal(entryOf(ctx).answer, 'side answer');
});

test('lists are separate per main chat and keep 50 entries at most', async () => {
  const ctx = setup();
  for (let i = 0; i < MAX_ENTRIES + 5; i++) await ask(ctx, `q${i}`);
  await ask(ctx, 'other', { chatId: 'st-two', runtimeId: 'rt-two' });
  const lists = ctx.chat.$lists.get();
  assert.equal(lists['st-main'].length, MAX_ENTRIES);
  assert.equal(lists['st-main'][0].question, `q${MAX_ENTRIES + 4}`);
  assert.equal(lists['st-two'].length, 1);
  assert.equal(lists['st-two'][0].question, 'other');
  assert.equal(ctx.storage.data[listKey('st-main')].length, MAX_ENTRIES);
  assert.equal(ctx.storage.data[listKey('st-two')].length, 1);
  ctx.unload();
});

test('lists are keyed by the stored session id, which survives a reload', async () => {
  const storage = syncStorage();
  const first = setup({ storage });
  await ask(first, 'q');
  await first.clock.tick(POLL_MS * 3);
  first.unload();
  assert.ok(storage.data[listKey('st-main')]);
  assert.equal(storage.data[listKey('rt-main')], undefined);
  // After a restart the runtime id is new; the stored id is the same.
  const second = setup({ storage, host: fakeHost({ runtime: 'rt-new' }) });
  assert.match(textOf(expand(second.pane.render())), /side answer/);
  // The fork still goes to the runtime id.
  await ask(second, 'q2', { runtimeId: 'rt-new' });
  assert.equal(second.host.calls[0][1].session_id, 'rt-new');
  second.unload();
});

test('unload stops polls and later writes; timers come from ctx.setTimeout', async () => {
  const storage = syncStorage();
  const ctx = setup({ storage, host: fakeHost({ script: () => {} }) });
  await ask(ctx, 'q');
  assert.ok(ctx.clock.pending() > 0);
  ctx.unload();
  assert.equal(ctx.clock.pending(), 0);
  const before = JSON.stringify(storage.data);
  const reads = methods(ctx.host).length;
  await ctx.clock.tick(TIMEOUT_MS * 2);
  assert.equal(methods(ctx.host).length, reads);
  assert.equal(JSON.stringify(storage.data), before);
  // Focus listeners are removed too.
  assert.equal(ctx.host.state.focusedStoredSessionId.listeners(), 0);
});

test('render never writes state; the list loads on focus change', async () => {
  const storage = syncStorage({
    [listKey('st-two')]: [{ id: 'b9', question: 'two q', session_id: 'b9', status: 'answered', answer: 'a', at: 5 }],
  });
  const ctx = setup({ storage });
  let sets = 0;
  const orig = ctx.chat.$lists.set;
  ctx.chat.$lists.set = (v) => {
    sets += 1;
    orig(v);
  };
  ctx.host.state.focusedStoredSessionId.set('st-two');
  assert.equal(sets, 1);
  sets = 0;
  const text = textOf(expand(ctx.pane.render()));
  assert.equal(sets, 0);
  assert.match(text, /two q/);
  ctx.unload();
});

test('the pane shows only the list of the focused chat', async () => {
  const stored = [{ id: 'b9', question: 'old q', session_id: 'b9', stored_session_id: 's9', status: 'answered', answer: 'old a', at: 5 }];
  const storage = asyncStorage({ [listKey('st-main')]: stored, [listKey('st-two')]: [{ ...stored[0], id: 'x', question: 'other chat q' }] });
  const ctx = setup({ storage });
  await flush();
  const text = textOf(expand(ctx.pane.render()));
  assert.match(text, /old q/);
  assert.match(text, /old a/);
  assert.doesNotMatch(text, /other chat q/);
});

test('corrupt stored entries are dropped, not rendered', async () => {
  const storage = syncStorage({
    [listKey('st-main')]: [
      { id: 'a', question: { bad: 1 }, session_id: 'a', status: 'answered', at: 3 },
      null,
      'junk',
      { id: 'b', question: 'good', session_id: 'b', status: 'answered', answer: { x: 1 }, at: 'x' },
    ],
  });
  const ctx = setup({ storage });
  const list = ctx.chat.$lists.get()['st-main'];
  assert.equal(list.length, 1);
  assert.equal(list[0].question, 'good');
  assert.equal(list[0].answer, null);
  // No plain object (a non-element) is ever rendered as a child.
  for (const n of findAll(expand(ctx.pane.render()), () => true)) {
    const c = n.props?.children;
    if (c && typeof c === 'object' && !Array.isArray(c)) assert.ok('type' in c, `object child: ${JSON.stringify(c)}`);
  }
});

test('a stored entry left asking with no live poll reads as timed out', async () => {
  const stored = [{ id: 'b1', question: 'q', session_id: 'b1', stored_session_id: 's1', status: 'asking', at: 5 }];
  const ctx = setup({ storage: asyncStorage({ [listKey('st-main')]: stored }) });
  await flush();
  assert.equal(entryOf(ctx).status, 'timeout');
});

test('Ask is disabled while a fork is in flight, and a second ask makes no second branch', async () => {
  const host = fakeHost();
  const base = host.request;
  let release;
  host.request = (method, params) => {
    if (method === 'session.branch_whole') {
      host.calls.push([method, params]);
      return new Promise((resolve) => {
        release = () => resolve({ session_id: 'branch-x', stored_session_id: 'branch-x' });
      });
    }
    return base(method, params);
  };
  host.branches.set('branch-x', { rows: [], reads: 0, submitted: false });
  const ctx = setup({ host });
  ctx.chat.$form.set({ question: 'q', model: '', provider: '' });
  const first = ctx.chat.ask('st-main', 'rt-main');
  const askButton = () => findAll(ctx.pane.render(), (n) => n.type === 'Button' && n.props.children === 'Ask')[0];
  assert.equal(askButton().props.disabled, true);
  await ctx.chat.ask('st-main', 'rt-main');
  release();
  await first;
  await flush();
  assert.equal(methods(host).filter((m) => m === 'session.branch_whole').length, 1);
  assert.equal(askButton().props.disabled, false);
  ctx.unload();
});

test('text typed during the fork is kept', async () => {
  const host = fakeHost();
  const base = host.request;
  let ctx;
  host.request = async (method, params) => {
    if (method === 'session.branch_whole') ctx.chat.$form.set({ ...ctx.chat.$form.get(), question: 'next question' });
    return base(method, params);
  };
  ctx = setup({ host });
  await ask(ctx, 'first');
  assert.equal(ctx.chat.$form.get().question, 'next question');
  assert.equal(entryOf(ctx).question, 'first');
  ctx.unload();
});

test('the asked text is cleared when nothing new was typed', async () => {
  const ctx = setup();
  await ask(ctx, 'first');
  assert.equal(ctx.chat.$form.get().question, '');
  ctx.unload();
});

test('Open calls host.openSession with the stored id and intent tab', async () => {
  const ctx = setup();
  await ask(ctx, 'q');
  const open = findAll(expand(ctx.pane.render()), (n) => n.type === 'Button' && n.props.children === 'Open')[0];
  open.props.onClick();
  await flush();
  assert.deepEqual(ctx.host.opened, [['branch-1', { intent: 'tab' }]]);
  ctx.unload();
});

test('model settings persist under sideChat:model and load on register', async () => {
  const storage = asyncStorage({ [MODEL_KEY]: { model: 'm', provider: 'p' } });
  const ctx = setup({ storage });
  await flush();
  assert.equal(ctx.chat.$form.get().model, 'm');
  assert.equal(ctx.chat.$form.get().provider, 'p');
  const inputs = findAll(ctx.pane.render(), (n) => n.type === 'Input');
  inputs[1].props.onChange({ target: { value: 'm2' } });
  await flush();
  assert.deepEqual(storage.data[MODEL_KEY], { model: 'm2', provider: 'p' });
});

test('all pane text allows selection', async () => {
  const ctx = setup();
  await ask(ctx, 'q');
  const tree = expand(ctx.pane.render());
  assert.equal(tree.props.children.props.style.userSelect, 'text');
  const rows = findAll(tree, (n) => n.type === 'pre');
  assert.ok(rows.length > 0);
  for (const row of rows) assert.equal(row.props.style.userSelect, 'text');
  ctx.unload();
});

test('each render calls the same hooks in the same order (React error 300)', async () => {
  const log = [];
  const useValue = (a) => {
    log.push(a);
    return a.get();
  };
  const host = fakeHost({ runtime: null, stored: null });
  const ctx = setup({ host, useValue });
  const order = () => {
    log.length = 0;
    // Expanding calls every component, so a hook hidden in EntryRow would show up here too.
    expand(ctx.pane.render());
    return [...log];
  };
  const states = [];
  states.push(order()); // no chat
  host.state.focusedSessionId.set('rt-main');
  host.state.focusedStoredSessionId.set('st-main');
  states.push(order()); // empty list
  await ask(ctx, 'q');
  states.push(order()); // one entry, asking
  await ctx.clock.tick(POLL_MS * 3);
  states.push(order()); // answered
  ctx.chat.$status.set({ 'st-main': { notice: BUSY_TEXT, pending: true } });
  states.push(order()); // notice, pending
  ctx.chat.$status.set({});
  for (let i = 0; i < 3; i++) await ask(ctx, `more ${i}`);
  states.push(order()); // several entries
  for (const s of states) {
    assert.equal(s.length, 6);
    assert.deepEqual(s, states[0]);
  }
  ctx.unload();
});

test('the fence reads on past a short page until an empty page (old same question later in the copy)', async () => {
  // Pages of one row each: a short page is not the end (pages are cut at 2 MiB and by store work).
  const mainRows = [
    { role: 'user', text: 'big' },
    { role: 'user', text: 'why?' },
    { role: 'assistant', text: 'OLD' },
  ];
  // The question row lands late, so a fence that stopped early would settle on "OLD" first.
  const script = (n, b, { add }) => {
    if (n === 4) add({ role: 'user', text: b.question });
    if (n === 5) add({ role: 'assistant', text: 'side answer' });
  };
  const host = fakeHost({ mainRows, script });
  const base = host.request;
  host.request = async (method, params) => {
    const b = host.branches.get(params?.session_id);
    if (method === 'session.transcript' && b && !b.submitted) {
      host.calls.push([method, params]);
      const offset = params.cursor ? Number(params.cursor) : 0;
      const rows = b.rows.slice(offset, offset + 1);
      return { rows, next_cursor: String(offset + rows.length), reset: false };
    }
    return base(method, params);
  };
  const ctx = setup({ host });
  await ask(ctx, 'why?');
  await ctx.clock.tick(POLL_MS * 8);
  assert.equal(entryOf(ctx).answer, 'side answer');
  ctx.unload();
});

test('each entry shows a muted, selectable poll readout', async () => {
  const busyScript = (n, b, { add, state }) => {
    if (n === 1) {
      add({ role: 'user', text: b.question });
      state.busyBySession.set({ 'branch-1': true });
    }
    if (n === 2) {
      add({ role: 'assistant', text: 'busy answer' });
      state.busyBySession.set({});
    }
  };
  const busy = setup({ host: fakeHost({ script: busyScript }) });
  await ask(busy, 'q');
  const readout = (ctx) => findAll(expand(ctx.pane.render()), (n) => n.type === 'p' && /^busy seen:/.test(n.props.children));
  assert.match(readout(busy)[0].props.children, /^busy seen: yes · reads: 1 · done by: -$/);
  await busy.clock.tick(POLL_MS * 3);
  const [line] = readout(busy);
  assert.equal(line.props.children, 'busy seen: yes · reads: 2 · done by: busy-signal');
  assert.equal(line.props.style.userSelect, 'text');
  assert.match(line.props.className, /opacity/);
  busy.unload();

  const quiet = setup();
  await ask(quiet, 'q');
  await quiet.clock.tick(POLL_MS * 3);
  assert.equal(readout(quiet)[0].props.children, 'busy seen: no · reads: 3 · done by: two-reads');
  quiet.unload();

  const slow = setup({ host: fakeHost({ script: () => {} }) });
  await ask(slow, 'q');
  await slow.clock.tick(TIMEOUT_MS + POLL_MS);
  assert.match(readout(slow)[0].props.children, /done by: timeout$/);
  slow.unload();
});

test('an answer renders through MessageTextContent when the SDK has it, else as plain text', async () => {
  const stored = [{ id: 'b9', question: 'q', session_id: 'b9', stored_session_id: 's9', status: 'answered', answer: '**bold**', at: 5 }];
  const MessageTextContent = 'MessageTextContent';
  const rich = setup({ storage: asyncStorage({ [listKey('st-main')]: stored }), MessageTextContent });
  await flush();
  const md = findAll(expand(rich.pane.render()), (n) => n.type === MessageTextContent);
  assert.equal(md.length, 1);
  assert.equal(md[0].props.text, '**bold**');
  assert.equal(md[0].props.media, false);

  const plain = setup({ storage: asyncStorage({ [listKey('st-main')]: stored }) });
  await flush();
  const tree = expand(plain.pane.render());
  assert.equal(findAll(tree, (n) => n.type === MessageTextContent).length, 0);
  assert.ok(findAll(tree, (n) => n.type === 'pre' && n.props.children === '**bold**').length === 1);
});

test('after dispose and a second register (disable, then enable), a question still gets its answer', async () => {
  const ctx = setup();
  ctx.unload();
  ctx.chat.register({
    register: () => {},
    storage: ctx.storage,
    setTimeout: ctx.clock.setTimeout,
    onDispose: () => {},
  });
  await ask(ctx, 'still alive?');
  await ctx.clock.tick(POLL_MS * 3);
  assert.equal(entryOf(ctx).status, 'answered');
});

const DIGEST = (question, answer) => `From side question:\n\nQuestion: ${question}\n\nAnswer:\n${answer}`;

const VERBATIM = (title, turns) => {
  const blocks = turns.map(([question, answer]) => `You:\n${question}\n\nAssistant:\n${answer}`).join('\n\n');
  return `From side chat: ${title}\n\n${blocks}`;
};

const roughTokens = (text) => (text ? Math.floor((text.length + 3) / 4) : 0);
const commas = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

test('rows after the fence are kept and copied history rows are not', () => {
  const rows = [
    { role: 'user', text: 'main question', row_id: 1 },
    { role: 'assistant', text: 'main answer', row_id: 2 },
    { role: 'user', text: 'side q', row_id: 3 },
    { role: 'tool', text: 'search hit', row_id: 4 },
    { role: 'assistant', text: 'side a', row_id: 5 },
    { role: 'assistant', text: '   ', row_id: 6 },
  ];
  assert.deepEqual(
    rowsAfterFence(rows, 2).map((row) => row.row_id),
    [3, 4, 5, 6],
  );
  assert.equal(digestFromRows(rows, 2, { question: 'ignored', answer: 'ignored' }), DIGEST('side q', 'side a'));
  // A copied row with no row id is still new to a fence, matching the poll. A missing fence keeps nothing.
  assert.deepEqual(rowsAfterFence([{ role: 'user', text: 'loose', row_id: Number.NaN }], 2), [
    { role: 'user', text: 'loose', row_id: Number.NaN },
  ]);
  assert.deepEqual(rowsAfterFence(rows, null), []);
});

test('digest falls back to the stored question and answer', () => {
  const copied = [
    { role: 'user', text: 'main question', row_id: 1 },
    { role: 'assistant', text: 'main answer', row_id: 2 },
  ];
  assert.equal(digestFromRows(copied, 2, { question: 'stored q', answer: 'stored a' }), DIGEST('stored q', 'stored a'));
  assert.equal(digestFromRows(null, 2, { question: 'stored q', answer: 'stored a' }), DIGEST('stored q', 'stored a'));
  assert.equal(digestFromRows([], null, { question: 'stored q', answer: '  stored a  ' }), DIGEST('stored q', 'stored a'));
});

function stageButton(ctx) {
  return findAll(expand(ctx.pane.render()), (n) => n.type === 'Button' && n.props.children === 'Merge into parent')[0];
}

function withComposer(ctx, setDraft, submit = () => {}) {
  const order = [];
  const opened = ctx.host.opened;
  ctx.host.openSession = async (id, opts) => {
    order.push(['open', id, opts]);
    opened.push([id, opts]);
  };
  ctx.host.composer = {
    setDraft: async (id, text) => {
      order.push(['draft', id, text]);
      return setDraft(id, text);
    },
    submit: (...args) => {
      order.push(['submit', ...args]);
      return submit(...args);
    },
  };
  return order;
}

test('Merge into parent opens the parent in place and stages the side exchange verbatim without sending', async () => {
  const ctx = setup();
  const order = withComposer(ctx, () => true);
  await ask(ctx, 'what is a monad?');
  await ctx.clock.tick(POLL_MS * 3);
  assert.equal(entryOf(ctx).status, 'answered');
  const button = stageButton(ctx);
  assert.equal(button.props.disabled, false);
  // The merge read sees copied history plus a newer turn than the one the poll stored.
  const base = ctx.host.request.bind(ctx.host);
  ctx.host.request = async (method, params) => {
    if (method === 'session.transcript') {
      ctx.host.calls.push([method, params]);
      return {
        rows: [
          { role: 'user', text: 'main question', row_id: 101 },
          { role: 'assistant', text: 'main answer', row_id: 102 },
          { role: 'user', text: 'what is a monad?', row_id: 210 },
          { role: 'assistant', text: 'fresh side answer', row_id: 211 },
        ],
        next_cursor: null,
        reset: false,
      };
    }
    return base(method, params);
  };
  await button.props.onClick();
  const draft = VERBATIM('what is a monad?', [['what is a monad?', 'fresh side answer']]);
  assert.deepEqual(order.map((step) => step[0]), ['open', 'draft']);
  assert.deepEqual(order[0], ['open', 'st-main', { intent: 'in-place' }]);
  assert.equal(order[1][1], 'st-main');
  assert.equal(order[1][2], draft);
  assert.equal(order[1][2].includes('From side question:'), false);
  assert.equal(order.some((step) => step[0] === 'submit'), false);
  const notice = findAll(expand(ctx.pane.render()), (n) => n.props?.children === MERGE_STAGED_TEXT)[0];
  assert.equal(notice.props.style.userSelect, 'text');
  assert.equal(notice.props['data-selectable-text'], 'true');
  ctx.unload();
});

test('a false setDraft shows a notice and does not throw', async () => {
  const ctx = setup();
  const order = withComposer(ctx, () => false);
  await ask(ctx, 'q');
  await ctx.clock.tick(POLL_MS * 3);
  await assert.doesNotReject(() => stageButton(ctx).props.onClick());
  assert.deepEqual(
    order.map((step) => step[0]),
    ['open', 'draft', 'draft'],
  );
  assert.deepEqual(order[1].slice(0, 2), ['draft', 'st-main']);
  assert.deepEqual(order[2].slice(0, 2), ['draft', 'rt-main']);
  assert.match(order[1][2], /You:\nq/);
  assert.match(order[1][2], /Assistant:\nside answer/);
  assert.equal(order[1][2].includes('From side question:'), false);
  assert.equal(order.some((step) => step[0] === 'submit'), false);
  assert.equal(ctx.chat.$status.get()['st-main'].notice, MERGE_HIDDEN_TEXT);
  ctx.unload();
});

test('a thrown setDraft shows the same notice and does not throw', async () => {
  const ctx = setup();
  withComposer(ctx, () => {
    throw new Error('composer gone');
  });
  await ask(ctx, 'q');
  await ctx.clock.tick(POLL_MS * 3);
  await assert.doesNotReject(() => stageButton(ctx).props.onClick());
  assert.equal(ctx.chat.$status.get()['st-main'].notice, MERGE_HIDDEN_TEXT);
  ctx.unload();
});

test('when session.transcript fails, Stage merge still uses the stored question and answer', async () => {
  const ctx = setup();
  const order = withComposer(ctx, () => true);
  await ask(ctx, 'stored question');
  await ctx.clock.tick(POLL_MS * 3);
  const base = ctx.host.request.bind(ctx.host);
  ctx.host.request = async (method, params) => {
    if (method === 'session.transcript') throw new Error('transcript down');
    return base(method, params);
  };
  await stageButton(ctx).props.onClick();
  assert.equal(order[1][2], VERBATIM('stored question', [['stored question', 'side answer']]));
  assert.equal(order[1][2].includes('From side question:'), false);
  assert.equal(order.some((step) => step[0] === 'submit'), false);
  ctx.unload();
});

test('Merge into parent is disabled when there is no answer', async () => {
  const asking = setup({ host: fakeHost({ script: () => {} }) });
  await ask(asking, 'q');
  assert.equal(stageButton(asking), undefined);
  asking.unload();

  const stored = [{ id: 'b9', question: 'q', session_id: 'b9', stored_session_id: 's9', status: 'answered', answer: '   ', at: 5 }];
  const empty = setup({ storage: asyncStorage({ [listKey('st-main')]: stored }) });
  await flush();
  assert.equal(stageButton(empty).props.disabled, true);
  empty.unload();
});

test('a missing composer draft API shows a notice and writes nothing', async () => {
  const ctx = setup();
  await ask(ctx, 'q');
  await ctx.clock.tick(POLL_MS * 3);
  const opened = ctx.host.opened.length;
  await assert.doesNotReject(() => stageButton(ctx).props.onClick());
  assert.equal(ctx.host.opened.length, opened);
  assert.equal(ctx.chat.$status.get()['st-main'].notice, MERGE_NO_COMPOSER_TEXT);
  ctx.unload();
});

test('estimateTokens matches the ASCII (len+3)//4 count and is 0 for empty text', () => {
  assert.equal(typeof sideChat.estimateTokens, 'function');
  assert.equal(sideChat.estimateTokens(''), 0);
  assert.equal(sideChat.estimateTokens(undefined), 0);
  assert.equal(sideChat.estimateTokens('abcd'), 1);
  assert.equal(sideChat.estimateTokens('abc'), 1);
  assert.equal(sideChat.estimateTokens('abcde'), 2);
});

test('parseContextHeadroom reads TUI usage, nested usage, and canonical stats', () => {
  assert.equal(typeof sideChat.parseContextHeadroom, 'function');
  assert.deepEqual(sideChat.parseContextHeadroom({
    calls: 1,
    input: 100,
    output: 50,
    total: 150,
    context_used: 1000,
    context_max: 128000,
  }), { used: 1000, max: 128000, available: 127000, estimated: false });
  assert.deepEqual(sideChat.parseContextHeadroom({
    usage: { context_used: 80, context_max: 1000, context_estimated: true },
  }), { used: 80, max: 1000, available: 920, estimated: true });
  assert.deepEqual(sideChat.parseContextHeadroom({
    last_prompt_tokens: 50,
    context_length: 200,
    context_tokens: 40,
  }), { used: 50, max: 200, available: 150, estimated: false });
  assert.equal(sideChat.parseContextHeadroom({ calls: 0, input: 0, output: 0, total: 0 }), null);
  assert.deepEqual(sideChat.parseContextHeadroom({
    context_length: 0,
    usage: { context_used: 5, context_max: 10 },
  }), { used: 5, max: 10, available: 5, estimated: false });
  assert.deepEqual(sideChat.parseContextHeadroom({
    context_tokens: 7,
    context_length: 11,
  }), { used: 7, max: 11, available: 4, estimated: false });
});

test('formatSideVerbatim and turnsFromRows keep every side pair and skip tool and system rows', () => {
  assert.equal(typeof sideChat.turnsFromRows, 'function');
  assert.equal(typeof sideChat.formatSideVerbatim, 'function');
  const turns = sideChat.turnsFromRows([
    { role: 'assistant', text: 'before any question' },
    { role: 'user', text: 'q1' },
    { role: 'tool', text: 'search hit' },
    { role: 'assistant', text: 'a1a' },
    { role: 'assistant', text: '   ' },
    { role: 'assistant', text: 'a1b' },
    { role: 'system', text: 'note' },
    { role: 'user', text: 'q2' },
    { role: 'assistant', content: [{ text: 'a2' }] },
  ]);
  assert.deepEqual(turns, [
    { question: 'q1', answer: 'a1a\na1b' },
    { question: 'q2', answer: 'a2' },
  ]);
  assert.equal(
    sideChat.formatSideVerbatim('  Title  ', turns),
    VERBATIM('Title', [['q1', 'a1a\na1b'], ['q2', 'a2']]),
  );
  assert.equal(sideChat.formatSideVerbatim('   ', [{ question: 'q', answer: 'a' }]), VERBATIM('Side chat', [['q', 'a']]));
});

test('formatNoFitNotice names side tokens, available headroom, and estimated figures', () => {
  assert.equal(typeof sideChat.formatNoFitNotice, 'function');
  assert.equal(
    sideChat.formatNoFitNotice({ sideTokens: 12400, available: 3200, used: 124800, max: 128000 }),
    "Doesn't fit: side chat is 12,400 tokens, parent has 3,200 available (124,800 used of 128,000).",
  );
  assert.equal(
    sideChat.formatNoFitNotice({
      sideTokens: 12400,
      available: 3200,
      used: 124800,
      max: 128000,
      sideEstimated: true,
    }),
    "Doesn't fit: side chat is 12,400 tokens (estimated), parent has 3,200 available (124,800 used of 128,000).",
  );
  assert.match(
    sideChat.formatNoFitNotice({
      sideTokens: 12,
      available: 3,
      used: 5,
      max: 8,
      sideEstimated: true,
      windowEstimated: true,
    }),
    /estimated/,
  );
});

test('a side exchange that fits the parent window is staged verbatim and not submitted', async () => {
  const ctx = setup();
  const order = withComposer(ctx, () => true);
  await ask(ctx, 'what is a monad?');
  await ctx.clock.tick(POLL_MS * 3);
  const base = ctx.host.request.bind(ctx.host);
  ctx.host.request = async (method, params) => {
    if (method === 'session.usage') {
      ctx.host.calls.push([method, params]);
      return { context_used: 1000, context_max: 128000 };
    }
    if (method === 'session.transcript') {
      ctx.host.calls.push([method, params]);
      return {
        rows: [
          { role: 'user', text: 'main question', row_id: 1 },
          { role: 'assistant', text: 'main answer', row_id: 2 },
          { role: 'user', text: 'what is a monad?', row_id: 210 },
          { role: 'assistant', text: 'fresh side answer', row_id: 211 },
        ],
        next_cursor: null,
      };
    }
    return base(method, params);
  };
  await stageButton(ctx).props.onClick();
  const usage = ctx.host.calls.filter(([method]) => method === 'session.usage');
  assert.equal(usage[0][1].session_id, 'st-main');
  assert.equal(usage.some(([, params]) => params.session_id === 'branch-1'), false);
  assert.deepEqual(order.map((step) => step[0]), ['open', 'draft']);
  assert.deepEqual(order[0], ['open', 'st-main', { intent: 'in-place' }]);
  assert.equal(order[1][2], VERBATIM('what is a monad?', [['what is a monad?', 'fresh side answer']]));
  assert.equal(order.some((step) => step[0] === 'submit'), false);
  assert.equal(ctx.chat.$status.get()['st-main'].notice, MERGE_STAGED_TEXT);
  ctx.unload();
});

test('a side exchange that does not fit is not opened, drafted, or submitted', async () => {
  const ctx = setup();
  const order = withComposer(ctx, () => true);
  await ask(ctx, 'q');
  await ctx.clock.tick(POLL_MS * 3);
  const opened = ctx.host.opened.length;
  const base = ctx.host.request.bind(ctx.host);
  ctx.host.request = async (method, params) => {
    if (method === 'session.usage') return { context_used: 127990, context_max: 128000 };
    return base(method, params);
  };
  await assert.doesNotReject(() => stageButton(ctx).props.onClick());
  assert.deepEqual(order, []);
  assert.equal(ctx.host.opened.length, opened);
  const notice = ctx.chat.$status.get()['st-main'].heldNotice;
  const verbatim = VERBATIM('q', [['q', 'side answer']]);
  assert.match(notice, /Doesn't fit/);
  assert.match(notice, new RegExp(commas(roughTokens(verbatim))));
  assert.match(notice, /10 available/);
  assert.match(notice, /127,990 used of 128,000/);
  assert.match(notice, /estimated/);
  const shown = findAll(expand(ctx.pane.render()), (n) => n.props?.children === notice)[0];
  assert.equal(shown.props.style.userSelect, 'text');
  assert.equal(shown.props['data-selectable-text'], 'true');
  assert.equal(order.some((step) => step[0] === 'submit'), false);
  ctx.unload();
});

test('merge stages every side pair after the fence, not a first-pair digest', async () => {
  const ctx = setup();
  const order = withComposer(ctx, () => true);
  await ask(ctx, 'seed question');
  await ctx.clock.tick(POLL_MS * 3);
  const fence = entryOf(ctx).maxRowId;
  const base = ctx.host.request.bind(ctx.host);
  ctx.host.request = async (method, params) => {
    if (method === 'session.transcript') {
      ctx.host.calls.push([method, params]);
      return {
        rows: [
          { role: 'user', text: 'main question', row_id: fence - 1 },
          { role: 'assistant', text: 'main answer', row_id: fence },
          { role: 'user', text: 'first side q', row_id: fence + 1 },
          { role: 'tool', text: 'search hit', row_id: fence + 2 },
          { role: 'assistant', text: 'first side a', row_id: fence + 3 },
          { role: 'system', text: 'note', row_id: fence + 4 },
          { role: 'user', text: 'second side q', row_id: fence + 5 },
          { role: 'assistant', text: 'second side a', row_id: fence + 6 },
        ],
        next_cursor: null,
      };
    }
    return base(method, params);
  };
  await stageButton(ctx).props.onClick();
  const draft = order[1][2];
  assert.equal(draft, VERBATIM('seed question', [['first side q', 'first side a'], ['second side q', 'second side a']]));
  assert.equal(draft.includes('From side question:'), false);
  assert.equal(draft.includes('main question'), false);
  assert.equal(draft.includes('search hit'), false);
  assert.equal(draft.includes(DIGEST('first side q', 'first side a')), false);
  assert.equal(order.some((step) => step[0] === 'submit'), false);
  ctx.unload();
});

test('when the host token APIs throw, merge still stages verbatim and says the window was not reported', async () => {
  const ctx = setup();
  const order = withComposer(ctx, () => true);
  await ask(ctx, 'q');
  await ctx.clock.tick(POLL_MS * 3);
  const base = ctx.host.request.bind(ctx.host);
  ctx.host.request = async (method, params) => {
    if (method === 'session.usage' || method === 'session.stats' || method === 'session.context_breakdown') {
      ctx.host.calls.push([method, params]);
      throw new Error(`no ${method}`);
    }
    return base(method, params);
  };
  await assert.doesNotReject(() => stageButton(ctx).props.onClick());
  assert.deepEqual(order.map((step) => step[0]), ['open', 'draft']);
  assert.equal(order[1][2], VERBATIM('q', [['q', 'side answer']]));
  assert.equal(order.some((step) => step[0] === 'submit'), false);
  const tried = ctx.host.calls.filter(([method]) => (
    method === 'session.usage' || method === 'session.stats' || method === 'session.context_breakdown'
  )).map(([method]) => method);
  assert.ok(tried.includes('session.usage'));
  assert.ok(tried.includes('session.stats'));
  assert.ok(tried.includes('session.context_breakdown'));
  const notice = ctx.chat.$status.get()['st-main'].notice;
  assert.match(notice, /estimated/);
  assert.match(notice, /window was not reported/);
  assert.match(notice, new RegExp(commas(roughTokens(VERBATIM('q', [['q', 'side answer']])))));
  ctx.unload();
});

test('session.stats supplies the window when session.usage has no context max', async () => {
  const ctx = setup();
  const order = withComposer(ctx, () => true);
  await ask(ctx, 'q');
  await ctx.clock.tick(POLL_MS * 3);
  const base = ctx.host.request.bind(ctx.host);
  ctx.host.request = async (method, params) => {
    if (method === 'session.usage') return { calls: 0, input: 0, output: 0, total: 0 };
    if (method === 'session.stats') return { last_prompt_tokens: 127990, context_length: 128000, context_tokens: 127990 };
    if (method === 'session.context_breakdown') throw new Error('breakdown down');
    return base(method, params);
  };
  await assert.doesNotReject(() => stageButton(ctx).props.onClick());
  assert.deepEqual(order, []);
  assert.match(ctx.chat.$status.get()['st-main'].heldNotice, /127,990 used of 128,000/);
  ctx.unload();
});

test('a parent window on the focused runtime id is used when the stored id has none', async () => {
  const ctx = setup();
  const order = withComposer(ctx, () => true);
  await ask(ctx, 'q');
  await ctx.clock.tick(POLL_MS * 3);
  const seen = [];
  const base = ctx.host.request.bind(ctx.host);
  ctx.host.request = async (method, params) => {
    if (method === 'session.usage' || method === 'session.stats' || method === 'session.context_breakdown') {
      seen.push([method, params.session_id]);
      if (params.session_id === 'st-main') throw new Error('no window on stored id');
      if (method === 'session.usage') return { context_used: 1000, context_max: 128000 };
      throw new Error('runtime usage should have answered');
    }
    return base(method, params);
  };
  await stageButton(ctx).props.onClick();
  assert.deepEqual(seen[0], ['session.usage', 'st-main']);
  assert.ok(seen.some(([method, id]) => method === 'session.usage' && id === 'rt-main'));
  assert.deepEqual(order.map((step) => step[0]), ['open', 'draft']);
  assert.equal(ctx.chat.$status.get()['st-main'].notice, MERGE_STAGED_TEXT);
  ctx.unload();
});

test('rowText uses trimmed text, then string content, then joined part text', () => {
  assert.equal(rowText({ text: '  hello  ' }), 'hello');
  assert.equal(rowText({ text: '   ', content: ' from content ' }), 'from content');
  assert.equal(rowText({ content: 'plain' }), 'plain');
  assert.equal(rowText({ content: [{ text: 'What is ' }, { type: 'image' }, { text: 'a virtualenv?' }] }), 'What is a virtualenv?');
  assert.equal(rowText({ role: 'assistant' }), '');
  assert.equal(rowText(null), '');
});

// v0.23.0 has session.history and no session.transcript. History is one complete snapshot.
function withHistoryFallback(host, { contentOnly = false } = {}) {
  const base = host.request.bind(host);
  host.request = async (method, params) => {
    if (method === 'session.transcript') {
      host.calls.push([method, params]);
      throw new Error('unknown method: session.transcript');
    }
    if (method === 'session.history') {
      host.calls.push([method, params]);
      const b = host.branches.get(params.session_id);
      const project = (row) => (
        contentOnly
          ? { role: row.role, content: row.text, row_id: row.row_id }
          : { role: row.role, text: row.text, row_id: row.row_id }
      );
      const messages = b.rows.map(project);
      if (b.submitted) {
        b.reads += 1;
        const user = contentOnly
          ? { role: 'user', content: b.question, row_id: 900 }
          : { role: 'user', text: b.question, row_id: 900 };
        const assistant = contentOnly
          ? { role: 'assistant', content: 'history answer', row_id: 901 }
          : { role: 'assistant', text: 'history answer', row_id: 901 };
        if (b.reads >= 1) messages.push(user);
        if (b.reads >= 2) messages.push(assistant);
      }
      return { count: messages.length, messages };
    }
    return base(method, params);
  };
  return host;
}

const historyCalls = (host) => host.calls.filter(([method]) => method === 'session.history').length;

test('session.history answers when session.transcript is unknown', async () => {
  const host = withHistoryFallback(fakeHost());
  const ctx = setup({ host });
  await ask(ctx, 'What is a virtualenv?');
  await ctx.clock.tick(POLL_MS * 3);
  assert.equal(entryOf(ctx).status, 'answered');
  assert.equal(entryOf(ctx).answer, 'history answer');
  assert.ok(historyCalls(host) < 30, `history called ${historyCalls(host)} times`);
  ctx.unload();
});

test('session.history answers from content-only rows', async () => {
  const host = withHistoryFallback(fakeHost(), { contentOnly: true });
  const ctx = setup({ host });
  await ask(ctx, 'What is a virtualenv?');
  await ctx.clock.tick(POLL_MS * 3);
  assert.equal(entryOf(ctx).status, 'answered');
  assert.equal(entryOf(ctx).answer, 'history answer');
  assert.ok(historyCalls(host) < 30, `history called ${historyCalls(host)} times`);
  ctx.unload();
});

test('after a numeric fence, a new user row starts the turn even when its text differs', async () => {
  const script = (n, b, { add }) => {
    if (n === 1) add({ role: 'user', text: 'Explain virtualenv' });
    if (n === 2) add({ role: 'assistant', text: 'renamed-user answer' });
  };
  const ctx = setup({ host: fakeHost({ script }) });
  await ask(ctx, 'What is a virtualenv?');
  assert.equal(Number.isFinite(entryOf(ctx).maxRowId), true);
  await ctx.clock.tick(POLL_MS * 3);
  assert.equal(entryOf(ctx).status, 'answered');
  assert.equal(entryOf(ctx).answer, 'renamed-user answer');
  ctx.unload();
});

test('digest keeps the first side pair when a follow-up turn is already stored', () => {
  const rows = [
    { role: 'user', text: 'Publish Python package to PyPI', row_id: 43 },
    { role: 'assistant', text: 'parent answer', row_id: 44 },
    { role: 'user', text: 'What is a virtualenv?', row_id: 45 },
    { role: 'assistant', text: 'a virtualenv is an isolated environment', row_id: 46 },
    { role: 'user', text: 'How do I make one?', row_id: 47 },
    { role: 'assistant', text: 'follow-up answer', row_id: 48 },
  ];
  assert.equal(
    digestFromRows(rows, 44, { question: 'What is a virtualenv?', answer: 'stored' }),
    DIGEST('What is a virtualenv?', 'a virtualenv is an isolated environment'),
  );
});

test('with no fence, the digest is the side pair that matches the stored question', () => {
  const rows = [
    { role: 'user', text: 'Publish Python package to PyPI', row_id: 43 },
    { role: 'assistant', text: 'parent answer', row_id: 44 },
    { role: 'user', text: 'What is a virtualenv?', row_id: 45 },
    { role: 'assistant', text: 'a virtualenv is an isolated environment', row_id: 46 },
  ];
  assert.equal(rowsAfterFence(rows, null).length, 0);
  assert.equal(
    digestFromRows(rows, null, { question: 'What is a virtualenv?' }),
    DIGEST('What is a virtualenv?', 'a virtualenv is an isolated environment'),
  );
  assert.equal(digestFromRows([], null, { question: 'stored q', answer: '  stored a  ' }), DIGEST('stored q', 'stored a'));
});

function paneInputs(ctx) {
  return findAll(expand(ctx.pane.render()), (n) => n.type === 'Input');
}

test('typing in the side form does not propagate to the parent composer', () => {
  const ctx = setup();
  const tree = expand(ctx.pane.render());
  const inputs = findAll(tree, (n) => n.type === 'Input');
  assert.equal(inputs.length, 3);
  for (const input of inputs) {
    assert.equal(typeof input.props.onKeyDown, 'function');
    assert.equal(typeof input.props.onKeyUp, 'function');
    assert.equal(typeof input.props.onPointerDown, 'function');
    let stopped = 0;
    const event = { key: 'a', stopPropagation: () => { stopped += 1; }, stopImmediatePropagation: () => { stopped += 1; } };
    input.props.onKeyDown(event);
    assert.equal(stopped, 2);
    input.props.onKeyUp(event);
    input.props.onPointerDown(event);
    assert.equal(stopped, 6);
  }
  const wrappers = findAll(tree, (n) => (
    n.type !== 'Input'
    && typeof n.props?.onKeyDown === 'function'
    && typeof n.props?.onKeyUp === 'function'
    && typeof n.props?.onPointerDown === 'function'
  ));
  assert.ok(wrappers.length >= 1);
  let wrapped = 0;
  wrappers[0].props.onKeyDown({ key: 'a', stopPropagation: () => { wrapped += 1; } });
  assert.equal(wrapped, 1);
  assert.equal(methods(ctx.host).includes('session.branch_whole'), false);
});

test('Enter in the question field asks and stops the key', async () => {
  const ctx = setup();
  ctx.chat.$form.set({ question: 'What is a virtualenv?', model: '', provider: '' });
  const [question] = paneInputs(ctx);
  assert.equal(question.props.placeholder, 'Side question');
  let prevented = 0;
  let stopped = 0;
  question.props.onKeyDown({
    key: 'Enter',
    shiftKey: false,
    preventDefault: () => { prevented += 1; },
    stopPropagation: () => { stopped += 1; },
    stopImmediatePropagation: () => { stopped += 1; },
  });
  await flush();
  assert.equal(prevented, 1);
  assert.equal(stopped, 2);
  assert.equal(entryOf(ctx).question, 'What is a virtualenv?');
  ctx.unload();
});

test('asking a side question registers the branch session ids', async () => {
  const host = fakeHost();
  const base = host.request.bind(host);
  host.request = async (method, params) => {
    const result = await base(method, params);
    if (method === 'session.branch_whole') return { ...result, stored_session_id: 'stored-branch-1' };
    return result;
  };
  const ctx = setup({ host });
  await ask(ctx, 'What is a virtualenv?');
  const entry = entryOf(ctx);
  assert.equal(isKnownSideBranch(entry.session_id), true);
  assert.equal(isKnownSideBranch(entry.stored_session_id), true);
  assert.equal(entry.stored_session_id, 'stored-branch-1');
  ctx.unload();
});

test('restoring a stored list registers the branch session ids', () => {
  const storage = syncStorage({
    [listKey('st-main')]: [{
      id: 'b9',
      question: 'q',
      session_id: 'sess-b9',
      stored_session_id: 'stored-b9',
      status: 'answered',
      answer: 'a',
      at: 5,
    }],
  });
  setup({ storage });
  assert.equal(isKnownSideBranch('sess-b9'), true);
  assert.equal(isKnownSideBranch('stored-b9'), true);
  assert.equal(rememberSideBranch('sess-b9'), undefined);
});

test('side cards follow the focused chat and come back with it', async () => {
  const ctx = setup();
  await ask(ctx, 'only on main');
  const shown = () => textOf(expand(ctx.pane.render()));
  assert.match(shown(), /only on main/);
  ctx.host.state.focusedStoredSessionId.set('st-other');
  ctx.host.state.focusedSessionId.set('rt-other');
  await flush();
  assert.doesNotMatch(shown(), /only on main/);
  ctx.host.state.focusedStoredSessionId.set('st-main');
  ctx.host.state.focusedSessionId.set('rt-main');
  await flush();
  assert.match(shown(), /only on main/);
  ctx.unload();
});

// ── Merge modes `unit.merge_modes` ────────────────────────────────────────────────────────────
// The header is always the side question exactly as prompt.submit sent it: the tree links a merge
// by matching it to the side chat's first own user message.

const RECORD = (question, id) => `From side chat: ${question}\n\nSide chat id: ${id}`;
const DIGEST_TEXT = (question, answer) => `From side chat: ${question}\n\n${answer}`;

function entryNode(ctx, id) {
  return findAll(expand(ctx.pane.render()), (n) => n.props?.['data-side-chat'] === id)[0];
}

function modeButtons(ctx, id) {
  return findAll(entryNode(ctx, id), (n) => n.type === 'Button' && typeof n.props?.['data-merge-mode'] === 'string');
}

const pressedModes = (ctx, id) => modeButtons(ctx, id).filter((n) => n.props['aria-pressed'] === true).map((n) => n.props['data-merge-mode']);

function pickMode(ctx, id, mode) {
  modeButtons(ctx, id).find((n) => n.props['data-merge-mode'] === mode).props.onClick();
}

function mergeButtonOf(ctx, id) {
  return findAll(entryNode(ctx, id), (n) => n.type === 'Button' && n.props.children === 'Merge into parent')[0];
}

// Answers every session.transcript read with these rows, and every session.usage with this window.
function withBranchRows(ctx, rows, usage = { context_used: 1000, context_max: 128000 }) {
  const base = ctx.host.request.bind(ctx.host);
  ctx.host.request = async (method, params) => {
    if (method === 'session.transcript') {
      ctx.host.calls.push([method, params]);
      return { rows, next_cursor: null };
    }
    if (method === 'session.usage') {
      ctx.host.calls.push([method, params]);
      return usage;
    }
    return base(method, params);
  };
}

async function answered(ctx, question) {
  await ask(ctx, question);
  await ctx.clock.tick(POLL_MS * 3);
  assert.equal(entryOf(ctx).status, 'answered');
  return entryOf(ctx);
}

test('the three merge modes, Full text by default, each text starting with the side question header', () => {
  assert.deepEqual(sideChat.MERGE_MODES.map((m) => [m.id, m.label]), [
    ['full', 'Full text'],
    ['record', 'Merge record'],
    ['digest', 'Digest'],
  ]);
  assert.equal(sideChat.DEFAULT_MERGE_MODE, 'full');
  assert.equal(sideChat.mergeModeOf('digest'), 'digest');
  assert.equal(sideChat.mergeModeOf('nope'), 'full');
  assert.equal(sideChat.mergeModeOf(undefined), 'full');
  assert.equal(sideChat.mergeModeLabel('record'), 'Merge record');
  assert.equal(sideChat.mergeModeLabel(null), 'Full text');
  assert.equal(sideChat.mergeHeader('  what is a monad?  '), 'From side chat: what is a monad?');
  assert.equal(sideChat.mergeHeader('   '), 'From side chat: Side chat');

  const parts = {
    question: '  what is a monad?  ',
    sideId: 'side-1',
    turns: [{ question: 'q1', answer: 'a1a\na1b' }, { question: 'q2', answer: 'a2' }],
    answer: '  a1b  ',
  };
  assert.equal(sideChat.formatMergeText('full', parts), VERBATIM('what is a monad?', [['q1', 'a1a\na1b'], ['q2', 'a2']]));
  assert.equal(sideChat.formatMergeText('full', parts), sideChat.formatSideVerbatim(parts.question, parts.turns));
  assert.equal(sideChat.formatMergeText('record', parts), RECORD('what is a monad?', 'side-1'));
  assert.equal(sideChat.formatSideRecord(' t ', ' id-9 '), RECORD('t', 'id-9'));
  // Digest: the header already holds the question, so the body is the final answer only.
  assert.equal(sideChat.formatMergeText('digest', parts), DIGEST_TEXT('what is a monad?', 'a1b'));
  assert.equal(sideChat.formatSideDigestText(' q ', ' a '), DIGEST_TEXT('q', 'a'));
  assert.equal(sideChat.formatMergeText(undefined, parts), sideChat.formatMergeText('full', parts));
  for (const mode of ['full', 'record', 'digest']) {
    const lines = sideChat.formatMergeText(mode, parts).split('\n');
    assert.equal(lines[0], 'From side chat: what is a monad?', mode);
    assert.equal(lines[1], '', mode);
    assert.equal(sideChat.formatMergeText(mode, { ...parts, question: '' }).split('\n')[0], 'From side chat: Side chat', mode);
  }
  // The old digest format is unchanged.
  assert.equal(sideChat.formatSideDigest('q', 'a'), DIGEST('q', 'a'));
});

test('digestTurn is the question and final answer that digestFromRows formats', () => {
  const rows = [
    { role: 'user', text: 'parent q', row_id: 43 },
    { role: 'assistant', text: 'parent a', row_id: 44 },
    { role: 'user', text: 'side q', row_id: 45 },
    { role: 'assistant', text: 'Let me check.', row_id: 46 },
    { role: 'tool', text: 'hit', row_id: 47 },
    { role: 'assistant', text: 'final side a', row_id: 48 },
    { role: 'user', text: 'follow-up', row_id: 49 },
    { role: 'assistant', text: 'follow-up a', row_id: 50 },
  ];
  const fallback = { question: 'stored q', answer: 'stored a' };
  assert.deepEqual(sideChat.digestTurn(rows, 44, fallback), { question: 'side q', answer: 'final side a' });
  assert.equal(digestFromRows(rows, 44, fallback), DIGEST('side q', 'final side a'));
  assert.deepEqual(sideChat.digestTurn(rows, null, { question: 'side q' }), { question: 'side q', answer: 'final side a' });
  assert.deepEqual(sideChat.digestTurn(null, 44, fallback), { question: 'stored q', answer: 'stored a' });
  assert.deepEqual(sideChat.digestTurn([], null, fallback), { question: 'stored q', answer: 'stored a' });
});

test('stripConceptMarkup: a termline becomes its v sentence, unescaped, with inline markdown kept', () => {
  const strip = sideChat.stripConceptMarkup;
  assert.equal(
    strip('::termline{v="In Haskell, a **monad** sequences `IO` effects." t="monad=A pattern;;IO=Input and output"}'),
    'In Haskell, a **monad** sequences `IO` effects.',
  );
  // Escaped quotes inside a double-quoted or single-quoted value.
  assert.equal(strip('::termline{v="She said \\"monad\\" twice." t="monad=it\\"s a pattern"}'), 'She said "monad" twice.');
  assert.equal(strip("::termline{v='It\\'s a \"monad\".' t='monad=x'}"), 'It\'s a "monad".');
  // The host's markdown escapes are undone; a `}` or `;;` inside a quoted value does not end it.
  assert.equal(strip('::termline{v="Use \\*stars\\* and {braces}." t="a=b\;\;c;;d=e\\\\"}'), 'Use *stars* and {braces}.');
  // Legacy markers inside v become their names, as the termline renderer shows them.
  assert.equal(strip('::termline{v="A [[monoid|combines values]] folds a list; a \\[\\[functor\\]\\] maps it."}'), 'A monoid folds a list; a functor maps it.');
  // The legacy text attribute, and a termline with no sentence.
  assert.equal(strip('::termline{text="Old form." t="x=y"}'), 'Old form.');
  assert.equal(strip('before\n\n::termline{t="x=y"}\n\nafter'), 'before\n\n\n\nafter');
});

test('stripConceptMarkup: several termlines, ::term and [[name|def]] in one text', () => {
  const strip = sideChat.stripConceptMarkup;
  const text = [
    'Assistant:',
    '::termline{v="A **monad** sequences effects." t="monad=A design pattern"}',
    '',
    "::termline{v='An idempotent call is safe to retry.' t='idempotent=Same effect when repeated'}",
    '',
    'A ::term{name="functor" def="maps over a value"} and a ::term{name=unit def=wraps} and [[bind|chains steps]].',
  ].join('\n');
  assert.equal(strip(text), [
    'Assistant:',
    'A **monad** sequences effects.',
    '',
    'An idempotent call is safe to retry.',
    '',
    'A functor and a unit and bind.',
  ].join('\n'));
});

test('stripConceptMarkup: code, wiki links, and markup that does not parse stay as written', () => {
  const strip = sideChat.stripConceptMarkup;
  const fenced = [
    'Write it like this:',
    '```markdown',
    '::termline{v="A monad." t="monad=x"}',
    'A [[monoid|combines]] marker.',
    '```',
    '::termline{v="Outside the fence." t="a=b"}',
  ].join('\n');
  assert.equal(strip(fenced), fenced.replace('::termline{v="Outside the fence." t="a=b"}', 'Outside the fence.'));
  assert.equal(strip('~~~~\n::term{name=x}\n~~~\nstill code\n~~~~\n[[a|b]]'), '~~~~\n::term{name=x}\n~~~\nstill code\n~~~~\na');
  assert.equal(strip('Run `[[ -f x || -d y ]]` or ``::termline{v="x"}`` and [[a|b]].'), 'Run `[[ -f x || -d y ]]` or ``::termline{v="x"}`` and a.');
  // Outside a termline only [[name|def]] (with a pipe) is markup.
  assert.equal(strip('See [[Monad laws]] and [[ | empty]].'), 'See [[Monad laws]] and [[ | empty]].');
  // A directive that does not parse is left alone.
  assert.equal(strip('::termline{v="unclosed'), '::termline{v="unclosed');
  assert.equal(strip('::termline{v="a" t="b"'), '::termline{v="a" t="b"');
  assert.equal(strip('::term{def="no name"} stays'), '::term{def="no name"} stays');
  assert.equal(strip('a `lone backtick ::term{name=x} here'), 'a `lone backtick x here');
  assert.equal(strip(''), '');
  assert.equal(strip(undefined), '');
  assert.equal(strip('plain text\r\nwith CRLF'), 'plain text\r\nwith CRLF');
});

test('markup removal leaves the header line exactly as the side question', () => {
  const question = 'why [[monad|x]] and ::term{name=y}?';
  for (const mode of ['full', 'record', 'digest']) {
    const text = sideChat.formatMergeText(mode, {
      question,
      sideId: 's',
      turns: [{ question: 'q [[a|b]]', answer: '::termline{v="Plain." t="p=q"}' }],
      answer: '::termline{v="Plain." t="p=q"}',
    });
    assert.equal(text.split('\n')[0], `From side chat: ${question}`, mode);
    assert.equal(text.slice(text.indexOf('\n')).includes('::termline'), false, mode);
  }
  assert.equal(
    sideChat.formatMergeText('full', { question, turns: [{ question: 'q [[a|b]]', answer: '::termline{v="Plain." t="p=q"}' }] }),
    VERBATIM(question, [['q a', 'Plain.']]),
  );
});

test('each answered side chat has a mode picker; Full text is the default and a pick is kept per side chat', async () => {
  const ctx = setup();
  const first = await answered(ctx, 'first');
  const second = await answered(ctx, 'second');
  const labels = modeButtons(ctx, first.id).map((n) => n.props.children);
  assert.deepEqual(labels, ['Full text', 'Merge record', 'Digest']);
  assert.deepEqual(pressedModes(ctx, first.id), ['full']);
  assert.deepEqual(pressedModes(ctx, second.id), ['full']);

  pickMode(ctx, first.id, 'digest');
  assert.deepEqual(pressedModes(ctx, first.id), ['digest']);
  assert.deepEqual(pressedModes(ctx, second.id), ['full']);

  // A third question polls and re-renders the pane; the pick stays.
  await answered(ctx, 'third');
  assert.deepEqual(pressedModes(ctx, first.id), ['digest']);
  // Focus away and back.
  ctx.host.state.focusedStoredSessionId.set('st-other');
  ctx.host.state.focusedSessionId.set('rt-other');
  await flush();
  assert.equal(entryNode(ctx, first.id), undefined);
  ctx.host.state.focusedStoredSessionId.set('st-main');
  ctx.host.state.focusedSessionId.set('rt-main');
  await flush();
  assert.deepEqual(pressedModes(ctx, first.id), ['digest']);
  // While the pane runs only: the pick is not stored.
  assert.equal(JSON.stringify(ctx.storage.data).includes('digest'), false);
  ctx.unload();
});

test('an entry with no answer has no mode picker', async () => {
  const ctx = setup({ host: fakeHost({ script: () => {} }) });
  await ask(ctx, 'q');
  assert.ok(entryNode(ctx, entryOf(ctx).id));
  assert.equal(modeButtons(ctx, entryOf(ctx).id).length, 0);
  ctx.unload();
});

test('Full text is staged when no mode was picked', async () => {
  const ctx = setup();
  const order = withComposer(ctx, () => true);
  const entry = await answered(ctx, 'q');
  await mergeButtonOf(ctx, entry.id).props.onClick();
  assert.equal(order[1][2], VERBATIM('q', [['q', 'side answer']]));
  ctx.unload();
});

test('Merge record stages the header and the side chat id only, after the fit check, with no side read', async () => {
  const ctx = setup();
  const order = withComposer(ctx, () => true);
  const entry = await answered(ctx, 'what is a monad?');
  pickMode(ctx, entry.id, 'record');
  const before = ctx.host.calls.length;
  await mergeButtonOf(ctx, entry.id).props.onClick();
  assert.deepEqual(order.map((step) => step[0]), ['open', 'draft']);
  assert.deepEqual(order[0], ['open', 'st-main', { intent: 'in-place' }]);
  assert.equal(order[1][2], RECORD('what is a monad?', 'branch-1'));
  const after = ctx.host.calls.slice(before).map(([method]) => method);
  assert.equal(after.includes('session.transcript'), false);
  assert.ok(after.includes('session.usage'));
  assert.equal(order.some((step) => step[0] === 'submit'), false);
  assert.equal(ctx.chat.$status.get()['st-main'].notice, MERGE_STAGED_TEXT);
  ctx.unload();
});

test('Digest stages the side question header and the final answer only, and calls no model', async () => {
  const ctx = setup();
  const order = withComposer(ctx, () => true);
  const entry = await answered(ctx, 'seed question');
  const fence = entry.maxRowId;
  // Hermes may store the user row with other text; the header still is the text side-chat sent.
  withBranchRows(ctx, [
    { role: 'user', text: 'main question', row_id: fence - 1 },
    { role: 'assistant', text: 'main answer', row_id: fence },
    { role: 'user', text: 'seed question (stored)', row_id: fence + 1 },
    { role: 'assistant', text: 'Let me check.', row_id: fence + 2 },
    { role: 'tool', text: 'search hit', row_id: fence + 3 },
    { role: 'assistant', text: 'final side a', row_id: fence + 4 },
    { role: 'user', text: 'follow-up q', row_id: fence + 5 },
    { role: 'assistant', text: 'follow-up a', row_id: fence + 6 },
  ]);
  pickMode(ctx, entry.id, 'digest');
  const submits = () => methods(ctx.host).filter((m) => m === 'prompt.submit').length;
  const before = submits();
  await mergeButtonOf(ctx, entry.id).props.onClick();
  assert.equal(order[1][2], DIGEST_TEXT('seed question', 'final side a'));
  assert.equal(submits(), before);
  assert.equal(order.some((step) => step[0] === 'submit'), false);
  ctx.unload();
});

test('Digest falls back to the stored answer when the side read fails', async () => {
  const ctx = setup();
  const order = withComposer(ctx, () => true);
  const entry = await answered(ctx, 'stored question');
  const base = ctx.host.request.bind(ctx.host);
  ctx.host.request = async (method, params) => {
    if (method === 'session.transcript') throw new Error('transcript down');
    return base(method, params);
  };
  pickMode(ctx, entry.id, 'digest');
  await mergeButtonOf(ctx, entry.id).props.onClick();
  assert.equal(order[1][2], DIGEST_TEXT('stored question', 'side answer'));
  ctx.unload();
});

test('concept-link markup is removed from every mode before the fit check', async () => {
  const longDef = 'x'.repeat(4000);
  const answer = `::termline{v="A **monad** sequences effects." t="monad=${longDef}"}\n\nUse [[bind|chains steps]] and ::term{name="unit" def="${longDef}"} here.`;
  const plain = 'A **monad** sequences effects.\n\nUse bind and unit here.';
  const cases = [
    ['full', (question) => VERBATIM(question, [[question, plain]])],
    ['digest', (question) => DIGEST_TEXT(question, plain)],
  ];
  for (const [mode, expected] of cases) {
    const ctx = setup();
    const order = withComposer(ctx, () => true);
    const entry = await answered(ctx, 'what is a monad?');
    const clean = expected('what is a monad?');
    // Room for the clean text only: the raw text, with two long definitions, would not fit.
    const available = roughTokens(clean) + 5;
    withBranchRows(
      ctx,
      [
        { role: 'user', text: 'what is a monad?', row_id: entry.maxRowId + 1 },
        { role: 'assistant', text: answer, row_id: entry.maxRowId + 2 },
      ],
      { context_used: 128000 - available, context_max: 128000 },
    );
    pickMode(ctx, entry.id, mode);
    await mergeButtonOf(ctx, entry.id).props.onClick();
    assert.deepEqual(order.map((step) => step[0]), ['open', 'draft'], mode);
    assert.equal(order[1][2], clean, mode);
    assert.equal(ctx.chat.$status.get()['st-main'].heldNotice ?? null, null, mode);
    ctx.unload();
  }
});

test('every mode goes through the fit check: a no-fit names the mode and the numbers, and stages nothing', async () => {
  const cases = [
    ['full', 'Full text', VERBATIM('q', [['q', 'side answer']])],
    ['record', 'Merge record', RECORD('q', 'branch-1')],
    ['digest', 'Digest', DIGEST_TEXT('q', 'side answer')],
  ];
  for (const [mode, label, text] of cases) {
    const ctx = setup();
    const order = withComposer(ctx, () => true);
    const entry = await answered(ctx, 'q');
    const opened = ctx.host.opened.length;
    const base = ctx.host.request.bind(ctx.host);
    ctx.host.request = async (method, params) => {
      if (method === 'session.usage') return { context_used: 127998, context_max: 128000 };
      return base(method, params);
    };
    pickMode(ctx, entry.id, mode);
    await assert.doesNotReject(() => mergeButtonOf(ctx, entry.id).props.onClick());
    assert.deepEqual(order, [], mode);
    assert.equal(ctx.host.opened.length, opened, mode);
    assert.equal(
      ctx.chat.$status.get()['st-main'].heldNotice,
      `Doesn't fit (${label}): side chat is ${commas(roughTokens(text))} tokens (estimated), parent has 2 available (127,998 used of 128,000).`,
    );
    ctx.unload();
  }
});

test('a no-fit notice stays through polls, a new question, focus changes and a later merge, until Dismiss', async () => {
  const ctx = setup();
  const order = withComposer(ctx, () => true);
  await answered(ctx, 'q');
  let tight = true;
  const base = ctx.host.request.bind(ctx.host);
  ctx.host.request = async (method, params) => {
    if (method === 'session.usage') return { context_used: tight ? 127990 : 1000, context_max: 128000 };
    return base(method, params);
  };
  await stageButton(ctx).props.onClick();
  assert.deepEqual(order, []);
  const heldShown = () => findAll(expand(ctx.pane.render()), (n) => (
    n.type === 'p' && typeof n.props.children === 'string' && n.props.children.startsWith("Doesn't fit")
  ));
  assert.equal(heldShown().length, 1);
  assert.equal(heldShown()[0].props.style.userSelect, 'text');
  assert.equal(heldShown()[0].props['data-selectable-text'], 'true');

  // A new question forks and polls: the pane re-renders on each tick, and ask() resets its own notice.
  await ask(ctx, 'next');
  assert.equal(heldShown().length, 1);
  await ctx.clock.tick(POLL_MS * 3);
  assert.equal(entryOf(ctx).status, 'answered');
  assert.equal(heldShown().length, 1);
  // Focus away and back.
  ctx.host.state.focusedStoredSessionId.set('st-other');
  ctx.host.state.focusedSessionId.set('rt-other');
  await flush();
  assert.equal(heldShown().length, 0);
  ctx.host.state.focusedStoredSessionId.set('st-main');
  ctx.host.state.focusedSessionId.set('rt-main');
  await flush();
  assert.equal(heldShown().length, 1);
  // A later merge that fits stages its draft; the held notice stays.
  tight = false;
  await stageButton(ctx).props.onClick();
  assert.deepEqual(order.map((step) => step[0]), ['open', 'draft']);
  assert.equal(ctx.chat.$status.get()['st-main'].notice, MERGE_STAGED_TEXT);
  assert.equal(heldShown().length, 1);

  const dismiss = findAll(expand(ctx.pane.render()), (n) => n.type === 'Button' && n.props.children === 'Dismiss');
  assert.equal(dismiss.length, 1);
  dismiss[0].props.onClick();
  assert.equal(heldShown().length, 0);
  assert.equal(findAll(expand(ctx.pane.render()), (n) => n.type === 'Button' && n.props.children === 'Dismiss').length, 0);
  assert.equal(ctx.chat.$status.get()['st-main'].notice, MERGE_STAGED_TEXT);
  ctx.unload();
});
