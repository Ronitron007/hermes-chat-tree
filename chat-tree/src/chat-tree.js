// Chat tree pane: a git graph of the focused chat's tree. A node is one exchange (one user
// message and its replies). A lane is one chat. A child lane forks off its parent at the last
// exchange they share. A parent exchange that starts with `From side chat: <side question>` is a
// merge node, linked by a curve to the one child chat that starts with that question. Blue marks the path from the
// first exchange of the root chat to the open node; everything else is grey. A click on a node
// opens its chat in place. Every action lives in this pane. Branch here on an exchange of the open
// chat forks it there (session.branch with count) and asks the branch a question (prompt.submit).
// One merge section for the open chat stages it, as is or as a digest, in the composer of the
// parent or any older ancestor. It never sends. Digests come from this plugin's Python half: the
// plugin RPC plugin.chat-tree.digest.write answers { job }, and the gateway event
// plugin.chat-tree.digest.written brings { job, digest } or { job, error }. Live subagents show below the graph.
// Histories come from the same Python half: one plugin.chat-tree.history.read per refresh reads the
// stored chats of the tree from the local session store, because session.history answers only for
// chats loaded in gateway memory. Without the Python half the pane falls back to session.history.
// Plain ESM with no imports: the SDK pieces and timers are injected so it runs under node --test.
// Spec: docs/specs/2026-11-12-competition-build/spec.md (unit.tree_view, unit.tree_actions)

export const PLUGIN_ID = 'chat-tree';
export const PANE_ID = 'pane';
export const REFRESH_MS = 15_000;
// How long a Branch on another chat waits for that chat to open before it gives up.
export const PENDING_BRANCH_MS = 20_000;
// Gateway events that change the tree. The pane reloads soon after one (debounced) instead of at
// the next REFRESH_MS tick. Names from hermes-agent apps/desktop/src/app/session/hooks/use-message-stream/
// gateway-event/: sessions.changed (lifecycle.ts:80, the change watcher's session-store broadcast),
// message.start and message.complete (message-stream.ts:260, :401), session.title (session-info.ts:559).
export const RELOAD_EVENTS = ['sessions.changed', 'message.start', 'message.complete', 'session.title'];
export const RELOAD_DEBOUNCE_MS = 300;
// The label of a fork with no exchange of its own yet, until Hermes names it.
export const NEW_BRANCH_TEXT = 'New branch';
export const LIST_LIMIT = 500;
export const MAX_CHATS = 30;
export const SIDE_PREFIX = 'Side: ';
// Scroll to a clicked exchange through the chat's own reveal event (see revealExchange).
export const REVEAL_EVENT = 'hermes:timeline-reveal';
export const WORKSPACE_VIEWPORT = '[data-session-anchor="workspace"] [data-slot="aui_thread-viewport"]';
const TURN_PAIR = '[data-slot="aui_turn-pair"]';
export const REVEAL_POLL_MS = 100;
export const REVEAL_WAIT_MS = 5_000;
export const REVEAL_SETTLE_MS = 150;
export const REVEAL_RETRY_MS = 400;
export const REVEAL_RETRIES = 2;
export const REVEAL_TIMEOUT_MS = 15_000;
export const MERGE_HEADER = 'From side chat: ';
export const LABEL_MAX = 60;
// Graph geometry in px. A row is one exchange; lanes are columns inside the graph column.
export const ROW_H = 26;
export const GRAPH_W = 58;
export const GRAPH_PAD = 8;
export const LANE_GAP = 14;
export const NODE_R = 4;
export const CURVE_R = 5;
// A name row's marker: a small square on the lane, where the fork elbow lands.
export const MARK_SIZE = 4;
// Name row keys start with this; no exchange key does (exchange keys end in `:<index>`).
export const NAME_PREFIX = 'name:';
// The pane's two views: one row per exchange (the default), or one row per chat.
export const EXCHANGES_MODE = 'exchanges';
export const BRANCHES_MODE = 'branches';
export const MODE_KEY = 'mode';
// Graph colours are Hermes theme variables, each with the old fixed colour as its fallback, so the
// pane still draws where the variables are missing. A role takes the token Hermes uses for that job
// (paths in hermes-agent/apps/desktop/src):
// - active (the open node's path, its fill, the open row band and left accent, the merge target
//   lane): --dt-primary, the theme's primary colour (styles.css:429, from --theme-primary). It carries
//   the user's chosen accent (themes/context.tsx:168, :342). --ui-accent is not used: it is
//   --theme-midground, a neutral (styles.css:240), so the active path looked like the hover path.
// - inactive: --dt-muted-foreground, the muted text token (styles.css:426, text-muted-foreground at styles.css:133).
// - hover: --dt-foreground, the text token (styles.css:422, text-foreground at styles.css:129). Hermes
//   lifts muted text to it on hover (hover:text-foreground). The row hover fill (bg-muted,
//   styles.css:425) is too faint for a line.
export const ACCENT = 'var(--dt-primary, #3B82F6)';
export const MUTED = 'var(--dt-muted-foreground, #6B7280)';
export const HOVER = 'var(--dt-foreground, currentColor)';
export const ROLE_COLOURS = { active: ACCENT, hover: HOVER, inactive: MUTED };
// Same wording as side-chat (side-chat/src/side-chat.js): the two panes show one merge flow.
export const MERGE_STAGED_TEXT =
  'The draft is in the main chat composer. Edit it and send. After sending, session.undo on an idle parent can drop that turn.';
export const MERGE_HIDDEN_TEXT = "The main chat's composer is not visible. Open the main chat and try again.";
export const MERGE_NO_COMPOSER_TEXT = 'The composer draft API is missing. Nothing was written.';
export const MERGE_ROOT_TEXT = 'This is the root chat. It has no parent chat to merge into.';
export const UNLISTED_FOCUS_TEXT =
  "This chat is not in Hermes's session list (a subagent's chat is hidden there). The tree shows the chat you had open before, read-only.";
export const BRANCH_MODEL_NOT_SET_TEXT =
  "The branch was made, but Hermes did not take its model. It uses this chat's model. Pick a model in the branch's own model menu.";
export const FOCUS_WAIT_MS = 6000;
export const MERGE_SEND_FOCUS_TEXT = 'The target chat did not open in time. Nothing was sent.';
export const MERGE_SEND_BUSY_TEXT = 'The target chat is running. Nothing was sent.';
export const MERGE_PARENT_MISSING_TEXT = 'The parent of this chat is not loaded. There is no chat to merge into.';
export const MERGE_NOTHING_TEXT = 'Nothing to merge: this chat has no question and answer of its own after its fork point.';
export const DIGEST_MISSING_TEXT = 'The digest backend is not available (the chat-tree Python half is not enabled). Nothing was staged.';
export const DIGEST_TIMEOUT_TEXT = 'No digest came back in 60 seconds.';
export const BRANCH_BUSY_TEXT = 'This chat is running. Branch here works again when the run ends.';
export const MODEL_INHERIT_TEXT = "This chat's model";
export const MODEL_PICKER_MISSING_TEXT = "This Hermes has no model picker for plugins. The branch uses this chat's model.";
// ctx.storage keys (stored as hermes.plugin.chat-tree.<key>). BRANCH_IDS_KEY lists the ids of the
// branches this pane made. A fork digest sits under digestKey.
export const BRANCH_IDS_KEY = 'branchIds';
export const digestKey = (chatId, index) => `digest:${chatId}:${index}`;
// The digest contract with the plugin's Python half. The request answers { job } at once; the
// result comes as a gateway event to the clients that view session_id, matched on job.
export const DIGEST_METHOD = 'plugin.chat-tree.digest.write';
export const DIGEST_EVENT = 'plugin.chat-tree.digest.written';
export const DIGEST_TIMEOUT_MS = 60_000;
// The history contract with the Python half: { session_ids: stored ids (at most MAX_CHATS),
// session_id?: the open chat's runtime id } answers { histories: { id: [{ role, text, row_id? }] },
// missing: [ids not in the store] }. Read-only, local, no model call.
export const HISTORY_METHOD = 'plugin.chat-tree.history.read';
export const BACKEND_NOTE_TEXT = 'Enable the chat-tree plugin backend to see other chats (hermes plugins enable chat-tree).';

const SELECTABLE = { userSelect: 'text', WebkitUserSelect: 'text' };
const HISTORY_CONCURRENCY = 4;
const HISTORY_CACHE_MAX = 200;

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const errorText = (error) => str(error?.message) || str(error) || 'Unknown error';
const isThenable = (v) => v != null && typeof v.then === 'function';
// Copied from side-chat: the gateway refuses a mutation it cannot run now as reason `session_busy`
// (hermes_state_mutation_guards.py busy_refusal; a branch needs an idle chat, hermes_state_mutation_branch.py:58).
const isBusy = (error) => /busy/i.test(`${error?.data?.reason ?? ''} ${errorText(error)}`);
// -32601 (method not found): a plugin method whose Python half is not enabled.
const isMissingMethod = (error) => error?.code === -32601 || /method not found|unknown method/i.test(errorText(error));

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
// The chat the tree centres on: the focused chat when the session list holds it, else the last
// listed chat that was focused. Hermes hides a subagent's chat from that list (is_internal_child,
// apps/desktop/src/types/hermes.ts:671), so opening one must not empty the tree.
export function treeFocus(rows, want, last) {
  if (want && buildTree(rows, want)) return want;
  if (last && buildTree(rows, last)) return last;
  return want ?? null;
}

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

// The chats whose histories the graph reads: the root and its descendants, depth first with the
// oldest child first, as [{ row, parentId }]. Past `max` chats, the path from the root to the
// focused chat stays, then chats whose parent is kept, in that order.
export function lineageChats(tree, max = MAX_CHATS) {
  if (!tree) return [];
  const order = [];
  const walk = (node, parentId) => {
    order.push({ row: node.row, parentId });
    for (const kid of node.children) walk(kid, node.row.id);
  };
  walk(tree.root, null);
  if (order.length <= max) return order;
  const byId = new Map(order.map((chat) => [chat.row.id, chat]));
  const keep = new Set();
  for (let chat = byId.get(tree.focused.id); chat && !keep.has(chat.row.id); chat = chat.parentId ? byId.get(chat.parentId) : null) {
    keep.add(chat.row.id);
  }
  for (const chat of order) {
    if (keep.size >= max) break;
    if (!keep.has(chat.row.id) && chat.parentId && keep.has(chat.parentId)) keep.add(chat.row.id);
  }
  return order.filter((chat) => keep.has(chat.row.id));
}

export const isSideTitle = (title) => typeof title === 'string' && title.startsWith(SIDE_PREFIX);

// Shared with side-chat through globalThis: assembled plugins cannot import each other.
const SIDE_BRANCH_IDS = '__hermesSideChatBranchIds';

function idSet(key) {
  if (!(globalThis[key] instanceof Set)) {
    const ids = new Set();
    try {
      const raw = globalThis.localStorage?.getItem?.(key);
      const parsed = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) {
        for (const id of parsed) if (typeof id === 'string' && id) ids.add(id);
      }
    } catch {
      // node tests have no localStorage; a bad stored value must not break the pane.
    }
    globalThis[key] = ids;
  }
  return globalThis[key];
}

function rememberId(key, id) {
  if (typeof id !== 'string' || !id) return;
  const ids = idSet(key);
  if (ids.has(id)) return;
  ids.add(id);
  try {
    globalThis.localStorage?.setItem?.(key, JSON.stringify([...ids]));
  } catch {
    // Persistence is best effort.
  }
}

export const rememberSideBranch = (id) => rememberId(SIDE_BRANCH_IDS, id);

export function isKnownSideBranch(id) {
  return typeof id === 'string' && id !== '' && idSet(SIDE_BRANCH_IDS).has(id);
}

// A side chat: a branch this pane made (ids: its stored branch ids, a Set or an array). The old
// marks are a read fallback only: a `Side: ` title, or an id side-chat recorded on globalThis.
export function isSideChat(row, ids) {
  const id = row?.id;
  if (typeof id === 'string' && id && (ids instanceof Set ? ids.has(id) : Array.isArray(ids) && ids.includes(id))) return true;
  return isSideTitle(row?.title) || isKnownSideBranch(id);
}

// ── Merge-back helpers (copied from side-chat/src/side-chat.js; plugins cannot import each other) ──

// Transcript rows on this Hermes may carry text, a string content, or content parts.
export function rowText(row) {
  const direct = typeof row?.text === 'string' ? row.text.trim() : '';
  if (direct) return direct;
  const content = row?.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('').trim();
}

// ASCII path of agent/model_metadata.py estimate_tokens_rough: CHARS_PER_TOKEN = 4, (len+3)//4.
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

// fields.mode: the button label; fields.target: the target chat's title (the parent by default).
// The notice is held until dismissed, so it names both. Wording copied from side-chat.
export function formatNoFitNotice(fields) {
  const src = fields || {};
  const sideEstimated = src.sideEstimated === true;
  const windowEstimated = src.windowEstimated === true;
  const mode = str(src.mode);
  const target = str(src.target) || 'parent';
  const side = `${formatTokenCount(src.sideTokens)} tokens${sideEstimated ? ' (estimated)' : ''}`;
  const parent = `${formatTokenCount(src.used)} used of ${formatTokenCount(src.max)}${windowEstimated ? ', estimated' : ''}`;
  return `Doesn't fit${mode ? ` (${mode})` : ''}: side chat is ${side}, ${target} has ${formatTokenCount(src.available)} available (${parent}).`;
}

export function formatMissingWindowNotice(sideTokens) {
  return `${MERGE_STAGED_TEXT} Side chat is about ${formatTokenCount(sideTokens)} tokens (estimated). The parent context window was not reported.`;
}

// ── Concept-link markup removal (copied verbatim from side-chat/src/side-chat.js) ──
// Merged text is plain prose: `::termline{v=… t=…}` becomes its v sentence, `::term{name=… def=…}`
// its name, and `[[name|def]]` its name. Rules copied from src/termline.js (the bundle has no
// imports). Fenced and inline code stay as written: a directive never goes in code, and code may
// hold `[[ a || b ]]`. Anything that does not parse stays as written.

const TERMLINE_OPEN = '::termline{';
const TERM_OPEN = '::term{';
// termline.js unescapeTermlineValue's set, plus the quotes a quoted attribute value may escape.
const ATTR_ESCAPED = /\\([\\`*_~[\]<>$&"'])/g;
const ATTR_KEY = /[A-Za-z_][\w.:-]*/y;
const ATTR_BARE = /[^\s"'=<>`{}]+/y;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;

// termline.js scanMarkers, sentence only. An earlier unmatched `[[` stays text, and a marker with
// an empty name keeps its characters. needPipe: outside a termline only `[[name|def]]` is markup.
function stripMarkers(input, needPipe) {
  let out = '';
  let pos = 0;
  while (pos < input.length) {
    const first = input.indexOf('[[', pos);
    const close = first === -1 ? -1 : input.indexOf(']]', first + 2);
    if (close === -1) break;
    const open = input.lastIndexOf('[[', close - 2);
    const inner = input.slice(open + 2, close);
    const sep = inner.indexOf('|');
    const name = (sep === -1 ? inner : inner.slice(0, sep)).trim();
    if (name === '' || (needPipe && sep === -1)) {
      out += input.slice(pos, open + 2);
      pos = open + 2;
      continue;
    }
    out += input.slice(pos, open) + name;
    pos = close + 2;
  }
  return out + input.slice(pos);
}

// Index of the quote that closes the value opened at j, or -1. A backslash escapes the next character.
function quoteEnd(s, j) {
  for (let k = j + 1; k < s.length; k++) {
    if (s[k] === '\\') k += 1;
    else if (s[k] === s[j]) return k;
    else if (s[k] === '\n' || s[k] === '\r') return -1;
  }
  return -1;
}

// The directive at i as { end, text }, or null. Values are "double", 'single' or bare.
function directiveAt(s, i) {
  const termline = s.startsWith(TERMLINE_OPEN, i);
  if (!termline && !s.startsWith(TERM_OPEN, i)) return null;
  const attrs = Object.create(null);
  let j = i + (termline ? TERMLINE_OPEN : TERM_OPEN).length;
  for (;;) {
    while (s[j] === ' ' || s[j] === '\t') j += 1;
    if (s[j] === '}') break;
    ATTR_KEY.lastIndex = j;
    const key = ATTR_KEY.exec(s);
    if (!key) return null;
    j = ATTR_KEY.lastIndex;
    let value = '';
    if (s[j] === '=') {
      j += 1;
      if (s[j] === '"' || s[j] === "'") {
        const end = quoteEnd(s, j);
        if (end === -1) return null;
        value = s.slice(j + 1, end).replace(ATTR_ESCAPED, '$1');
        j = end + 1;
      } else {
        ATTR_BARE.lastIndex = j;
        const bare = ATTR_BARE.exec(s);
        if (!bare) return null;
        value = bare[0];
        j = ATTR_BARE.lastIndex;
      }
    }
    attrs[key[0]] = value;
  }
  if (termline) {
    const sentence = (attrs.v ?? '').trim() || (attrs.text ?? '').trim();
    return { end: j + 1, text: stripMarkers(sentence, false) };
  }
  const name = (attrs.name ?? '').trim();
  return name ? { end: j + 1, text: name } : null;
}

// End of the code span whose opening run of `run` backticks starts at i, or -1 (the run is text).
function codeSpanEnd(s, i, run) {
  let j = s.indexOf('`', i + run);
  while (j !== -1) {
    let k = j;
    while (s[k] === '`') k += 1;
    if (k - j === run) return k;
    j = s.indexOf('`', k);
  }
  return -1;
}

// One paragraph: code spans stay, directives become their text, markers their name.
function stripInline(s) {
  let out = '';
  let text = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '`') {
      let run = 1;
      while (s[i + run] === '`') run += 1;
      const end = codeSpanEnd(s, i, run);
      if (end === -1) {
        text += s.slice(i, i + run);
        i += run;
      } else {
        out += stripMarkers(text, true) + s.slice(i, end);
        text = '';
        i = end;
      }
      continue;
    }
    const directive = s[i] === ':' ? directiveAt(s, i) : null;
    if (directive) {
      out += stripMarkers(text, true) + directive.text;
      text = '';
      i = directive.end;
      continue;
    }
    text += s[i];
    i += 1;
  }
  return out + stripMarkers(text, true);
}

