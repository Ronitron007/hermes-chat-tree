// Side chat pane: asks a side question in a fork of the focused chat, on the side model,
// and shows the answer here. The main chat gets no new message.
// Plain ESM with no imports: the SDK pieces, timers and clock are injected so it runs under node --test.
// Spec: docs/research/2026-11-11-chat-tree/spec-side-chat.md
// Verbatim merge-back: docs/research/2026-11-11-chat-tree/spec-merge-back.md

export const PLUGIN_ID = 'side-chat';
export const PANE_ID = 'pane';
export const POLL_MS = 1500;
export const TIMEOUT_MS = 180_000;
export const MAX_ENTRIES = 50;
export const PAGE_LIMIT = 200;
export const MODEL_KEY = 'sideChat:model';
export const BUSY_TEXT = 'The main chat is busy. Ask again when the run ends.';
export const TIMEOUT_TEXT = 'No answer yet. Open the branch to see it.';
export const MERGE_STAGED_TEXT =
  'The draft is in the main chat composer. Edit it and send. After sending, session.undo on an idle parent can drop that turn.';
export const MERGE_HIDDEN_TEXT = "The main chat's composer is not visible. Open the main chat and try again.";
export const MERGE_NO_COMPOSER_TEXT = 'The composer draft API is missing. Nothing was written.';

export const listKey = (chatId) => `sideChat:${chatId}`;
export const branchName = (question) => `Side: ${question.slice(0, 50)}`;

// Shared with chat-tree through globalThis: assembled plugins cannot import each other.
// Hermes retitles a side branch, so the side mark is keyed by these ids, with the title prefix as fallback.
const SIDE_BRANCH_IDS = '__hermesSideChatBranchIds';

function sideBranchIds() {
  if (!(globalThis[SIDE_BRANCH_IDS] instanceof Set)) {
    const ids = new Set();
    try {
      const raw = globalThis.localStorage?.getItem?.(SIDE_BRANCH_IDS);
      const parsed = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) {
        for (const id of parsed) if (typeof id === 'string' && id) ids.add(id);
      }
    } catch {
      // node tests have no localStorage; a bad stored value must not break the pane.
    }
    globalThis[SIDE_BRANCH_IDS] = ids;
  }
  return globalThis[SIDE_BRANCH_IDS];
}

export function rememberSideBranch(id) {
  if (typeof id !== 'string' || !id) return;
  const ids = sideBranchIds();
  if (ids.has(id)) return;
  ids.add(id);
  try {
    globalThis.localStorage?.setItem?.(SIDE_BRANCH_IDS, JSON.stringify([...ids]));
  } catch {
    // Persistence is best effort.
  }
}

export function isKnownSideBranch(id) {
  return typeof id === 'string' && id !== '' && sideBranchIds().has(id);
}

// Pane text must be copyable; the spike log was not.
const SELECTABLE = { userSelect: 'text', WebkitUserSelect: 'text' };
const PRE_STYLE = { ...SELECTABLE, whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, font: 'inherit' };
const STATUSES = new Set(['asking', 'answered', 'timeout', 'error']);

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const isThenable = (v) => v != null && typeof v.then === 'function';
const errorText = (error) => str(error?.message) || str(error) || 'Unknown error';
// The canonical gateway refuses a mutation it cannot run now as reason `session_busy`
// (hermes_state_mutation_guards.py busy_refusal); the desktop sends branch_whole as that mutation.
const isBusy = (error) => /busy/i.test(`${error?.data?.reason ?? ''} ${errorText(error)}`);

// Transcript rows on this Hermes may carry text, a string content, or content parts.
export function rowText(row) {
  const direct = typeof row?.text === 'string' ? row.text.trim() : '';
  if (direct) return direct;
  const content = row?.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('').trim();
}

// Copied parent rows (row_id at or under the fence) stay out of a merge.
// formatSideDigest / digestFromRows stay exported for a later digest option. stageMerge does not call them.
export function rowsAfterFence(rows, maxRowId) {
  if (!Number.isFinite(maxRowId) || !Array.isArray(rows)) return [];
  return rows.filter((row) => {
    const id = row?.row_id;
    if (!Number.isFinite(id)) return true;
    return id > maxRowId;
  });
}

