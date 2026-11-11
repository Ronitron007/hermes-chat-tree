import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSideChat,
  BUSY_TEXT,
  TIMEOUT_TEXT,
  TIMEOUT_MS,
  POLL_MS,
  MAX_ENTRIES,
  MODEL_KEY,
  listKey,
  branchName,
} from '../src/side-chat.js';

const el = (type, props, key) => ({ type, props, key });

function atom(initial) {
  let value = initial;
  return { get: () => value, set: (next) => void (value = next) };
}

function memoryStorage(seed = {}) {
  const data = { ...seed };
  return { data, get: async (k) => data[k], set: async (k, v) => void (data[k] = v) };
}

// Fake timers and clock: run() fires due timers in order, advancing now().
function fakeClock() {
  let t = 1_000_000;
  let id = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimeout: (fn, ms) => (timers.set(++id, { at: t + ms, fn }), id),
    clearTimeout: (i) => void timers.delete(i),
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
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

const copied = [
  { role: 'user', text: 'main question', row_id: 1 },
  { role: 'assistant', text: 'main answer', row_id: 2 },
];

// A fake gateway. The branch transcript is the copied rows, then the question and the answer
// appear after `answerAfter` transcript reads.
function fakeHost({ focused = 'main-1', branchError, answerAfter = 2, answer = 'side answer', submitError } = {}) {
  const calls = [];
  let branches = 0;
  let reads = 0;
  const opened = [];
  const state = { focusedSessionId: atom(focused), activeSessionId: atom(null) };
  const host = {
    state,
    calls,
    opened,
    openSession: async (id, opts) => void opened.push([id, opts]),
    revealPane: () => {},
    async request(method, params) {
      calls.push([method, params]);
      if (method === 'session.branch_whole') {
        if (branchError) throw branchError;
        branches += 1;
        return { session_id: `branch-${branches}`, stored_session_id: `stored-${branches}`, title: params.name };
      }
      if (method === 'prompt.submit') {
        if (submitError) throw submitError;
        return { status: 'queued', session_id: params.session_id, admission_id: 'a1' };
      }
      if (method === 'session.transcript') {
        reads += 1;
        const question = calls.find(([m]) => m === 'prompt.submit')?.[1]?.text;
        if (!params.cursor) {
          const rows = [...copied];
          if (reads >= answerAfter) rows.push({ role: 'user', text: question, row_id: 3 });
          return { session_id: params.session_id, rows, next_cursor: 'c1', reset: false };
        }
        if (reads >= answerAfter && answer !== null) {
          return {
            session_id: params.session_id,
            rows: [
              { role: 'user', text: question, row_id: 3 },
              { role: 'assistant', text: answer, row_id: 4 },
            ],
            next_cursor: 'c2',
            reset: false,
          };
        }
        return { session_id: params.session_id, rows: [], next_cursor: params.cursor, reset: false };
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  return host;
}

function setup({ host = fakeHost(), storage = memoryStorage(), clock = fakeClock(), useValue } = {}) {
  const registered = [];
  const chat = createSideChat({
    host,
    jsx: el,
    jsxs: el,
    atom,
    useValue: useValue ?? ((a) => a.get()),
    Button: 'Button',
    Input: 'Input',
    ScrollArea: 'ScrollArea',
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
  });
  chat.register({ register: (c) => registered.push(c), storage });
  return { chat, host, storage, clock, registered, pane: registered.find((c) => c.area === 'panes') };
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

async function ask(ctx, question, { model = '', provider = '' } = {}) {
  ctx.chat.$form.set({ question, model, provider });
  await ctx.chat.ask('main-1');
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
  const [branchCall, submitCall] = ctx.host.calls;
  assert.deepEqual(branchCall[0], 'session.branch_whole');
  assert.equal(branchCall[1].session_id, 'main-1');
  assert.equal(branchCall[1].name, 'Side: what is a monad?');
  assert.ok(branchCall[1].idempotency_key);
  assert.deepEqual(submitCall, ['prompt.submit', { session_id: 'branch-1', text: 'what is a monad?' }]);
  assert.equal(ctx.host.calls[2][0], 'session.transcript');
  assert.equal(ctx.host.calls[2][1].order, 'oldest');
  assert.equal(ctx.host.calls[2][1].session_id, 'branch-1');

  // The copied rows hold an old answer; it must not count.
  assert.equal(ctx.chat.$lists.get()['main-1'][0].status, 'asking');
  await ctx.clock.tick(POLL_MS);
  const entry = ctx.chat.$lists.get()['main-1'][0];
  assert.equal(entry.status, 'answered');
  assert.equal(entry.answer, 'side answer');
  // The second read passes the cursor of the first page.
  assert.equal(ctx.host.calls[3][1].cursor, 'c1');
  assert.ok(!ctx.host.calls.some(([m, p]) => m === 'prompt.submit' && p.session_id === 'main-1'));
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
  const entry = ctx.chat.$lists.get()['main-1'][0];
  assert.equal(entry.model, 'gpt-5.6-luna');
  assert.equal(entry.provider, 'openai-codex');
});

test('a model with no provider sends only the model', async () => {
  const ctx = setup();
  await ask(ctx, 'q', { model: 'm1' });
  const submit = ctx.host.calls.find(([m]) => m === 'prompt.submit')[1];
  assert.deepEqual(submit.model_override, { model: 'm1' });
});

test('a busy error shows the busy message and sends no prompt.submit', async () => {
  const error = Object.assign(new Error('session busy'), { code: 4009 });
  const ctx = setup({ host: fakeHost({ branchError: error }) });
  await ask(ctx, 'q');
  assert.deepEqual(methods(ctx.host), ['session.branch_whole']);
  assert.equal(ctx.chat.$notices.get()['main-1'], BUSY_TEXT);
  assert.match(textOf(expand(ctx.pane.render())), /The main chat is busy/);
  assert.equal(ctx.chat.$lists.get()['main-1'], undefined);
});

test('another fork error shows its own text', async () => {
  const ctx = setup({ host: fakeHost({ branchError: new Error('nothing to branch — send a message first') }) });
  await ask(ctx, 'q');
  assert.deepEqual(methods(ctx.host), ['session.branch_whole']);
  assert.match(ctx.chat.$notices.get()['main-1'], /nothing to branch/);
});

test('a submit error marks the entry and stops', async () => {
  const ctx = setup({ host: fakeHost({ submitError: new Error('bad model') }) });
  await ask(ctx, 'q', { model: 'nope' });
  const entry = ctx.chat.$lists.get()['main-1'][0];
  assert.equal(entry.status, 'error');
  assert.match(entry.error, /bad model/);
  assert.ok(!methods(ctx.host).includes('session.transcript'));
});

test('the poll stops at the answer', async () => {
  const ctx = setup();
  await ask(ctx, 'q');
  await ctx.clock.tick(POLL_MS);
  const reads = methods(ctx.host).filter((m) => m === 'session.transcript').length;
  assert.equal(ctx.clock.pending(), 0);
  await ctx.clock.tick(POLL_MS * 10);
  assert.equal(methods(ctx.host).filter((m) => m === 'session.transcript').length, reads);
});

test('the poll stops at the timeout with the timeout message', async () => {
  const ctx = setup({ host: fakeHost({ answer: null, answerAfter: Infinity }) });
  await ask(ctx, 'q');
  await ctx.clock.tick(TIMEOUT_MS - POLL_MS);
  assert.equal(ctx.chat.$lists.get()['main-1'][0].status, 'asking');
  await ctx.clock.tick(POLL_MS * 2);
  assert.equal(ctx.chat.$lists.get()['main-1'][0].status, 'timeout');
  assert.equal(ctx.clock.pending(), 0);
  const reads = methods(ctx.host).filter((m) => m === 'session.transcript').length;
  assert.ok(reads > 100 && reads <= TIMEOUT_MS / POLL_MS + 1, `reads ${reads}`);
  assert.match(textOf(expand(ctx.pane.render())), new RegExp(TIMEOUT_TEXT.replace('.', '\\.')));
});

test('reset restarts the read and drops the question seen before it', async () => {
  const host = fakeHost();
  let n = 0;
  const base = host.request;
  host.request = async (method, params) => {
    if (method !== 'session.transcript') return base.call(host, method, params);
    host.calls.push([method, params]);
    n += 1;
    if (n === 1) return { rows: [{ role: 'user', text: 'q' }], next_cursor: 'c1', reset: false };
    // A rewind replaced the rows: the old question is gone, then an assistant row with no question before it.
    if (n === 2) return { rows: [...copied], next_cursor: 'r1', reset: true };
    return { rows: [{ role: 'user', text: 'q' }, { role: 'assistant', text: 'after reset' }], next_cursor: 'r2', reset: false };
  };
  const ctx = setup({ host });
  await ask(ctx, 'q');
  await ctx.clock.tick(POLL_MS);
  assert.equal(ctx.chat.$lists.get()['main-1'][0].status, 'asking');
  await ctx.clock.tick(POLL_MS);
  assert.equal(ctx.chat.$lists.get()['main-1'][0].answer, 'after reset');
  const cursors = host.calls.filter(([m]) => m === 'session.transcript').map(([, p]) => p.cursor);
  assert.deepEqual(cursors, [undefined, 'c1', 'r1']);
});

test('lists are separate per main chat and keep 50 entries at most', async () => {
  const ctx = setup();
  for (let i = 0; i < MAX_ENTRIES + 5; i++) await ask(ctx, `q${i}`);
  ctx.host.state.focusedSessionId.set('main-2');
  ctx.chat.$form.set({ question: 'other', model: '', provider: '' });
  await ctx.chat.ask('main-2');
  await flush();
  const lists = ctx.chat.$lists.get();
  assert.equal(lists['main-1'].length, MAX_ENTRIES);
  assert.equal(lists['main-1'][0].question, `q${MAX_ENTRIES + 4}`);
  assert.equal(lists['main-2'].length, 1);
  assert.equal(lists['main-2'][0].question, 'other');
  assert.equal(ctx.storage.data[listKey('main-1')].length, MAX_ENTRIES);
  assert.equal(ctx.storage.data[listKey('main-2')].length, 1);
  ctx.chat.dispose();
});

test('the pane shows only the list of the focused chat and loads it from storage', async () => {
  const stored = [{ id: 'b9', question: 'old q', session_id: 'b9', stored_session_id: 's9', status: 'answered', answer: 'old a', at: 5 }];
  const storage = memoryStorage({ [listKey('main-1')]: stored, [listKey('main-2')]: [{ ...stored[0], id: 'x', question: 'other chat q' }] });
  const ctx = setup({ storage });
  ctx.pane.render();
  await flush();
  const text = textOf(expand(ctx.pane.render()));
  assert.match(text, /old q/);
  assert.match(text, /old a/);
  assert.doesNotMatch(text, /other chat q/);
});

test('a stored entry left asking with no live poll reads as timed out', async () => {
  const stored = [{ id: 'b1', question: 'q', session_id: 'b1', stored_session_id: 's1', status: 'asking', at: 5 }];
  const ctx = setup({ storage: memoryStorage({ [listKey('main-1')]: stored }) });
  ctx.pane.render();
  await flush();
  assert.equal(ctx.chat.$lists.get()['main-1'][0].status, 'timeout');
});

test('Open calls host.openSession with the stored id and intent tab', async () => {
  const ctx = setup();
  await ask(ctx, 'q');
  const tree = expand(ctx.pane.render());
  const open = findAll(tree, (n) => n.type === 'Button' && n.props.children === 'Open')[0];
  open.props.onClick();
  await flush();
  assert.deepEqual(ctx.host.opened, [['stored-1', { intent: 'tab' }]]);
  ctx.chat.dispose();
});

test('model settings persist under sideChat:model and load on register', async () => {
  const storage = memoryStorage({ [MODEL_KEY]: { model: 'm', provider: 'p' } });
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
  const root = tree.props.children;
  assert.equal(root.props.style.userSelect, 'text');
  const rows = findAll(tree, (n) => n.type === 'pre');
  assert.ok(rows.length > 0);
  for (const row of rows) assert.equal(row.props.style.userSelect, 'text');
  ctx.chat.dispose();
});

test('each render calls the same hooks in the same order (React error 300)', async () => {
  const log = [];
  const useValue = (a) => {
    log.push(a);
    return a.get();
  };
  const host = fakeHost({ focused: null });
  const ctx = setup({ host, useValue });
  const order = () => {
    log.length = 0;
    // Expanding calls every component, so a hook hidden in EntryRow would show up here too.
    expand(ctx.pane.render());
    return [...log];
  };
  const states = [];
  states.push(order()); // no chat
  host.state.focusedSessionId.set('main-1');
  states.push(order()); // empty list
  await ask(ctx, 'q');
  states.push(order()); // one entry, asking
  await ctx.clock.tick(POLL_MS);
  states.push(order()); // answered
  ctx.chat.$notices.set({ 'main-1': BUSY_TEXT });
  states.push(order()); // with a notice
  for (let i = 0; i < 3; i++) await ask(ctx, `more ${i}`);
  states.push(order()); // several entries
  for (const s of states) {
    assert.equal(s.length, 5);
    assert.deepEqual(s, states[0]);
  }
  ctx.chat.dispose();
});