export function stripConceptMarkup(text) {
  if (typeof text !== 'string') return '';
  const out = [];
  let para = [];
  let fence = null;
  const flush = () => {
    if (para.length) out.push(stripInline(para.join('\n')));
    para = [];
  };
  for (const line of text.split('\n')) {
    if (fence) {
      out.push(line);
      const close = FENCE_CLOSE.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open || !line.trim()) {
      flush();
      out.push(line);
      if (open) fence = open[1];
      continue;
    }
    para.push(line);
  }
  flush();
  return out.join('\n');
}

// The compact readout next to the notice. Side tokens are always an estimate.
function fitReadout(state) {
  const side = formatTokenCount(state.sideTokens);
  if (state.fit === 'yes') return `✓ Fits: about ${side} tokens (estimated) of ${formatTokenCount(state.available)} available.`;
  if (state.fit === 'no') return `✗ No room: about ${side} tokens (estimated), ${formatTokenCount(state.available)} available.`;
  return `? Window not reported: about ${side} tokens (estimated).`;
}

// ── Exchanges: the nodes of the graph ──────────────────────────────────────────────────────

// One line, at most `max` characters, with an ellipsis when cut.
export function shortLabel(text, max = LABEL_MAX) {
  // Markup the reader never sees in the chat: HTML comments and leading quote marks.
  const raw = typeof text === 'string' ? text.replace(/<!--[\s\S]*?-->/g, ' ').replace(/^(\s*>)+\s*/, '') : '';
  const line = raw.replace(/\s+/g, ' ').trim();
  if (!line) return '(no text)';
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

// Runs of whitespace become one space; the ends are trimmed.
export const normalizeText = (text) => (typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '');

// The header text of a merge message: everything after `From side chat: ` up to the first blank
// line (it may span lines). It carries the side question. null when the text is not a merge message.
export function mergeHeader(text) {
  if (typeof text !== 'string' || !text.startsWith(MERGE_HEADER)) return null;
  return text.slice(MERGE_HEADER.length).split(/\n[ \t]*\r?\n/)[0].trim();
}

// One exchange per user message: { user, reply, label, merge }. The reply joins the non-empty
// assistant texts until the next user message; tool and system rows are skipped. An unanswered
// last message is still an exchange. merge is the normalized header text of a merge message, else null.
export function exchangesFromRows(rows) {
  const out = [];
  let current = null;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.role === 'user') {
      const user = rowText(row);
      const header = mergeHeader(user);
      const merge = header === null ? null : normalizeText(header);
      current = { user, reply: '', label: shortLabel(merge === null ? user : `Merged: ${merge || 'side chat'}`), merge };
      // The user row's durable id: the scroll to this exchange reveals it by row.
      if (Number.isInteger(row.row_id)) current.rowId = row.row_id;
      out.push(current);
    } else if (row?.role === 'assistant' && current) {
      const text = rowText(row);
      if (text) current.reply = current.reply ? `${current.reply}\n${text}` : text;
    }
  }
  return out;
}

// How many leading exchanges a child chat shares with its parent: its fork point.
export function sharedExchangeCount(child, parent) {
  const a = Array.isArray(child) ? child : [];
  const b = Array.isArray(parent) ? parent : [];
  let n = 0;
  while (n < a.length && n < b.length && a[n].user === b[n].user && a[n].reply === b[n].reply) n += 1;
  return n;
}

// ── Branch here: the `count` of session.branch ─────────────────────────────────────────────
//
// session.branch keeps history[:count] of the parent's branch source history. That history holds
// only user and assistant rows with visible text (tui_gateway/methods_session_branch.py
// _visible_branch_history). The desktop's own branch from a message counts the same rows
// (apps/desktop/src/app/session/hooks/use-session-actions/utils.ts toBranchMessages).
//
// The pane numbers exchanges from the same history rows it reads (session.transcript or
// session.history), as exchangesFromRows does: each user row starts the next exchange. For
// exchange `index`:
//   count   = the number of user and assistant rows with non-empty text, from the first row up to
//             and including the last assistant row with text in that exchange.
//   through = the highest row_id in that exchange up to that row, or null when rows carry no
//             row_id. It goes out as through_message_id: the canonical gateway cuts at that row and
//             refuses `count` alone. The legacy client strips it and uses `count`
//             (apps/desktop/src/api/client.ts LEGACY_STRIP, as the desktop's branchThroughRowId).
// Not counted: tool rows, system rows, rows with no text (an assistant tool call, an empty user
// row). Counted: an assistant row before the first user row, because the gateway keeps it.
// Example: [user q1, assistant a1, user q2, assistant (tool call, no text), tool, assistant a2]
// gives exchange 0 -> count 2, exchange 1 -> count 4.
// That rule counts only the rows the pane reads. The gateway also counts rows that no history shows,
// such as `[System:` notes and hidden rows, so the count can come out short. A history.read row
// carries branch_index, its position in the gateway's own list. When the last answer row of the
// exchange has one, count = branch_index + 1, exactly. Such a row counts as an answer even when the
// reply cap of history.read emptied its text.
// null when the exchange does not exist or has no answer yet: the branch would end on a question.
export function branchCount(rows, index) {
  if (!Number.isInteger(index) || index < 0) return null;
  let exchange = -1;
  let visible = 0;
  let maxId = 0;
  let found = null;
  for (const row of Array.isArray(rows) ? rows : []) {
    const role = row?.role;
    if (role === 'user') {
      exchange += 1;
      if (exchange > index) break;
    }
    const text = rowText(row);
    if ((role === 'user' || role === 'assistant') && text) visible += 1;
    if (exchange !== index) continue;
    if (Number.isInteger(row?.row_id) && row.row_id > maxId) maxId = row.row_id;
    const at = Number.isInteger(row?.branch_index) && row.branch_index >= 0 ? row.branch_index : null;
    if (role === 'assistant' && (text || at !== null)) {
      found = { count: at === null ? visible : at + 1, through: maxId > 0 ? maxId : null };
    }
  }
  return found;
}

// ── Branch here: the model the user picks ──────────────────────────────────────────────────
//
// The user picks the branch model and reasoning level in Hermes's own ModelCatalogMenu (Rohan,
// 2026-11-12 01:05). A choice is { model, provider, effort }, as the kanban plugin's per-task
// override holds it (plugins/kanban/model-override.tsx). effort: '' is the default, 'none' is
// thinking off, else a reasoning level. EMPTY_CHOICE: nothing picked, the chat's own model.
export const EMPTY_CHOICE = Object.freeze({ model: '', provider: '', effort: '' });

// The one-turn model_override of prompt.submit for a choice, or null when no model is picked.
// Only model, provider and reasoning: any other key fails with invalid_params
// (gateway/session_cli_turn.py:40-53). A key the user did not set is left out.
export function modelOverride(choice) {
  const model = str(choice?.model);
  if (!model) return null;
  const provider = str(choice?.provider);
  const reasoning = str(choice?.effort);
  return { model, ...(provider ? { provider } : {}), ...(reasoning ? { reasoning } : {}) };
}

// The picker button text: `provider: model · level`, or MODEL_INHERIT_TEXT when nothing is picked.
export function choiceLabel(choice, effortLabel) {
  const model = str(choice?.model);
  if (!model) return MODEL_INHERIT_TEXT;
  const provider = str(choice?.provider);
  const effort = str(choice?.effort);
  const level = effort ? (typeof effortLabel === 'function' ? str(effortLabel(effort)) || effort : effort) : '';
  const base = provider ? `${provider}: ${model}` : model;
  return level ? `${base} · ${level}` : base;
}

// ── Merge back: targets, the merged part, the staged text, digests ─────────────────────────

// The merge targets of the open chat: its ancestors in the loaded tree, parent first, up to the root.
export function mergeTargets(lanes, openId) {
  const byId = new Map((Array.isArray(lanes) ? lanes : []).map((lane) => [lane.id, lane]));
  const out = [];
  const seen = new Set([openId]);
  for (let lane = byId.get(openId); lane?.parentId && !seen.has(lane.parentId); ) {
    const parent = byId.get(lane.parentId);
    if (!parent) break;
    seen.add(parent.id);
    out.push({ id: parent.id, title: parent.title });
    lane = parent;
  }
  return out;
}

// The picked target while it is still an ancestor of the open chat, else the parent (the default).
export function selectedTarget(targets, selection, openId) {
  const list = Array.isArray(targets) ? targets : [];
  const picked = selection && selection.chatId === openId ? list.find((t) => t.id === selection.id) : null;
  return picked ?? list[0] ?? null;
}

// The open chat's own part, from its fork point on. question: its first own user message, the
// merge header (the tree links a merge node to its chat by it). turns: the answered own exchanges.
export function ownPart(exchanges, fork) {
  const own = (Array.isArray(exchanges) ? exchanges : []).slice(Math.max(0, Number.isInteger(fork) ? fork : 0));
  return {
    question: own.length ? own[0].user : '',
    turns: own.filter((ex) => str(ex.reply)).map((ex) => ({ question: ex.user, answer: ex.reply })),
  };
}

// The Merge as-is body: `You:` and `Assistant:` blocks, as side-chat's formatSideVerbatim writes them.
export const verbatimBody = (turns) =>
  (Array.isArray(turns) ? turns : []).map((turn) => `You:\n${turn.question}\n\nAssistant:\n${turn.answer}`).join('\n\n');

// The staged text: `From side chat: <question>` on one line, a blank line, then the body with
// concept-link markup removed. Whitespace runs in the question become one space, so a question
// with blank lines still ends the header at its first blank line and still matches its chat.
export function formatMergeText(question, body) {
  return `${MERGE_HEADER}${normalizeText(question) || 'Side chat'}\n\n${stripConceptMarkup(str(body))}`;
}

// The digest request without its session_id. purpose: 'fork' (the part a branch fixed) or
// 'merge' (a chat's own part). The model reads each question and answer with concept-link markup
// removed, as the staged text has it.
export function digestRequest(purpose, title, exchanges) {
  return {
    purpose,
    title: str(title),
    exchanges: (Array.isArray(exchanges) ? exchanges : []).map((ex) => ({
      question: stripConceptMarkup(ex?.question),
      answer: stripConceptMarkup(ex?.answer),
    })),
  };
}

// The job id of a digest request or event: a non-empty string or a number, as a string; else ''.
export const digestJob = (job) => (typeof job === 'number' && Number.isFinite(job) ? String(job) : str(job));

// A digest event, checked. The gateway puts the plugin's fields under `payload`
// (apps/shared/src/gateway-events.ts GatewayEvent); a flat event is read too.
// { job, ok: true, digest } or { job, ok: false, error }; job is '' when the event names none.
export function digestResult(event) {
  const p = event?.payload && typeof event.payload === 'object' ? event.payload : event;
  const job = digestJob(p?.job);
  if (typeof p?.digest === 'string' && p.digest.trim() && !str(p?.error)) return { job, ok: true, digest: p.digest.trim() };
  return { job, ok: false, error: str(p?.error) || 'The digest backend sent no digest.' };
}

// The history.read reply, checked: { histories: Map(id -> rows), missing: Set(id) }, or null when
// the reply has no histories object. A history that is not a list is left out (read as not answered).
export function parseHistoryReply(result) {
  const raw = result?.histories;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const histories = new Map();
  for (const [id, rows] of Object.entries(raw)) if (Array.isArray(rows)) histories.set(id, rows);
  const missing = new Set((Array.isArray(result?.missing) ? result.missing : []).filter((id) => typeof id === 'string'));
  return { histories, missing };
}

// A history is read again only when its chat's message count or last activity moved.
// null (no metadata) means: always read.
export function historyKey(row) {
  const count = num(row?.message_count);
  const active = num(row?.last_active);
  return count || active ? `${count}:${active}` : null;
}

// One lane per chat: { id, row, title, model, side, parentId, exchanges, fork }. fork is the
// number of exchanges shared with the parent lane (0 for the root). sideIds: the branch ids this
// pane stored (isSideChat).
export function buildLanes(chats, exchangesById, sideIds) {
  const lanes = [];
  const byId = new Map();
  for (const { row, parentId } of Array.isArray(chats) ? chats : []) {
    const exchanges = Array.isArray(exchangesById?.[row.id]) ? exchangesById[row.id] : [];
    const parent = parentId ? byId.get(parentId) : null;
    const lane = {
      id: row.id,
      row,
      title: str(row.title) || 'Untitled',
      model: str(row.model),
      side: isSideChat(row, sideIds),
      parentId: parent ? parent.id : null,
      exchanges,
      fork: parent ? sharedExchangeCount(exchanges, parent.exchanges) : 0,
    };
    byId.set(lane.id, lane);
    lanes.push(lane);
  }
  return lanes;
}

// ── Graph plan: row order, forks, merges, the blue path, collapse, and columns ──────────────

// The lane that draws exchange `index` of chat `id`: up the parents while that exchange is shared.
function drawer(byId) {
  return (id, index) => {
    let lane = byId.get(id);
    const seen = new Set();
    while (lane && lane.parentId && index < lane.fork && !seen.has(lane.id)) {
      seen.add(lane.id);
      lane = byId.get(lane.parentId);
    }
    return lane ? { lane: lane.id, index } : null;
  };
}

