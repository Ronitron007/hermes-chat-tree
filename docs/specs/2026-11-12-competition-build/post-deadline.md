# Spec and plan: the units after the deadline

Date: 2026-11-12, 04:30 IST. Base: `outbox/competition-entry` at `eb94f10`, the SHA that the catalog PR pins. Owner: Rohan.

Trail: [decisions.tsv](decisions.tsv). The main spec is [spec.md](spec.md).

## What ships `post.outcome`

The tree shows which chats run now and which chats are done. A branch keeps the model that the user picks. A click on a node scrolls the chat onto that exchange.

The units use only the Hermes plugin framework of today. They change no Hermes code.

## Unit `unit.chat_status`

Show a status for every chat in the tree (Rohan, 2026-11-12 04:25: "Every chat in the tree"). Files: `chat-tree/src/chat-tree.js`, `chat-tree/test/chat-tree.test.js`, `chat-tree/desktop/plugin.js` (assembled), `chat-tree/README.md`.

### Source `chat_status.source`

- Call the gateway RPC `session.active_list` with no session id. Each row has `id` (the runtime id), `session_key` (the stored id), and `status`. The values of `status` are `working`, `waiting`, `starting`, and `idle` (`tui_gateway/session_registry.py:657-680`).

- Map each row to its chat by `session_key`. Match a lane when `session_key` is the lane id or one of the lane's lineage ids.

- A chat that has no row is not live. Its status is `done`. A row with `idle` is also `done`.

- Treat the rows as untrusted. Keep only rows with a string `session_key` and a known `status`.

- Also read `host.state.busyBySession`, keyed by runtime id. When the open chat's runtime id is busy there, its status is `working`, also before the next `session.active_list` reply.

- If the RPC fails or is missing, show no status marks. Show no error. The tree works as before.

### Refresh `chat_status.refresh`

- Read the status at each tree load.

- Read it again, at most once per second, when `busyBySession` changes.

- While a chat in the tree is `working`, `waiting`, or `starting`, read it again every 3 seconds. Stop the timer when no chat in the tree is live, and when the pane closes.

- A status read never reloads histories.

### Marks `chat_status.marks`

| Status | Exchanges view | Branches view | Text for screen readers and the tooltip |
|---|---|---|---|
| `working` | A pulsing dot in the accent colour | Dot and the word `working` | Working |
| `waiting` | An amber dot | Dot and the words `needs you` | Needs you |
| `starting` | A hollow dot | Dot and the word `starting` | Starting |
| `done` | No mark | The word `done`, muted | Done |

- In the exchanges view, put the mark on the lane's last visible row. Collapse always keeps that row visible.

- In the branches view, put the mark on the chat's name row, after the exchange count.

- The pulse uses the `animate-pulse` class. The shipped Hermes CSS has it. The colours use the theme tokens: `--dt-primary` for working, an amber `#d97706` for waiting, `--dt-muted-foreground` for the rest.

- Each mark has `data-chat-status` with the status value, and `aria-label` with its text. A mark never moves the row text or the lane lines.

### Check `chat_status.check`

- `npm test` and `npm run assemble:chat-tree` exit 0.

- New tests cover these cases:

  - Each status maps to its mark in both views.

  - A chat with no row is `done`.

  - A lineage id matches its lane.

  - A failed RPC shows no marks and no error.

  - `busyBySession` makes the open chat `working` before the RPC reply.

  - The timer starts while a chat is live and stops when none is live.

  - The hook order stays the same on every render.

## Unit `unit.model_sticks`

A branch keeps the model that the user picks, for every turn. Files: `chat-tree/src/chat-tree.js`, `chat-tree/test/chat-tree.test.js`, `chat-tree/desktop/plugin.js` (assembled).

### Fault `model_sticks.fault`

In the take of 2026-11-12, the first question of a branch ran on the picked model. Every later turn in that branch ran on `claude-sonnet-5`, the profile default. A Retry of a failed first question also ran on `claude-sonnet-5`. The composer chip showed Sonnet 5.

### Cause `model_sticks.cause`

A research agent read the code. The table gives its findings. The fix below is not run yet.

| Finding | Evidence |
|---|---|
| Desktop sends `config.set` for the model as a `session.mutate` op. The op needs the session revision and generation. | `apps/desktop/src/.../canonical-protocol.ts:91-100, 338-350, 480-484` |
| A new branch has no revision in Desktop yet, so the call throws before Desktop sends a request. | `canonical-protocol.ts:347, 602, 620-626, 681, 727` |
| `setBranchSessionModel` catches the error. `submitBranch` then sends a `model_override` that applies to one turn only. | `chat-tree.js:2279-2289, 2339-2347` |
| Composer submits and Retry send no model. They run on the session policy. | `submit.ts:1084-1117` |

