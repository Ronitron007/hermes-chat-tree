// Side chat pane: asks a side question in a fork of the focused chat, on the side model,
// and shows the answer here. The main chat gets no new message.
// Plain ESM with no imports: the SDK pieces, timers and clock are injected so it runs under node --test.
// Spec: docs/research/2026-11-11-chat-tree/spec-side-chat.md

export const PLUGIN_ID = 'side-chat';
export const PANE_ID = 'pane';
export const POLL_MS = 1500;
export const TIMEOUT_MS = 180_000;
export const MAX_ENTRIES = 50;
export const PAGE_LIMIT = 200;
export const MODEL_KEY = 'sideChat:model';
export const BUSY_TEXT = 'The main chat is busy. Ask again when the run ends.';
export const TIMEOUT_TEXT = 'No answer yet. Open the branch to see it.';

export const listKey = (mainId) => `sideChat:${mainId}`;
export const branchName = (question) => `Side: ${question.slice(0, 50)}`;

// Pane text must be copyable; the spike log was not.
const SELECTABLE = { userSelect: 'text', WebkitUserSelect: 'text' };
const PRE_STYLE = { ...SELECTABLE, whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, font: 'inherit' };

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const isThenable = (v) => v != null && typeof v.then === 'function';
const errorText = (error) => str(error?.message) || str(error) || 'Unknown error';
// The gateway refuses a fork during a run with code 4009, "session busy" (tui_gateway/methods_session.py).
const isBusy = (error) => error?.code === 4009 || /\bbusy\b/i.test(errorText(error));

