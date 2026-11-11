# Spec and plan: chat tree pane `chat_tree_pane`

Date: 2026-11-11. Hermes Agent v0.23.1, local commit `3b42157858`. Base: hermes-concept-links `main` at `ac0649a`.

This spec builds the second feature from decision `D-first` in [decisions.tsv](decisions.tsv). It follows decisions `D-tree-ui` (an outline first) and `D-unify-tree` (branches and subagent runs in one tree).

## What the user gets `chat_tree_pane.outcome`

The user opens the "Chat tree" pane beside a chat. The pane shows the focused chat, its ancestors, and all its branches as an indented outline. The pane also shows the subagents that the focused chat runs now. A click on a node opens that chat in a tab. Side chat branches have a mark, so the user can see which branches hold side questions.

## Data `chat_tree_pane.data`

1. Branch rows come from `host.listPersistedSessions(route, { profile, limit: 500 })` (`apps/desktop/src/sdk/index.ts:1432`). Use the profile of the focused chat from `host.state.focusedSessionOwner`. The implementer finds the correct `route` value in the SDK and cites it.

2. The parent of a row is the parent that the Hermes sidebar uses (`forkParentId`, `apps/desktop/src/lib/session-branch-tree.ts:28-40`):

   - If `_reset_from` has a value, the row has no parent.

   - Else, if `_branched_from` has a value, that value is the parent.

   - Else, `parent_session_id` is the parent.

3. Copy the compression rule from the same file. Rows with the same `_lineage_root_id` are one chat. Keep one row for each lineage.

4. Live subagents come from `host.request('subagent.list', { session_id })` for the focused chat (`tui_gateway/contracts/profiles_vault_complete_foreign_subagents.py:659-698`). Each subagent is a child node of the focused chat. It shows `goal`, `status`, and `model`.

5. The session list does not show past subagent sessions (`is_internal_child`, `apps/desktop/src/types/hermes.ts:671`). Thus the tree shows only live subagents. This is a known limit.

## Behavior `chat_tree_pane.behavior`

1. The root of the tree is the oldest ancestor of the focused chat. Walk the parent rule up from the focused chat. Stop at a row with no parent, or at a parent that is not in the list.

2. The pane shows the whole tree under the root as an indented list. Children sort by `started_at`, oldest first. If a row has no `started_at`, use `last_active`.

3. Each node shows the title (or "Untitled"), the model, the message count, and the time of the last activity. The focused chat has a mark.

4. A title that starts with `Side: ` gets a "side" mark. The side chat pane makes these titles.

5. A click on a chat node calls `host.openSession(id, { intent: 'tab' })`. A click on a subagent node opens `child_session_id` when it has a value. When it has no value, the node does not react to a click.

6. The pane loads the data again when the focused chat changes. It also loads the data every 15 s while the plugin runs, and when the user clicks "Refresh". Use `ctx.setTimeout` and `ctx.onDispose`, so that no timer outlives the plugin.

7. A cycle in parent links must not cause a loop. Visit each row one time only.

8. If a call fails, the pane shows the error text and keeps the last good tree.

9. All text in the pane allows selection. Use `userSelect: 'text'` and `data-selectable-text`.

## Code layout `chat_tree_pane.layout`

Use the same layout as the side chat plugin:

- `chat-tree/src/chat-tree.js`: a factory `createChatTree(deps)` with no imports.

- `chat-tree/test/chat-tree.test.js`: tests with the Node test runner and a fake host.

- `chat-tree/scripts/assemble.mjs`: writes `chat-tree/desktop/plugin.js`.

- `package.json`: add `test:chat-tree` and `assemble:chat-tree`. Make `npm test` also run these tests.

Put the pure tree logic (parent rule, lineage collapse, root walk, sort, cycle guard) in functions that tests can call without a render.

## Checks `chat_tree_pane.check`

The unit closes when all of these are true:

- `npm test` exits 0.

- The tests prove these behaviors:
  - The parent rule, including a `_reset_from` row at the top level.
  - One row for each compression lineage.
  - The root walk from a deep branch.
  - Sort order, with the `last_active` fallback.
  - A parent cycle ends with no loop.
  - Live subagents appear under the focused chat.
  - A click calls `openSession` with the correct id.
  - Timers stop after dispose.
  - Each render calls the same hooks in the same order.

- The Hermes desktop lint finds no refusal and no review cue in `chat-tree/desktop/plugin.js`.

- A person runs the pane in Hermes Desktop once and reports the result.

## Out of scope `chat_tree_pane.out_of_scope`

- Past subagent sessions.

- Labels from the judge model. This is the next unit.

- A graph view with React Flow.
