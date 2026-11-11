# Spec and plan: a public LSP request API in Hermes Agent

Date: 2026-11-11. Target repo: NousResearch/hermes-agent, base `60f81635c2` (upstream `main`). Status: approved direction (Rohan, 2026-11-11: "Own request() PR"). We built nothing yet.

Research: [2026-11-10-lsp-bridge.md](../research/2026-11-10-lsp-bridge.md).

## Problem `request_api.problem`

Hermes Agent runs language servers in `agent/lsp/`. Its public API gives only diagnostics. A plugin that needs hover, definition, or references must call private methods (`_get_or_spawn`, `_send_request_with_retry`). The plugin validator warns on these calls, and the calls break when Hermes changes.

The open PR NousResearch/hermes-agent#55532 adds `query_lsp_sync()` and five agent tools. It is open since 2026-06-30 with no review. This spec is smaller. It adds only a public read-only request method for plugins. It adds no agent tools. The PR text must name #55532 and say how the two differ.

## What ships `request_api.outcome`

A plugin can call one public function to send a read-only LSP request for a file and get the raw LSP result. The plugin validator does not warn on this import.

## Interface `request_api.interface`

In `agent/lsp/manager.py`, add a method to `LSPService`:

```python
def request_sync(
    self, file_path: str, method: str, params: Optional[dict[str, Any]] = None,
    *, timeout: Optional[float] = None,
) -> Any:
    """Open ``file_path`` on its server, send ``method``, return the raw LSP result."""
```

In `agent/lsp/__init__.py`, add a module function and an exception:

```python
class LSPUnavailable(Exception):
    """No language server can answer for this file. ``reason`` says why."""

def request(file_path: str, method: str, params: Optional[dict[str, Any]] = None,
            *, timeout: Optional[float] = None) -> Any: ...
```

`request()` gets the service with `get_service()` and calls `request_sync()`.

## Rules `request_api.rules`

- `method` must be in `READ_ONLY_METHODS`. Any other method raises `ValueError` before any server starts. The set is:

  - `textDocument/hover`

  - `textDocument/definition`

  - `textDocument/declaration`

  - `textDocument/typeDefinition`

  - `textDocument/implementation`

  - `textDocument/references`

  - `textDocument/documentSymbol`

  - `textDocument/documentHighlight`

  - `workspace/symbol`

- If `method` starts with `textDocument/` and `params` has no `textDocument`, set `params["textDocument"] = {"uri": file_uri(file_path)}`. Do not change the caller's dict.

- Open the file with `client.open_file` before the request. This also makes `workspace/symbol` work on typescript-language-server, which answers "No Project." with no open file.

- Use the same gates as diagnostics: `enabled_for`, workspace trust, the broken set, and disabled servers. Use the same background loop.

- A `null` LSP result returns `None`. This means "the server has no answer". It is a valid result.

- Raise `LSPUnavailable` with a reason when the server cannot answer. Reasons: LSP disabled, no server for the file, no git workspace, untrusted workspace, server broken, timeout. A caller must be able to tell "cannot answer" from "no answer".

- An LSP error response (`LSPRequestError`) propagates to the caller. A protocol failure marks the server broken, as `get_diagnostics_sync` does, and raises `LSPUnavailable`.

- The default timeout is `lsp.wait_timeout`, the same as diagnostics.

- Touch the client (`_touch`) after a request, so the idle reaper keeps a server that a plugin uses.

- Change no client capabilities. Semantic tokens are out of scope.

## Public plugin surface `request_api.plugin_surface`

- Add `agent.lsp:request` and `agent.lsp:LSPUnavailable` to `hermes_cli/data/plugin_api.json`. Follow the harvest rules in its `_comment`. If the rules require a docs mention, add the mention to the plugin docs.

- Regenerate `website/docs/developer-guide/plugins/public-api.md` with `scripts/gen_plugin_api_docs.py`.

- Add a short "Query a language server from a plugin" section to `website/docs/user-guide/features/lsp.md` or the plugin developer guide, whichever the repo uses for plugin-facing APIs.

## Plan `request_api.plan`

One unit, one PR. Branch `feat/lsp-public-request` in a fork (`Ronitron007/hermes-agent`).

1. Build the dev environment as `CONTRIBUTING.md` says.

2. Write the tests first in a new file `tests/agent/lsp/test_request_api.py`. Use `_mock_lsp_server.py`. Cover each rule in `request_api.rules`.

3. Implement `request_api.interface`.

4. Update the plugin surface in `request_api.plugin_surface`.

5. Run the check.

## Check `request_api.check`

All of these must exit 0:

- `just test tests/agent/lsp/`

- `just test tests/hermes_cli/test_plugin_docs_public_imports.py tests/hermes_cli/test_plugin_validate_private_imports.py tests/plugins/conformance/`

- `just check`

The new tests must fail on the base commit.

## Out of scope `request_api.out_of_scope`

- Agent tools (that is #55532).

- Semantic tokens and new client capabilities.

- Any write method, such as rename or code actions.

- Desktop SDK changes.
