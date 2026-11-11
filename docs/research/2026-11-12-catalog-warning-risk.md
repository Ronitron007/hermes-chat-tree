# The catalog warning of the scroll feature: what it means for the entry

Date: 2026-11-12. Status: information only.

## What the plugin does `warning.what`

A click on a tree node scrolls the main chat to that exchange. The plugin sends the DOM event `hermes:timeline-reveal` to the chat viewport, and it finds the viewport with the selector `[data-slot="aui_thread-viewport"]`. Details: [2026-11-12-scroll-to-message.md](2026-11-12-scroll-to-message.md).

## What the validator says `warning.validator`

Verified (ran `hermes plugins validate chat-tree` on PR #36):

```
✓ desktop surface — stays inside the plugin SDK surface
⚠ desktop surface review (catalog rule 8: SDK surface only): app markup selector
Validation passed.
```

The validator has two levels for this rule (`hermes_cli/plugin_validate_desktop.py`):

| Form | Result |
|---|---|
| `document.querySelector('...[data-slot...]')` with the selector written in the call | refused: the plugin fails admission |
| Any other form, such as a selector in a constant | warning: a reviewer reads it and decides |

The plugin uses the second form. It passes admission with one warning.

## What this means for the entry `warning.risk`

Inferred, not verified: a form that only draws a warning likely does not get the entry disqualified on its own.

- Catalog review is done by a person. The warning tells the reviewer to look. It does not reject the plugin.

- The catalog rules say that a plugin that needs a missing capability must ask for an SDK hook. We asked: [NousResearch/hermes-agent#153905](https://github.com/NousResearch/hermes-agent/issues/153905).

- The risk is that a reviewer rejects the catalog PR, or that the judges score it lower on reliability or polish.

We did not read the official competition rules. The facts about the competition come from secondary sources.

## What we did to lower the risk `warning.mitigation`

- The feature falls back to "open the chat" when the viewport, the row id, or the event is missing.

- The README discloses the feature and the warning.

- The issue asks Hermes for a public function, `host.revealMessage`. When it ships, the plugin can drop the DOM path.
