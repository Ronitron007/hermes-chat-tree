# Chat Tree

Chat Tree is a Hermes Desktop plugin. It is one window, a side pane that draws the open chat and its branches as a git graph. You branch, ask, and merge from the same pane.

## What it does

- Each node is one exchange, one user message and its replies.

- **Branch here** starts a branch from a node. The branch is a new chat that continues after that exchange. Hermes names the branch.

- A branch can use a cheaper model for a side question.

- A merge brings a branch back into any ancestor chat on its path. Choose the mode:

  - **Merge as-is** copies the questions and answers.

  - **Digest** gives the ancestor a short digest by the model.

- Each chat has its own lane. A branch leaves its parent lane at the exchange where it starts. A merge curves back into a node on the ancestor lane.

- Blue marks the path from the first exchange to the open node. Grey marks all other nodes.

- A long run of exchanges folds into one `+N` row. Click the row to show the exchanges in it.

- Point to a node to see the chat title and its model. Click a node to open its chat.

## Parts

| Part | Files | Job |
|---|---|---|
| Desktop half | `desktop/plugin.js` (built from `src/`) | The tree pane |
| Python half | `plugin.yaml`, `__init__.py`, `dashboard/` | The digest route |

## The digest route

The Desktop half calls the route through `ctx.rest('/digest', { method: 'POST', body })`. Hermes serves it at `POST /api/plugins/chat-tree/digest`.

Request:

```json
{ "purpose": "fork", "title": "Rust lifetimes", "exchanges": [{ "question": "…", "answer": "…" }] }
```

- `purpose` is `fork` or `merge`.

- `exchanges` are oldest first.

Response:

- HTTP 200 with `{ "ok": true, "digest": "…" }` when the model wrote a digest.

- HTTP 200 with `{ "ok": false, "error": "…" }` when the model call or its reply failed.

- HTTP 400 with `{ "ok": false, "error": "…" }` when the request does not have the shape above.

A `fork` digest has 3 to 5 bullet lines and fewer than 80 words. It covers the chat up to the fork. A `merge` digest has fewer than 120 words. It tells what the branch asked, what it concluded, and the key facts. Both digests use only facts from the exchanges.

The route sends at most 24,000 characters of exchanges to the model. It cuts each question and each answer to 6,000 characters. Then it leaves out the oldest exchanges first, and it tells the model how many it left out.

## How the route reaches the model

- `register(ctx)` in `__init__.py` registers the auxiliary task `chat_tree_digest` and keeps `ctx`.

- The route calls `ctx.llm.complete_structured` with the JSON schema `{ digest: string }`, temperature 0, and `task="chat_tree_digest"`.

- Hermes runs `register(ctx)` and the route in the same process. The two halves share `dashboard/digest.py` through one module name. The comment at the top of that file gives the evidence in the Hermes source.

- If the plugin is not loaded in that process, the route answers `ok: false` with the fix. It never writes a digest of its own.

## Choose the digest model

Until you choose a model, `chat_tree_digest` uses the model of the built-in title generation task. To choose a model, set `auxiliary.chat_tree_digest` in `config.yaml`:

```yaml
auxiliary:
  chat_tree_digest:
    provider: openrouter
    model: vendor/model-id
```

Hermes Desktop shows the same setting in **Settings → Models → Auxiliary**.

## Install

You need Hermes 0.23 or later and Hermes Desktop.

Run the install script from the root of the repository, then run the commands that it prints:

```bash
bash scripts/install.sh
hermes plugins enable chat-tree
hermes gateway restart -y --detach
```

Then quit and relaunch Hermes Desktop. The root [README](../README.md) gives all the steps. The script is [`scripts/install.sh`](../scripts/install.sh).

## Tests

```bash
npm run test:chat-tree
<hermes venv>/bin/python chat-tree/tests_py/test_digest.py
```

The Python tests need FastAPI and httpx. No test calls a model.

## Limits

- Hermes has no API to scroll a chat to one message. A click on a node opens the chat of that node, at its usual scroll position.

- The tree reads the newest 500 chats and at most 30 chats of one lineage.

- A digest needs a model call. If the call fails, the pane gets an error and no digest.