export function formatSideDigest(question, answer) {
  return `From side question:\n\nQuestion: ${question}\n\nAnswer:\n${answer}`;
}

function turnFromNewRows(rows) {
  let question = '';
  let answer = '';
  for (const row of rows) {
    if (row?.role === 'user') {
      // First complete turn only: a later user stops once this pair is in hand.
      if (question && answer) break;
      const text = rowText(row);
      if (!question && text) question = text;
    } else if (row?.role === 'assistant' && question) {
      const text = rowText(row);
      if (text) answer = text;
    }
  }
  if (!question || !answer) return null;
  return { question, answer };
}

// Legacy entries stored no fence. Match the side question instead of the copied parent turn.
function digestWithoutFence(rows, fallback) {
  const question = str(fallback?.question);
  const stored = str(fallback?.answer);
  const list = Array.isArray(rows) ? rows : [];
  let start = -1;
  if (question) {
    for (let i = 0; i < list.length; i++) {
      if (list[i]?.role === 'user' && rowText(list[i]) === question) start = i;
    }
  }
  if (start < 0) return formatSideDigest(question, stored);
  let answer = '';
  for (let i = start + 1; i < list.length; i++) {
    if (list[i]?.role === 'user') break;
    if (list[i]?.role === 'assistant') {
      const text = rowText(list[i]);
      if (text) answer = text;
    }
  }
  return formatSideDigest(question, answer || stored);
}

export function digestFromRows(rows, maxRowId, fallback) {
  if (!Number.isFinite(maxRowId)) return digestWithoutFence(rows, fallback);
  const turn = turnFromNewRows(rowsAfterFence(rows, maxRowId));
  const question = turn?.question ?? str(fallback?.question);
  const answer = turn?.answer ?? str(fallback?.answer);
  return formatSideDigest(question, answer);
}

// ASCII path of agent/model_metadata.py estimate_tokens_rough: CHARS_PER_TOKEN = 4, (len+3)//4.
// SessionMessage has no token_count, and the side session's context_used includes copied parent
// history, so the verbatim setDraft payload is estimated from its own text.
export function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  return Math.floor((text.length + 3) / 4);
}