export function createSideChat(deps) {
  const { host, jsx, jsxs, atom, useValue, Button, Input, ScrollArea } = deps;
  const setTimer = deps.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
  const clearTimer = deps.clearTimeout ?? ((id) => globalThis.clearTimeout(id));
  const now = deps.now ?? (() => Date.now());

  // main session id -> entries, newest first.
  const $lists = atom({});
  const $form = atom({ question: '', model: '', provider: '' });
  // main session id -> notice text (busy, fork error, empty question).
  const $notices = atom({});
  // Stand-in so the pane calls useValue the same number of times when host.state lacks an atom.
  const $none = atom(null);

  let storage = null;
  let seq = 0;
  const loaded = new Set();
  const polls = new Map(); // entry id -> timer id

  const write = (key, value) => {
    try {
      const pending = storage?.set?.(key, value);
      if (isThenable(pending)) pending.then(null, () => {});
    } catch {
      // Storage is best effort; the pane still works for this session.
    }
  };

  // Storage may be sync or promise-based; handle both (as src/plugin-factory.js does).
  const read = (key, apply) => {
    if (!storage) return apply(undefined);
    let value;
    try {
      value = storage.get(key);
    } catch {
      return apply(undefined);
    }
    if (isThenable(value)) value.then(apply, () => apply(undefined));
    else apply(value);
  };

  const setNotice = (mainId, text) => $notices.set({ ...$notices.get(), [mainId ?? '']: text || null });

  function setList(mainId, list) {
    const next = list.slice(0, MAX_ENTRIES);
    $lists.set({ ...$lists.get(), [mainId]: next });
    write(listKey(mainId), next);
  }

  function addEntry(mainId, entry) {
    setList(mainId, [entry, ...($lists.get()[mainId] ?? [])]);
  }

  function updateEntry(mainId, id, patch) {
    const list = $lists.get()[mainId] ?? [];
    setList(mainId, list.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  }

  // Loads the stored list once per main chat. Entries added before the read lands are kept:
  // the merge puts them first, so a slow read cannot drop a new question.
  function loadList(mainId) {
    if (!mainId || loaded.has(mainId)) return;
    loaded.add(mainId);
    read(listKey(mainId), (stored) => {
      const current = $lists.get()[mainId] ?? [];
      const ids = new Set(current.map((e) => e.id));
      // An entry still "asking" with no live poll lost its poll to a reload.
      const restored = (Array.isArray(stored) ? stored : [])
        .filter((e) => e && typeof e === 'object' && !ids.has(e.id))
        .map((e) => (e.status === 'asking' && !polls.has(e.id) ? { ...e, status: 'timeout' } : e));
      const merged = [...current, ...restored].sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, MAX_ENTRIES);
      $lists.set({ ...$lists.get(), [mainId]: merged });
      if (current.length) write(listKey(mainId), merged);
    });
  }

  // Reads the branch transcript (oldest first) from the last cursor until an assistant row with
  // text follows the question. The question row is the last user row whose text equals it.
  function poll(mainId, entry) {
    const started = now();
    let cursor = null;
    let questionSeen = false;

    const finish = (patch) => {
      polls.delete(entry.id);
      updateEntry(mainId, entry.id, patch);
    };

    // dispose() empties polls; a step that wakes after it stops.
    const live = () => polls.has(entry.id);

    const step = async () => {
      if (!live()) return;
      if (now() - started >= TIMEOUT_MS) return finish({ status: 'timeout' });
      let page = null;
      try {
        const params = { session_id: entry.session_id, order: 'oldest', limit: PAGE_LIMIT };
        if (cursor) params.cursor = cursor;
        page = await host.request('session.transcript', params);
      } catch {
        // A failed read is retried on the next tick until the timeout.
      }
      if (!live()) return;
      const rows = Array.isArray(page?.rows) ? page.rows : [];
      if (page) {
        // reset: the reply is the first page again and replaces what was read.
        if (page.reset) questionSeen = false;
        for (const row of rows) {
          const text = str(row?.text);
          if (row?.role === 'user' && text === entry.question) questionSeen = true;
          else if (questionSeen && row?.role === 'assistant' && text) return finish({ status: 'answered', answer: text });
        }
        cursor = page.next_cursor ?? (page.reset ? null : cursor);
        // A full page means more rows wait; read on without the delay.
        if (rows.length >= PAGE_LIMIT) return step();
      }
      polls.set(entry.id, setTimer(step, POLL_MS));
    };

    polls.set(entry.id, null);
    step();
  }

  async function ask(mainId) {
    const { question, model, provider } = $form.get();
    const text = str(question);
    if (!mainId) return setNotice(mainId, 'Open a chat first.');
    if (!text) return setNotice(mainId, 'Type a question.');
    setNotice(mainId, 'Forking the chat...');

    let branch;
    try {
      branch = await host.request('session.branch_whole', {
        session_id: mainId,
        name: branchName(text),
        idempotency_key: `side-chat-${now()}-${++seq}`,
      });
    } catch (error) {
      return setNotice(mainId, isBusy(error) ? BUSY_TEXT : errorText(error));
    }
    if (!branch?.session_id) return setNotice(mainId, 'The fork returned no session.');

    const sideModel = str(model);
    const sideProvider = str(provider);
    const entry = {
      id: branch.session_id,
      question: text,
      session_id: branch.session_id,
      stored_session_id: branch.stored_session_id ?? null,
      model: sideModel || null,
      provider: sideModel && sideProvider ? sideProvider : null,
      answer: null,
      status: 'asking',
      at: now(),
    };
    addEntry(mainId, entry);
    setNotice(mainId, null);
    $form.set({ ...$form.get(), question: '' });

    const params = { session_id: branch.session_id, text };
    // A blank model field keeps the session model: no override at all.
    if (sideModel) params.model_override = { model: sideModel, ...(sideProvider ? { provider: sideProvider } : {}) };
    try {
      await host.request('prompt.submit', params);
    } catch (error) {
      return updateEntry(mainId, entry.id, { status: 'error', error: errorText(error) });
    }
    poll(mainId, entry);
  }

  function openBranch(entry) {
    if (!entry?.stored_session_id || typeof host?.openSession !== 'function') return;
    Promise.resolve()
      .then(() => host.openSession(entry.stored_session_id, { intent: 'tab' }))
      .then(null, () => {});
  }

  function setField(key, value) {
    const next = { ...$form.get(), [key]: value };
    $form.set(next);
    if (key !== 'question') write(MODEL_KEY, { model: next.model, provider: next.provider });
  }

  function statusText(entry) {
    if (entry.status === 'answered') return entry.answer ?? '';
    if (entry.status === 'timeout') return TIMEOUT_TEXT;
    if (entry.status === 'error') return `Error: ${entry.error ?? 'unknown'}`;
    return 'Waiting for the answer...';
  }

  // No hooks here. The pane renders it as an element, never as a function call.
  function EntryRow({ entry }) {
    const when = typeof entry.at === 'number' ? new Date(entry.at).toLocaleTimeString() : '';
    const modelText = entry.model ? `${entry.model}${entry.provider ? ` (${entry.provider})` : ''}` : 'session model';
    return jsxs('div', {
      className: 'flex flex-col gap-1 rounded border p-2',
      style: SELECTABLE,
      children: [
        jsx('p', { className: 'text-sm font-semibold', style: PRE_STYLE, children: entry.question }),
        jsx('p', { className: 'text-xs opacity-70', style: SELECTABLE, children: `${modelText} · ${when}` }),
        jsx('pre', { className: 'text-sm', style: PRE_STYLE, children: statusText(entry) }),
        jsx(Button, {
          type: 'button',
          disabled: !entry.stored_session_id,
          onClick: () => openBranch(entry),
          children: 'Open',
        }),
      ],
    });
  }

  // Hook order is fixed: five useValue calls, every render, before any branch (React error 300).
  function renderPane() {
    const focused = useValue(host?.state?.focusedSessionId ?? $none);
    const active = useValue(host?.state?.activeSessionId ?? $none);
    const lists = useValue($lists);
    const form = useValue($form);
    const notices = useValue($notices);

    const mainId = focused ?? active ?? null;
    loadList(mainId);
    const entries = mainId ? lists[mainId] ?? [] : [];
    const notice = notices[mainId ?? ''];
    const onAsk = () => ask(mainId);

    return jsx(ScrollArea, {
      children: jsxs('div', {
        className: 'flex flex-col gap-2 p-4 text-sm',
        style: SELECTABLE,
        children: [
          jsx('p', {
            className: 'text-xs opacity-70',
            children: mainId
              ? 'Ask a side question. It runs in a branch of this chat, not in the chat.'
              : 'Open a chat to ask a side question.',
          }),
          jsx(Input, {
            value: form.question,
            placeholder: 'Side question',
            onChange: (event) => setField('question', event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault?.();
                onAsk();
              }
            },
          }),
          jsx(Input, {
            value: form.model,
            placeholder: 'Side model (blank = session model)',
            onChange: (event) => setField('model', event.target.value),
          }),
          jsx(Input, {
            value: form.provider,
            placeholder: 'Side provider (optional)',
            onChange: (event) => setField('provider', event.target.value),
          }),
          jsx(Button, { type: 'button', disabled: !mainId, onClick: onAsk, children: 'Ask' }),
          notice ? jsx('p', { className: 'text-xs', style: SELECTABLE, children: notice }) : null,
          ...entries.map((entry) => jsx(EntryRow, { entry }, entry.id)),
        ].filter(Boolean),
      }),
    });
  }

  function register(ctx) {
    storage = ctx?.storage ?? null;
    read(MODEL_KEY, (saved) => {
      if (!saved || typeof saved !== 'object') return;
      $form.set({ ...$form.get(), model: str(saved.model), provider: str(saved.provider) });
    });
    ctx.register({
      id: PANE_ID,
      area: 'panes',
      title: 'Side chat',
      data: { placement: 'right', width: '360px' },
      render: renderPane,
    });
    ctx.register({
      id: 'open-side-chat',
      area: 'palette',
      data: {
        id: 'open-side-chat',
        label: 'Open side chat',
        keywords: ['side', 'branch', 'question', 'btw'],
        run: () => {
          if (typeof host?.revealPane === 'function') host.revealPane(`${PLUGIN_ID}:${PANE_ID}`);
        },
      },
    });
  }

  // Stops every live poll (tests, and a plugin reload).
  function dispose() {
    for (const id of polls.values()) if (id != null) clearTimer(id);
    polls.clear();
  }

  return { register, renderPane, EntryRow, ask, openBranch, dispose, $lists, $form, $notices };
}
