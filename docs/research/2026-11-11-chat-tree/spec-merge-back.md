# Spec and plan: stage merge `merge_back`

Date: 2026-11-11. Base: the side chat pane in [spec-side-chat.md](spec-side-chat.md). Decision: `D-merge-back` in [decisions.tsv](decisions.tsv).

This is cherry-pick merge-back. The user stages a short digest of one answered side turn into the main chat composer, edits it, and sends it. The pane does not auto-merge. It does not call `host.composer.submit`. It does not write the parent transcript. That is the difference from study-tree, which auto-injects a takeaway.

## What the user gets `merge_back.outcome`

A side question has an answer in the Side chat pane. The user clicks "Stage merge". The main chat opens in place, and its composer holds a plain-text digest of that side turn. The user edits the digest and sends it. The side branch stays as it is. After a send, `session.undo` on an idle parent can drop that turn.

## Behavior `merge_back.behavior`

1. The button is on each entry whose `status` is `answered`. It is disabled when the answer text is empty. Other entries have no button.

2. The digest is plain text the user can edit. No HTML. No auto-commit language. The shape is:

   ```
   From side question:

   Question: <question>

   Answer:
   <answer>
   ```

3. The question and the answer come from `session.transcript` on the branch (`order: 'oldest'`), keeping rows that are new after the fence (`row_id` above `maxRowId`, the same cut the pane uses while polling). Copied parent history stays out. The first new user text is the question. The last new assistant text is the answer.

4. If that call fails, or the new rows have no question and answer, the digest uses `entry.question` and `entry.answer`.

5. The pane opens the parent with `host.openSession(parentStoredId, { intent: 'in-place' })`. `parentStoredId` is `host.state.focusedStoredSessionId`, the same id `listChatId()` uses for this list.

6. It then calls `await host.composer.setDraft(sessionId, digest)`. The parent stored id is first. If that returns false or throws, it retries with `host.state.focusedSessionId.get()` after the open (the runtime id of the focused parent). `setDraft` is fail-closed unless a composer for that session is visible.

7. If either call returns true, the pane shows a selectable notice: the draft is in the main chat composer; edit it and send; after sending, `session.undo` on an idle parent can drop that turn.

8. If both return false or throw, the pane shows a selectable notice: the main chat's composer is not visible; open the main chat and try again. The click handler does not throw.

9. If `host.composer` or `setDraft` is missing, the pane shows a notice and does not open a session or write a draft.

10. The pane never calls `host.composer.submit`. It never writes the digest into the parent by any other API.

11. `renderPane` still calls the same six `useValue` hooks, in the same order, before any branch. `EntryRow` adds no hooks. Re-enable after disable still sets `disposed = false` at the start of `register`.

## Code layout `merge_back.layout`

- `rowsAfterFence`, `formatSideDigest`, and `digestFromRows` are exported from `side-chat/src/side-chat.js`. Tests call them without rendering.

- The fence `maxRowId` is stored on the entry so a later click can drop copied rows. `cleanEntry` keeps a finite `maxRowId`.

- `side-chat/desktop/plugin.js` is only updated by `npm run assemble:side-chat`.

## Checks `merge_back.check`

The unit closes when all of these are true:

- `npm test` exits 0, including the side chat tests and the chat tree tests.

- The tests prove:
  - After an answered question, Stage merge calls `host.openSession` with the parent stored id and `{ intent: 'in-place' }`, then `host.composer.setDraft` with a digest that contains the question and the answer.
  - `host.composer.submit` is never called.
  - A false or thrown `setDraft` shows a notice and does not throw.
  - A failed `session.transcript` still uses the stored question and answer.
  - New rows after the fence are kept. Copied history rows are not. The fallback format includes the question and the answer.
  - Each render calls the same hooks in the same order.
  - After dispose and a second register, a question still gets its answer.

- The Hermes desktop lint finds no refusal and no review cue in `side-chat/desktop/plugin.js`.

- A person runs Stage merge in Hermes Desktop once and reports the result. That live run is still pending.

## Out of scope `merge_back.out_of_scope`

- Auto-merge, `host.composer.submit`, and a silent pin into the parent transcript.

- `session.branch` and `through_message_id`. The fork stays `session.branch_whole`.

- A window intent. Open on a branch stays `{ intent: 'tab' }`.

- Querying `[data-message-id]` or any app DOM.

- A graph library or a plugin-owned tree store.

- Changes to the chat tree pane.