### Fix `model_sticks.fix`

- In `submitBranch`, after `session.branch` returns and before `setBranchSessionModel`, call `session.resume` with `{ session_id, source: 'desktop', omit_messages: true }`. This gives Desktop the revision of the branch.

- Keep the `model_override` on the first question only when `config.set` still fails.

- When `config.set` returns `confirm_required`, show the confirm with the exported `surfaceModelSwitchConfirm`. Do not report the model as set until the user confirms.

- When `config.set` fails, show the error text in the branch notice. Do not drop it.

### Check `model_sticks.check`

- `npm test` and `npm run assemble:chat-tree` exit 0.

- New tests cover these cases:

  - `session.resume` comes before `config.set`.

  - A successful `config.set` sends no `model_override`.

  - A failed `config.set` sends the `model_override` and shows the error.

  - A `confirm_required` answer opens the confirm.

- A live check in Desktop: a branch made with Opus 5.5 answers a typed follow-up on `claude-opus-5-5` in `agent.log`.

## Unit `unit.navigate_exact`

A click on a node scrolls the chat onto that exchange. Files: `chat-tree/src/chat-tree.js`, `chat-tree/test/chat-tree.test.js`, `chat-tree/desktop/plugin.js` (assembled).

### Fault `navigate_exact.fault`

In the take of 2026-11-12, a click on the second exchange of a 15-exchange chat stopped three exchanges too low. An earlier click on another row scrolled toward the end of the chat.

### Cause `navigate_exact.cause`

A research agent read the code. These findings are inferred from the code and are not run.

- `revealExchange` waits a fixed 150 ms after the viewport appears (`chat-tree.js:40, 1741-1745`). The chat's own scroll restore can run for up to 15 frames after that, and it can end with a scroll to the bottom (`list.tsx:1140-1146, 1219, 1407-1413`).

- `scrollToTurn` measures the row once and calls a smooth `scrollTo` (`chat-tree.js:1770-1777`). Turns that are not drawn yet keep a 37.5rem placeholder height (`list.tsx:468-473, 485`). When they draw, the target moves. A write to `scrollTop` also stops a smooth scroll.

- The row id is correct. Desktop maps the durable row id (`use-timeline-reveal.ts:55-64`).

### Fix `navigate_exact.fix`

- Replace the fixed wait. Send the reveal only when the viewport's `[data-chat-surface]` ancestor has no `data-session-switching` attribute. Hermes documents this attribute as the hook for a chat switch (`session-switching.ts:1-38`).

- In `scrollToTurn`, set `scrollTop` directly, with no smooth scroll.

- On each animation frame after that, measure the row again and correct `scrollTop` by its offset. Stop after 2 frames with no change, or after 20 frames.

### Check `navigate_exact.check`

- `npm test` and `npm run assemble:chat-tree` exit 0.

- New tests cover these cases:

  - The reveal waits while `data-session-switching` is set.

  - The scroll corrects when the row moves after the first scroll.

  - The scroll stops after 2 stable frames.

- A live check in Desktop: a click on the second exchange of the demo chat puts that exchange at the top of the view.

## Unit `unit.font_swap`

The branch name is bigger than the node text (Rohan, 2026-11-12 04:50: "branch name should be bigger"). Files: `chat-tree/src/chat-tree.js`, `chat-tree/test/chat-tree.test.js`, `chat-tree/desktop/plugin.js` (assembled).

- In the exchanges view, a name row uses 14 px text. Before, it used 12 px (`NAME_TEXT`).

- A node row uses 12 px text. Before, it used 14 px from the pane's `text-sm` class.

- The branches view keeps 14 px names.

- The row height, the circles, and the lane lines do not move.

Check: `npm test` and `npm run assemble:chat-tree` exit 0, and a test reads the font size of a name row and of a node row.

## Process `post.process`

- Opus implements each unit in its own worktree from `eb94f10`. The three units run at the same time. They change different functions of `chat-tree.js`: the marks and the status read, `submitBranch`, and the reveal. Merge them one at a time into `outbox/competition-entry`, and assemble `desktop/plugin.js` again after each merge.

- A fresh Opus reviewer reviews all units together at the end (Rohan, 2026-11-12: "we do them in the end").

- After the review, install into `~/.hermes`, and ask Rohan before the catalog PR gets the new SHA.
