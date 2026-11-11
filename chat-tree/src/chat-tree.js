// Chat tree pane: a git graph of the focused chat's tree. A node is one exchange (one user
// message and its replies). A lane is one chat. A child lane forks off its parent at the last
// exchange they share. A parent exchange that starts with `From side chat: <side question>` is a
// merge node, linked by a curve to the one child chat that starts with that question. Blue marks the path from the
// first exchange of the root chat to the open node; everything else is grey. A click on a node
// opens its chat in place. Side chats keep a Merge as-is button that stages the side exchange
// verbatim in the parent composer (never sends it). Live subagents show below the graph.
// Plain ESM with no imports: the SDK pieces and timers are injected so it runs under node --test.
// Spec: docs/specs/2026-11-12-competition-build/spec.md (unit.tree_view)

export const PLUGIN_ID = 'chat-tree';
export const PANE_ID = 'pane';
export const REFRESH_MS = 15_000;
export const LIST_LIMIT = 500;
export const MAX_CHATS = 30;
export const SIDE_PREFIX = 'Side: ';
export const MERGE_HEADER = 'From side chat: ';
export const LABEL_MAX = 60;
// Graph geometry in px. A row is one exchange; lanes are columns inside the graph column.
export const ROW_H = 26;
export const GRAPH_W = 58;
export const GRAPH_PAD = 8;
export const LANE_GAP = 14;
export const NODE_R = 4;
export const CURVE_R = 5;
// The only two graph colours: the path to the open node, and everything else.
export const BLUE = '#3B82F6';
export const GREY = '#6B7280';
// Same wording as side-chat (side-chat/src/side-chat.js): the two panes show one merge flow.
export const MERGE_STAGED_TEXT =
  'The draft is in the main chat composer. Edit it and send. After sending, session.undo on an idle parent can drop that turn.';
export const MERGE_HIDDEN_TEXT = "The main chat's composer is not visible. Open the main chat and try again.";
export const MERGE_NO_COMPOSER_TEXT = 'The composer draft API is missing. Nothing was written.';

const SELECTABLE = { userSelect: 'text', WebkitUserSelect: 'text' };
const HISTORY_CONCURRENCY = 4;
const HISTORY_CACHE_MAX = 200;

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