// rows: [{ kind: 'node', key, lane, index, label, merge, mergeFrom, blue, hover, open, first, target,
//          branchable, digest, stub } |
//        { kind: 'more', key, runKey, lane, index, count, blue, hover, target }], oldest first, each with col.
// lanes: [{ id, col, rows, firstRow, lastRow, anchorRow, anchorCol, target }] for lanes with rows.
// merges: [{ from, fromRow, to, toRow }]: a curve from a side lane's last row to a merge node.
// A node `lane:index` is drawn once, on the lane that owns it: the shared exchanges of a child
// are its parent's. options: { focusedId, open: { chatId, index } | null, expanded: { [runKey]: true },
// target: the merge target lane id (its rows and lane get target: true), digests: { 'chatId:index':
// fork digest } (each goes to the node that draws that exchange), hovered: the node key under the
// pointer (its path gets hover: true) }. branchable: an answered
// exchange of the focused chat, where Branch here applies.
//
// Name rows: { kind: 'name', key: 'name:<chat id>', lane, index, label, model, count, merged, blue,
// hover, open, first, target }. In the exchanges view (the default) every child lane starts with
// one name row: its Hermes title, right after its fork elbow and before its first own row. The
// elbow lands on it. index is the lane's first own exchange (or its stub). options.mode
// 'branches' plans every lane fully collapsed: one name row per chat (the root too), with
// count (its own exchanges), merged (a merge node in an ancestor names it) and open (the focused chat).
export function planGraph(lanes, options = {}) {
  const list = Array.isArray(lanes) ? lanes : [];
  const byId = new Map(list.map((lane) => [lane.id, lane]));
  const start = (lane) => (lane.parentId ? Math.min(lane.fork, lane.exchanges.length) : 0);
  const nodeKey = (id, index) => `${id}:${index}`;
  const branchesMode = options.mode === BRANCHES_MODE;
  const resolve = drawer(byId);
  const mergeLane = typeof options.target === 'string' && byId.has(options.target) ? options.target : null;
  // A child with no exchange of its own yet (a fork just made) draws one stub node at index
  // start(lane), where its first exchange will go: right after its fork elbow. The stub has the
  // key that node will have, so it turns into that node once the exchange exists.
  // A child that shares nothing has no exact fork point, so no stub (its history may be unread).
  const stubbed = (lane) => Boolean(lane?.parentId) && lane.fork > 0 && start(lane) >= lane.exchanges.length;
  // The node that draws exchange `index` of chat `id`, or the stub of a chat with none of its own.
  const nodeAt = (id, index) => {
    const lane = byId.get(id);
    if (!lane || !Number.isInteger(index) || index < 0) return null;
    if (index < lane.exchanges.length) return resolve(id, index);
    return stubbed(lane) && index === start(lane) ? { lane: id, index } : null;
  };

  // Each child leaves its parent at the node of the last shared exchange. A child that shares
  // nothing has no fork node: it starts its own lane after its parent's rows.
  const anchorOf = new Map();
  const anchored = new Map();
  const loose = new Map();
  for (const lane of list) {
    if (!lane.parentId) continue;
    const at = lane.fork > 0 ? resolve(lane.parentId, lane.fork - 1) : null;
    if (at) {
      anchorOf.set(lane.id, at);
      const key = nodeKey(at.lane, at.index);
      anchored.set(key, [...(anchored.get(key) ?? []), lane]);
    } else {
      loose.set(lane.parentId, [...(loose.get(lane.parentId) ?? []), lane]);
    }
  }

  // The open node: the clicked node while its chat is focused, else the focused chat's last exchange.
  const focused = byId.get(options.focusedId);
  const open = options.open;
  let target = null;
  if (focused && open && open.chatId === focused.id && Number.isInteger(open.index) && open.index >= 0 && open.index < focused.exchanges.length) {
    target = resolve(focused.id, open.index);
  } else if (focused && stubbed(focused)) {
    target = { lane: focused.id, index: start(focused) };
  } else if (focused && focused.exchanges.length) {
    target = resolve(focused.id, focused.exchanges.length - 1);
  }
  const openKey = target ? nodeKey(target.lane, target.index) : null;

  // The node keys on each lane from a node up through the fork nodes to the root's first exchange.
  const pathFrom = (from) => {
    const keys = new Set();
    for (let at = from, guard = new Set(); at && !guard.has(at.lane); at = anchorOf.get(at.lane) ?? null) {
      guard.add(at.lane);
      const lane = byId.get(at.lane);
      for (let i = start(lane); i <= at.index; i++) keys.add(nodeKey(lane.id, i));
    }
    return keys;
  };
  // Blue: the path of the open node. Hover: the path of options.hovered, the node key under the pointer.
  const blue = pathFrom(target);
  let hoverAt = null;
  if (typeof options.hovered === 'string' && options.hovered.startsWith(NAME_PREFIX)) {
    // A name row under the pointer: the path of its lane's first own exchange (or stub).
    const lane = byId.get(options.hovered.slice(NAME_PREFIX.length));
    if (lane) hoverAt = nodeAt(lane.id, start(lane));
  } else if (typeof options.hovered === 'string') {
    const cut = options.hovered.lastIndexOf(':');
    if (cut > 0) hoverAt = nodeAt(options.hovered.slice(0, cut), Number(options.hovered.slice(cut + 1)));
  }
  const hover = pathFrom(hoverAt);

  // Branch here: every answered exchange in the tree, on the node that draws it. The value is the
  // chat that branches there (branchFrom): the focused chat for its own path, else the chat that
  // owns the node. Hermes branches only a loaded chat, so the pane opens that chat first.
  const branchable = new Map();
  if (focused) {
    focused.exchanges.forEach((ex, i) => {
      const at = str(ex.reply) ? resolve(focused.id, i) : null;
      if (at) branchable.set(nodeKey(at.lane, at.index), focused.id);
    });
  }
  for (const lane of list) {
    lane.exchanges.forEach((ex, i) => {
      const at = str(ex.reply) ? resolve(lane.id, i) : null;
      if (at && !branchable.has(nodeKey(at.lane, at.index))) branchable.set(nodeKey(at.lane, at.index), at.lane);
    });
  }
  // Fork digests, joined per node when two chats forked at one shared exchange.
  const digestOf = new Map();
  for (const [key, text] of Object.entries(options.digests ?? {})) {
    const cut = key.lastIndexOf(':');
    const index = Number(key.slice(cut + 1));
    const lane = byId.get(key.slice(0, cut));
    const at = lane && Number.isInteger(index) && index >= 0 && index < lane.exchanges.length && str(text) ? resolve(lane.id, index) : null;
    if (!at) continue;
    const node = nodeKey(at.lane, at.index);
    digestOf.set(node, digestOf.has(node) ? `${digestOf.get(node)}\n\n${str(text)}` : str(text));
  }

  // Rows, depth first: a lane's own exchanges in order, each fork node followed by its children.
  const expanded = options.expanded ?? {};
  const rows = [];
  const visited = new Set();
  const pushNode = (lane, i) => {
    const ex = lane.exchanges[i];
    const key = nodeKey(lane.id, i);
    rows.push({
      kind: 'node',
      key,
      lane: lane.id,
      index: i,
      label: ex.label,
      merge: ex.merge,
      mergeFrom: null,
      blue: blue.has(key),
      hover: hover.has(key),
      open: key === openKey,
      first: false,
      target: lane.id === mergeLane,
      branchable: branchable.has(key),
      branchFrom: branchable.get(key) ?? null,
      digest: digestOf.get(key) ?? null,
      stub: false,
    });
  };
  const pushStub = (lane) => {
    const key = nodeKey(lane.id, start(lane));
    rows.push({
      kind: 'node',
      key,
      lane: lane.id,
      index: start(lane),
      label: str(lane.row?.title) || NEW_BRANCH_TEXT,
      merge: null,
      mergeFrom: null,
      blue: blue.has(key),
      hover: hover.has(key),
      open: key === openKey,
      first: false,
      target: lane.id === mergeLane,
      branchable: false,
      branchFrom: null,
      digest: null,
      stub: true,
    });
  };
  // The chats from the focused chat up to the root: the open path of the branches view.
  const pathLanes = new Set();
  for (let lane = focused; lane && !pathLanes.has(lane.id); lane = lane.parentId ? byId.get(lane.parentId) : null) pathLanes.add(lane.id);
  const pushName = (lane) => {
    const first = nodeKey(lane.id, start(lane));
    rows.push({
      kind: 'name',
      key: `${NAME_PREFIX}${lane.id}`,
      lane: lane.id,
      index: start(lane),
      label: lane.title,
      model: lane.model,
      count: Math.max(0, lane.exchanges.length - start(lane)),
      merged: false,
      blue: branchesMode ? pathLanes.has(lane.id) : blue.has(first),
      hover: hover.has(first),
      open: branchesMode && lane.id === focused?.id,
      first: false,
      target: lane.id === mergeLane,
    });
  };
  const emit = (lane) => {
    if (visited.has(lane.id)) return;
    visited.add(lane.id);
    const n = lane.exchanges.length;
    const s = start(lane);
    if (branchesMode) {
      // Every lane fully collapsed: its name row, then its children in fork order.
      pushName(lane);
      for (let i = 0; i < n; i++) for (const kid of anchored.get(nodeKey(lane.id, i)) ?? []) emit(kid);
      for (const kid of loose.get(lane.id) ?? []) emit(kid);
      return;
    }
    // A child lane with rows of its own starts with its name row. Collapse never takes it.
    if (lane.parentId && (stubbed(lane) || s < n)) pushName(lane);
    if (stubbed(lane)) pushStub(lane);
    const keep = new Set([s, n - 1]);
    for (let i = s; i < n; i++) {
      const key = nodeKey(lane.id, i);
      if (anchored.has(key) || lane.exchanges[i].merge !== null || key === openKey) keep.add(i);
    }
    for (let i = s; i < n; ) {
      if (keep.has(i)) {
        pushNode(lane, i);
        for (const kid of anchored.get(nodeKey(lane.id, i)) ?? []) emit(kid);
        i += 1;
        continue;
      }
      let j = i;
      while (j < n && !keep.has(j)) j += 1;
      const runKey = nodeKey(lane.id, i);
      if (j - i >= 3 && !expanded[runKey]) {
        rows.push({ kind: 'more', key: `more:${runKey}`, runKey, lane: lane.id, index: i, count: j - i, blue: blue.has(runKey), hover: hover.has(runKey), target: lane.id === mergeLane });
      } else {
        for (let k = i; k < j; k++) pushNode(lane, k);
      }
      i = j;
    }
    for (const kid of loose.get(lane.id) ?? []) emit(kid);
  };
  for (const lane of list) if (!lane.parentId) emit(lane);
  for (const lane of list) emit(lane); // a lane whose parent is not in the list

  const rowOf = new Map(rows.map((row, index) => [row.key, index]));
  const info = new Map();
  rows.forEach((row, index) => {
    const entry = info.get(row.lane) ?? { id: row.lane, rows: [], firstRow: index, lastRow: index, anchorRow: -1, anchorCol: -1, col: 0, end: index, target: row.lane === mergeLane };
    entry.rows.push(index);
    entry.lastRow = index;
    entry.end = index;
    info.set(row.lane, entry);
  });
  // first: the lane's first exchange row (its side pill), the name row only in the branches view.
  for (const entry of info.values()) rows[entry.rows.find((i) => rows[i].kind !== 'name') ?? entry.firstRow].first = true;

  // Merge links: the header text carries the side question. Link only when exactly one chat
  // below the merge node's chat has a first own exchange with that text. Titles never count:
  // Hermes cuts and renames them. Zero or several matches, or a match not above the node: no curve.
  const below = (id, ancestorId) => {
    const seen = new Set();
    for (let lane = byId.get(id); lane && lane.parentId && !seen.has(lane.id); lane = byId.get(lane.parentId)) {
      seen.add(lane.id);
      if (lane.parentId === ancestorId) return true;
    }
    return false;
  };
  const merges = [];
  rows.forEach((row, index) => {
    if (row.kind !== 'node' || !row.merge) return;
    const matches = list.filter((lane) => {
      const first = lane.exchanges[start(lane)];
      return lane.parentId && first && normalizeText(first.user) === row.merge && below(lane.id, row.lane);
    });
    const pick = matches.length === 1 ? matches[0] : null;
    const entry = pick ? info.get(pick.id) : null;
    if (!entry || entry.lastRow >= index) return;
    row.mergeFrom = pick.id;
    entry.end = Math.max(entry.end, index);
    merges.push({ from: pick.id, fromRow: entry.lastRow, to: row.lane, toRow: index });
  });
  // The branches view has no merge nodes: a chat that a merge node in an ancestor names is merged.
  if (branchesMode) {
    const merged = new Set();
    for (const lane of list) {
      for (let i = start(lane); i < lane.exchanges.length; i++) {
        const text = lane.exchanges[i].merge;
        if (!text) continue;
        const matches = list.filter((kid) => {
          const first = kid.exchanges[start(kid)];
          return kid.parentId && first && normalizeText(first.user) === text && below(kid.id, lane.id);
        });
        if (matches.length === 1) merged.add(matches[0].id);
      }
    }
    for (const row of rows) row.merged = merged.has(row.lane);
  }

  // Columns: a lane holds its column from its fork node to its last row (or its last merge).
  // A child sits right of the lane it forks from; the lowest free column wins.
  for (const [id, entry] of info) {
    const at = anchorOf.get(id);
    if (at) entry.anchorRow = rowOf.get(branchesMode ? `${NAME_PREFIX}${at.lane}` : nodeKey(at.lane, at.index)) ?? -1;
  }
  const order = [...info.values()].sort((a, b) => (a.anchorRow >= 0 ? a.anchorRow : a.firstRow) - (b.anchorRow >= 0 ? b.anchorRow : b.firstRow) || a.firstRow - b.firstRow);
  const placed = [];
  for (const entry of order) {
    const lane = byId.get(entry.id);
    const from = entry.anchorRow >= 0 ? info.get(anchorOf.get(entry.id).lane) : lane.parentId ? info.get(lane.parentId) : null;
    const begin = entry.anchorRow >= 0 ? entry.anchorRow : entry.firstRow;
    let col = from ? from.col + 1 : 0;
    // The branches view is an outline: a chat sits one column right of its parent, always.
    while (!branchesMode && placed.some((p) => p.col === col && p.begin <= entry.end && begin <= p.end)) col += 1;
    entry.col = col;
    if (entry.anchorRow >= 0) entry.anchorCol = from.col;
    placed.push({ col, begin, end: entry.end });
  }
  for (const row of rows) row.col = info.get(row.lane).col;

  const laneList = [...info.values()].map(({ end, ...entry }) => entry);
  return { rows, lanes: laneList, merges, openKey, ...(branchesMode ? { mode: BRANCHES_MODE } : {}) };
}

// The plan with `span` spacer rows after row `after` (the merge result line under its row). Every
// row index past `after` moves down by `span`, so lane lines, fork elbows and merge curves run on
// through the spacer. A plan with no such row comes back unchanged.
export function withSpacer(plan, after, span, spacer = {}) {
  const rows = Array.isArray(plan?.rows) ? plan.rows : [];
  if (!Number.isInteger(after) || after < 0 || after >= rows.length || !(span >= 1)) return plan;
  const at = (i) => (Number.isInteger(i) && i > after ? i + span : i);
  const key = spacer.key ?? 'spacer';
  const pad = Array.from({ length: span }, (_, k) => ({ ...spacer, kind: 'spacer', key: `${key}:${k}`, spanIndex: k, span }));
  return {
    ...plan,
    rows: [...rows.slice(0, after + 1), ...pad, ...rows.slice(after + 1)],
    lanes: (Array.isArray(plan.lanes) ? plan.lanes : []).map((lane) => ({
      ...lane,
      rows: Array.isArray(lane.rows) ? lane.rows.map(at) : lane.rows,
      firstRow: at(lane.firstRow),
      lastRow: at(lane.lastRow),
      anchorRow: lane.anchorRow >= 0 ? at(lane.anchorRow) : lane.anchorRow,
      ...(Number.isInteger(lane.end) ? { end: at(lane.end) } : {}),
    })),
    merges: (Array.isArray(plan.merges) ? plan.merges : []).map((m) => ({ ...m, fromRow: at(m.fromRow), toRow: at(m.toRow) })),
  };
}

// ── Graph geometry: a pure function of the plan, in px ──────────────────────────────────────

const laneX = (col) => GRAPH_PAD + col * LANE_GAP;
const rowY = (row) => row * ROW_H + ROW_H / 2;

