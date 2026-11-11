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
| Python half | `plugin.yaml`, `__init__.py` | The digest and history RPC methods |

## The digest method

The Python half follows the plugin RPC path that Hermes documents for `ctx.llm` from a frontend. The pane calls the method with `host.request`:

```js
host.request('plugin.chat-tree.digest.write', { session_id, purpose, title, exchanges })
```

- `purpose` is `fork` or `merge`.

- `exchanges` is a list of `{ question, answer }` objects, oldest first.

- The call answers `{ job }` at once. A bad request fails the call with the reason `plugin_rpc_failed`.

- At most 4 digests run at one time. A fifth call fails until one of them ends.

The model writes the digest in a worker thread. Then the pane gets the gateway event `plugin.chat-tree.digest.written` for that session:

- `{ job, digest }` when the model wrote a digest.

- `{ job, error }` when the model call or its reply failed. The Python half never writes a digest of its own.

A `fork` digest has 3 to 5 bullet lines and fewer than 80 words. It covers the chat up to the fork. A `merge` digest has fewer than 120 words. It tells what the branch asked, what it concluded, and the key facts. Both digests use only facts from the exchanges.

The method sends at most 24,000 characters of exchanges to the model. It cuts each question and each answer to 6,000 characters. Then it leaves out the oldest exchanges first, and it tells the model how many it left out. It masks secrets in the text before the model call.

## The history method

The pane draws the tree from the messages of each chat in the lineage of the open chat. The `session.history` method of Hermes answers only for a chat that the gateway holds in memory. Thus the Python half reads the other chats from the local session store of Hermes.

Privacy: the plugin reads the messages of the chats in the lineage of the open chat. It reads them from the local session store of Hermes, to draw the tree. It reads only. Nothing leaves the machine, and no model gets this text.

On each refresh, the pane sends one call for all chats with new messages:

```js
host.request('plugin.chat-tree.history.read', { session_ids, session_id })
```

- `session_ids` is a list of stored chat ids. The method reads the first 30 different ids. It ignores an item that is not a string.

- `session_id` is the runtime id of the open chat. The call can also come without it.

- The call answers `{ histories, missing }`. `histories` maps each stored id to its rows, oldest first. Each row is `{ role, text, row_id }`, and `role` is `user` or `assistant`. `missing` lists the ids that are not in the store.

- The method opens the store of the profile of the call one time, read-only (`hermes_state.SessionDB(read_only=True)`). It reads the active rows with `get_messages_as_conversation`, as `session.history` does.

- A bad request fails the call with the reason `plugin_rpc_failed`.

If the Python half is not enabled, the call fails with the error `-32601`. Then the pane reads each chat with `session.history` and shows this note: `Enable the chat-tree plugin backend to see other chats (hermes plugins enable chat-tree).`

## How the method calls the model

- `register(ctx)` in `__init__.py` registers the auxiliary task `chat_tree_digest` and the RPC methods `digest.write` and `history.read`.

- The worker thread calls `ctx.llm.complete_structured` with the JSON schema `{ digest: string }`, temperature 0, and `task="chat_tree_digest"`.

- The thread then calls `ctx.emit_to_session` with the result.

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
<hermes venv>/bin/python chat-tree/tests_py/test_history.py
```

The digest tests import `agent.redact` and `agent.plugin_llm` from the Hermes source. The history tests make a temporary session store with `hermes_state.SessionDB`. No test calls a model, and no test opens a real Hermes home.

## Limits

- Hermes has no API to scroll a chat to one message. A click on a node opens the chat of that node, at its usual scroll position.

- The tree reads the newest 500 chats and at most 30 chats of one lineage.

- Without the Python half, the tree shows only the chats that the gateway holds in memory.

- A digest needs a model call. If the call fails, the pane gets an error and no digest.
