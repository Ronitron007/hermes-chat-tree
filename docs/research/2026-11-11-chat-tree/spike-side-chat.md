# Spike plan: side chat `chat_tree.spike_side_chat`

Date: 2026-11-11. Hermes Agent v0.23.1, local commit `3b42157858`.

## Goal `spike_side_chat.goal`

Find out if a desktop plugin pane can do these three things through public SDK calls:

1. Fork the focused chat into a branch.

2. Send a side question to the branch with a different model for that one turn.

3. Open the branch.

The spike answers decision `D-route` in [decisions.tsv](decisions.tsv). It is throwaway code. It is not the side chat feature.

## Calls `spike_side_chat.calls`

All calls go through `host.request`, which sends gateway JSON-RPC (`apps/desktop/src/sdk/index.ts:1507`).

| Step | Call | Parameters |
|---|---|---|
| Fork | `session.branch_whole` | `session_id` from `host.state.focusedSessionId`, `name`, `idempotency_key` |
| Ask | `prompt.submit` | `session_id` of the branch, `text`, `model_override` with `model` and `provider` |
| Open | `host.openSession` | `stored_session_id` of the branch, `intent: 'tab'` |

The desktop branch button uses the same `session.branch_whole` call (`apps/desktop/src/app/session/hooks/use-session-actions/index.ts:2642`). The gateway checks `model_override` in `gateway/session_cli_turn.py:40-53`.

## What the spike shows `spike_side_chat.output`

The pane shows the raw result or error of each call. The pane keeps a log of all calls.

## Pass and fail `spike_side_chat.check`

The spike passes if all of these are true:

- `session.branch_whole` returns a new `session_id`.

- `prompt.submit` with `model_override` returns an admission, and the answer in the branch comes from the override model.

- The parent chat gets no new message.

The spike fails if one call returns an error. Record the error text in [decisions.tsv](decisions.tsv).

## Known risks `spike_side_chat.risks`

- A branch needs an idle session. A fork during an agent run can fail.

- The override model name must be valid for the provider. The pane lets the user type both.

- A user runs the spike in the app. Claude cannot drive the app in this session.