// { width, height, circles: [{ key, cx, cy, r, role, filled, target }], paths: [{ key, d, role, target }] }.
// role is the colour role: 'hover' on the path of the hovered node (it wins where it overlaps the
// open path), else 'active' on the open path and on the merge target lane, else 'inactive'. The
// pane maps roles to theme colours (ROLE_COLOURS). target marks the merge target lane: its line,
// fork elbow and nodes, drawn thicker with a dashed line. Lane lines stop at circle edges. A fork leaves its node sideways, turns down with a rounded
// corner, and runs to the child's first node. A merge runs down from the side lane's last node
// and turns into the merge node. Merge curves are always inactive: a merged chat is not on a path.
export function graphGeometry(plan) {
  const rows = Array.isArray(plan?.rows) ? plan.rows : [];
  const lanes = Array.isArray(plan?.lanes) ? plan.lanes : [];
  const maxCol = rows.reduce((m, row) => Math.max(m, num(row.col)), 0);
  const width = Math.max(GRAPH_W, GRAPH_PAD * 2 + maxCol * LANE_GAP);
  const height = rows.length * ROW_H;
  const roleOf = (row, target) => (row.hover ? 'hover' : row.blue || target ? 'active' : 'inactive');
  const edge = (index) => (rows[index].kind === 'node' ? NODE_R : 0);
  const outline = plan?.mode === BRANCHES_MODE;
  const paths = [];
  for (const lane of lanes) {
    const x = laneX(lane.col);
    for (let k = 1; k < lane.rows.length; k++) {
      const a = lane.rows[k - 1];
      const b = lane.rows[k];
      paths.push({ key: `lane:${lane.id}:${a}`, d: `M ${x} ${rowY(a) + edge(a)} V ${rowY(b) - edge(b)}`, role: roleOf(rows[b], lane.target === true), target: lane.target === true });
    }
    if (lane.anchorRow >= 0 && outline) {
      // The branches view: down the parent's column, then a rounded turn right into the chat's row.
      const xa = laneX(lane.anchorCol);
      const yc = rowY(lane.firstRow);
      const d = `M ${xa} ${rowY(lane.anchorRow)} V ${yc - CURVE_R} A ${CURVE_R} ${CURVE_R} 0 0 0 ${xa + CURVE_R} ${yc} H ${x}`;
      paths.push({ key: `fork:${lane.id}`, d, role: roleOf(rows[lane.firstRow], lane.target === true), target: lane.target === true });
    } else if (lane.anchorRow >= 0) {
      const xa = laneX(lane.anchorCol);
      const ya = rowY(lane.anchorRow);
      // The elbow lands on the lane's first row: its name row (no circle), else its first node.
      const d = `M ${xa + edge(lane.anchorRow)} ${ya} H ${x - CURVE_R} A ${CURVE_R} ${CURVE_R} 0 0 1 ${x} ${ya + CURVE_R} V ${rowY(lane.firstRow) - edge(lane.firstRow)}`;
      paths.push({ key: `fork:${lane.id}`, d, role: roleOf(rows[lane.firstRow], lane.target === true), target: lane.target === true });
    }
  }
  for (const merge of Array.isArray(plan?.merges) ? plan.merges : []) {
    const xs = laneX(rows[merge.fromRow].col);
    const xt = laneX(rows[merge.toRow].col);
    const y0 = rowY(merge.fromRow) + NODE_R;
    const y1 = rowY(merge.toRow);
    let d = `M ${xs} ${y0} V ${y1 - NODE_R}`;
    if (xs > xt) d = `M ${xs} ${y0} V ${y1 - CURVE_R} A ${CURVE_R} ${CURVE_R} 0 0 1 ${xs - CURVE_R} ${y1} H ${xt + NODE_R}`;
    else if (xs < xt) d = `M ${xs} ${y0} V ${y1 - CURVE_R} A ${CURVE_R} ${CURVE_R} 0 0 0 ${xs + CURVE_R} ${y1} H ${xt - NODE_R}`;
    paths.push({ key: `merge:${merge.from}:${merge.toRow}`, d, role: 'inactive', target: false });
  }
  const circles = [];
  rows.forEach((row, index) => {
    if (row.kind !== 'node') return;
    circles.push({ key: row.key, cx: laneX(row.col), cy: rowY(index), r: NODE_R, role: roleOf(row, row.target === true), filled: row.open === true, target: row.target === true });
  });
  // Outline elbows of one parent share its column: the open and hover paths draw last, on top.
  if (outline) {
    const rank = { inactive: 0, active: 1, hover: 2 };
    paths.sort((a, b) => rank[a.role] - rank[b.role]);
  }
  // Name rows: a small filled square on the lane line (larger on the open chat's row).
  const marks = [];
  rows.forEach((row, index) => {
    if (row.kind !== 'name') return;
    const size = row.open ? MARK_SIZE + 2 : MARK_SIZE;
    marks.push({ key: row.key, x: laneX(row.col) - size / 2, y: rowY(index) - size / 2, size, role: roleOf(row, row.target === true) });
  });
  return { width, height, circles, paths, marks };
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
export function openOptions(owner, intent = 'tab') {
  const route = routeFor(owner);
  if (route && route.mode === 'remote') return { intent, route };
  const profile = str(owner?.profile);
  return profile ? { intent, profile } : { intent };
}

const profileKey = (v) => str(v) || 'default'; // store/profile.ts normalizeProfileKey

// The model id without its provider path: `anthropic/claude-x` reads `claude-x`.
const modelName = (model) => str(model).split('/').pop();

// Runs fn over items, at most `limit` at a time. fn must not throw.
async function eachLimited(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// Inline styles, not host classes: the plugin cannot rely on the host's CSS having them.
// A block of the pane never grows past the pane's width (a narrow side pane).
export const BLOCK = { ...SELECTABLE, width: '100%', minWidth: 0, boxSizing: 'border-box', overflowX: 'hidden' };
// The pane root. Radix ScrollArea puts its children in a display:table div that grows to its
// content's min-content width; width 0 with min-width 100% keeps the root at the viewport's width.
export const PANE_ROOT = { ...SELECTABLE, ...BLOCK, display: 'block', width: 0, minWidth: '100%' };
// A note, a message or an error line: it wraps inside the pane, also a long word or path.
export const NOTE = { ...SELECTABLE, whiteSpace: 'normal', overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0, maxWidth: '100%', margin: 0 };
export const ROW_STYLE = {
  ...SELECTABLE,
  height: ROW_H,
  width: '100%',
  minWidth: 0,
  boxSizing: 'border-box',
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  paddingRight: 4,
  overflow: 'hidden',
  whiteSpace: 'nowrap',
  cursor: 'pointer',
};
// The open row: the accent at 14 %, as Hermes tints its active tab (components/ui/pane-tab.tsx:49).
const OPEN_ROW = { background: `color-mix(in srgb, ${ACCENT} 14%, transparent)`, boxShadow: `inset 2px 0 0 ${ACCENT}` };
const LABEL_STYLE = { ...SELECTABLE, flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const PILL = {
  ...SELECTABLE,
  flex: '0 0 auto',
  maxWidth: 84,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  border: `1px solid ${MUTED}`,
  borderRadius: 4,
  padding: '0 4px',
  fontSize: 10,
  lineHeight: '14px',
};

// A small action button inside a one-line row, and a merge target chip.
const ROW_ACTION = { ...SELECTABLE, flex: '0 0 auto', fontSize: 10, lineHeight: '14px', padding: '0 4px' };
const PICK_HOVER_BG = 'color-mix(in srgb, var(--dt-foreground, #e5e5e5) 10%, transparent)';
const CHIP = { ...SELECTABLE, maxWidth: 140, minWidth: 0, justifyContent: 'flex-start' };
// The row icons: Hermes's own Branch in new chat button draws GitForkIcon at size-3.5, 14 px
// (components/assistant-ui/thread/assistant-message.tsx:1418); the SDK exports it as icons.GitForkIcon.
const BRANCH_GLYPH = { flex: '0 0 auto', width: 14, height: 14 };
// A name row: the fork icon at 12 px, the chat title in 14 px muted text, then its model, muted.
// The name is bigger than the node text (Rohan, 2026-11-12 04:50).
const NAME_GLYPH = { flex: '0 0 auto', width: 12, height: 12, color: MUTED };
const NAME_TEXT = { fontSize: 14, color: MUTED };
// A node row's label: 12 px, smaller than the name rows.
const NODE_TEXT = { fontSize: 12 };
const NAME_MODEL = { ...SELECTABLE, flex: '0 0 auto', maxWidth: 72, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11, color: MUTED };
// The view toggle in the pane header: two small segmented buttons.
const MODE_BUTTON = { ...SELECTABLE, flex: '0 0 auto', fontSize: 11, lineHeight: '16px', padding: '1px 6px', border: `1px solid ${MUTED}`, background: 'transparent', color: 'inherit', cursor: 'pointer' };
const MODE_ON = { background: `color-mix(in srgb, ${ACCENT} 14%, transparent)`, borderColor: ACCENT, color: ACCENT };
// One icon slot at a row's right edge. Every node row reserves all three slots, so the icons line
// up in columns and a row never changes width when they show.
const ICON_SLOT = { ...SELECTABLE, flex: '0 0 auto', width: 20, height: 20, minWidth: 20, padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' };
// A Quick Pick item in the merge popover: a label line and a detail line.
const PICK_ITEM = {
  ...SELECTABLE,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'stretch',
  gap: 1,
  width: '100%',
  minWidth: 0,
  boxSizing: 'border-box',
  textAlign: 'left',
  padding: '4px 6px',
  borderRadius: 4,
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  fontSize: 12,
  cursor: 'pointer',
};
const PICK_GROUP = { ...NOTE, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em', color: MUTED, padding: '4px 6px 0' };
const DETAIL = { ...NOTE, fontSize: 11, color: MUTED };
// How an ancestor relates to the open chat, so two ancestors with one title stay apart.
export function targetRelation(i, count) {
  if (i === 0) return count === 1 ? 'Parent (root)' : 'Parent';
  if (i === count - 1) return 'Root';
  return i === 1 ? 'Grandparent' : `Ancestor ${i + 1}`;
}
// The SDK Button centres its children, so the ellipsis lives on an inner span that starts at the left.
const CHIP_TEXT = { ...SELECTABLE, display: 'block', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const INPUT_STYLE = { ...SELECTABLE, width: '100%', boxSizing: 'border-box' };

export function createChatTree(deps) {
  const { host, jsx, jsxs, atom, useValue, Button, ScrollArea } = deps;
  const Input = deps.Input ?? 'input';
  const BranchIcon = deps.BranchIcon ?? null;
  // Merge as-is sends its text as a message (the default); false keeps the older staged draft.
  const mergeSends = deps.mergeSends !== false;
  // Row and header icons (sdk.icons, sdk.Codicon) and tooltips (sdk.Tip). Each falls back: a drawn
  // icon, the native title.
  const MergeCodicon = deps.Codicon ?? null;
  const TabIcon = deps.TabIcon ?? null;
  const ViewIcon = deps.ViewIcon ?? null;
  const RefreshIcon = deps.RefreshIcon ?? null;
  const Tip = deps.Tip ?? null;
  // The merge pick opens in Hermes's Popover at the row. Without it, the pick shows under the graph.
  const pop = deps.Popover && deps.PopoverTrigger && deps.PopoverContent ? { Root: deps.Popover, Trigger: deps.PopoverTrigger, Content: deps.PopoverContent } : null;
  // Hermes's model picker, as the kanban plugin uses it: ModelCatalogMenu inside DropdownMenu,
  // DropdownMenuTrigger and DropdownMenuContent (all SDK exports). null when the SDK lacks one:
  // the Branch form then says so and sends no override.
  const picker =
    deps.ModelCatalogMenu && deps.DropdownMenu && deps.DropdownMenuTrigger && deps.DropdownMenuContent
      ? {
          Menu: deps.ModelCatalogMenu,
          Close: deps.ModelMenuCloseContext?.Provider ?? deps.ModelMenuCloseContext ?? null,
          Root: deps.DropdownMenu,
          Trigger: deps.DropdownMenuTrigger,
          Content: deps.DropdownMenuContent,
          effortLabel: typeof deps.reasoningEffortLabel === 'function' ? deps.reasoningEffortLabel : null,
        }
      : null;

  // rows: last good session rows. agents: last good subagents, for agentsFor (a runtime id).
  // exchanges: { [chat id]: exchanges } for the chats of the focused tree. branchIds: the ids of
  // the branches this pane made (ctx.storage). digests: { 'chatId:index': fork digest } (ctx.storage).
  const $data = atom({ rows: [], agents: [], agentsFor: null, exchanges: {}, branchIds: [], digests: {} });
  // note: why live subagents are not shown (not an error).
  const $status = atom({ loading: false, error: null, note: null });
  // In memory only, never stored. open: { chatId, index } the clicked node. expanded: { [run key]:
  // true } the +N runs the user opened. pick: the open merge popover { rowKey, chatId, step
  // ('where' | 'how'), targetId, prep }. result: the last merge { busy, ok, kind, text, targetId,
  // title, anchor, fit, sideTokens, available }, shown under its row until Dismiss or the next
  // merge. branch: the Branch here form { chatId, index, label, question, model, busy, error }.
  // forkNotice: a failed fork digest, until Dismiss.
  const freshUi = () => ({ open: null, expanded: {}, pick: null, result: null, branch: null, forkNotice: null, mode: EXCHANGES_MODE, rename: null });
  const $ui = atom(freshUi());
  // The node rows under the pointer and under keyboard focus: { pointer, focus } node keys, in
  // memory only. The pointer's node gets the hover path; either one reveals its Branch button.
  // Only SVG colours and those buttons change: nothing is read again.
  const freshHover = () => ({ pointer: null, focus: null, target: null, item: null });
  const $hover = atom(freshHover());
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
  // ctx.storage of this activation; null when the host has none.
  let storage = null;
  // Digest jobs in flight: job id -> finish(result). early: results whose event came before the
  // request's { job } reply. listening: this activation hears the digest event.
  const jobs = new Map();
  const early = new Map();
  let listening = false;
  // chat id -> { key, exchanges }: a history is read again only when historyKey(row) moves.
  let historyCache = new Map();
  // Chat ids a gateway event named since the last landed load: read again, cache or not.
  let named = new Set();
  // Cancels the debounced reload that RELOAD_EVENTS schedule.
  let cancelSoon = null;
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

  // ── ctx.storage (write copied from side-chat; best effort, a store that throws never breaks the pane) ──

  const write = (key, value) => {
    if (disposed) return;
    try {
      const pending = storage?.set?.(key, value);
      if (isThenable(pending)) pending.then(null, () => {});
    } catch {
      // Storage is best effort; the pane still works for this session.
    }
  };
  // The desktop's ctx.storage is synchronous (contrib/plugin.ts createPluginStorage). A
  // promise-based store reads as empty here.
  const read = (key) => {
    try {
      const value = storage?.get?.(key);
      return isThenable(value) ? undefined : value;
    } catch {
      return undefined;
    }
  };
  const storedBranchIds = () => {
    const ids = read(BRANCH_IDS_KEY);
    return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string' && id) : [];
  };

  // Fork digests of every exchange in the tree, read on each load (never in render).
  function readDigests(exchangesById) {
    const out = {};
    for (const [id, list] of Object.entries(exchangesById ?? {})) {
      for (let i = 0; i < (Array.isArray(list) ? list.length : 0); i++) {
        const text = read(digestKey(id, i));
        if (typeof text === 'string' && text.trim()) out[`${id}:${i}`] = text.trim();
      }
    }
    return out;
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

  // Exchanges of every chat in the focused tree. A cached history is used while its chat's
  // message count and last activity hold; a failed read keeps the last good one. The stale chats
  // go in one history.read (stored ids). A chat it does not answer, or every stale chat when it
  // fails, is read the old way, one session.history each. backendMissing: history.read is unknown.
  // fresh: ids read again even when their history key holds (the open chat, chats an event named):
  // the session list's message count and last activity lag live turns.
  async function loadExchanges(rows, focusedId, fresh = new Set()) {
    const chats = lineageChats(buildTree(rows, focusedId));
    const exchanges = {};
    const errors = [];
    const stale = [];
    for (const { row } of chats) {
      const key = historyKey(row);
      const hit = historyCache.get(row.id);
      if (hit && key !== null && hit.key === key && !fresh.has(row.id)) exchanges[row.id] = hit.exchanges;
      else stale.push(row);
    }
    const keep = (row, list) => {
      historyCache.delete(row.id);
      historyCache.set(row.id, { key: historyKey(row), exchanges: list });
      exchanges[row.id] = list;
    };
    let live = stale;
    let backendMissing = false;
    if (stale.length) {
      const batch = await readStored(stale.map((row) => row.id));
      if (batch.ok) {
        live = [];
        for (const row of stale) {
          const list = batch.histories.get(row.id);
          if (list) keep(row, exchangesFromRows(list));
          else live.push(row);
        }
      } else if (batch.missing) backendMissing = true;
      else errors.push(`Stored histories: ${batch.error}`);
    }
    // session.history knows the open chat by its runtime id on some gateways: readOpenRows tries both.
    const openStored = atomOf('focusedStoredSessionId').get();
    await eachLimited(live, HISTORY_CONCURRENCY, async (row) => {
      try {
        keep(row, exchangesFromRows(await (row.id === openStored ? readOpenRows(row.id) : readRows(row.id))));
      } catch (error) {
        const old = historyCache.get(row.id);
        if (old) exchanges[row.id] = old.exchanges;
        errors.push(`History of ${str(row.title) || 'Untitled'}: ${errorText(error)}`);
      }
    });
    while (historyCache.size > HISTORY_CACHE_MAX) historyCache.delete(historyCache.keys().next().value);
    return { exchanges, errors, backendMissing };
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
    // Histories only from the active backend: host.request cannot reach another owner.
    let backendMissing = false;
    const asked = [...named];
    if (agentsOk) {
      const fresh = new Set([stored, runtime, ...asked].filter(Boolean));
      const want = stored ?? runtime;
      const centre = treeFocus(next.rows, want, $data.get().lastFocus);
      if (centre === want && buildTree(next.rows, want)) next.lastFocus = want;
      const histories = await loadExchanges(next.rows, centre, fresh);
      if (disposed || mine !== generation) return;
      for (const id of asked) named.delete(id);
      next.exchanges = histories.exchanges;
      errors.push(...histories.errors);
      backendMissing = histories.backendMissing;
    }
    // A branch or a fork digest may have landed while the reads ran: keep the newest.
    const now = $data.get();
    next.branchIds = now.branchIds;
    if (next.lastFocus === undefined) next.lastFocus = now.lastFocus;
    next.digests = storage ? { ...now.digests, ...readDigests(next.exchanges) } : now.digests;
    $data.set(next);
    settlePendingBranch();
    settlePendingRename();
    $status.set({
      loading: false,
      error: errors.length ? errors.join('\n') : null,
      note: !agentsOk
        ? 'Messages and subagents are unavailable for a chat of another profile or connection.'
        : backendMissing
          ? BACKEND_NOTE_TEXT
          : null,
    });
  }

  const reload = () => {
    load().then(null, (error) => {
      if (!disposed) $status.set({ loading: false, error: errorText(error) });
    });
  };

  // One reload RELOAD_DEBOUNCE_MS after the last of a burst of calls.
  function reloadSoon() {
    if (disposed) return;
    if (typeof cancelSoon === 'function') cancelSoon();
    cancelSoon = schedule(() => {
      cancelSoon = null;
      reload();
    }, RELOAD_DEBOUNCE_MS);
  }

  // A RELOAD_EVENTS event: remember the chats it names, then reload soon.
  function onTreeEvent(event) {
    if (disposed) return;
    const payload = event?.payload && typeof event.payload === 'object' ? event.payload : {};
    for (const id of [event?.session_id, event?.stored_session_id, payload.session_id, payload.stored_session_id]) {
      if (typeof id === 'string' && id) named.add(id);
    }
    reloadSoon();
  }

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

  // Opens a chat for the focused chat's owner: in place for a tree node, in a tab for a subagent.
  function openChat(id, intent = 'tab') {
    if (!id || typeof host?.openSession !== 'function') return;
    const options = openOptions(atomOf('focusedSessionOwner').get(), intent);
    Promise.resolve()
      .then(() => host.openSession(id, options))
      .then(null, () => {});
  }

  // A drag that selects text also fires click; do not open a chat then.
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
  const stop = (event) => {
    event?.stopPropagation?.();
  };
  // Copied from side-chat: Hermes listens for keys on window capture; the composer takes whatever still bubbles.
  const stopHostEvent = (event) => {
    event?.stopPropagation?.();
    event?.stopImmediatePropagation?.();
  };

  // ── UI state (all in $ui; render only reads it) ───────────────────────────────────────────

  const setUi = (patch) => $ui.set({ ...$ui.get(), ...patch });

  // A click on a node makes it the open node and opens its chat in place.
  function selectNode(chatId, index) {
    setUi({ open: { chatId, index } });
    openChat(chatId, 'in-place');
    revealExchange(chatId, index);
  }

  // ── Scroll to the clicked exchange ────────────────────────────────────────────────────────
  //
  // Not SDK surface. The SDK has no scroll API, so this sends the event the chat's own timeline
  // rail sends (components/assistant-ui/thread/timeline.tsx:148-230) to the main chat's viewport.
  // Its listener (use-timeline-reveal.ts) finds the row by rowId, loads older rows when needed, and
  // answers through `complete`. Then this scrolls the turn into view, as the rail does. Rohan
  // accepted the catalog risk on 2026-11-12. Anything missing (no viewport, no row id, a Hermes
  // that renamed the event) leaves the chat opened and nothing else.
  let revealing = null; // the AbortController of the reveal in flight
  function revealExchange(chatId, index) {
    revealing?.abort();
    revealing = null;
    const rowId = $data.get().exchanges?.[chatId]?.[index]?.rowId;
    const doc = deps.document ?? globalThis.document;
    if (!Number.isInteger(rowId) || typeof doc?.querySelector !== 'function') return;
    if (typeof CustomEvent !== 'function' || typeof AbortController !== 'function') return;
    const controller = new AbortController();
    revealing = controller;
    const live = () => !disposed && !controller.signal.aborted;
    let waits = 0;
    let misses = 0;
    // Wait for the main chat to show the clicked chat; openSession settles before it renders.
    const attempt = () => {
      if (!live()) return;
      const viewport = atomOf('focusedStoredSessionId').get() === chatId ? doc.querySelector(WORKSPACE_VIEWPORT) : null;
      if (viewport) {
        schedule(() => live() && send(viewport), REVEAL_SETTLE_MS);
        return;
      }
      if (++waits < REVEAL_WAIT_MS / REVEAL_POLL_MS) schedule(attempt, REVEAL_POLL_MS);
    };
    const send = (viewport) => {
      let settled = false;
      const complete = (revealed) => {
        if (settled || !live()) return;
        settled = true;
        if (revealed) return scrollToTurn(viewport, revealed);
        // A miss right after the switch can be the old chat's rows: try again a little later.
        if (++misses <= REVEAL_RETRIES) schedule(attempt, REVEAL_RETRY_MS);
      };
      schedule(() => {
        if (!settled) controller.abort();
      }, REVEAL_TIMEOUT_MS);
      try {
        viewport.dispatchEvent(new CustomEvent(REVEAL_EVENT, { detail: { id: `history:${rowId}`, rowId, signal: controller.signal, complete } }));
      } catch {
        // A viewport that throws on dispatch: the chat stays opened.
      }
    };
    attempt();
  }

  function scrollToTurn(viewport, revealedId) {
    try {
      const escape = globalThis.CSS?.escape ?? ((s) => String(s).replace(/["\\]/g, '\\$&'));
      const node = viewport.querySelector(`[data-message-id="${escape(revealedId)}"]`);
      const turn = node?.closest?.(TURN_PAIR) ?? node;
      if (!turn?.getBoundingClientRect) return;
      const top = viewport.scrollTop + turn.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 8;
      viewport.scrollTo?.({ top: Math.max(0, top), behavior: 'smooth' });
    } catch {
      // Markup that changed under us: the chat stays opened.
    }
  }
  // The view toggle: remembered in $ui and in ctx.storage (best effort).
  const setMode = (mode) => {
    if ($ui.get().mode === mode) return;
    setUi({ mode, pick: null });
    write(MODE_KEY, mode);
  };
  const expandRun = (runKey) => setUi({ expanded: { ...$ui.get().expanded, [runKey]: true } });
  // Enter or Space on a focused row acts like a click.
  const onKey = (fn) => (event) => {
    if (event?.key !== 'Enter' && event?.key !== ' ') return;
    event.preventDefault?.();
    fn();
  };
  const dismissResult = () => setUi({ result: null });
  const dismissForkNotice = () => setUi({ forkNotice: null });

  // The tree as the pane draws it now, for the click handlers (render never runs an action).
  function currentView() {
    const data = $data.get();
    const want = atomOf('focusedStoredSessionId').get() ?? runtimeId();
    const centre = treeFocus(data.rows, want, data.lastFocus);
    const tree = buildTree(data.rows, centre);
    const lanes = buildLanes(lineageChats(tree), data.exchanges, data.branchIds);
    // A fallback tree is read-only: its chat is not the one open in Hermes, so nothing acts on it.
    const open = tree && centre === want ? (lanes.find((lane) => lane.id === tree.focused.id) ?? null) : null;
    return { lanes, open };
  }

  // host.state.busyBySession is keyed by runtime id (side-chat reads it the same way). A branch
  // needs an idle chat (hermes_state_mutation_branch.py:58 require_idle).
  const chatBusy = (busyMap, ids) => ids.some((id) => typeof id === 'string' && id !== '' && Boolean(busyMap?.[id]));

  // ── Reads ─────────────────────────────────────────────────────────────────────────────────

  // One history.read for the stored ids. It names the open chat's runtime id, if any, as the call's
  // session; the Python half reads the store either way. Never throws: { ok: true, histories, missing }
  // or { ok: false, missing, error } (missing: the Python half is not enabled).
  async function readStored(ids) {
    const runtime = runtimeId();
    try {
      const reply = parseHistoryReply(await host.request(HISTORY_METHOD, { session_ids: ids, ...(runtime ? { session_id: runtime } : {}) }));
      return reply ? { ok: true, ...reply } : { ok: false, missing: false, error: 'The history backend sent no histories.' };
    } catch (error) {
      return { ok: false, missing: isMissingMethod(error), error: errorText(error) };
    }
  }

  // The open chat's rows for Branch here. history.read rows carry branch_index (see branchCount), so
  // they come first. Without the Python half, or when it does not return the chat, readOpenRows.
  async function readBranchRows(openId) {
    if ($status.get().note !== BACKEND_NOTE_TEXT) {
      const stored = await readStored([openId]);
      const rows = stored.ok ? stored.histories.get(openId) : undefined;
      if (Array.isArray(rows)) return rows;
    }
    return readOpenRows(openId);
  }

  // This Hermes (v0.23) has no session.transcript: fall back to session.history, a complete snapshot.
  async function readRows(sessionId) {
    try {
      const rows = [];
      const seen = new Set();
      let cursor = null;
      for (let i = 0; i < 1000; i++) {
        const result = await host.request('session.transcript', {
          session_id: sessionId,
          order: 'oldest',
          ...(cursor ? { cursor } : {}),
        });
        const batch = Array.isArray(result?.rows) ? result.rows : [];
        rows.push(...batch);
        const next = typeof result?.next_cursor === 'string' && result.next_cursor ? result.next_cursor : null;
        if (batch.length === 0 || !next || next === cursor || seen.has(next)) break;
        seen.add(next);
        cursor = next;
      }
      return rows;
    } catch {
      // Unknown method or a failed page: read the complete history instead.
    }
    const history = await host.request('session.history', { session_id: sessionId });
    return Array.isArray(history?.messages) ? history.messages : [];
  }

  // The open chat's rows by its stored id, as the tree read them, so exchange numbers match the
  // nodes. Its runtime id when that read fails: a legacy gateway serves live runtime ids only.
  async function readOpenRows(openId) {
    try {
      return await readRows(openId);
    } catch (error) {
      const runtime = atomOf('focusedStoredSessionId').get() === openId ? runtimeId() : null;
      if (!runtime || runtime === openId) throw error;
      return readRows(runtime);
    }
  }

  // The target's context window: session.usage, then session.stats, then session.context_breakdown.
  // Never the open chat's own window: a branch holds a copy of its parent's history.
  async function targetHeadroom(targetId) {
    for (const method of ['session.usage', 'session.stats', 'session.context_breakdown']) {
      try {
        const window = parseContextHeadroom(await host.request(method, { session_id: targetId }));
        if (window) return window;
      } catch {
        // A throw or a payload with no context max tries the next method.
      }
    }
    return null;
  }

  // The digest event: finishes its job, or keeps the result until the request's reply names it.
  function onDigestEvent(event) {
    const result = digestResult(event);
    if (!result.job) return;
    const finish = jobs.get(result.job);
    if (finish) return finish(result);
    early.set(result.job, result);
    while (early.size > 20) early.delete(early.keys().next().value);
  }

  // Asks the plugin's Python half for a digest and waits for its event, at most 60 seconds.
  // sessionId: a session this window views, because the event reaches only those clients.
  // Never throws: { ok: true, digest } or { ok: false, error, missing } (missing: no backend).
  async function requestDigest(sessionId, purpose, title, exchanges) {
    if (!listening) return { ok: false, missing: true, error: DIGEST_MISSING_TEXT };
    let job;
    try {
      job = digestJob((await host.request(DIGEST_METHOD, { session_id: sessionId, ...digestRequest(purpose, title, exchanges) }))?.job);
    } catch (error) {
      // -32601 (method not found): the plugin's Python half is not enabled.
      const missing = isMissingMethod(error);
      return { ok: false, missing, error: missing ? DIGEST_MISSING_TEXT : errorText(error) };
    }
    if (!job) return { ok: false, error: 'The digest backend returned no job.' };
    if (early.has(job)) {
      const result = early.get(job);
      early.delete(job);
      return result;
    }
    return new Promise((resolve) => {
      let cancel = null;
      const finish = (result) => {
        jobs.delete(job);
        if (typeof cancel === 'function') cancel();
        resolve(result);
      };
      jobs.set(job, finish);
      cancel = schedule(() => finish({ job, ok: false, error: DIGEST_TIMEOUT_TEXT }), DIGEST_TIMEOUT_MS);
    });
  }

  // The runtime id of chatId once it is the focused chat, or null after FOCUS_WAIT_MS.
  async function waitForFocus(chatId) {
    const end = Date.now() + FOCUS_WAIT_MS;
    for (;;) {
      const runtime = atomOf('focusedSessionId').get();
      if (atomOf('focusedStoredSessionId').get() === chatId && typeof runtime === 'string' && runtime) return runtime;
      if (disposed || Date.now() > end) return null;
      await new Promise((resolve) => schedule(resolve, 150));
    }
  }

  async function tryDraft(sessionId, text) {
    try {
      return (await host.composer.setDraft(sessionId, text)) === true;
    } catch {
      return false;
    }
  }

  // ── Merge: stage the open chat in an ancestor's composer. Never sends. ─────────────────────

  // The open chat's own part after its fork point: { question, turns }, { notice } when there is
  // nothing to merge or a read failed, or { dead: true } when the activation ended.
  async function readOwnPart(open, lanes, alive = () => true) {
    let exchanges;
    try {
      exchanges = exchangesFromRows(await readOpenRows(open.id));
    } catch (error) {
      return { notice: `Could not read this chat: ${errorText(error)}` };
    }
    if (!alive()) return { dead: true };
    // The fork point: against the parent as the tree loaded it, else a fresh read of the parent.
    let parentExchanges = lanes.find((lane) => lane.id === open.parentId)?.exchanges ?? [];
    if (!parentExchanges.length) {
      try {
        parentExchanges = exchangesFromRows(await readRows(open.parentId));
      } catch (error) {
        return { notice: `Could not read the parent chat: ${errorText(error)}` };
      }
      if (!alive()) return { dead: true };
    }
    const { question, turns } = ownPart(exchanges, sharedExchangeCount(exchanges, parentExchanges));
    if (!turns.length) return { notice: MERGE_NOTHING_TEXT };
    return { question, turns };
  }

  // Runs when the user picks a mode in the merge popover: kind 'asis' (As-is) or 'digest'. Reads
  // the open chat, builds the text, checks it against the target's window, opens the target in
  // place, and stages the draft. The outcome is ui.result, under the row `anchor`. Never throws,
  // and never sends.
  async function merge(kind, targetId, anchor = null) {
    if ($ui.get().result?.busy) return;
    const act = activation;
    const alive = () => !disposed && act === activation;
    let target = null;
    const finish = (patch) => {
      if (alive()) setUi({ result: { kind, anchor, targetId: target?.id ?? null, title: target?.title ?? '', ...patch } });
    };
    const fail = (text, extra = {}) => finish({ ok: false, text, ...extra });
    const mode = kind === 'digest' ? 'Digest' : 'Merge as-is';
    try {
      const { lanes, open } = currentView();
      if (!open) return fail('Open a chat first.');
      const targets = mergeTargets(lanes, open.id);
      if (!targets.length) return fail(forkParentId(open.row) ? MERGE_PARENT_MISSING_TEXT : MERGE_ROOT_TEXT);
      if (typeof host?.composer?.setDraft !== 'function') return fail(MERGE_NO_COMPOSER_TEXT);
      target = targets.find((t) => t.id === targetId) ?? selectedTarget(targets, null, open.id);
      finish({ busy: true });

      const part = await readOwnPart(open, lanes, alive);
      if (part.dead || !alive()) return;
      if (part.notice) return fail(part.notice);
      const { question, turns } = part;

      let body = verbatimBody(turns);
      if (kind === 'digest') {
        // The open chat's session: this window views it while the pane waits, before the target opens.
        const viewing = atomOf('focusedStoredSessionId').get() === open.id ? runtimeId() || open.id : open.id;
        const reply = await requestDigest(viewing, 'merge', open.title, turns);
        if (!alive()) return;
        if (!reply.ok) return fail(reply.missing ? DIGEST_MISSING_TEXT : `Digest failed: ${reply.error.replace(/[.\s]+$/, '')}. Nothing was staged.`);
        body = reply.digest;
      }
      const text = formatMergeText(question, body);
      const sideTokens = estimateTokens(text);

      const headroom = await targetHeadroom(target.id);
      if (!alive()) return;
      if (headroom && sideTokens > headroom.available) {
        return fail(
          formatNoFitNotice({
            sideTokens,
            available: headroom.available,
            used: headroom.used,
            max: headroom.max,
            sideEstimated: true,
            windowEstimated: headroom.estimated === true,
            mode,
            target: target.title,
          }),
          { fit: 'no', sideTokens, available: headroom.available },
        );
      }

      // setDraft fails closed on a composer that is not mounted (sdk/composer.ts): open the target first.
      if (typeof host.openSession === 'function') {
        try {
          await host.openSession(target.id, openOptions(atomOf('focusedSessionOwner').get(), 'in-place'));
        } catch {
          // A failed open still tries the draft: the target may be open already.
        }
      }
      if (!alive()) return;
      if (kind !== 'digest' && mergeSends) {
        // Merge as-is sends the text as a message in the target chat (Rohan, 2026-11-12 03:04, for the
        // demo). Hermes needs the chat loaded, so wait until the target is the focused chat.
        const runtime = await waitForFocus(target.id);
        if (!alive()) return;
        if (!runtime) return fail(MERGE_SEND_FOCUS_TEXT, { fit: headroom ? 'yes' : 'unknown', sideTokens, available: headroom?.available });
        try {
          await host.request('prompt.submit', { session_id: runtime, text });
        } catch (error) {
          return fail(isBusy(error) ? `${MERGE_SEND_BUSY_TEXT} ${errorText(error)}` : `Merge was not sent: ${errorText(error)}`);
        }
        if (!alive()) return;
        return finish({ fit: headroom ? 'yes' : 'unknown', sideTokens, available: headroom?.available, ok: true, sent: true, text: '' });
      }
      let ok = await tryDraft(target.id, text);
      if (!ok) {
        // The target's runtime id once focus is on the target. Never the merged chat itself.
        const focusedRuntime = atomOf('focusedSessionId').get();
        if (typeof focusedRuntime === 'string' && focusedRuntime && atomOf('focusedStoredSessionId').get() === target.id) {
          ok = await tryDraft(focusedRuntime, text);
        }
      }
      if (!alive()) return;

      const fit = headroom ? 'yes' : 'unknown';
      const base = { fit, sideTokens, available: headroom?.available };
      if (!ok) return fail(MERGE_HIDDEN_TEXT, base);
      // Staged. Once the user sends it, the target's next history read shows the Merged node.
      finish({ ...base, ok: true, text: headroom ? MERGE_STAGED_TEXT : formatMissingWindowNotice(sideTokens) });
    } catch (error) {
      fail(`Merge failed: ${errorText(error)}`);
    }
  }

  // ── The merge popover: step 'where' (an ancestor), then step 'how' (As-is or Digest) ───────

  // Opens the pick on the Merge icon of row rowKey. The parent is preselected: its lane lights up.
  function openPick(rowKey) {
    const { lanes, open } = currentView();
    if (!open) return;
    setUi({ pick: { rowKey, chatId: open.id, step: 'where', targetId: null, prep: null } });
    hoverSet('target', mergeTargets(lanes, open.id)[0]?.id ?? null);
  }

  function closePick() {
    if ($ui.get().pick) setUi({ pick: null });
    hoverSet('target', null);
  }

  // The size of an As-is merge into targetId, for the detail line of step 'how'.
  async function measureMerge(targetId) {
    try {
      const { lanes, open } = currentView();
      if (!open) return { error: 'Open a chat first.' };
      const part = await readOwnPart(open, lanes);
      if (part.notice || part.dead) return { error: part.notice ?? 'The pane was closed.' };
      const sideTokens = estimateTokens(formatMergeText(part.question, verbatimBody(part.turns)));
      const headroom = await targetHeadroom(targetId);
      return { turns: part.turns.length, sideTokens, headroom };
    } catch (error) {
      return { error: `Could not measure this chat: ${errorText(error)}` };
    }
  }

  // Step 'where' picked targetId: show step 'how' and measure the As-is merge.
  async function pickWhere(targetId) {
    const pick = $ui.get().pick;
    if (!pick || !targetId) return;
    const token = {};
    setUi({ pick: { ...pick, step: 'how', targetId, prep: { busy: true, token } } });
    hoverSet('target', targetId);
    const act = activation;
    const prep = await measureMerge(targetId);
    const now = $ui.get().pick;
    if (disposed || act !== activation || !now || now.prep?.token !== token) return;
    setUi({ pick: { ...now, prep } });
  }

  function backToWhere() {
    const pick = $ui.get().pick;
    if (pick) setUi({ pick: { ...pick, step: 'where', targetId: null, prep: null } });
  }

  // Step 'how' picked kind: close the popover and stage.
  function pickHow(kind) {
    const pick = $ui.get().pick;
    if (!pick?.targetId) return;
    closePick();
    merge(kind, pick.targetId, pick.rowKey).then(null, () => {});
  }

  // ── Branch here: fork the open chat at an exchange and ask the branch a question ──────────

  // A new form has nothing picked: the branch keeps this chat's model until the user picks one.
  // model: the picked choice (EMPTY_CHOICE). picking: the model picker is open.
  // A Tabler outline icon, drawn when the SDK has no icon for it (an older Hermes).
  const drawn = (paths, style = BRANCH_GLYPH) =>
    jsx(
      'svg',
      {
        viewBox: '0 0 24 24', style, fill: 'none', stroke: 'currentColor', strokeWidth: 2,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
        children: paths.map((d, i) => jsx('path', { d }, i)),
      },
      'icon',
    );
  const sdkIcon = (Icon, paths, style = BRANCH_GLYPH) => (Icon ? jsx(Icon, { size: style.width, style, 'aria-hidden': 'true' }, 'icon') : drawn(paths, style));
  // Tabler's git-fork, the icon Hermes's own Branch button uses.
  const FORK_PATHS = ['M10 18a2 2 0 1 0 4 0a2 2 0 1 0 -4 0', 'M5 6a2 2 0 1 0 4 0a2 2 0 1 0 -4 0', 'M15 6a2 2 0 1 0 4 0a2 2 0 1 0 -4 0', 'M7 8v2a2 2 0 0 0 2 2h6a2 2 0 0 0 2 -2v-2', 'M12 12l0 4'];
  const forkGlyph = () => sdkIcon(BranchIcon, FORK_PATHS);
  // The same icon at 12 px on a name row.
  const nameGlyph = () => sdkIcon(BranchIcon, FORK_PATHS, NAME_GLYPH);
  // The codicon git-merge (the SDK has no Tabler merge icon), else Tabler's git-merge.
  const mergeGlyph = () =>
    MergeCodicon
      ? jsx(MergeCodicon, { name: 'git-merge', size: 14, style: { flex: '0 0 auto', lineHeight: 1 }, 'aria-hidden': 'true' }, 'icon')
      : drawn(['M5 18a2 2 0 1 0 4 0a2 2 0 1 0 -4 0', 'M5 6a2 2 0 1 0 4 0a2 2 0 1 0 -4 0', 'M15 12a2 2 0 1 0 4 0a2 2 0 1 0 -4 0', 'M7 8l0 8', 'M7 8a4 4 0 0 0 4 4h4']);
  const tabGlyph = () => sdkIcon(TabIcon, ['M12 6h-6a2 2 0 0 0 -2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-6', 'M11 13l9 -9', 'M15 4h5v5']);
  const refreshGlyph = () => sdkIcon(RefreshIcon, ['M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4', 'M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4']);

  // A tooltip with the control's name: Hermes's Tip, else the native title (set on the control).
  const tipped = (label, child, key) => (Tip ? jsx(Tip, { label, children: child }, key) : child);

  // One icon button. An icon only, with its name as aria-label and tooltip. A click or a key on it
  // never reaches the row (the row selects its node).
  function iconButton({ label, glyph, attrs, onClick, disabled = false, key, popTrigger = false }) {
    const button = jsx(
      Button,
      {
        type: 'button',
        size: 'xs',
        variant: 'ghost',
        style: ICON_SLOT,
        'aria-label': label,
        ...(Tip ? {} : { title: label }),
        disabled,
        ...attrs,
        onClick: (event) => {
          stop(event);
          if (onClick) onClick(event);
        },
        onKeyDown: stop,
        children: glyph(),
      },
      popTrigger ? 'button' : key,
    );
    return popTrigger ? button : tipped(label, button, key);
  }
  // A reserved slot: the same size, hidden and inert, so showing the icon moves nothing.
  const hiddenSlot = (glyph, attrs, key) =>
    jsx(Button, { type: 'button', size: 'xs', variant: 'ghost', style: { ...ICON_SLOT, visibility: 'hidden' }, tabIndex: -1, 'aria-hidden': 'true', disabled: true, ...attrs, children: glyph() }, key);
  // A slot whose action does not apply to the row: empty space, so the columns line up.
  const emptySlot = (key) => jsx('span', { 'aria-hidden': 'true', style: { ...ICON_SLOT, visibility: 'hidden' }, 'data-empty-slot': key }, key);

  // Branch on a node of another chat opens that chat first, then the form once it is the open chat.
  let pendingBranch = null;
  function branchAt(row, actions) {
    if (!row?.branchFrom) return;
    if (row.branchFrom === actions?.openId) {
      if (!actions.busy) openBranchForm(actions.openId, row.index, row.label);
      return;
    }
    pendingBranch = { chatId: row.branchFrom, index: row.index, label: row.label, at: Date.now() };
    selectNode(row.branchFrom, row.index);
  }
  // Called after each load: the chat a pending Branch opened is now open, so show its form.
  function settlePendingBranch() {
    if (!pendingBranch) return;
    if (Date.now() - pendingBranch.at > PENDING_BRANCH_MS) {
      pendingBranch = null;
      return;
    }
    const { open } = currentView();
    if (open && open.id === pendingBranch.chatId && runtimeId()) {
      const { chatId, index, label } = pendingBranch;
      pendingBranch = null;
      openBranchForm(chatId, index, label);
    }
  }

  function openBranchForm(chatId, index, label) {
    setUi({ branch: { chatId, index, label, question: '', model: EMPTY_CHOICE, picking: false, busy: false, error: null } });
  }

  function setBranchField(key, value) {
    const form = $ui.get().branch;
    if (!form) return;
    setUi({ branch: { ...form, [key]: typeof value === 'string' ? value : '' } });
  }

  // The picked choice. Only the form holds it: nothing is stored, and Hermes's presets never change.
  function setBranchModel(choice) {
    const form = $ui.get().branch;
    if (!form || form.busy) return;
    setUi({ branch: { ...form, model: { model: str(choice?.model), provider: str(choice?.provider), effort: str(choice?.effort) } } });
  }

  function setBranchPicking(open) {
    const form = $ui.get().branch;
    if (!form) return;
    setUi({ branch: { ...form, picking: open === true && !form.busy } });
  }

  const cancelBranch = () => setUi({ branch: null });

  // Records a branch this pane made, so its lane shows the side pill, also after a reload.
  function recordBranch(ids) {
    const next = [...new Set([...storedBranchIds(), ...$data.get().branchIds, ...ids.filter((id) => typeof id === 'string' && id)])];
    $data.set({ ...$data.get(), branchIds: next });
    write(BRANCH_IDS_KEY, next);
  }

  // The fork digest of the part a branch just fixed, stored under digestKey(chatId, index) and
  // shown on that node's tooltip. It runs after the branch opens and never holds it up. The
  // request names the new branch's session: Branch here opens it before the digest returns.
  async function forkDigest(branchSessionId, chatId, index, title, exchanges) {
    const act = activation;
    const reply = await requestDigest(branchSessionId, 'fork', title, exchanges);
    if (disposed || act !== activation) return;
    if (!reply.ok) {
      setUi({ forkNotice: reply.missing ? `No fork digest. ${DIGEST_MISSING_TEXT.replace(' Nothing was staged.', '')}` : `Fork digest failed: ${reply.error}` });
      return;
    }
    write(digestKey(chatId, index), reply.digest);
    const data = $data.get();
    $data.set({ ...data, digests: { ...data.digests, [`${chatId}:${index}`]: reply.digest } });
  }

  // Submit of the Branch here form. Forks the open chat after the form's exchange, asks the branch
  // the question on the form's model, and opens the branch in place. Never throws. Errors stay in the form.
  // Sets the branch session's model (and level) the way Hermes Desktop's picker does. true when both
  // calls answered without an error.
  async function setBranchSessionModel(sessionId, override) {
    try {
      const value = `${override.model}${override.provider ? ` --provider ${override.provider}` : ''} --session`;
      await host.request('config.set', { key: 'model', session_id: sessionId, value });
      if (override.reasoning) await host.request('config.set', { key: 'reasoning', session_id: sessionId, value: override.reasoning });
      return true;
    } catch {
      return false;
    }
  }

  async function submitBranch() {
    const form = $ui.get().branch;
    if (!form || form.busy) return;
    const act = activation;
    const alive = () => !disposed && act === activation;
    const fail = (error) => {
      const now = $ui.get().branch;
      if (alive() && now) setUi({ branch: { ...now, busy: false, error } });
    };
    // The question is optional: with none, the branch is made and opened, and the user types there.
    const question = str(form.question);
    const { open } = currentView();
    const runtime = runtimeId();
    if (!open || open.id !== form.chatId || !runtime) return fail('The open chat changed. Click Branch on a node again.');
    if (chatBusy(atomOf('busyBySession').get(), [runtime, open.id])) return fail(BRANCH_BUSY_TEXT);
    setUi({ branch: { ...form, busy: true, error: null } });

    let rows;
    try {
      rows = await readBranchRows(open.id);
    } catch (error) {
      return fail(`Could not read this chat: ${errorText(error)}`);
    }
    if (!alive()) return;
    const cut = branchCount(rows, form.index);
    if (!cut) return fail('This exchange has no answer yet. Branch at an answered exchange.');

    // No name: Hermes names a branch its own way.
    const params = { session_id: runtime, count: cut.count, ...(cut.through ? { through_message_id: cut.through } : {}) };
    let branch;
    try {
      branch = await host.request('session.branch', params);
    } catch (error) {
      return fail(isBusy(error) ? `${BRANCH_BUSY_TEXT} ${errorText(error)}` : `Branch failed: ${errorText(error)}`);
    }
    if (!alive()) return;
    const sessionId = str(branch?.session_id);
    if (!sessionId) return fail('Branch failed: the gateway returned no session.');
    const storedId = str(branch?.stored_session_id) || sessionId;
    recordBranch([sessionId, storedId]);
    // The new fork shows at once: its stub node until its first exchange lands.
    reload();

    // The picked model becomes the branch's own model, so every turn uses it, with or without a
    // question: config.set with session scope, the call Hermes Desktop's model picker makes
    // (app/session/hooks/use-model-controls.ts:280-284, lib/reasoning-step.ts:69-71). If it fails,
    // the question still goes out with a one-turn model_override.
    const override = modelOverride(form.model);
    let modelSet = false;
    if (override) modelSet = await setBranchSessionModel(sessionId, override);
    if (!alive()) return;
    if (override && !modelSet && !question) {
      setUi({ branch: null, forkNotice: BRANCH_MODEL_NOT_SET_TEXT });
      openChat(storedId, 'in-place');
      return;
    }
    if (question) {
      const submit = { session_id: sessionId, text: question, ...(override && !modelSet ? { model_override: override } : {}) };
      try {
        await host.request('prompt.submit', submit);
      } catch (error) {
        return fail(`The branch was made, but the question was not sent: ${errorText(error)}`);
      }
      if (!alive()) return;
    }
    setUi({ branch: null });
    openChat(storedId, 'in-place');
    const fixed = exchangesFromRows(rows)
      .slice(0, form.index + 1)
      .map((ex) => ({ question: ex.user, answer: ex.reply }));
    forkDigest(sessionId, open.id, form.index, open.title, fixed).then(null, () => {});
  }

  // ── Graph rows ─────────────────────────────────────────────────────────────────────────────

  // `title · model`, `side chat of X` for a side chat, and the fork digest of the node. A native
  // tooltip: rows never grow.
  function tooltip(lane, lanesById, digest) {
    let text = [lane.title, lane.model].filter(Boolean).join(' · ');
    if (lane.side) {
      const parent = lane.parentId ? lanesById.get(lane.parentId) : null;
      text = `${text}\nside chat of ${parent ? parent.title : 'a chat that is not loaded'}`;
    }
    return digest ? `${text}\n\nFork digest:\n${digest}` : text;
  }

  // Pointer and keyboard focus on node rows ($hover). A set or clear that changes nothing writes nothing.
  const hoverSet = (field, key) => {
    const now = $hover.get();
    if (now[field] !== key) $hover.set({ ...now, [field]: key });
  };
  const hoverClear = (field, key) => {
    if ($hover.get()[field] === key) hoverSet(field, null);
  };

  // actions: { openId, busy, model, hover, mergeLane, merging, pick, targets, open }: the open
  // chat's id, its busy flag, its model, the $hover value, the lane whose rows carry Merge (the open
  // chat when it has a parent, else null), a merge in flight, the open pick, the merge targets and
  // the open lane. Every node row reserves three icon slots at its right edge: Branch here (a
  // branchable node), Merge into (a row of the open chat's own lane) and Open in a tab (every row).
  // The icons show on the open row, on the row under the pointer or keyboard focus, and on the row
  // whose merge popover is open. Elsewhere they stay in place, hidden and inert.
  function nodeLine(row, lane, lanesById, indent, actions) {
    const children = [
      jsx(
        'span',
        { style: { ...LABEL_STYLE, ...NODE_TEXT, ...(row.blue ? {} : { opacity: 0.72 }), ...(row.open ? { fontWeight: 600 } : {}) }, 'data-selectable-text': 'true', 'data-label': 'true', children: row.label },
        'label',
      ),
    ];
    // The model pill sits on the open node only (Rohan, 2026-11-12 01:10): the open chat's model.
    const model = row.open ? actions.model || lane.model : '';
    if (model) children.push(jsx('span', { style: PILL, 'data-selectable-text': 'true', 'data-pill': 'model', children: modelName(model) }, 'model'));
    if (row.first && lane.side) children.push(jsx('span', { style: PILL, 'data-selectable-text': 'true', 'data-pill': 'side', children: 'side' }, 'side'));
    const picking = actions.pick?.rowKey === row.key;
    // The Branch here form of this node: with Hermes's Popover it opens at the row.
    const formHere = Boolean(pop && row.branchable && actions.form && actions.form.chatId === row.branchFrom && actions.form.index === row.index);
    const shown = row.open || picking || formHere || row.key === actions.hover?.pointer || row.key === actions.hover?.focus;
    const own = row.branchFrom === actions.openId;
    if (!row.branchable) children.push(emptySlot('branch'));
    else if (!shown) children.push(hiddenSlot(forkGlyph, { 'data-branch-slot': row.key }, 'branch'));
    else {
      const label = own && actions.busy ? BRANCH_BUSY_TEXT : 'Branch here';
      const button = iconButton({
        label,
        glyph: forkGlyph,
        key: 'branch',
        disabled: own && actions.busy,
        attrs: { 'data-branch-here': row.key, 'aria-label': 'Branch here' },
        popTrigger: Boolean(pop),
        onClick: pop ? null : () => branchAt(row, actions),
      });
      children.push(pop ? branchPopover(row, actions, label, button, formHere) : button);
    }
    if (!actions.mergeLane || row.lane !== actions.mergeLane) children.push(emptySlot('merge'));
    else if (!shown) children.push(hiddenSlot(mergeGlyph, { 'data-merge-slot': row.key }, 'merge'));
    else children.push(mergeControl(row, actions, picking));
    if (!shown) children.push(hiddenSlot(tabGlyph, { 'data-tab-slot': row.key }, 'tab'));
    else {
      children.push(
        iconButton({ label: 'Open in a tab', glyph: tabGlyph, key: 'tab', attrs: { 'data-open-tab': row.key }, onClick: () => openChat(row.lane, 'tab') }),
      );
    }
    const select = () => selectNode(row.lane, row.index);
    return jsxs(
      'div',
      {
        role: 'button',
        tabIndex: 0,
        title: tooltip(lane, lanesById, row.digest),
        className: row.open ? '' : 'hover:bg-muted',
        style: { ...ROW_STYLE, paddingLeft: indent, ...(row.open ? OPEN_ROW : {}) },
        'data-selectable-text': 'true',
        'data-node': row.key,
        'data-chat-id': row.lane,
        'data-exchange': row.index,
        ...(row.blue ? { 'data-blue': 'true' } : {}),
        ...(row.open ? { 'data-open': 'true', 'aria-current': 'true' } : {}),
        ...(row.target ? { 'data-target-lane': 'true' } : {}),
        ...(row.merge !== null ? { 'data-merge-node': row.mergeFrom ?? '' } : {}),
        ...(row.digest ? { 'data-fork-digest': 'true' } : {}),
        ...(row.stub ? { 'data-stub': 'true' } : {}),
        onClick: () => {
          if (!selecting() && actions.rename?.chatId !== row.lane) select();
        },
        onKeyDown: actions.rename?.chatId === row.lane ? undefined : onKey(select),
        onMouseEnter: () => hoverSet('pointer', row.key),
        onMouseLeave: () => hoverClear('pointer', row.key),
        onFocus: () => hoverSet('focus', row.key),
        // Focus that moves into the row (its Branch button) keeps the row focused.
        onBlur: (event) => {
          const next = event?.relatedTarget;
          if (next && typeof event.currentTarget?.contains === 'function' && event.currentTarget.contains(next)) return;
          hoverClear('focus', row.key);
        },
        children,
      },
      row.key,
    );
  }

  // Branch here in Hermes's Popover at the row: the one-line question, the model picker and Enter
  // to send (branchForm). Branch on another chat's node opens that chat first; the popover opens
  // once the form is set. A form that is sending stays open.
  function branchPopover(row, actions, label, button, formHere) {
    return jsx(
      pop.Root,
      {
        open: formHere,
        onOpenChange: (next) => {
          if (next) branchAt(row, actions);
          else if (!actions.form?.busy) cancelBranch();
        },
        children: [
          tipped(label, jsx(pop.Trigger, { asChild: true, children: button }, 'trigger'), 'tip'),
          formHere
            ? jsx(
                pop.Content,
                {
                  align: 'end',
                  side: 'bottom',
                  style: { ...SELECTABLE, boxSizing: 'border-box', maxWidth: 'calc(100vw - 16px)', padding: 4 },
                  'data-branch-pick': row.key,
                  'data-selectable-text': 'true',
                  onClick: stop,
                  onKeyDown: stop,
                  children: branchForm(actions.form, actions.busy),
                },
                'content',
              )
            : null,
        ].filter(Boolean),
      },
      'branch',
    );
  }

  // The Merge into icon. With Hermes's Popover, the pick opens anchored at the row; without it,
  // the icon toggles the pick under the graph.
  function mergeControl(row, actions, picking) {
    const label = 'Merge into…';
    const attrs = { 'data-merge-here': row.key, 'aria-label': 'Merge into', 'aria-haspopup': 'dialog', 'aria-expanded': picking };
    const disabled = actions.merging === true;
    if (!pop) return iconButton({ label, glyph: mergeGlyph, key: 'merge', disabled, attrs, onClick: () => (picking ? closePick() : openPick(row.key)) });
    const trigger = jsx(pop.Trigger, { asChild: true, children: iconButton({ label, glyph: mergeGlyph, key: 'merge', disabled, attrs, popTrigger: true }) }, 'trigger');
    return jsx(
      pop.Root,
      {
        open: picking,
        onOpenChange: (next) => (next ? openPick(row.key) : closePick()),
        children: [
          tipped(label, trigger, 'tip'),
          picking
            ? jsx(
                pop.Content,
                {
                  align: 'end',
                  side: 'bottom',
                  style: { ...SELECTABLE, boxSizing: 'border-box', maxWidth: 'calc(100vw - 16px)', padding: 4 },
                  'data-merge-pick': row.key,
                  'data-selectable-text': 'true',
                  // The content is a React child of the row: its clicks and keys must not select the node.
                  onClick: stop,
                  onKeyDown: pickKeys,
                  children: pickPanel(actions),
                },
                'content',
              )
            : null,
        ].filter(Boolean),
      },
      'merge',
    );
  }

  // Arrow keys move between the pick items; Enter picks the focused one (its native click).
  function pickKeys(event) {
    stopHostEvent(event);
    const key = event?.key;
    if (key !== 'ArrowDown' && key !== 'ArrowUp') return;
    const items = [...(event.currentTarget?.querySelectorAll?.('[data-pick-item]') ?? [])];
    if (!items.length) return;
    event.preventDefault?.();
    const at = items.indexOf(globalThis.document?.activeElement);
    items[(at + (key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus?.();
  }

  // One Quick Pick item: a label and a detail line. A disabled item stays focusable (its detail
  // says why) and cannot be picked.
  function pickItem({ key, label, detail, title, disabled = false, autoFocus = false, onPick, target = null, attrs = {} }) {
    const hoveredItem = $hover.get().item;
    return jsxs(
      'button',
      {
        type: 'button',
        style: {
          ...PICK_ITEM,
          ...(disabled ? { opacity: 0.45, cursor: 'default' } : {}),
          // Inline, because a class hover shows no change on the popover background.
          ...(!disabled && hoveredItem === key ? { background: PICK_HOVER_BG } : {}),
        },
        ...(title ? { title } : {}),
        ...(autoFocus ? { autoFocus: true } : {}),
        ...(disabled ? { 'aria-disabled': 'true' } : {}),
        'data-pick-item': key,
        'data-selectable-text': 'true',
        onClick: (event) => {
          stop(event);
          if (!disabled) onPick();
        },
        // Hovering or focusing a target lights its lane in the graph ($hover.target).
        onMouseEnter: () => {
          hoverSet('item', key);
          if (target) hoverSet('target', target);
        },
        onMouseLeave: () => hoverClear('item', key),
        ...(target ? { onFocus: () => hoverSet('target', target) } : {}),
        ...attrs,
        children: [
          jsx('span', { style: { ...LABEL_STYLE, fontWeight: 500 }, 'data-selectable-text': 'true', children: label }, 'label'),
          detail ? jsx('span', { style: DETAIL, 'data-selectable-text': 'true', 'data-pick-detail': key, children: detail }, 'detail') : null,
        ].filter(Boolean),
      },
      key,
    );
  }

  // The two steps of the merge pick. 'where': the ancestors, the parent first and preselected.
  // 'how': As-is with its size and fit, and Digest. A mode that does not fit is greyed.
  function pickPanel(actions) {
    const pick = actions.pick;
    const targets = actions.targets ?? [];
    const title = actions.open?.title ?? '';
    const head = (left, right) =>
      jsxs(
        'div',
        {
          style: { ...NOTE, display: 'flex', alignItems: 'baseline', gap: 6, padding: '2px 6px 4px', fontSize: 12, fontWeight: 600 },
          'data-selectable-text': 'true',
          'data-pick-head': right,
          children: [
            jsx('span', { style: { ...NOTE, flex: '1 1 auto' }, 'data-selectable-text': 'true', children: left }, 'left'),
            jsx('span', { style: { ...SELECTABLE, flex: '0 0 auto', color: MUTED, fontWeight: 400, fontSize: 11 }, 'data-selectable-text': 'true', children: right }, 'right'),
          ],
        },
        'head',
      );
    if (pick.step !== 'how') {
      const rows = [head(`Merge "${shortLabel(title, 40)}"`, '1/2 Where')];
      targets.forEach((t, i) => {
        if (i === 0) rows.push(jsx('div', { style: PICK_GROUP, 'data-selectable-text': 'true', children: 'Parent' }, 'group:parent'));
        if (i === 1) rows.push(jsx('div', { style: PICK_GROUP, 'data-selectable-text': 'true', children: 'Older ancestors' }, 'group:older'));
        rows.push(
          pickItem({
            key: t.id,
            label: shortLabel(t.title, 48),
            detail: i === 0 ? 'default' : targetRelation(i, targets.length),
            title: t.title,
            autoFocus: i === 0,
            target: t.id,
            onPick: () => pickWhere(t.id),
            attrs: { 'data-merge-target': t.id, ...(i === 0 ? { 'data-default': 'true' } : {}) },
          }),
        );
      });
      return rows;
    }
    const target = targets.find((t) => t.id === pick.targetId);
    const prep = pick.prep ?? {};
    let asisDetail;
    let asisOff = false;
    let asisFit = 'unknown';
    if (prep.busy) {
      asisDetail = 'Measuring this chat...';
      asisOff = true;
      asisFit = 'pending';
    } else if (prep.error) {
      asisDetail = prep.error;
      asisOff = true;
      asisFit = 'error';
    } else {
      const size = `${prep.turns} exchange${prep.turns === 1 ? '' : 's'} · about ${formatTokenCount(prep.sideTokens)} tokens`;
      const free = prep.headroom ? `${formatTokenCount(prep.headroom.available)} free` : '';
      if (!prep.headroom) asisDetail = `${size} · the target's window is not reported`;
      else if (prep.sideTokens > prep.headroom.available) {
        asisDetail = `${size} · does not fit (${free})`;
        asisOff = true;
        asisFit = 'no';
      } else {
        asisDetail = `${size} · fits (${free})`;
        asisFit = 'yes';
      }
    }
    const digestOff = Boolean(prep.error);
    return [
      head(`Merge "${shortLabel(title, 28)}" into "${shortLabel(target?.title ?? '', 28)}"`, '2/2 How'),
      pickItem({
        key: 'asis',
        label: 'As-is',
        detail: asisDetail,
        title: 'Stage this chat after its fork point in the target composer as it is. Nothing is sent.',
        disabled: asisOff,
        // While it measures, As-is keeps the focus: Enter, Enter merges as-is into the parent.
        autoFocus: prep.busy === true || !asisOff || digestOff,
        onPick: () => pickHow('asis'),
        attrs: { 'data-merge': 'asis', 'data-fit': asisFit },
      }),
      pickItem({
        key: 'digest',
        label: 'Digest',
        detail: prep.error ? prep.error : 'a summary by the digest model',
        title: 'Stage a short digest of this chat after its fork point in the target composer. Nothing is sent.',
        disabled: digestOff,
        autoFocus: prep.busy !== true && asisOff && !digestOff,
        onPick: () => pickHow('digest'),
        attrs: { 'data-merge': 'digest' },
      }),
      jsx(
        'button',
        {
          type: 'button',
          className: 'hover:bg-muted',
          style: { ...PICK_ITEM, color: MUTED, fontSize: 11 },
          'data-pick-back': 'true',
          onClick: (event) => {
            stop(event);
            backToWhere();
          },
          children: '‹ Back to Where',
        },
        'back',
      ),
    ];
  }

  // The result line of the last merge, under its row: staged (with Open), in flight, or failed (in
  // the destructive colour). It stays until Dismiss or the next merge.
  function resultLine(result, indent, span) {
    const busy = result.busy === true;
    const ok = !busy && result.ok === true;
    const text = busy
      ? result.kind === 'digest'
        ? 'Writing the digest...'
        : 'Sending...'
      : ok
        ? result.sent
          ? `✓ Sent to "${shortLabel(result.title, 32)}".`
          : `✓ Staged in the composer of "${shortLabel(result.title, 32)}". Not sent.`
        : result.text;
    const detail = [ok ? result.text : '', result.fit ? fitReadout(result) : ''].filter(Boolean).join('\n');
    const link = (label, attr, onClick) =>
      jsx(
        Button,
        {
          type: 'button',
          size: 'xs',
          variant: 'ghost',
          style: { ...SELECTABLE, flex: '0 0 auto', padding: '0 4px', height: 20, fontSize: 11 },
          [`data-result-${attr}`]: 'true',
          onClick: (event) => {
            stop(event);
            onClick();
          },
          onKeyDown: stop,
          children: label,
        },
        attr,
      );
    return jsxs(
      'div',
      {
        role: busy || ok ? 'status' : 'alert',
        className: busy || ok ? 'text-xs' : 'text-xs text-destructive',
        style: { ...SELECTABLE, ...BLOCK, height: span * ROW_H, paddingLeft: indent, paddingRight: 4, display: 'flex', alignItems: 'center', gap: 4 },
        ...(detail ? { title: detail } : {}),
        'data-selectable-text': 'true',
        'data-merge-result': busy ? 'busy' : ok ? 'ok' : 'error',
        ...(result.fit ? { 'data-token-fit': result.fit } : {}),
        onClick: stop,
        children: [
          jsx(
            'span',
            {
              style: { ...NOTE, flex: '1 1 auto', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: span, WebkitBoxOrient: 'vertical' },
              'data-selectable-text': 'true',
              'data-merge-notice': 'true',
              children: text,
            },
            'text',
          ),
          ok && result.targetId ? link('Open', 'open', () => openChat(result.targetId, 'in-place')) : null,
          busy ? null : link('Dismiss', 'dismiss', dismissResult),
        ].filter(Boolean),
      },
      'result',
    );
  }

  function moreLine(row, indent) {
    const expand = () => expandRun(row.runKey);
    return jsx(
      'div',
      {
        role: 'button',
        tabIndex: 0,
        'aria-expanded': false,
        title: `Show ${row.count} more exchanges`,
        className: 'hover:bg-muted',
        style: { ...ROW_STYLE, paddingLeft: indent },
        'data-selectable-text': 'true',
        'data-more': row.runKey,
        'data-count': row.count,
        onClick: expand,
        onKeyDown: onKey(expand),
        children: jsx('span', { style: { ...LABEL_STYLE, opacity: 0.72 }, children: `+${row.count}` }),
      },
      row.key,
    );
  }

  // ── Rename: a double-click on a name opens a one-line box; Enter saves, Escape or leaving cancels ──
  // Hermes renames a chat with session.title (tui_gateway/methods_session.py:1214), which needs the
  // chat loaded, so a chat that is not open opens first and is renamed once it is the open chat.
  let pendingRename = null;
  const startRename = (chatId, title) => setUi({ rename: { chatId, text: str(title) } });
  const setRenameText = (text) => {
    const now = $ui.get().rename;
    if (now) setUi({ rename: { ...now, text: typeof text === 'string' ? text : '' } });
  };
  const cancelRename = () => setUi({ rename: null });
  async function sendRename(title) {
    const runtime = runtimeId();
    if (!runtime) return;
    try {
      await host.request('session.title', { session_id: runtime, title });
      reload();
    } catch (error) {
      if (!disposed) setUi({ forkNotice: `Rename failed: ${errorText(error)}` });
    }
  }
  function commitRename(lanesById) {
    const edit = $ui.get().rename;
    setUi({ rename: null });
    if (!edit) return;
    const title = str(edit.text);
    const lane = lanesById?.get?.(edit.chatId);
    if (!title || title === str(lane?.title)) return;
    const { open } = currentView();
    if (open && open.id === edit.chatId && runtimeId()) {
      sendRename(title).then(null, () => {});
      return;
    }
    pendingRename = { chatId: edit.chatId, title, at: Date.now() };
    openChat(edit.chatId, 'in-place');
  }
  function settlePendingRename() {
    if (!pendingRename) return;
    if (Date.now() - pendingRename.at > PENDING_BRANCH_MS) {
      pendingRename = null;
      return;
    }
    const { open } = currentView();
    if (open && open.id === pendingRename.chatId && runtimeId()) {
      const { title } = pendingRename;
      pendingRename = null;
      sendRename(title).then(null, () => {});
    }
  }

  // A name row: the chat's Hermes title at the start of its lane (never a node). A click opens the
  // chat in place: on the lane's first own exchange (or its stub) in the exchanges view, on the
  // chat's last exchange in the branches view.
  function nameLine(row, lane, lanesById, indent, actions) {
    const branches = actions.mode === BRANCHES_MODE;
    const children = [
      jsx('span', { style: { ...SELECTABLE, flex: '0 0 auto', display: 'inline-flex', color: MUTED }, 'data-name-glyph': 'true', children: nameGlyph() }, 'glyph'),
      actions.rename?.chatId === row.lane
        ? jsx(
            Input,
            {
              value: actions.rename.text,
              autoFocus: true,
              'aria-label': 'Rename chat',
              'data-rename-input': row.lane,
              style: { ...SELECTABLE, flex: '1 1 auto', minWidth: 0, height: 20, fontSize: 12, padding: '0 4px', boxSizing: 'border-box' },
              onChange: (event) => setRenameText(event?.target?.value),
              onClick: stop,
              onDoubleClick: stop,
              onKeyDown: (event) => {
                stopHostEvent(event);
                if (event?.key === 'Enter') commitRename(lanesById);
                else if (event?.key === 'Escape') cancelRename();
              },
              onBlur: () => cancelRename(),
            },
            'rename',
          )
        : jsx(
            'span',
            {
              style: { ...LABEL_STYLE, ...(branches ? {} : NAME_TEXT), ...(branches && !row.blue ? { opacity: 0.72 } : {}), ...(row.open ? { fontWeight: 600 } : {}) },
              'data-selectable-text': 'true',
              'data-label': 'true',
              title: 'Double-click to rename',
              onDoubleClick: (event) => {
                stop(event);
                startRename(row.lane, lane?.title ?? row.label);
              },
              children: row.label,
            },
            'label',
          ),
    ];
    if (branches) {
      children.push(jsx('span', { style: { ...NAME_MODEL, maxWidth: 110 }, 'data-selectable-text': 'true', 'data-count': row.count, children: `(${row.count} ${row.count === 1 ? 'exchange' : 'exchanges'})` }, 'count'));
      if (row.merged) children.push(jsx('span', { style: PILL, 'data-selectable-text': 'true', 'data-pill': 'merged', children: 'merged' }, 'merged'));
    }
    // The model in the exchanges view; the branches view keeps the row for the title (the tooltip has it).
    if (lane?.model && !branches) children.push(jsx('span', { style: NAME_MODEL, 'data-selectable-text': 'true', 'data-name-model': 'true', children: modelName(lane.model) }, 'model'));
    const select = () => {
      if (!branches) return selectNode(row.lane, row.index);
      setUi({ open: null });
      openChat(row.lane, 'in-place');
    };
    return jsx(
      'div',
      {
        role: 'button',
        tabIndex: 0,
        title: lane ? tooltip(lane, lanesById, null) : row.label,
        className: row.open ? '' : 'hover:bg-muted',
        style: { ...ROW_STYLE, paddingLeft: indent, ...(row.open ? OPEN_ROW : {}) },
        'data-selectable-text': 'true',
        'data-name-row': row.lane,
        'data-chat-id': row.lane,
        ...(row.blue ? { 'data-blue': 'true' } : {}),
        ...(row.open ? { 'data-open': 'true', 'aria-current': 'true' } : {}),
        ...(row.target ? { 'data-target-lane': 'true' } : {}),
        onClick: () => {
          if (!selecting()) select();
        },
        onKeyDown: onKey(select),
        onMouseEnter: () => hoverSet('pointer', row.key),
        onMouseLeave: () => hoverClear('pointer', row.key),
        children,
      },
      row.key,
    );
  }

  // The rows, with one decorative SVG over them. The SVG takes no clicks; the graph column is
  // the rows' left padding, so no line runs over text. The merge target lane is drawn thicker
  // with a dashed line, in the accent colour. Each shape's role maps to a theme colour here only.
  function graphView(plan, lanes, actions) {
    const geo = graphGeometry(plan);
    const lanesById = new Map(lanes.map((lane) => [lane.id, lane]));
    const indent = geo.width + 2;
    const shapes = [
      ...geo.paths.map((p) =>
        jsx(
          'path',
          {
            d: p.d,
            fill: 'none',
            stroke: ROLE_COLOURS[p.role],
            strokeWidth: (p.role === 'inactive' ? 1.5 : 2) + (p.target ? 1 : 0),
            strokeLinecap: 'round',
            'data-role': p.role,
            ...(p.target ? { strokeDasharray: '4 3', 'data-target': 'true' } : {}),
          },
          p.key,
        ),
      ),
      ...geo.marks.map((m) =>
        jsx('rect', { x: m.x, y: m.y, width: m.size, height: m.size, fill: ROLE_COLOURS[m.role], 'data-role': m.role, 'data-mark': 'name' }, `m:${m.key}`),
      ),
      ...geo.circles.map((c) =>
        jsx(
          'circle',
          {
            cx: c.cx,
            cy: c.cy,
            r: c.r,
            fill: c.filled ? ROLE_COLOURS[c.role] : 'none',
            stroke: ROLE_COLOURS[c.role],
            strokeWidth: c.target ? 2.5 : 1.5,
            'data-role': c.role,
            ...(c.target ? { 'data-target': 'true' } : {}),
          },
          `c:${c.key}`,
        ),
      ),
    ];
    return jsxs(
      'div',
      {
        style: { ...SELECTABLE, ...BLOCK, position: 'relative' },
        'data-selectable-text': 'true',
        'data-tree-graph': 'true',
        children: [
          ...plan.rows
            .map((row) => {
              if (row.kind === 'more') return moreLine(row, indent);
              if (row.kind === 'name') return nameLine(row, lanesById.get(row.lane), lanesById, indent, actions);
              // The result line spans its spacer rows: the first one draws it, the rest hold its height.
              if (row.kind === 'spacer') return row.spanIndex === 0 && actions.result ? resultLine(actions.result, indent, row.span) : null;
              return nodeLine(row, lanesById.get(row.lane), lanesById, indent, actions);
            })
            .filter(Boolean),
          jsxs(
            'svg',
            {
              'aria-hidden': 'true',
              'data-graph': 'true',
              width: geo.width,
              height: geo.height,
              viewBox: `0 0 ${geo.width} ${geo.height}`,
              style: { position: 'absolute', top: 0, left: 0, pointerEvents: 'none', overflow: 'visible' },
              children: shapes,
            },
            'svg',
          ),
        ],
      },
      'graph',
    );
  }

  // A line of pane text.
  const note = (text, extra, key) =>
    jsx('p', { className: 'text-xs opacity-70', style: NOTE, 'data-selectable-text': 'true', ...extra, children: text }, key);

  // The branch model field: Hermes's ModelCatalogMenu in a DropdownMenu, as the kanban plugin's
  // per-task override (plugins/kanban/model-override.tsx). The controller only holds the choice in the
  // form. presetFor gives {} so Hermes's presets never change. allowSpeed is false: model_override has
  // no fast key. A picked row starts at the default level (effort ''), so reasoning goes out only
  // when the user sets a level. Clear goes back to this chat's model.
  function modelField(form) {
    if (!picker) return note(MODEL_PICKER_MISSING_TEXT, { 'data-branch-model-missing': 'true' }, 'model');
    const choice = form.model ?? EMPTY_CHOICE;
    const latest = () => $ui.get().branch?.model ?? EMPTY_CHOICE;
    const controller = {
      allowSpeed: false,
      applyPreset: (_preset, row) => setBranchModel({ model: row?.model, provider: row?.provider, effort: '' }),
      current: { effort: choice.effort, fast: false, model: choice.model, provider: choice.provider },
      presetFor: () => ({}),
      select: (model, provider) => setBranchModel({ ...latest(), model, provider }),
      setOptions: (patch, row) => {
        if (patch?.effort === undefined) return;
        // A level edit can arrive with a row that names no model: keep the picked model then.
        const now = latest();
        setBranchModel({ effort: patch.effort, model: str(row?.model) || now.model, provider: str(row?.provider) || now.provider });
      },
    };
    const menu = jsx(picker.Menu, { controller, profile: profileKey(atomOf('profile').get()) }, 'menu');
    const picked = Boolean(modelOverride(choice));
    const close = () => setBranchPicking(false);
    return jsxs(
      'div',
      {
        className: 'flex items-center gap-1',
        style: SELECTABLE,
        'data-selectable-text': 'true',
        children: [
          jsxs(
            picker.Root,
            {
              open: form.picking === true,
              onOpenChange: (open) => setBranchPicking(open),
              children: [
                jsx(
                  picker.Trigger,
                  {
                    asChild: true,
                    children: jsxs(Button, {
                      type: 'button',
                      variant: 'outline',
                      className: 'h-8 w-full justify-between gap-2 font-normal',
                      style: { ...SELECTABLE, flex: '1 1 auto', minWidth: 0, fontSize: 12, padding: '0 10px', ...(picked ? {} : { opacity: 0.72 }) },
                      'data-branch-model': 'true',
                      disabled: form.busy,
                      children: [
                        jsx('span', { className: 'min-w-0 truncate', style: SELECTABLE, 'data-selectable-text': 'true', children: choiceLabel(choice, picker.effortLabel) }, 'label'),
                        jsx('span', { 'aria-hidden': 'true', className: 'shrink-0', style: { ...SELECTABLE, opacity: 0.5 }, children: '▾' }, 'caret'),
                      ],
                    }),
                  },
                  'trigger',
                ),
                jsx(
                  picker.Content,
                  { align: 'start', className: 'w-72 p-0', children: picker.Close ? jsx(picker.Close, { value: close, children: menu }) : menu },
                  'content',
                ),
              ],
            },
            'picker',
          ),
          picked
            ? jsx(
                Button,
                {
                  type: 'button',
                  variant: 'ghost',
                  title: `Back to ${MODEL_INHERIT_TEXT.toLowerCase()}`,
                  'data-branch-model-clear': 'true',
                  disabled: form.busy,
                  style: ROW_ACTION,
                  onClick: (event) => {
                    stop(event);
                    setBranchModel(EMPTY_CHOICE);
                  },
                  children: 'Clear',
                },
                'clear',
              )
            : null,
        ].filter(Boolean),
      },
      'model',
    );
  }

  // The Branch here form, below the graph so the rows never move. busy: the open chat is running.
  function branchForm(form, busy) {
    const blocked = busy || form.busy;
    const submit = () => (blocked ? undefined : submitBranch());
    const field = (key, placeholder, extra = {}) =>
      jsx(
        Input,
        {
          value: form[key],
          placeholder,
          style: INPUT_STYLE,
          'data-selectable-text': 'true',
          'data-branch-field': key,
          disabled: form.busy,
          onChange: (event) => setBranchField(key, event?.target?.value),
          onKeyDown: stopHostEvent,
          onKeyUp: stopHostEvent,
          onPointerDown: stopHostEvent,
          ...extra,
        },
        key,
      );
    return jsxs(
      'div',
      {
        className: 'flex flex-col gap-1 rounded border p-2',
        style: { ...BLOCK, marginTop: 6 },
        'data-selectable-text': 'true',
        'data-branch-form': `${form.chatId}:${form.index}`,
        onClick: stop,
        children: [
          jsx('p', { className: 'text-xs font-semibold', style: NOTE, 'data-selectable-text': 'true', children: `Branch here: ${form.label}` }, 'head'),
          field('question', 'Question for the branch (optional)', {
            onKeyDown: (event) => {
              stopHostEvent(event);
              if (event?.key === 'Enter' && !event.shiftKey) {
                event.preventDefault?.();
                submit();
              }
            },
          }),
          modelField(form),
          jsxs(
            'div',
            {
              className: 'flex flex-wrap items-center gap-1',
              style: SELECTABLE,
              'data-selectable-text': 'true',
              children: [
                jsx(Button, {
                  type: 'button',
                  'data-branch-submit': 'true',
                  disabled: blocked,
                  onClick: (event) => {
                    stop(event);
                    return submit();
                  },
                  children: str(form.question) ? 'Branch and ask' : 'Branch',
                }),
                jsx(Button, {
                  type: 'button',
                  variant: 'ghost',
                  'data-branch-cancel': 'true',
                  disabled: form.busy,
                  onClick: (event) => {
                    stop(event);
                    cancelBranch();
                  },
                  children: 'Cancel',
                }),
                form.busy ? jsx('span', { className: 'text-xs opacity-60', style: SELECTABLE, 'data-selectable-text': 'true', children: 'Branching...' }) : null,
              ].filter(Boolean),
            },
            'buttons',
          ),
          busy ? note(BRANCH_BUSY_TEXT, { 'data-branch-busy': 'true' }, 'busy') : null,
          form.error
            ? jsx('p', { className: 'text-xs text-destructive', style: NOTE, 'data-selectable-text': 'true', 'data-branch-error': 'true', children: form.error }, 'error')
            : null,
        ].filter(Boolean),
      },
      'branch-form',
    );
  }

  // A notice that stays until Dismiss: the no-fit notice, or a failed fork digest.
  function heldNotice(text, kind, onDismiss) {
    return jsxs(
      'div',
      {
        className: 'flex items-start justify-between gap-2',
        style: { ...SELECTABLE, ...BLOCK },
        'data-selectable-text': 'true',
        'data-held-notice': kind,
        onClick: stop,
        children: [
          jsx('p', { className: 'text-xs', style: { ...NOTE, flex: '1 1 auto' }, 'data-selectable-text': 'true', children: text }, 'text'),
          jsx(Button, {
            type: 'button',
            size: 'xs',
            variant: 'ghost',
            'data-dismiss': kind,
            onClick: (event) => {
              stop(event);
              onDismiss();
            },
            children: 'Dismiss',
          }),
        ],
      },
      `held:${kind}`,
    );
  }

  function agentLine(agent) {
    const parts = [agent.status, agent.model].filter(Boolean);
    const id = agent.child_session_id;
    return jsxs(
      'div',
      {
        className: `flex min-w-0 flex-col rounded px-1 py-0.5${id ? ' cursor-pointer hover:bg-muted' : ''}`,
        style: BLOCK,
        'data-selectable-text': 'true',
        'data-subagent-id': agent.subagent_id,
        ...(id ? { role: 'button', onClick: onClickOpen(id) } : {}),
        children: [
          jsx('span', { className: 'text-sm', style: NOTE, 'data-selectable-text': 'true', 'data-subagent-goal': 'true', children: `↳ subagent: ${agent.goal ?? '(no goal)'}` }, 'goal'),
          jsx('span', { className: 'text-xs opacity-60', style: NOTE, 'data-selectable-text': 'true', children: parts.join(' · ') }, 'meta'),
        ],
      },
      `agent:${agent.subagent_id}`,
    );
  }

  // Hook order is fixed: eight useValue calls, every render, before any branch (React error 300).
  // The last two are the in-memory UI and hover atoms. Render only reads state; loading happens on focus change
  // and on the timer, in register(); branching and merging happen in click handlers. Row builders
  // have no hooks.
  // One toggle for the view: a branch icon, pressed (in the accent) in the Branches view. A click
  // switches between Exchanges and Branches; the tooltip names the view and the next one.
  function modeToggle(mode) {
    const branches = mode === BRANCHES_MODE;
    const next = branches ? EXCHANGES_MODE : BRANCHES_MODE;
    const label = branches ? 'Branches view. Click for exchanges.' : 'Exchanges view. Click for branches.';
    const icon = ViewIcon
      ? jsx(ViewIcon, { size: 14, 'aria-hidden': 'true' }, 'icon')
      : jsxs('svg', {
          viewBox: '0 0 24 24', width: 14, height: 14, fill: 'none', stroke: 'currentColor', strokeWidth: 2,
          strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
          children: [
            jsx('circle', { cx: 7, cy: 18, r: 2 }, 'a'),
            jsx('circle', { cx: 7, cy: 6, r: 2 }, 'b'),
            jsx('circle', { cx: 17, cy: 6, r: 2 }, 'c'),
            jsx('path', { d: 'M7 8v8M17 8a4 4 0 0 1 -4 4h-2a4 4 0 0 0 -4 4' }, 'd'),
          ],
        }, 'icon');
    return jsx(
      'button',
      {
        type: 'button',
        title: label,
        'aria-label': label,
        'aria-pressed': branches,
        style: { ...MODE_BUTTON, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 22, padding: 0, borderRadius: 4, ...(branches ? MODE_ON : {}) },
        'data-selectable-text': 'true',
        'data-mode-toggle': 'true',
        'data-mode': mode,
        onClick: () => setMode(next),
        children: icon,
      },
      'mode',
    );
  }

  function renderPane() {
    const stored = useValue(atomOf('focusedStoredSessionId'));
    const focused = useValue(atomOf('focusedSessionId'));
    const active = useValue(atomOf('activeSessionId'));
    const busyMap = useValue(atomOf('busyBySession'));
    const data = useValue($data);
    const status = useValue($status);
    const ui = useValue($ui);
    const hover = useValue($hover);

    const runtime = focused ?? active ?? null;
    const want = stored ?? runtime;
    const centre = treeFocus(data.rows, want, data.lastFocus);
    const fellBack = Boolean(want) && centre !== want;
    const tree = buildTree(data.rows, centre);
    const chats = lineageChats(tree);
    const lanes = buildLanes(chats, data.exchanges, data.branchIds);
    const open = tree && !fellBack ? (lanes.find((lane) => lane.id === tree.focused.id) ?? null) : null;
    const targets = open ? mergeTargets(lanes, open.id) : [];
    // The pick of the open chat only. While it is open, its hovered target lights up: the target's
    // last exchange takes the hover path. The preview wins over the row pointer: the popover is a
    // React child of its row, so the pointer in the popover never leaves the row.
    const pick = ui.pick && open && ui.pick.chatId === open.id ? ui.pick : null;
    const previewLane = pick && hover.target ? lanes.find((lane) => lane.id === hover.target) : null;
    const preview = previewLane && previewLane.exchanges.length ? `${previewLane.id}:${previewLane.exchanges.length - 1}` : null;
    const mode = ui.mode === BRANCHES_MODE ? BRANCHES_MODE : EXCHANGES_MODE;
    let plan = planGraph(lanes, { focusedId: tree?.focused?.id, open: ui.open, expanded: ui.expanded, digests: data.digests, hovered: preview ?? hover.pointer, mode });
    // The result line takes spacer rows under its row (else the open row, else the last row), so
    // the graph's lines run on through it: one row, two for a failure.
    const result = ui.result;
    if (result && plan.rows.length) {
      let at = plan.rows.findIndex((row) => row.kind === 'node' && row.key === result.anchor);
      if (at < 0) at = plan.rows.findIndex((row) => row.open);
      if (at < 0) at = plan.rows.length - 1;
      plan = withSpacer(plan, at, result.busy !== true && result.ok !== true ? 2 : 1, { key: 'result' });
    }
    const agents = runtime && data.agentsFor === runtime ? data.agents : [];
    const busy = open ? chatBusy(busyMap, [runtime, open.id]) : false;
    const form = ui.branch && open && ui.branch.chatId === open.id ? ui.branch : null;
    const actions = {
      rename: ui.rename ?? null,
      openId: open?.id ?? null,
      busy,
      model: open?.model ?? '',
      hover,
      mergeLane: open && targets.length ? open.id : null,
      merging: result?.busy === true,
      pick,
      targets,
      open,
      result,
      form,
      mode,
    };
    // The form shows under the graph when no row holds it in a popover.
    const formAnchored = Boolean(pop && form && plan.rows.some((row) => row.kind === 'node' && row.branchable && row.branchFrom === form.chatId && row.index === form.index));

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
    } else if (tree && !plan.rows.length && !status.loading) {
      notice = 'No messages in this chat tree yet.';
    }
    const total = lineageChats(tree, Infinity).length;
    const capped = total > chats.length ? `Showing ${chats.length} of ${total} chats in this tree.` : null;

    return jsx(ScrollArea, {
      children: jsxs('div', {
        className: 'flex flex-col gap-1 p-3 text-sm',
        style: PANE_ROOT,
        'data-selectable-text': 'true',
        'data-chat-tree-root': 'true',
        children: [
          jsxs(
            'div',
            {
              className: 'flex flex-wrap items-center gap-2',
              style: BLOCK,
              'data-pane-head': 'true',
              children: [
                iconButton({ label: 'Refresh', glyph: refreshGlyph, key: 'refresh', disabled: disposed, attrs: { 'data-refresh': 'true' }, onClick: () => reload() }),
                modeToggle(mode),
                status.loading ? jsx('span', { className: 'text-xs opacity-60', style: SELECTABLE, children: 'Loading...' }, 'loading') : null,
              ].filter(Boolean),
            },
            'head',
          ),
          status.error
            ? jsx('pre', {
                className: 'text-xs text-destructive',
                style: { ...NOTE, whiteSpace: 'pre-wrap', font: 'inherit' },
                'data-note': 'error',
                children: status.error,
              }, 'error')
            : null,
          notice ? note(notice, { 'data-note': 'notice' }, 'notice') : null,
          capped ? note(capped, { 'data-note': 'capped' }, 'capped') : null,
          status.note ? note(status.note, { 'data-note': 'status' }, 'status') : null,
          fellBack ? note(UNLISTED_FOCUS_TEXT, { 'data-unlisted-focus': 'true' }, 'unlisted') : null,
          plan.rows.length ? graphView(plan, lanes, actions) : null,
          // Without Hermes's Popover, the merge pick shows here, under the graph.
          pick && !pop
            ? jsx(
                'div',
                {
                  className: 'flex flex-col',
                  style: { ...BLOCK, marginTop: 4, border: '1px solid var(--dt-border, #3f3f46)', borderRadius: 6, padding: 4 },
                  'data-merge-pick': pick.rowKey,
                  'data-selectable-text': 'true',
                  onKeyDown: pickKeys,
                  children: pickPanel(actions),
                },
                'pick',
              )
            : null,
          form && !formAnchored ? branchForm(form, busy) : null,
          !form && busy && plan.rows.some((row) => row.branchable) ? note(BRANCH_BUSY_TEXT, { 'data-branch-busy': 'true' }, 'busy') : null,
          ui.forkNotice ? heldNotice(ui.forkNotice, 'fork', dismissForkNotice) : null,
          agents.length
            ? jsx('div', { className: 'flex flex-col', style: { ...BLOCK, marginTop: 4 }, 'data-subagents': 'true', children: agents.map(agentLine) }, 'agents')
            : null,
        ].filter(Boolean),
      }),
    });
  }

  // Stops the timer and every store listener. Wired to ctx.onDispose.
  function dispose() {
    disposed = true;
    revealing?.abort();
    revealing = null;
    if (typeof cancelSoon === 'function') cancelSoon();
    cancelSoon = null;
    generation += 1;
    if (typeof cancelTimer === 'function') cancelTimer();
    cancelTimer = null;
    // Pending digests end now; their callers see the dead activation and do nothing.
    for (const finish of [...jobs.values()]) finish({ ok: false, error: 'The pane was closed.' });
    early.clear();
    listening = false;
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
    historyCache = new Map();
    named = new Set();
    cancelSoon = null;
    storage = ctx?.storage ?? null;
    // ctx.onEvent is tracked and removed with the plugin (contrib/plugin.ts); host.onEvent is the fallback.
    const listen = typeof ctx?.onEvent === 'function' ? ctx.onEvent : typeof host?.onEvent === 'function' ? host.onEvent : null;
    if (listen) {
      try {
        const off = listen(DIGEST_EVENT, onDigestEvent);
        if (typeof off === 'function') unsubscribers.push(off);
        listening = true;
      } catch {
        listening = false;
      }
      for (const type of RELOAD_EVENTS) {
        try {
          const off = listen(type, onTreeEvent);
          if (typeof off === 'function') unsubscribers.push(off);
        } catch {
          // A host that refuses the subscription: the REFRESH_MS tick still reloads.
        }
      }
    }
    $status.set({ loading: false, error: null, note: null });
    $ui.set({ ...freshUi(), mode: read(MODE_KEY) === BRANCHES_MODE ? BRANCHES_MODE : EXCHANGES_MODE });
    $hover.set(freshHover());
    $data.set({ ...$data.get(), branchIds: storedBranchIds() });
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
        keywords: ['tree', 'branch', 'subagent', 'lineage', 'merge'],
        run: () => {
          if (typeof host?.revealPane === 'function') host.revealPane(`${PLUGIN_ID}:${PANE_ID}`);
        },
      },
    });
  }

  return { register, renderPane, load, openChat, dispose, $data, $status, $ui, $hover };
}
