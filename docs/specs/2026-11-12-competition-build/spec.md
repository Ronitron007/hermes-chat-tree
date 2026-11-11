# Spec and plan: the chat-branching competition entry

Date: 2026-11-12, 00:05 IST. Deadline: 03:30 IST. Base: `outbox/competition-entry` at `46a3bef` (draft PR #21). Owner: Rohan.

Decision tree: [decision-tree.md](decision-tree.md). Trail: [decisions.tsv](decisions.tsv).

## What ships `build.outcome`

The entry lives in one window: the `chat-tree` pane, a git graph of a chat and its branches (Rohan, 2026-11-12 00:24). A side chat is not a separate pane. It is a branch lane in the graph. From the pane, the user can branch at an exchange, ask the branch a question on a cheaper model, open any chat, and merge a branch back into its parent.

`concept-links` ships beside it: chips on terms in replies, with definitions in its own pane.

The `side-chat` pane is not part of the entry. Its fork, ask, and merge code moves into `chat-tree` in `unit.tree_actions`.

The entry uses only the Hermes plugin framework of today (Rohan, 2026-11-11). It changes no Hermes code.

## Product rules from Rohan `build.rules`

- A node is one exchange: one user message and its replies. The label is a short form of the user message (Rohan, 2026-11-11 22:31).

- A lane is one chat. A fork leaves the parent lane at the exact exchange where the child chat starts. A merge curves into a `Merged: …` node on the parent lane.

- The tree uses exactly two colours. Blue marks the path from the first exchange of the root chat to the open node, and the open node. Grey marks everything else.

- Long linear runs collapse to a `+N` row. A click expands the run. Collapse never breaks the lane geometry or the blue path.

- The merge mode is the user's choice (Rohan, 2026-11-11 22:35). The modes are Full text (default), Merge record, and Digest.

- Remove `::termline{...}` concept-link markup from merged text. Keep the plain sentence.

## Unit `unit.tree_view`

Rebuild the `chat-tree` pane to `build.rules`. Files: `chat-tree/src/chat-tree.js`, `chat-tree/test/chat-tree.test.js`, `chat-tree/desktop/plugin.js` (assembled).

- Data: for the lineage of the focused chat (the root chat and all its descendants, at most 30 chats), read each chat's messages with the existing history reader. Cache each history by chat id and its message count or last activity. Do not read a history again on each refresh when the chat did not change.

- Fork point: the number of leading exchanges that a child shares with its parent. Draw the shared exchanges only on the parent lane.

- Merge node: a parent exchange whose user message starts with `From side chat: `. Link it to the one side chat whose first own exchange has the same user text as the header, after whitespace normalization. If no chat or more than one chat matches, draw the merged node with no curve. Never guess a link.

- Order: the oldest exchange is at the top.

- Geometry: a graph column about 58 px wide, rows about 26 px tall, hollow circles centred on rows, rounded fork elbows, and a merge curve. Lines never run over text. The geometry is a pure function of the rows, so tests can check it.

- Open node: by default, the last exchange of the focused chat. A click on a node makes it the open node and opens its chat with `host.openSession` in place. The open node has a filled circle, a row highlight, and a left accent.

- Labels are one line with an ellipsis. Each lane shows a model pill on its first row, and side chats show a `side` pill. No other badges.

- Hover shows `title · model`, and `side chat of X` for side chats. The tooltip never expands rows.

- Collapse: keep the first and last exchange of each lane, fork points, merge nodes, and the open node visible. Collapse a run of 3 or more other exchanges into one `+N` row.

- Keep the factory `createChatTree(deps)`, the pane registration, the live subagent rows, and the side chat `Merge as-is` action. `unit.tree_merge` changes the merge action later.

- Remove the outline, gutter, and strip modes from PR #20. The pane has one view.

Check: `npm test` and `npm run assemble:chat-tree` exit 0, and new tests cover fork points, merge links, the blue path, collapse, and geometry.

## Unit `unit.merge_modes`

Add the merge modes to the `side-chat` pane. Files: `side-chat/src/side-chat.js`, `side-chat/test/side-chat.test.js`, `side-chat/desktop/plugin.js` (assembled).

- A mode picker on each side chat entry: Full text (default), Merge record, Digest. Remember the choice per side chat while the pane runs.

- Every mode starts its text with the line `From side chat: <side question>`, so that the tree can draw the merge. The side question is the first message that the side chat sent after the fork.

- Full text: the current verbatim text (all You and Assistant pairs after the fork, with no tool rows).

- Merge record: the header line and the side chat id only.

- Digest: the header line, the side question, and the final answer of the side chat. This uses the existing `formatSideDigest`. It calls no model.

- Remove concept-link markup from the text of every mode before the fit check: `::termline{v=… t=…}` becomes its `v` sentence, `::term{name=… def=…}` becomes the name, and `[[name|def]]` becomes the name.

- Check every mode against the parent's remaining context window, as Full text does now. If the text does not fit, show the notice with the numbers and stage nothing. The notice stays until the user dismisses it.

- Stage with `host.composer.setDraft`. Never send.

Check: `npm test` and `npm run assemble:side-chat` exit 0, and new tests cover each mode, the markup removal, and the notice.

## Unit `unit.entry_package`

Make the repo installable and reviewable as an entry. Files: `side-chat/plugin.yaml`, `chat-tree/plugin.yaml`, `scripts/install.sh`, `README.md`, `catalog/*.yaml`, `dev/` (render harness), `package.json` (dev dependencies only).

- Give `side-chat/` and `chat-tree/` a manifest each, so that `hermes plugins validate` passes on each directory.

- Write `scripts/install.sh`. It copies the three plugins into a Hermes home given as an argument, and it defaults to `~/.hermes`.

- Write a README section for the entry: what it does, how to install, how to use, the limits, and how it differs from study-tree.

- Write a catalog entry draft for each plugin, with `subdir` and a placeholder SHA.

- Write a render harness in `dev/`. It renders each pane with fixture chats to a static HTML file, through `react-dom/server`, with the pane's real code. The fixtures hold a main chat, a merged side chat, a fork with the open node, and a second side chat.

Check: `npm test` exits 0, `node dev/render.mjs` writes the HTML files, and `hermes plugins validate` passes on each plugin directory.

## Unit `unit.tree_actions`

After `unit.tree_view` merges, put the actions in the tree pane. This unit replaces `unit.tree_merge`.

- Branch here: an action on each exchange of the open chat. It shows a small form in the pane: a question and a model, with a cheap model as the default. It forks the chat at that exchange with `session.branch` and `count`, sends the question with `prompt.submit` and `model_override`, and opens the branch in place.

- Merge back: an action on each branch lane. It shows the mode picker (Full text, Merge record, Digest), the fit check, and the notice that stays until dismissed. It stages the text in the parent's composer with `host.composer.setDraft`, opens the parent, and never sends.

- Copy the merge helpers from `side-chat/src/side-chat.js` (`formatMergeText`, `stripConceptMarkup`, `formatNoFitNotice`, and the modes), because each plugin is one bundle with no imports.

Check: `npm test` and `npm run assemble:chat-tree` exit 0, and new tests cover branch here (the `count` value and the payloads), each merge mode, and the notice.

## Unit `unit.verify`

Integrate on `outbox/competition-entry`. Run all tests, assemble all bundles, render the harness, and compare the screenshots with the two-colour mockup. Install into Hermes. A live Desktop click-through needs Rohan's access or his hands.

## Process `build.process`

- Opus implements each unit. A fresh Opus reviewer reviews each unit. A unit merges into `outbox/competition-entry` only when its checks pass and no finding is open.

- `unit.tree_view`, `unit.merge_modes`, and `unit.entry_package` run in parallel. They touch different files.

- There is no review for each unit. One review of the whole build runs at the end (Rohan, 2026-11-12 00:22).

- No agent calls a model, starts Hermes Desktop, or writes to `~/.hermes`.

## Open items for Rohan `build.open`

- The repo is private. The catalog loads each entry from the repo at the pinned SHA, so the catalog cannot read a private repo. Choose: make this repo public, or publish the entry in a new public repo.

- The catalog submission is a PR to NousResearch/hermes-agent that adds only catalog files. It does not change Hermes code. It needs your yes.
