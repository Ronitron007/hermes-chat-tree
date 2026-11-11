# Spec and plan: verbatim merge `merge_back`

Date: 2026-11-11. Base: the side chat pane in [spec-side-chat.md](spec-side-chat.md). Decision: `D-merge-verbatim` in [decisions.tsv](decisions.tsv). `D-merge-back` (digest-first) is the abandoned shape.

This is cherry-pick merge-back. The user stages the side exchange as-is (full text, not a summary) into the main chat composer, edits it, and sends it. Before that write, the pane checks the verbatim payload against the parent context window. The pane does not auto-merge. It does not call `host.composer.submit`. It does not write the parent transcript. That is the difference from study-tree, which auto-injects a takeaway.

## What the user gets `merge_back.outcome`

A side question has an answer in the Side chat pane. The user clicks "Merge into parent". If the verbatim side text fits the parent's remaining context, the main chat opens in place and its composer holds that text. The user edits it and sends it. The side branch stays as it is. After a send, `session.undo` on an idle parent can drop that turn.

If the parent window is known and the side text is larger than the remaining room, nothing is opened and nothing is written. The pane shows how many tokens the side text is and how many the parent has left.

## Behavior `merge_back.behavior`

1. The button is on each entry whose `status` is `answered`. The label is "Merge into parent". It is disabled when the answer text is empty. Other entries have no button.

2. The staged text is plain text the user can edit. No HTML. No auto-commit language. The shape is:

   ```
   From side chat: <title>

   You:
   <q1>

   Assistant:
   <a1>

   You:
   <q2>

   Assistant:
   <a2>
   ```

   `<title>` is the trimmed `entry.question`, or "Side chat" when that is empty. A blank line follows the header, separates turns, and separates each You block from its Assistant block.

3. The turns come from `session.transcript` on the branch (`order: 'oldest'`), then `session.history` when transcript is missing. `rowsAfterFence` keeps rows that are new after the fence (`row_id` above `maxRowId`). Copied parent history stays out. Every user/assistant pair after the fence is included. Tool and system rows are not turns. Each user row starts a turn. Following non-empty assistant texts until the next user are that answer, joined with newlines.

4. If that read fails, or the new rows have no pair, the text is one pair from `entry.question` and `entry.answer`.

5. Side tokens are the token count of that verbatim string, not `context_used` on the side session. `session.branch_whole` copies the parent history, so the side session's context count includes the parent and would falsely fail the fit check. `SessionMessage` has no `token_count`, so the count is `estimateTokens`: the ASCII path of `agent/model_metadata.py` `estimate_tokens_rough`, `CHARS_PER_TOKEN = 4`, `(len(text) + 3) // 4`. Empty text is 0. The UI marks that number as estimated.

6. The fit check runs before `openSession` and before `setDraft`. Parent used/max come from `host.request` in this order: `session.usage`, then `session.stats`, then `session.context_breakdown`. Each method is tried on `listChatId()` (the stored parent id), then on `focusedSessionId`. A throw, or a payload with no positive max, tries the next. Shapes accepted:

   - TUI `UsageStats`: `context_used`, `context_max`, optional `context_estimated` (`apps/desktop/src/types/hermes.ts`).
   - The same object nested under `.usage` (`gateway/session_usage.py` `tui_usage` / `usage_frame`).
   - Canonical `session.stats`: `used = context_used ?? last_prompt_tokens ?? context_tokens ?? 0`, `max = context_max ?? context_length`.
   - `session.context_breakdown`, which always carries `context_used` and `context_max`.

   `available = max(0, max - used)`. `context_used` and `context_max` are omitted by v0.23 unless both `last_prompt_tokens` and `context_length` are truthy. An agent-less session may be only `{calls, input, output, total}`.

7. If a max is known and side tokens are greater than `available`, the pane does not call `openSession` or `setDraft`. It shows a selectable notice from `formatNoFitNotice`, for example: "Doesn't fit: side chat is 12,400 tokens, parent has 3,200 available (124,800 used of 128,000)." Estimated figures are marked.

8. If no call reports a max, the merge is not blocked. The pane still opens and calls `setDraft`, and the notice says the side tokens are estimated and the parent context window was not reported.

9. When the text fits, the pane opens the parent with `host.openSession(parentStoredId, { intent: 'in-place' })`. `parentStoredId` is `host.state.focusedStoredSessionId`, the same id `listChatId()` uses for this list.

