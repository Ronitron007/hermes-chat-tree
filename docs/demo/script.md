# Demo script: Chat Tree, word by word

Date: 2026-11-12. Length: about 90 seconds. Story: a developer ships a CLI tool, `tidyfiles`, to PyPI. Side questions come up. Each goes into a branch, so the main chat stays on topic.

How to read this script:

- **VO** is the voice-over, word for word. Use the same words as on-screen captions if you record with no voice.

- **TYPE** is the exact text to type. Copy it as it is.

- **DO** is the click or key.

- **SEE** is what must be on screen before you go on.

## Before you record `demo.setup`

1. Install the entry from `outbox/competition-entry`, then relaunch Hermes Desktop.

2. Import the main chat. This makes no model call:

   ```bash
   hermes sessions import --from claude docs/demo/ship-tidyfiles.jsonl
   ```

3. Rename it, with the id that the import prints:

   ```bash
   hermes sessions rename <id> "Ship tidyfiles to PyPI"
   ```

4. Open the chat. Open the Chat Tree pane. Set the window to about 1440 × 900.

5. Do one full dry run. Then import the chat again under a new name for the real take.

6. Start the recording with the main chat scrolled to the bottom and the tree collapsed (`+9`).

## Title card `demo.title` (0:00–0:04)

ON SCREEN, centred:

> **Chat Tree for Hermes**
> Branch a side question. Merge the answer back. See it all as a tree.

## Beat 1: the itch `demo.itch` (0:04–0:14)

SEE: the main chat "Ship tidyfiles to PyPI". The tree shows one lane and a `+9` row.

DO: scroll the chat up to the reply about `python -m build`. Hover the dotted word **wheel**.

SEE: the tooltip with the definition of wheel.

VO:

> "I'm shipping a CLI tool to PyPI. Eleven steps in, and a new word shows up: wheel. I want to ask about it. But not here. This chat is about shipping."

## Beat 2: the side question `demo.side_question` (0:14–0:28)

DO: in the tree, click `+9` to expand it. Hover the row "How do I build the package?". Click the fork icon.

SEE: the popover "Branch here: How do I build the package?".

TYPE:

```
What is the difference between a wheel and an sdist?
```

DO: open the model picker and pick a small, fast model. Press Enter.

SEE: a new lane forks off exactly that row. The branch opens and the answer streams in.

VO:

> "So I branch, right at the step where the word came up. I ask on a small, fast model. My main chat doesn't move."

## Beat 3: bring it home `demo.merge_back` (0:28–0:40)

DO: in the tree, hover the branch row. Click the merge icon. Keep the target **Ship tidyfiles to PyPI**. Click **As-is**.

SEE: the main chat opens with the answer staged in the composer, and the fit numbers.

DO: press Send.

SEE: a curve from the branch lands on a new node, `Merged: What is the difference between a wheel and an sdist?`, on the main lane.

VO:

> "Now I bring the answer home. It lands in the composer. Nothing is sent until I say so. And the tree draws the merge."

## Beat 4: go deep `demo.go_deep` (0:40–0:56)

DO: hover the row "Can GitHub Actions publish releases for me?". Click the fork icon.

TYPE:

```
Walk me through setting up trusted publishing.
```

DO: pick your strongest model. Press Enter. When the answer is done, type the follow-up in the branch chat and send it:

```
What does the workflow file look like?
```

SEE: a second lane with two nodes. The rows between the two forks fold to `+4`.

VO:

> "Some questions are bigger. Trusted publishing gets its own branch, on my strongest model. Two exchanges deep, and the main chat is still clean."

## Beat 5: a branch of a branch `demo.nested` (0:56–1:06)

DO: hover the row "What does the workflow file look like?" in the second lane. Click the fork icon.

TYPE:

```
What is OIDC, in two sentences?
```

DO: pick the small, fast model. Press Enter.

SEE: a third lane forks off the second lane.

VO:

> "The answer mentions OIDC. Another side question. A branch can branch, too."

## Beat 6: skip a level `demo.skip_level` (1:06–1:14)

DO: hover the OIDC row. Click the merge icon. In the target list, pick **Ship tidyfiles to PyPI**, the main chat, not its parent.

SEE: the main lane lights up while you pick. Click **As-is**, then press Send in the main chat.

SEE: the merge curve jumps over the second lane and lands on the main lane.

VO:

> "And I can merge into any ancestor. This one goes straight to the main chat."

## Beat 7: compress `demo.digest` (1:14–1:22)

DO: hover a row of the trusted publishing lane. Click the merge icon. Keep the target **Ship tidyfiles to PyPI**. Click **Digest**. When the digest is staged, press Send.

SEE: a third `Merged:` node on the main lane.

VO:

> "A long branch comes back as a digest. The main chat gets the point, not the whole conversation."

## Beat 8: navigate `demo.navigate` (1:22–1:27)

DO: in the tree, click the row "What goes in pyproject.toml?".

SEE: the main chat scrolls to that exchange.

VO:

> "Every node is a way back into the chat."

## End card `demo.end` (1:27–1:30)

ON SCREEN, centred:

> **Chat Tree for Hermes**
> Branch. Ask on any model. Merge back.
> github.com/Ronitron007/hermes-concept-links

VO:

> "Branch, ask, merge. One window."

## The tree at the end `demo.final_tree`

```
●  I want to publish my CLI tool…
●  What goes in pyproject.toml?               ← beat 8 jumps here
●──╮  How do I build the package?
│  ●  What is the difference between a wheel…   [small] side
●  │  +4
●──┼──╮  Can GitHub Actions publish releases…?
│  │  ●  Walk me through setting up trusted…    [strong]
│  │  ●──╮  What does the workflow file look like?
│  │  │  ●  What is OIDC, in two sentences?     [small]
●  │  │  │  Will my README show on the PyPI page?
●  │  │  │  Should I keep a changelog?
●  │  │  │  OK, give me the release checklist.
●──╯  │  │  Merged: wheel vs sdist
●─────┼──╯  Merged: What is OIDC                ← skipped a level
●─────╯     Merged: trusted publishing (digest)
```

## Model calls in one take `demo.cost`

The import makes no model call. One take makes these calls on your own Hermes models:

- Four questions: beats 2, 4 (two), and 5.

- Three fork digests, one after each branch. The plugin asks for them on its own.

- One merge digest, in beat 7.

## If the take runs long `demo.cuts`

Cut beats 5 and 6 together. The story still works: fork, merge, go deep, digest, navigate.

## Check before the take `demo.risks`

- Beat 8 needs the scroll feature (PR #36) merged and installed. Without it, end on beat 7.

- Keep the typed questions as they are. Short questions keep the node labels on one line.
