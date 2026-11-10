# concept-links

Hermes Desktop plugin: mark dense terms in chat with `::term{...}` directives,
show a short definition on hover, and open a right-hand Concepts pane on click.

Definitions come from a pluggable **definition provider** module. See `SPEC.md`
and `docs/providers.md`.

```
npm test
npm run assemble    # writes desktop/plugin.js
```

## Layout

- `src/` — headless provider chain, cache, and plugin factory (tested under Node)
- `test/` — Node built-in test runner, no dependencies
- `desktop/plugin.js` — assembled disk plugin (imports only the SDK, react, jsx-runtime)
- `skills/concept-links/SKILL.md` — tells the agent to emit `::term` directives
- `plugin.yaml`, `__init__.py`, `dashboard/plugin_api.py` — optional Python half
  (mechanical annotator hook + Wikipedia/Wiktionary/MDN proxy + 501 `/define`)

Do not `git push`. Local commits are only to keep the tree clean for `mr`.