10. It then calls `await host.composer.setDraft(sessionId, verbatim)`. The parent stored id is first. If that returns false or throws, it retries with `host.state.focusedSessionId.get()` after the open (the runtime id of the focused parent). `setDraft` (`apps/desktop/src/sdk/composer.ts`, `apps/desktop/src/app/chat/composer/focus.ts` `requestComposerSetDraft`) has no documented size limit. A non-string returns false. It is fail-closed when no composer for that session is mounted: the draft of an unmounted session is never half-written. `insertText` documents the same fail-closed result for whitespace-only text.

11. If `setDraft` returns true, the pane shows a selectable notice: the draft is in the main chat composer; edit it and send; after sending, `session.undo` on an idle parent can drop that turn. That notice is the fit indicator. There is no prefetch hook.

12. If both `setDraft` calls return false or throw, the pane shows a selectable notice: the main chat's composer is not visible; open the main chat and try again. The click handler does not throw.

13. If `host.composer` or `setDraft` is missing, the pane shows a notice and does not open a session or write a draft. That exit happens before the fit check.

14. The pane never calls `host.composer.submit`. It never writes the verbatim text into the parent by any other API.

15. `renderPane` still calls the same six `useValue` hooks, in the same order, before any branch. `EntryRow` adds no hooks. Re-enable after disable still sets `disposed = false` at the start of `register`.

## Code layout `merge_back.layout`

- `rowsAfterFence`, `estimateTokens`, `parseContextHeadroom`, `turnsFromRows`, `formatSideVerbatim`, `formatNoFitNotice`, and `formatMissingWindowNotice` are exported from `side-chat/src/side-chat.js`. Tests call them without rendering.

- `formatSideDigest` and `digestFromRows` stay exported. `stageMerge` does not call them. A short digest is a later option, unused now.

- The fence `maxRowId` is stored on the entry so a later click can drop copied rows. `cleanEntry` keeps a finite `maxRowId`.

- `side-chat/desktop/plugin.js` is only updated by `npm run assemble:side-chat`.

## Checks `merge_back.check`

The unit closes when all of these are true:

- `npm test` exits 0, including the side chat tests and the chat tree tests.

- The tests prove:
  - After an answered question, Merge into parent calls `host.openSession` with the parent stored id and `{ intent: 'in-place' }`, then `host.composer.setDraft` with the verbatim side text (header, You, Assistant), which contains the question and the answer and is not a "From side question:" digest.
  - A parent window with room (`context_used: 1000`, `context_max: 128000`) reaches that open and `setDraft`. `host.composer.submit` is never called.
  - A parent window without room (`context_used: 127990`, `context_max: 128000`) does not open, does not call `setDraft`, does not submit, and does not throw. The notice shows side tokens and available room, and marks the estimate.
  - Two side pairs after the fence are both in the draft. Copied parent rows and tool rows are not. The draft is not a first-pair digest.
  - When `session.usage`, `session.stats`, and `session.context_breakdown` throw, the pane still opens and calls `setDraft` with the verbatim text, and the notice says the tokens are estimated and the window was not reported.
  - A false or thrown `setDraft` shows a notice and does not throw.
  - A failed transcript read still uses the stored question and answer, as verbatim text.
  - A missing `setDraft` shows a notice and does not open a session.
  - `formatSideDigest` / `digestFromRows` still build the old digest. Nothing in `stageMerge` calls them.
  - Each render calls the same hooks in the same order.
  - After dispose and a second register, a question still gets its answer.

- The Hermes desktop lint finds no refusal and no review cue in `side-chat/desktop/plugin.js`.

- A person runs Merge into parent in Hermes Desktop once and reports the result. That live run is still pending. Undo is not implemented here.

## Out of scope `merge_back.out_of_scope`

- Auto-merge, `host.composer.submit`, and a silent pin into the parent transcript.

- Using the side session's `context_used` as the size of the verbatim payload.

- A digest button. The digest helpers stay in the module and are not wired to the click.

- `session.branch` and `through_message_id`. The fork stays `session.branch_whole`.

- A window intent. Open on a branch stays `{ intent: 'tab' }`.

- Querying `[data-message-id]` or any app DOM.

- A graph library or a plugin-owned tree store.

- Changes to the chat tree pane.

- Undo of a sent merge.