function formatTokenCount(n) {
  const value = Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
  return String(Math.trunc(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function finiteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// Parent window from session.usage (TUI UsageStats, possibly nested under .usage),
// session.stats (last_prompt_tokens / context_length / context_tokens), or session.context_breakdown.
export function parseContextHeadroom(payload) {
  const sources = [];
  const push = (obj) => {
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) sources.push(obj);
  };
  push(payload);
  push(payload?.usage);
  push(payload?.usage_stats);
  for (const src of sources) {
    const max = finiteNumber(src.context_max) ?? finiteNumber(src.context_length);
    if (max == null || max <= 0) continue;
    const used = finiteNumber(src.context_used) ?? finiteNumber(src.last_prompt_tokens) ?? finiteNumber(src.context_tokens) ?? 0;
    let estimated = false;
    if (typeof src.context_estimated === 'boolean') estimated = src.context_estimated;
    else if (typeof src.context_source === 'string' && src.context_source && src.context_source !== 'provider_usage') {
      estimated = true;
    }
    return { used, max, available: Math.max(0, max - used), estimated };
  }
  return null;
}

// Every user/assistant pair. Tool and system rows are not turns. Each user starts a turn.
// Following non-empty assistant texts until the next user are that answer, joined with newlines.
export function turnsFromRows(rows) {
  const turns = [];
  let question = '';
  let parts = [];
  const flush = () => {
    if (question && parts.length) turns.push({ question, answer: parts.join('\n') });
    question = '';
    parts = [];
  };
  for (const row of Array.isArray(rows) ? rows : []) {
    const role = row?.role;
    if (role === 'tool' || role === 'system') continue;
    if (role === 'user') {
      flush();
      question = rowText(row);
      continue;
    }
    if (role === 'assistant' && question) {
      const text = rowText(row);
      if (text) parts.push(text);
    }
  }
  flush();
  return turns;
}

export function formatSideVerbatim(title, turns) {
  const name = str(title) || 'Side chat';
  const list = Array.isArray(turns) ? turns : [];
  const blocks = list.map((turn) => `You:\n${turn.question}\n\nAssistant:\n${turn.answer}`);
  return `From side chat: ${name}\n\n${blocks.join('\n\n')}`;
}

export function formatNoFitNotice(fields) {
  const src = fields || {};
  const sideEstimated = src.sideEstimated === true;
  const windowEstimated = src.windowEstimated === true;
  const side = `${formatTokenCount(src.sideTokens)} tokens${sideEstimated ? ' (estimated)' : ''}`;
  const parent = `${formatTokenCount(src.used)} used of ${formatTokenCount(src.max)}${windowEstimated ? ', estimated' : ''}`;
  return `Doesn't fit: side chat is ${side}, parent has ${formatTokenCount(src.available)} available (${parent}).`;
}

export function formatMissingWindowNotice(sideTokens) {
  return `${MERGE_STAGED_TEXT} Side chat is about ${formatTokenCount(sideTokens)} tokens (estimated). The parent context window was not reported.`;
}

// Poll readout, shown under each entry so a manual run can tell whether the host reports the
// branch as busy (finding 2 of the review on PR #10).
const DONE_BY = new Set(['busy-signal', 'two-reads', 'timeout']);
function cleanDiag(d) {
  if (!d || typeof d !== 'object') return null;
  return {
    busySeen: d.busySeen === true,
    reads: Number.isInteger(d.reads) && d.reads >= 0 ? d.reads : 0,
    doneBy: DONE_BY.has(d.doneBy) ? d.doneBy : null,
  };
}
export function diagText(diag) {
  if (!diag) return '';
  return `busy seen: ${diag.busySeen ? 'yes' : 'no'} · reads: ${diag.reads} · done by: ${diag.doneBy ?? '-'}`;
}

// Stored entries are untrusted (old versions, hand edits): keep only well-typed ones.
function cleanEntry(e) {
  if (!e || typeof e !== 'object') return null;
  if (typeof e.id !== 'string' || typeof e.question !== 'string' || typeof e.session_id !== 'string') return null;
  const opt = (v) => (typeof v === 'string' ? v : null);
  return {
    id: e.id,
    question: e.question,
    session_id: e.session_id,
    stored_session_id: opt(e.stored_session_id),
    model: opt(e.model),
    provider: opt(e.provider),
    answer: opt(e.answer),
    error: opt(e.error),
    status: STATUSES.has(e.status) ? e.status : 'timeout',
    maxRowId: Number.isFinite(e.maxRowId) ? e.maxRowId : null,
    at: typeof e.at === 'number' && Number.isFinite(e.at) ? e.at : 0,
    diag: cleanDiag(e.diag),
  };
}

export function createSideChat(deps) {
  const { host, jsx, jsxs, atom, useValue, Button, Input, ScrollArea, MessageTextContent } = deps;
  const now = deps.now ?? (() => Date.now());

  // stored main chat id -> entries, newest first.
  const $lists = atom({});
  const $form = atom({ question: '', model: '', provider: '' });
  // stored main chat id -> { notice, pending }. pending: a fork is in flight.
  const $status = atom({});
  // Stand-in so the pane calls useValue the same number of times when host.state lacks an atom.
  const $none = atom(null);

  let storage = null;
  let disposed = false;
  let seq = 0;
  // ctx.setTimeout once registered: the host clears it on unload (apps/desktop/src/contrib/plugin.ts).
  let scopedTimeout = null;
  const loaded = new Set();
  const polls = new Map(); // entry id -> cancel function of its next tick
  const unsubscribers = [];

  function schedule(fn, ms) {
    if (scopedTimeout) return scopedTimeout(fn, ms);
    const set = deps.setTimeout ?? ((f, t) => globalThis.setTimeout(f, t));
    const clear = deps.clearTimeout ?? ((id) => globalThis.clearTimeout(id));
    const id = set(fn, ms);
    return () => clear(id);
  }

  const write = (key, value) => {
    if (disposed) return;
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

  const atomOf = (name) => host?.state?.[name] ?? $none;
  const runtimeChatId = () => atomOf('focusedSessionId').get() ?? atomOf('activeSessionId').get() ?? null;
  // Lists are keyed by the stored id: runtime ids do not survive a reload (sdk/index.ts focusedStoredSessionId).
  const listChatId = () => atomOf('focusedStoredSessionId').get() ?? runtimeChatId();

  function setStatus(chatId, patch) {
    const all = $status.get();
    $status.set({ ...all, [chatId ?? '']: { ...all[chatId ?? ''], ...patch } });
  }

  function setList(chatId, list) {
    if (disposed) return;
    const next = list.slice(0, MAX_ENTRIES);
    $lists.set({ ...$lists.get(), [chatId]: next });
    write(listKey(chatId), next);
  }

  const addEntry = (chatId, entry) => {
    rememberSideBranch(entry?.session_id);
    rememberSideBranch(entry?.stored_session_id);
    setList(chatId, [entry, ...($lists.get()[chatId] ?? [])]);
  };

  function updateEntry(chatId, id, patch) {
    const list = $lists.get()[chatId] ?? [];
    setList(chatId, list.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  }

  // Loads the stored list once per main chat, on focus change (never during render).
  // Entries added before the read lands are kept: the merge puts them first.
  function loadList(chatId) {
    if (!chatId || loaded.has(chatId) || disposed) return;
    loaded.add(chatId);
    read(listKey(chatId), (stored) => {
      if (disposed) return;
      const current = $lists.get()[chatId] ?? [];
      const ids = new Set(current.map((e) => e.id));
      // An entry still "asking" with no live poll lost its poll to a reload.
      const restored = (Array.isArray(stored) ? stored : [])
        .map(cleanEntry)
        .filter((e) => e && !ids.has(e.id))
        .map((e) => (e.status === 'asking' && !polls.has(e.id) ? { ...e, status: 'timeout' } : e));
      for (const entry of restored) {
        rememberSideBranch(entry.session_id);
        rememberSideBranch(entry.stored_session_id);
      }
      const merged = [...current, ...restored].sort((a, b) => b.at - a.at).slice(0, MAX_ENTRIES);
      $lists.set({ ...$lists.get(), [chatId]: merged });
      if (current.length) write(listKey(chatId), merged);
    });
  }

  // This Hermes (v0.23) has no session.transcript. Cache that and read session.history,
  // which is one complete snapshot. An empty transcript page is not a missing method.
  let transcriptMissing = false;
  const request = (params) => host.request('session.transcript', params);
  async function page(sessionId, cursor) {
    const params = { session_id: sessionId, order: 'oldest', limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) };
    if (!transcriptMissing) {
      try {
        return await request(params);
      } catch {
        transcriptMissing = true;
      }
    }
    const history = await host.request('session.history', { session_id: sessionId });
    const messages = Array.isArray(history?.messages) ? history.messages : [];
    return { rows: messages, next_cursor: null, reset: true, complete: true };
  }

  // Reads the copied history to its end before the question goes in. Only an EMPTY page means
  // caught up: the gateway also cuts pages at 2 MiB and between tool groups (session_stored_reads.py). The poll then starts from
  // that cursor, and a reset page drops rows at or below the highest copied row_id, so an old
  // identical question in the main chat can never answer this one.
  async function fence(sessionId) {
    let cursor = null;
    let maxRowId = null;
    for (let i = 0; i < 1000; i++) {
      const result = await page(sessionId, cursor);
      const rows = Array.isArray(result?.rows) ? result.rows : [];
      for (const row of rows) if (Number.isFinite(row?.row_id)) maxRowId = Math.max(maxRowId ?? row.row_id, row.row_id);
      cursor = result?.next_cursor ?? cursor;
      // History is a complete snapshot. Without this, the fence rereads it until the cap.
      if (result?.complete === true || rows.length === 0) break;
    }
    return { cursor, maxRowId };
  }

  // Polls the branch from the fence until its turn ends, then takes the last assistant text after
  // the question. A turn has ended when the last assistant/tool row is assistant text (no tool call
  // still running after it), the branch is not busy in host.state.busyBySession, and either the
  // branch was seen busy or the same text held for two reads (a host that never reports the branch).
  function poll(chatId, entry, start) {
    const started = now();
    let cursor = start.cursor;
    let questionSeen = false;
    let tail = []; // assistant and tool rows after the question
    let seenBusy = false;
    let reads = 0;
    const diag = (doneBy = null) => ({ busySeen: seenBusy, reads, doneBy });
    let previous = null;

    const live = () => polls.has(entry.id) && !disposed;
    const finish = (patch) => {
      polls.delete(entry.id);
      updateEntry(chatId, entry.id, patch);
    };
    const isNew = (row) => start.maxRowId == null || !Number.isFinite(row?.row_id) || row.row_id > start.maxRowId;

    const step = async () => {
      if (!live()) return;
      if (now() - started >= TIMEOUT_MS) return finish({ status: 'timeout', diag: diag('timeout') });
      let result = null;
      try {
        reads += 1;
        result = await page(entry.session_id, cursor);
      } catch {
        // A failed read is retried on the next tick until the timeout.
      }
      if (!live()) return;
      const rows = Array.isArray(result?.rows) ? result.rows : [];
      if (result) {
        // reset: the reply is the first page again and replaces what was read.
        if (result.reset) {
          questionSeen = false;
          tail = [];
        }
        for (const row of rows) {
          if (!isNew(row)) continue;
          const text = rowText(row);
          // A numeric fence already dropped copied rows, so any new user row is this turn.
          // With no fence, only the exact question starts it.
          const startsTurn = row?.role === 'user' && (text === entry.question || Number.isFinite(start.maxRowId));
          if (startsTurn) {
            questionSeen = true;
            tail = [];
          } else if (questionSeen && (row?.role === 'assistant' || row?.role === 'tool')) {
            tail.push(row);
          }
        }
        cursor = result.next_cursor ?? (result.reset ? null : cursor);
        // A full page means more rows wait; a complete history snapshot does not.
        if (rows.length >= PAGE_LIMIT && result.complete !== true) return step();
      }
      const busy = Boolean(atomOf('busyBySession').get()?.[entry.session_id]);
      if (busy) seenBusy = true;
      const last = tail[tail.length - 1];
      const candidate = last?.role === 'assistant' ? rowText(last) || null : null;
      if (candidate && !busy && (seenBusy || candidate === previous)) {
        return finish({ status: 'answered', answer: candidate, diag: diag(seenBusy ? 'busy-signal' : 'two-reads') });
      }
      previous = candidate;
      updateEntry(chatId, entry.id, { diag: diag() });
      polls.set(entry.id, schedule(step, POLL_MS));
    };

    polls.set(entry.id, null);
    step();
  }

  async function ask(chatId, runtimeId) {
    if (disposed) return;
    const form = $form.get();
    const text = str(form.question);
    if (!chatId || !runtimeId) return setStatus(chatId, { notice: 'Open a chat first.' });
    if ($status.get()[chatId]?.pending) return;
    if (!text) return setStatus(chatId, { notice: 'Type a question.' });
    setStatus(chatId, { notice: 'Forking the chat...', pending: true });

    let branch;
    try {
      branch = await host.request('session.branch_whole', {
        session_id: runtimeId,
        name: branchName(text),
        idempotency_key: `side-chat-${now()}-${++seq}`,
      });
    } catch (error) {
      return setStatus(chatId, { notice: isBusy(error) ? BUSY_TEXT : errorText(error), pending: false });
    }
    if (disposed) return;
    if (!branch?.session_id) return setStatus(chatId, { notice: 'The fork returned no session.', pending: false });

    const sideModel = str(form.model);
    const sideProvider = str(form.provider);
    const entry = {
      id: branch.session_id,
      question: text,
      session_id: branch.session_id,
      stored_session_id: branch.stored_session_id ?? null,
      model: sideModel || null,
      provider: sideModel && sideProvider ? sideProvider : null,
      answer: null,
      error: null,
      status: 'asking',
      at: now(),
    };
    addEntry(chatId, entry);
    setStatus(chatId, { notice: null, pending: false });
    // Text typed while the fork ran is a new question: keep it.
    if ($form.get().question === form.question) $form.set({ ...$form.get(), question: '' });

    // On the canonical gateway the branch's runtime and stored ids are the same id
    // (apps/desktop/src/api/canonical-protocol.ts maps branched_session_id to both), and
    // session.transcript resolves it (gateway/session_stored_reads.py _readable_target).
    let start = { cursor: null, maxRowId: null };
    try {
      start = await fence(entry.session_id);
    } catch {
      // No fence: the poll reads from the first page and matches the last question row it sees.
    }
    if (disposed) return;
    if (Number.isFinite(start.maxRowId)) updateEntry(chatId, entry.id, { maxRowId: start.maxRowId });

    const params = { session_id: branch.session_id, text };
    // A blank model field keeps the session model: no override at all.
    if (sideModel) params.model_override = { model: sideModel, ...(sideProvider ? { provider: sideProvider } : {}) };
    try {
      await host.request('prompt.submit', params);
    } catch (error) {
      return updateEntry(chatId, entry.id, { status: 'error', error: errorText(error) });
    }
    poll(chatId, entry, start);
  }

  function openBranch(entry) {
    if (!entry?.stored_session_id || typeof host?.openSession !== 'function') return;
    Promise.resolve()
      .then(() => host.openSession(entry.stored_session_id, { intent: 'tab' }))
      .then(null, () => {});
  }

  // Pages the branch the same way the fence does, then the caller drops copied history.
  async function transcriptRows(sessionId) {
    const rows = [];
    let cursor = null;
    const seen = new Set();
    for (let i = 0; i < 1000; i++) {
      const result = await page(sessionId, cursor);
      const batch = Array.isArray(result?.rows) ? result.rows : [];
      rows.push(...batch);
      const next = typeof result?.next_cursor === 'string' && result.next_cursor ? result.next_cursor : null;
      if (batch.length === 0 || !next || next === cursor || seen.has(next)) break;
      seen.add(next);
      cursor = next;
    }
    return rows;
  }

  // Parent context window. Never the side session: branch_whole copies parent history, so that
  // context_used would count the parent and falsely fail the fit check.
  async function parentHeadroom() {
    const ids = [];
    const stored = listChatId();
    if (typeof stored === 'string' && stored) ids.push(stored);
    let focused = null;
    try {
      focused = atomOf('focusedSessionId').get();
    } catch {
      focused = null;
    }
    if (typeof focused === 'string' && focused && !ids.includes(focused)) ids.push(focused);
    const methods = ['session.usage', 'session.stats', 'session.context_breakdown'];
    for (const method of methods) {
      for (const session_id of ids) {
        try {
          const window = parseContextHeadroom(await host.request(method, { session_id }));
          if (window) return window;
        } catch {
          // A throw or a payload with no context max tries the next id, then the next method.
        }
      }
    }
    return null;
  }

  async function sideVerbatim(entry) {
    let turns = null;
    if (entry.session_id) {
      try {
        const fresh = turnsFromRows(rowsAfterFence(await transcriptRows(entry.session_id), entry.maxRowId));
        if (fresh.length) turns = fresh;
      } catch {
        turns = null;
      }
    }
    if (!turns) turns = [{ question: str(entry.question), answer: str(entry.answer) }];
    return formatSideVerbatim(entry.question, turns);
  }

  // Stages the side exchange verbatim in the parent composer when it fits. Never submits.
  async function stageMerge(entry) {
    try {
      if (disposed || entry?.status !== 'answered' || !str(entry?.answer)) return;
      const parentId = listChatId();
      const setDraft = host?.composer?.setDraft;
      if (typeof setDraft !== 'function') {
        setStatus(parentId, { notice: MERGE_NO_COMPOSER_TEXT });
        return;
      }
      const verbatim = await sideVerbatim(entry);
      if (disposed) return;
      // No host token count exists for this payload (SessionMessage has no token_count).
      const sideTokens = estimateTokens(verbatim);
      const headroom = await parentHeadroom();
      if (disposed) return;
      if (headroom && sideTokens > headroom.available) {
        setStatus(parentId, {
          notice: formatNoFitNotice({
            sideTokens,
            available: headroom.available,
            used: headroom.used,
            max: headroom.max,
            sideEstimated: true,
            windowEstimated: headroom.estimated === true,
          }),
        });
        return;
      }
      if (typeof parentId !== 'string' || !parentId) {
        setStatus(parentId, { notice: MERGE_HIDDEN_TEXT });
        return;
      }
      if (typeof host?.openSession === 'function') {
        try {
          await host.openSession(parentId, { intent: 'in-place' });
        } catch {
          // setDraft is fail-closed when the parent composer is not mounted.
        }
      }
      if (disposed) return;
      let ok = false;
      try {
        ok = (await setDraft(parentId, verbatim)) === true;
      } catch {
        ok = false;
      }
      if (!ok) {
        let runtimeId = null;
        try {
          runtimeId = atomOf('focusedSessionId').get();
        } catch {
          runtimeId = null;
        }
        if (typeof runtimeId === 'string' && runtimeId) {
          try {
            ok = (await setDraft(runtimeId, verbatim)) === true;
          } catch {
            ok = false;
          }
        }
      }
      if (disposed) return;
      const staged = headroom ? MERGE_STAGED_TEXT : formatMissingWindowNotice(sideTokens);
      setStatus(parentId, { notice: ok ? staged : MERGE_HIDDEN_TEXT });
    } catch {
      try {
        setStatus(listChatId(), { notice: MERGE_HIDDEN_TEXT });
      } catch {
        // A click must not throw into the pane.
      }
    }
  }

  // Hermes listens for keys on window capture; the composer takes whatever still bubbles.
  function stopHostEvent(event) {
    event.stopPropagation?.();
    event.stopImmediatePropagation?.();
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
    const when = entry.at ? new Date(entry.at).toLocaleTimeString() : '';
    const modelText = entry.model ? `${entry.model}${entry.provider ? ` (${entry.provider})` : ''}` : 'session model';
    return jsxs('div', {
      className: 'flex flex-col gap-1 rounded border p-2',
      style: SELECTABLE,
      children: [
        jsx('p', { className: 'text-sm font-semibold', style: PRE_STYLE, children: entry.question }),
        jsx('p', { className: 'text-xs opacity-70', style: SELECTABLE, children: `${modelText} · ${when}` }),
        // Answers use the chat's own markdown renderer when the SDK has it.
        entry.status === 'answered' && MessageTextContent
          ? jsx('div', {
              className: 'text-sm',
              style: SELECTABLE,
              'data-selectable-text': 'true',
              // media off: outside a chat, MEDIA: paths resolve against the primary session, not the branch.
              children: jsx(MessageTextContent, { text: entry.answer ?? '', media: false }),
            })
          : jsx('pre', { className: 'text-sm', style: PRE_STYLE, children: statusText(entry) }),
        entry.diag && (entry.status === 'asking' || entry.status === 'answered' || entry.status === 'timeout')
          ? jsx('p', { className: 'text-xs opacity-60', style: SELECTABLE, children: diagText(entry.diag) })
          : null,
        jsx(Button, {
          type: 'button',
          disabled: !entry.stored_session_id,
          onClick: () => openBranch(entry),
          children: 'Open',
        }),
        entry.status === 'answered'
          ? jsx(Button, {
              type: 'button',
              disabled: !str(entry.answer),
              onClick: () => stageMerge(entry),
              children: 'Merge into parent',
            })
          : null,
      ].filter(Boolean),
    });
  }

  // Hook order is fixed: six useValue calls, every render, before any branch (React error 300).
  // Render only reads state; loading happens on focus change in register().
  function renderPane() {
    const stored = useValue(atomOf('focusedStoredSessionId'));
    const focused = useValue(atomOf('focusedSessionId'));
    const active = useValue(atomOf('activeSessionId'));
    const lists = useValue($lists);
    const form = useValue($form);
    const statuses = useValue($status);

    const runtimeId = focused ?? active ?? null;
    const chatId = stored ?? runtimeId;
    const entries = chatId ? lists[chatId] ?? [] : [];
    const status = statuses[chatId ?? ''] ?? {};
    const onAsk = () => ask(chatId, runtimeId);

    return jsx(ScrollArea, {
      children: jsxs('div', {
        className: 'flex flex-col gap-2 p-4 text-sm',
        style: SELECTABLE,
        onKeyDown: stopHostEvent,
        onKeyUp: stopHostEvent,
        onPointerDown: stopHostEvent,
        children: [
          jsx('p', {
            className: 'text-xs opacity-70',
            children: chatId
              ? 'Ask a side question. It runs in a branch of this chat, not in the chat.'
              : 'Open a chat to ask a side question.',
          }),
          jsx(Input, {
            value: form.question,
            placeholder: 'Side question',
            onChange: (event) => setField('question', event.target.value),
            onKeyDown: (event) => {
              stopHostEvent(event);
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault?.();
                onAsk();
              }
            },
            onKeyUp: stopHostEvent,
            onPointerDown: stopHostEvent,
          }),
          jsx(Input, {
            value: form.model,
            placeholder: 'Side model (blank = session model)',
            onChange: (event) => setField('model', event.target.value),
            onKeyDown: stopHostEvent,
            onKeyUp: stopHostEvent,
            onPointerDown: stopHostEvent,
          }),
          jsx(Input, {
            value: form.provider,
            placeholder: 'Side provider (optional)',
            onChange: (event) => setField('provider', event.target.value),
            onKeyDown: stopHostEvent,
            onKeyUp: stopHostEvent,
            onPointerDown: stopHostEvent,
          }),
          jsx(Button, { type: 'button', disabled: !chatId || Boolean(status.pending), onClick: onAsk, children: 'Ask' }),
          status.notice
            ? jsx('p', {
                className: 'text-xs',
                style: SELECTABLE,
                'data-selectable-text': 'true',
                children: status.notice,
              })
            : null,
          ...entries.map((entry) => jsx(EntryRow, { entry }, entry.id)),
        ].filter(Boolean),
      }),
    });
  }

  // Stops every live poll and every store listener. Wired to ctx.onDispose.
  function dispose() {
    disposed = true;
    for (const cancel of polls.values()) if (typeof cancel === 'function') cancel();
    polls.clear();
    for (const off of unsubscribers.splice(0)) {
      try {
        off();
      } catch {
        // A listener that is already gone needs no cleanup.
      }
    }
  }

  function register(ctx) {
    // The loader calls register again on the same module after a disable and enable.
    disposed = false;
    storage = ctx?.storage ?? null;
    if (typeof ctx?.setTimeout === 'function') scopedTimeout = (fn, ms) => ctx.setTimeout(fn, ms);
    if (typeof ctx?.onDispose === 'function') ctx.onDispose(dispose);
    read(MODEL_KEY, (saved) => {
      if (!saved || typeof saved !== 'object') return;
      $form.set({ ...$form.get(), model: str(saved.model), provider: str(saved.provider) });
    });
    const sync = () => loadList(listChatId());
    for (const name of ['focusedStoredSessionId', 'focusedSessionId', 'activeSessionId']) {
      const store = host?.state?.[name];
      if (typeof store?.listen === 'function') unsubscribers.push(store.listen(sync));
    }
    sync();
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

  return { register, renderPane, EntryRow, ask, openBranch, dispose, $lists, $form, $status };
}