export function isSideChat(row) {
  return isSideTitle(row?.title) || isKnownSideBranch(row?.id);
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

// A side chat is a copy of its parent, then its own turns. Walk both lists from the start while
// role and text match: that is the copied history. The remainder of the side list is new.
export function rowsAfterSharedPrefix(sideRows, parentRows) {
  const side = Array.isArray(sideRows) ? sideRows : [];
  const parent = Array.isArray(parentRows) ? parentRows : [];
  let i = 0;
  while (i < side.length && i < parent.length && side[i]?.role === parent[i]?.role && rowText(side[i]) === rowText(parent[i])) i += 1;
  return side.slice(i);
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
  return `${MERGE_HEADER}${name}\n\n${blocks.join('\n\n')}`;
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
  const line = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
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

// A history is read again only when its chat's message count or last activity moved.
// null (no metadata) means: always read.
export function historyKey(row) {
  const count = num(row?.message_count);
  const active = num(row?.last_active);
  return count || active ? `${count}:${active}` : null;
}

// One lane per chat: { id, row, title, model, side, parentId, exchanges, fork }. fork is the
// number of exchanges shared with the parent lane (0 for the root).
export function buildLanes(chats, exchangesById) {
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
      side: isSideChat(row),
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

// rows: [{ kind: 'node', key, lane, index, label, merge, mergeFrom, blue, open, first } |
//        { kind: 'more', key, runKey, lane, index, count, blue }], oldest first, each with col.
// lanes: [{ id, col, rows, firstRow, lastRow, anchorRow, anchorCol }] for lanes with rows.
// merges: [{ from, fromRow, to, toRow }]: a curve from a side lane's last row to a merge node.
// A node `lane:index` is drawn once, on the lane that owns it: the shared exchanges of a child
// are its parent's. options: { focusedId, open: { chatId, index } | null, expanded: { [runKey]: true } }.
export function planGraph(lanes, options = {}) {
  const list = Array.isArray(lanes) ? lanes : [];
  const byId = new Map(list.map((lane) => [lane.id, lane]));
  const start = (lane) => (lane.parentId ? Math.min(lane.fork, lane.exchanges.length) : 0);
  const nodeKey = (id, index) => `${id}:${index}`;

  // The lane that draws exchange `index` of chat `id`: up the parents while it is shared.
  const resolve = (id, index) => {
    let lane = byId.get(id);
    const seen = new Set();
    while (lane && lane.parentId && index < lane.fork && !seen.has(lane.id)) {
      seen.add(lane.id);
      lane = byId.get(lane.parentId);
    }
    return lane ? { lane: lane.id, index } : null;
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
  } else if (focused && focused.exchanges.length) {
    target = resolve(focused.id, focused.exchanges.length - 1);
  }
  const openKey = target ? nodeKey(target.lane, target.index) : null;

  // Blue: on each lane from the open node up through the fork nodes to the root's first exchange.
  const blue = new Set();
  for (let at = target, guard = new Set(); at && !guard.has(at.lane); at = anchorOf.get(at.lane) ?? null) {
    guard.add(at.lane);
    const lane = byId.get(at.lane);
    for (let i = start(lane); i <= at.index; i++) blue.add(nodeKey(lane.id, i));
  }

  // Rows, depth first: a lane's own exchanges in order, each fork node followed by its children.
  const expanded = options.expanded ?? {};
  const rows = [];
  const visited = new Set();
  const pushNode = (lane, i) => {
    const ex = lane.exchanges[i];
    const key = nodeKey(lane.id, i);
    rows.push({ kind: 'node', key, lane: lane.id, index: i, label: ex.label, merge: ex.merge, mergeFrom: null, blue: blue.has(key), open: key === openKey, first: false });
  };
  const emit = (lane) => {
    if (visited.has(lane.id)) return;
    visited.add(lane.id);
    const n = lane.exchanges.length;
    const s = start(lane);
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
        rows.push({ kind: 'more', key: `more:${runKey}`, runKey, lane: lane.id, index: i, count: j - i, blue: blue.has(runKey) });
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
    const entry = info.get(row.lane) ?? { id: row.lane, rows: [], firstRow: index, lastRow: index, anchorRow: -1, anchorCol: -1, col: 0, end: index };
    entry.rows.push(index);
    entry.lastRow = index;
    entry.end = index;
    info.set(row.lane, entry);
  });
  for (const entry of info.values()) rows[entry.firstRow].first = true;

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

  // Columns: a lane holds its column from its fork node to its last row (or its last merge).
  // A child sits right of the lane it forks from; the lowest free column wins.
  for (const [id, entry] of info) {
    const at = anchorOf.get(id);
    if (at) entry.anchorRow = rowOf.get(nodeKey(at.lane, at.index)) ?? -1;
  }
  const order = [...info.values()].sort((a, b) => (a.anchorRow >= 0 ? a.anchorRow : a.firstRow) - (b.anchorRow >= 0 ? b.anchorRow : b.firstRow) || a.firstRow - b.firstRow);
  const placed = [];
  for (const entry of order) {
    const lane = byId.get(entry.id);
    const from = entry.anchorRow >= 0 ? info.get(anchorOf.get(entry.id).lane) : lane.parentId ? info.get(lane.parentId) : null;
    const begin = entry.anchorRow >= 0 ? entry.anchorRow : entry.firstRow;
    let col = from ? from.col + 1 : 0;
    while (placed.some((p) => p.col === col && p.begin <= entry.end && begin <= p.end)) col += 1;
    entry.col = col;
    if (entry.anchorRow >= 0) entry.anchorCol = from.col;
    placed.push({ col, begin, end: entry.end });
  }
  for (const row of rows) row.col = info.get(row.lane).col;

  const laneList = [...info.values()].map(({ end, ...entry }) => entry);
  return { rows, lanes: laneList, merges, openKey };
}

// ── Graph geometry: a pure function of the plan, in px ──────────────────────────────────────

const laneX = (col) => GRAPH_PAD + col * LANE_GAP;
const rowY = (row) => row * ROW_H + ROW_H / 2;

// { width, height, circles: [{ key, cx, cy, r, color, filled }], paths: [{ key, d, color }] }.
// Lane lines stop at circle edges. A fork leaves its node sideways, turns down with a rounded
// corner, and runs to the child's first node. A merge runs down from the side lane's last node
// and turns into the merge node. Merge curves are always grey: a merged chat is not on the path.
export function graphGeometry(plan) {
  const rows = Array.isArray(plan?.rows) ? plan.rows : [];
  const lanes = Array.isArray(plan?.lanes) ? plan.lanes : [];
  const maxCol = rows.reduce((m, row) => Math.max(m, num(row.col)), 0);
  const width = Math.max(GRAPH_W, GRAPH_PAD * 2 + maxCol * LANE_GAP);
  const height = rows.length * ROW_H;
  const colour = (on) => (on ? BLUE : GREY);
  const edge = (index) => (rows[index].kind === 'node' ? NODE_R : 0);
  const paths = [];
  for (const lane of lanes) {
    const x = laneX(lane.col);
    for (let k = 1; k < lane.rows.length; k++) {
      const a = lane.rows[k - 1];
      const b = lane.rows[k];
      paths.push({ key: `lane:${lane.id}:${a}`, d: `M ${x} ${rowY(a) + edge(a)} V ${rowY(b) - edge(b)}`, color: colour(rows[b].blue) });
    }
    if (lane.anchorRow >= 0) {
      const xa = laneX(lane.anchorCol);
      const ya = rowY(lane.anchorRow);
      const d = `M ${xa + NODE_R} ${ya} H ${x - CURVE_R} A ${CURVE_R} ${CURVE_R} 0 0 1 ${x} ${ya + CURVE_R} V ${rowY(lane.firstRow) - NODE_R}`;
      paths.push({ key: `fork:${lane.id}`, d, color: colour(rows[lane.firstRow].blue) });
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
    paths.push({ key: `merge:${merge.from}:${merge.toRow}`, d, color: GREY });
  }
  const circles = [];
  rows.forEach((row, index) => {
    if (row.kind !== 'node') return;
    circles.push({ key: row.key, cx: laneX(row.col), cy: rowY(index), r: NODE_R, color: colour(row.blue), filled: row.open === true });
  });
  return { width, height, circles, paths };
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
const ROW_STYLE = {
  ...SELECTABLE,
  height: ROW_H,
  boxSizing: 'border-box',
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  paddingRight: 4,
  overflow: 'hidden',
  whiteSpace: 'nowrap',
  cursor: 'pointer',
};
const OPEN_ROW = { background: 'rgba(59,130,246,0.14)', boxShadow: `inset 2px 0 0 ${BLUE}` };
const LABEL_STYLE = { ...SELECTABLE, flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const PILL = {
  ...SELECTABLE,
  flex: '0 0 auto',
  maxWidth: 84,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  border: `1px solid ${GREY}`,
  borderRadius: 4,
  padding: '0 4px',
  fontSize: 10,
  lineHeight: '14px',
};

export function createChatTree(deps) {
  const { host, jsx, jsxs, atom, useValue, Button, ScrollArea } = deps;

  // rows: last good session rows. agents: last good subagents, for agentsFor (a runtime id).
  // exchanges: { [chat id]: exchanges } for the chats of the focused tree.
  const $data = atom({ rows: [], agents: [], agentsFor: null, exchanges: {} });
  // note: why live subagents are not shown (not an error).
  const $status = atom({ loading: false, error: null, note: null });
  // In memory only, never stored: open: { chatId, index } the clicked node; expanded: { [run key]:
  // true } the +N runs the user opened; merge: { [side chat id]: { busy, notice, fit, sideTokens, available } }.
  const freshUi = () => ({ open: null, expanded: {}, merge: {} });
  const $ui = atom(freshUi());
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
  // chat id -> { key, exchanges }: a history is read again only when historyKey(row) moves.
  let historyCache = new Map();
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

  // Exchanges of every chat in the focused tree. A cached history is used while its chat's
  // message count and last activity hold; a failed read keeps the last good one.
  async function loadExchanges(rows, focusedId) {
    const chats = lineageChats(buildTree(rows, focusedId));
    const exchanges = {};
    const errors = [];
    const stale = [];
    for (const { row } of chats) {
      const key = historyKey(row);
      const hit = historyCache.get(row.id);
      if (hit && key !== null && hit.key === key) exchanges[row.id] = hit.exchanges;
      else stale.push(row);
    }
    await eachLimited(stale, HISTORY_CONCURRENCY, async (row) => {
      try {
        const list = exchangesFromRows(await readRows(row.id));
        historyCache.delete(row.id);
        historyCache.set(row.id, { key: historyKey(row), exchanges: list });
        exchanges[row.id] = list;
      } catch (error) {
        const old = historyCache.get(row.id);
        if (old) exchanges[row.id] = old.exchanges;
        errors.push(`History of ${str(row.title) || 'Untitled'}: ${errorText(error)}`);
      }
    });
    while (historyCache.size > HISTORY_CACHE_MAX) historyCache.delete(historyCache.keys().next().value);
    return { exchanges, errors };
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
    if (agentsOk) {
      const histories = await loadExchanges(next.rows, stored ?? runtime);
      if (disposed || mine !== generation) return;
      next.exchanges = histories.exchanges;
      errors.push(...histories.errors);
    }
    $data.set(next);
    $status.set({
      loading: false,
      error: errors.length ? errors.join('\n') : null,
      note: agentsOk ? null : 'Messages and subagents are unavailable for a chat of another profile or connection.',
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

  // ── UI state (all in $ui; render only reads it) ───────────────────────────────────────────

  const setUi = (patch) => $ui.set({ ...$ui.get(), ...patch });
  const setMerge = (id, state) => setUi({ merge: { ...$ui.get().merge, [id]: state } });

  // A click on a node makes it the open node and opens its chat in place.
  function selectNode(chatId, index) {
    setUi({ open: { chatId, index } });
    openChat(chatId, 'in-place');
  }
  const expandRun = (runKey) => setUi({ expanded: { ...$ui.get().expanded, [runKey]: true } });
  // Enter or Space on a focused row acts like a click.
  const onKey = (fn) => (event) => {
    if (event?.key !== 'Enter' && event?.key !== ' ') return;
    event.preventDefault?.();
    fn();
  };

  // ── Merge as-is: stage a side chat verbatim in its parent's composer. Never sends. ───────────

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

  // Parent context window. Never the side chat's own: it holds a copy of the parent's history.
  async function parentHeadroom(parentId, sideId) {
    const ids = [];
    if (typeof parentId === 'string' && parentId) ids.push(parentId);
    const focused = atomOf('focusedSessionId').get();
    const focusedIsSide = atomOf('focusedStoredSessionId').get() === sideId;
    if (!focusedIsSide && typeof focused === 'string' && focused && !ids.includes(focused)) ids.push(focused);
    for (const method of ['session.usage', 'session.stats', 'session.context_breakdown']) {
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

  async function tryDraft(sessionId, text) {
    try {
      return (await host.composer.setDraft(sessionId, text)) === true;
    } catch {
      return false;
    }
  }

  // Click handler: reads, fit check, open the parent, stage the draft. Never throws, never sends,
  // and never merges unless the user clicked. The check happens here, not in render.
  async function mergeAsIs(row) {
    const sideId = row?.id;
    if (!sideId || $ui.get().merge[sideId]?.busy) return;
    const act = activation;
    const alive = () => !disposed && act === activation;
    const show = (state) => {
      if (alive()) setMerge(sideId, state);
    };
    try {
      if (typeof host?.composer?.setDraft !== 'function') return show({ notice: MERGE_NO_COMPOSER_TEXT });
      const parentId = forkParentId(row);
      if (!parentId) return show({ notice: 'This side chat has no parent chat to merge into.' });
      show({ busy: true });

      let sideRows;
      let parentRows;
      try {
        sideRows = await readRows(sideId);
      } catch (error) {
        return show({ notice: `Could not read the side chat: ${errorText(error)}` });
      }
      if (!alive()) return;
      try {
        parentRows = await readRows(parentId);
      } catch (error) {
        return show({ notice: `Could not read the parent chat: ${errorText(error)}` });
      }
      if (!alive()) return;

      const turns = turnsFromRows(rowsAfterSharedPrefix(sideRows, parentRows));
      if (!turns.length) {
        return show({ notice: 'Nothing to merge: the side chat has no new question and answer after the shared history.' });
      }
      const verbatim = formatSideVerbatim(row.title, turns);
      const sideTokens = estimateTokens(verbatim);

      const headroom = await parentHeadroom(parentId, sideId);
      if (!alive()) return;
      if (headroom && sideTokens > headroom.available) {
        return show({
          fit: 'no',
          sideTokens,
          available: headroom.available,
          notice: formatNoFitNotice({
            sideTokens,
            available: headroom.available,
            used: headroom.used,
            max: headroom.max,
            sideEstimated: true,
            windowEstimated: headroom.estimated === true,
          }),
        });
      }

      if (typeof host.openSession === 'function') {
        try {
          await host.openSession(parentId, { intent: 'in-place' });
        } catch {
          // setDraft is fail-closed when the parent composer is not mounted.
        }
      }
      if (!alive()) return;
      let ok = await tryDraft(parentId, verbatim);
      if (!ok) {
        // Never stage into the side chat itself.
        const focused = atomOf('focusedSessionId').get();
        if (typeof focused === 'string' && focused && atomOf('focusedStoredSessionId').get() !== sideId) {
          ok = await tryDraft(focused, verbatim);
        }
      }
      if (!alive()) return;

      const fit = headroom ? 'yes' : 'unknown';
      const base = { fit, sideTokens, available: headroom?.available };
      if (!ok) return show({ ...base, notice: MERGE_HIDDEN_TEXT });
      // Staged. Once the user sends it, the parent's next history read shows the merge node.
      show({ ...base, notice: headroom ? MERGE_STAGED_TEXT : formatMissingWindowNotice(sideTokens) });
    } catch (error) {
      show({ notice: `Merge failed: ${errorText(error)}` });
    }
  }

  // ── Graph rows ─────────────────────────────────────────────────────────────────────────────

  // `title · model`, and `side chat of X` for a side chat. A native tooltip: rows never grow.
  function tooltip(lane, lanesById) {
    const head = [lane.title, lane.model].filter(Boolean).join(' · ');
    if (!lane.side) return head;
    const parent = lane.parentId ? lanesById.get(lane.parentId) : null;
    return `${head}\nside chat of ${parent ? parent.title : 'a chat that is not loaded'}`;
  }

  function nodeLine(row, lane, lanesById, indent) {
    const children = [
      jsx(
        'span',
        { style: { ...LABEL_STYLE, ...(row.blue ? {} : { opacity: 0.72 }), ...(row.open ? { fontWeight: 600 } : {}) }, children: row.label },
        'label',
      ),
    ];
    if (row.first && lane.model) children.push(jsx('span', { style: PILL, 'data-pill': 'model', children: modelName(lane.model) }, 'model'));
    if (row.first && lane.side) children.push(jsx('span', { style: PILL, 'data-pill': 'side', children: 'side' }, 'side'));
    const select = () => selectNode(row.lane, row.index);
    return jsxs(
      'div',
      {
        role: 'button',
        tabIndex: 0,
        title: tooltip(lane, lanesById),
        className: row.open ? '' : 'hover:bg-muted',
        style: { ...ROW_STYLE, paddingLeft: indent, ...(row.open ? OPEN_ROW : {}) },
        'data-selectable-text': 'true',
        'data-node': row.key,
        'data-chat-id': row.lane,
        'data-exchange': row.index,
        ...(row.blue ? { 'data-blue': 'true' } : {}),
        ...(row.open ? { 'data-open': 'true', 'aria-current': 'true' } : {}),
        ...(row.merge !== null ? { 'data-merge-node': row.mergeFrom ?? '' } : {}),
        onClick: () => {
          if (!selecting()) select();
        },
        onKeyDown: onKey(select),
        children,
      },
      row.key,
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

  // The rows, with one decorative SVG over them. The SVG takes no clicks; the graph column is
  // the rows' left padding, so no line runs over text.
  function graphView(plan, lanes) {
    const geo = graphGeometry(plan);
    const lanesById = new Map(lanes.map((lane) => [lane.id, lane]));
    const indent = geo.width + 2;
    const shapes = [
      ...geo.paths.map((p) =>
        jsx('path', { d: p.d, fill: 'none', stroke: p.color, strokeWidth: p.color === BLUE ? 2 : 1.5, strokeLinecap: 'round' }, p.key),
      ),
      ...geo.circles.map((c) => jsx('circle', { cx: c.cx, cy: c.cy, r: c.r, fill: c.filled ? c.color : 'none', stroke: c.color, strokeWidth: 1.5 }, `c:${c.key}`)),
    ];
    return jsxs(
      'div',
      {
        style: { ...SELECTABLE, position: 'relative', minWidth: 0 },
        'data-selectable-text': 'true',
        'data-tree-graph': 'true',
        children: [
          ...plan.rows.map((row) => (row.kind === 'more' ? moreLine(row, indent) : nodeLine(row, lanesById.get(row.lane), lanesById, indent))),
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

  function mergeResult(state) {
    return jsxs('div', {
      className: 'flex flex-col',
      style: SELECTABLE,
      'data-selectable-text': 'true',
      'data-merge-result': 'true',
      ...(state.fit ? { 'data-token-fit': state.fit } : {}),
      children: [
        jsx('p', {
          className: 'text-xs',
          style: SELECTABLE,
          'data-selectable-text': 'true',
          'data-merge-notice': 'true',
          children: state.notice,
        }),
        state.fit ? jsx('span', { className: 'text-xs opacity-70', style: SELECTABLE, 'data-token-readout': 'true', children: fitReadout(state) }) : null,
      ].filter(Boolean),
    });
  }

  // Merge controls of a side chat. A click here must not open the chat behind it.
  function mergeControls(row, state) {
    const busy = state?.busy === true;
    return jsxs('div', {
      className: 'flex flex-col gap-1',
      style: { ...SELECTABLE, marginTop: 4 },
      'data-merge-controls': 'true',
      onClick: stop,
      children: [
        jsxs('div', {
          className: 'flex flex-wrap items-center gap-1',
          children: [
            jsx(Button, {
              type: 'button',
              'data-merge': 'asis',
              disabled: busy,
              title: 'Stage this side chat in the parent composer as it is. Nothing is sent.',
              onClick: (event) => {
                stop(event);
                return mergeAsIs(row);
              },
              children: 'Merge as-is',
            }),
            jsx(Button, {
              type: 'button',
              'data-merge': 'digest',
              disabled: true,
              title: 'A short digest is planned. It is not built yet.',
              onClick: stop,
              children: 'Digest (later)',
            }),
            busy ? jsx('span', { className: 'text-xs opacity-60', style: SELECTABLE, children: 'Checking...' }) : null,
          ].filter(Boolean),
        }),
        state?.notice ? mergeResult(state) : null,
      ].filter(Boolean),
    });
  }

  // One entry per side chat of the tree, below the graph, so a notice never moves the rows.
  function sideEntries(lanes, ui) {
    const sides = lanes.filter((lane) => lane.side);
    if (!sides.length) return null;
    return jsxs(
      'div',
      {
        className: 'flex flex-col gap-2',
        style: { ...SELECTABLE, marginTop: 8 },
        'data-selectable-text': 'true',
        'data-side-chats': 'true',
        children: sides.map((lane) =>
          jsxs(
            'div',
            {
              className: 'flex flex-col',
              style: SELECTABLE,
              'data-selectable-text': 'true',
              'data-side-entry': lane.id,
              children: [
                jsx('span', { className: 'text-xs', title: lane.title, style: { ...LABEL_STYLE, opacity: 0.85 }, children: lane.title }),
                mergeControls(lane.row, ui.merge[lane.id]),
              ],
            },
            `side:${lane.id}`,
          ),
        ),
      },
      'sides',
    );
  }

  function agentLine(agent) {
    const parts = [agent.status, agent.model].filter(Boolean);
    const id = agent.child_session_id;
    return jsxs(
      'div',
      {
        className: `flex min-w-0 flex-col rounded px-1 py-0.5${id ? ' cursor-pointer hover:bg-muted' : ''}`,
        style: SELECTABLE,
        'data-selectable-text': 'true',
        'data-subagent-id': agent.subagent_id,
        ...(id ? { role: 'button', onClick: onClickOpen(id) } : {}),
        children: [
          jsx('span', { className: 'text-sm', style: { ...LABEL_STYLE, flex: 'none' }, children: `↳ subagent: ${agent.goal ?? '(no goal)'}` }),
          jsx('span', { className: 'text-xs opacity-60', style: SELECTABLE, children: parts.join(' · ') }),
        ],
      },
      `agent:${agent.subagent_id}`,
    );
  }

  // Hook order is fixed: six useValue calls, every render, before any branch (React error 300).
  // The sixth is the in-memory UI atom. Render only reads state; loading happens on focus change
  // and on the timer, in register(); merging happens in a click handler. Row builders have no hooks.
  function renderPane() {
    const stored = useValue(atomOf('focusedStoredSessionId'));
    const focused = useValue(atomOf('focusedSessionId'));
    const active = useValue(atomOf('activeSessionId'));
    const data = useValue($data);
    const status = useValue($status);
    const ui = useValue($ui);

    const runtime = focused ?? active ?? null;
    const tree = buildTree(data.rows, stored ?? runtime);
    const chats = lineageChats(tree);
    const lanes = buildLanes(chats, data.exchanges);
    const plan = planGraph(lanes, { focusedId: tree?.focused?.id, open: ui.open, expanded: ui.expanded });
    const agents = runtime && data.agentsFor === runtime ? data.agents : [];

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
        style: SELECTABLE,
        'data-selectable-text': 'true',
        'data-chat-tree-root': 'true',
        children: [
          jsxs('div', {
            className: 'flex flex-wrap items-center gap-2',
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
          capped ? jsx('p', { className: 'text-xs opacity-70', style: SELECTABLE, children: capped }) : null,
          status.note ? jsx('p', { className: 'text-xs opacity-70', style: SELECTABLE, children: status.note }) : null,
          plan.rows.length ? graphView(plan, lanes) : null,
          agents.length
            ? jsx('div', { className: 'flex flex-col', style: { ...SELECTABLE, marginTop: 4 }, 'data-subagents': 'true', children: agents.map(agentLine) }, 'agents')
            : null,
          sideEntries(lanes, ui),
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
    historyCache = new Map();
    $status.set({ loading: false, error: null, note: null });
    $ui.set(freshUi());
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

  return { register, renderPane, load, openChat, dispose, $data, $status, $ui };
}
