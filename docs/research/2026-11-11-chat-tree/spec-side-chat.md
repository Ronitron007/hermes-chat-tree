# Spec and plan: side chat pane `side_chat`

Date: 2026-11-11. Hermes Agent v0.23.1, local commit `3b42157858`. Base: hermes-concept-links `main` at `1e65e0b`.

This spec builds the first feature from decision `D-first` in [decisions.tsv](decisions.tsv). The spike in [spike-side-chat.md](spike-side-chat.md) proved the calls (decision `D-route-result`).

## What the user gets `side_chat.outcome`

The user opens the "Side chat" pane beside a chat. The user types a side question. The pane forks the chat into a branch, asks the question in the branch on the side model, and shows the answer in the pane. The main chat gets no new message. Each side question stays in a list under its main chat, and the user can open each branch as a tab.

## Behavior `side_chat.behavior`

1. The main chat is the focused chat: `host.state.focusedSessionId`, else `host.state.activeSessionId`.

2. Each question makes one new branch with `session.branch_whole`. The branch name is `Side: ` plus the first 50 characters of the question.

3. The pane sends the question with `prompt.submit` to the branch. If the side model field has a value, the call includes `model_override` with `model` and an optional `provider`. If the field is blank, the call has no `model_override`.

4. The pane reads the answer with `session.transcript` on the branch, `order: 'oldest'`. It polls every 1.5 s with the cursor from the last page. It stops when a row with `role: 'assistant'` and text appears after the question. It stops after 180 s with the message "No answer yet. Open the branch to see it."

5. If `session.branch_whole` fails, the pane shows the error text. If the text says that the session is busy, the pane shows "The main chat is busy. Ask again when the run ends."

6. The pane keeps a list of side questions for each main chat in `ctx.storage`, under the key `sideChat:<main session id>`. Each entry holds the question, the branch `session_id`, the branch `stored_session_id`, the model, the answer, and the time. The list keeps the newest 50 entries.

7. Each entry has an "Open" button. The button calls `host.openSession(stored_session_id, { intent: 'tab' })`.

8. The side model and provider are settings in `ctx.storage` under `sideChat:model`. They apply to all main chats.

9. All text in the pane allows selection (`userSelect: 'text'`). The spike log did not allow it.

## Code layout `side_chat.layout`

- `side-chat/src/side-chat.js`: a factory `createSideChat(deps)` with no imports. `deps` holds `host`, `jsx`, `jsxs`, `atom`, `useValue`, the SDK components, `setTimeout`, `clearTimeout`, and `now`. This follows `src/plugin-factory.js`.

- `side-chat/test/side-chat.test.js`: tests with the Node test runner and a fake `host.request`.

- `side-chat/scripts/assemble.mjs`: writes `side-chat/desktop/plugin.js`. The output imports only `@hermes/plugin-sdk`, `react`, and `react/jsx-runtime`.

- `package.json`: add `test:side-chat` and `assemble:side-chat` scripts. Make `npm test` also run the side chat tests.

- Remove `spike/side-chat/` from the repo after the pane works.

## Checks `side_chat.check`

The unit closes when all of these are true:

- `npm test` exits 0. It runs the old tests and the new side chat tests.

- The tests prove these behaviors with a fake host:
  - A question calls `session.branch_whole`, then `prompt.submit` on the new branch, then `session.transcript` until the answer appears.
  - A blank model field sends no `model_override`.
  - A model field sends `model_override` with the model and the provider.
  - A busy error shows the busy message, and no `prompt.submit` call happens.
  - The poll stops at the answer, and it stops at the timeout.
  - The list for each main chat is separate, and it keeps 50 entries at most.
  - Each render calls the same hooks in the same order. The glossary pane broke this rule once (React error 300).

- The Hermes desktop lint finds no refusal and no review cue in `side-chat/desktop/plugin.js`. Run `desktop_surface_findings` and `desktop_review_findings` from `hermes_cli/plugin_validate_desktop.py`.

- A person runs the pane in Hermes Desktop once and reports the result.

## Out of scope `side_chat.out_of_scope`

- A side question during a busy run. This needs a `/btw` style snapshot, which is a later unit.

- Labels from the judge model, the tree pane, and concept links. These are later units.

- Upstream changes to Hermes.
