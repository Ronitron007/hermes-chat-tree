# Demo script: the chat tree in 90 seconds

Date: 2026-11-12. Story: a developer ships a CLI tool, `tidyfiles`, to PyPI. The main chat is long. Two questions come up on the way, and each goes into a branch so the main chat stays on topic.

## The tree at the end `demo.final_tree`

```
main: Ship tidyfiles to PyPI
●  I want to publish my CLI tool…
●  What goes in pyproject.toml?
●──╮  How do I build the package?                     ← branch A forks here
│  ●  What is the difference between a wheel and an sdist?   [haiku] side
│  │
●  │  +4                                               ← license … TestPyPI, collapsed
●──┼──╮  Can GitHub Actions publish releases?          ← branch B forks here
│  │  ●  Walk me through trusted publishing setup     [opus]
│  │  ●  What does the workflow file look like?
●  │  │  Will my README show on PyPI?
●  │  │  Should I keep a changelog?
●  │  │  OK, give me the release checklist.
●──╯  │  Merged: wheel vs sdist                         ← branch A, merged as-is
●─────╯  Merged: trusted publishing setup (digest)     ← branch B, merged as a digest
```

## Before you record `demo.setup`

1. Install the entry from `outbox/competition-entry` and relaunch Hermes Desktop.

2. Import the main chat. This makes no model call:

   ```bash
   hermes sessions import --from claude docs/demo/ship-tidyfiles.jsonl
   ```

3. Rename it: `hermes sessions rename <id> "Ship tidyfiles to PyPI"`. Use the id that the import prints.

4. Open the chat, open the Chat Tree pane, and set the window to about 1440 × 900.

5. Do one full dry run. Then delete the two branches and the two merged messages, or import the chat again under a new name.

## The script `demo.script`

| Time | On screen | Do | Say (caption) |
|---|---|---|---|
| 0:00–0:08 | The long main chat, the tree pane on the right | Nothing. Let the tree show one blue lane and a `+4` row. | "One chat, eleven exchanges. The tree shows each one." |
| 0:08–0:18 | The reply about `python -m build` | Hover **wheel**, then click it. The Concepts pane opens. | "Terms you do not know get a definition in place." |
| 0:18–0:35 | Tree, node "How do I build the package?" | Click **Branch**. Type "What is the difference between a wheel and an sdist?". Pick a small, fast model in the model picker. Send. | "A side question goes into a branch, on a model I pick. The main chat stays on topic." |
| 0:35–0:45 | The new lane forks at the exact exchange | Wait for the answer. | "The branch forks at the exchange it came from." |
| 0:45–0:57 | Merge section of the branch | Pick the parent. Click **Merge as-is**. The text appears in the composer of the main chat with the fit numbers. Send it. | "Merge it back in full. It is only staged. I decide to send." |
| 0:57–1:05 | Tree | The merge curve lands on a new `Merged:` node. | "The tree draws the merge." |
| 1:05–1:12 | Tree, node "What goes in pyproject.toml?" | Click it. The main chat scrolls to that exchange. | "Any node takes me back to that point in the chat." |
| 1:12–1:25 | Tree, node "Can GitHub Actions publish releases?" | Branch there on a stronger model: "Walk me through trusted publishing setup". Ask one follow-up. Then **Digest** into the main chat and send it. | "Long branches come back as a digest." |
| 1:25–1:30 | Final tree | Hover the blue path. | "Branch, ask, merge. One window." |

## Model calls `demo.cost`

The import makes no model call. Each recording run makes these calls on your own Hermes models:

- Two branch questions and one follow-up.

- One fork digest after each branch. The plugin asks for it on its own.

- One merge digest.

Do the dry run first, so that the recorded run has no surprises.

## Before the recording, check `demo.risks`

- The merge UI on the entry branch is the section below the graph. If the new popover UI lands first, change the "Do" column.

- The scroll on a node click is PR #36. It is not merged yet. Without it, skip 1:05–1:12.

- Keep the questions short, so that the node labels fit on one line.
