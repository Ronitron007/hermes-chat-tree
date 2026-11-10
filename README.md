# Concept Links

A Hermes Desktop plugin that turns terms in chat output into dotted-underline chips. Hover a chip for a short definition tooltip; click it to open a right-hand Concepts side pane with the definition, its source, and where the term was first used in the session.

It has two halves:

- A disk UI plugin (`desktop/plugin.js`) that renders the chips, tooltip, and panes, and looks terms up through a definition-provider chain.
- A Python plugin (`plugin.yaml`, `__init__.py`, `dashboard/plugin_api.py`) that annotates replies after they are generated, plus a small lookup proxy. A skill (`skills/concept-links/SKILL.md`) tells the assistant to emit the paragraph-level markup when it already knows a definition.

## Encoding: `::termline{v= t=}`

Annotated paragraphs are encoded as a single paragraph-level directive:

```
::termline{v="A monoid lets you fold a list in any grouping." t="monoid=An algebraic structure with an associative binary operation and an identity element."}
```

- `v` is the plain sentence, with no markup inside it.
- `t` is a list of `name=definition` pairs, separated by `;;`.

This exists because of two host constraints in Hermes Desktop:

1. The host splits a Markdown paragraph at every `::directive`, so a mid-sentence `::term{...}` broke the sentence into separate `<p>` blocks (plain text, then the chip, then the rest).
2. The host's `liftDirectives` preprocessor backslash-escapes `[` and `]`, which broke an earlier `[[name|def]]` encoding inside the directive body.

A paragraph-level `::termline` keeps the sentence in one block. Legacy `[[name|def]]` markup in `v` is still accepted after unescaping, and older `::term{name= def=}` directives still render, but new annotation uses the `v` / `t` form. Shipped CSS lacks `decoration-dotted`, so chips set `textDecoration: 'underline dotted'` inline.

The Python annotator (`transform_llm_output`, registered without `hold_stream`) rewrites whole paragraphs this way. It does not hold the stream, so a reply may appear briefly as plain text before the tagged version replaces it.

## Definition providers

A provider is an object:

```
{id, label, canResolve(term, ctx), resolve(term, ctx) -> {short, long, source, kind: standard|coined|uncertain, firstUse?, url?, providerId}}
```

Providers are registered in an ordered fallback chain, with a per-session in-memory cache. The first provider that returns a definition wins. A throwing provider is skipped. You can reorder providers and switch each on or off in the Concepts pane (or the standalone Concept providers pane).

Default order:

1. **inline** — definitions written into the reply itself (directive attributes).
2. **session glossary** — terms already defined earlier in the session.
3. **static / user glossary** — a bundled glossary of 30 terms, plus terms you add (`ctx.storage`).
4. **MDN** — the web developer reference.
5. **Wiktionary**
6. **Wikipedia** — `ctx.fetch`, with a `ctx.rest` proxy fallback and a 4s timeout.
7. **coined fallback** — never invents a definition; shows the first-use quote labelled "inferred from context", or "No definition found".
8. **LLM backend** — built (`src/llm-provider.js`) but disabled by default. `POST /define` returns 501.

A **docs / codebase index** provider was ruled out. The Hermes plugin SDK has no index API, and `ctx.files.requestFolder()` would only grant folder access, not a searchable index.

Details, costs, and risks are in [`docs/providers.md`](docs/providers.md). The full design notes are in [`SPEC.md`](SPEC.md).

## Install

Copy the three pieces into your Hermes config, then enable the plugin and restart the gateway.

```bash
# UI plugin
mkdir -p ~/.hermes/desktop-plugins/concept-links
cp desktop/plugin.js ~/.hermes/desktop-plugins/concept-links/plugin.js

# Python plugin (annotator hook, lookup proxy, /define stub)
mkdir -p ~/.hermes/plugins/concept-links
cp plugin.yaml __init__.py ~/.hermes/plugins/concept-links/
mkdir -p ~/.hermes/plugins/concept-links/dashboard
cp dashboard/plugin_api.py ~/.hermes/plugins/concept-links/dashboard/

# Skill
mkdir -p ~/.hermes/skills/concept-links
cp skills/concept-links/SKILL.md ~/.hermes/skills/concept-links/SKILL.md

hermes plugins enable concept-links
# Then restart the Hermes gateway (and relaunch Hermes Desktop so it picks up the disk plugin).
```

Rebuild the UI plugin after editing `src/` with `npm run assemble` (writes `desktop/plugin.js`). The assembled file may import only `@hermes/plugin-sdk`, `react`, and `react/jsx-runtime`.

## Tests

```bash
npm test                    # 91 tests (Node built-in test runner, no extra dependencies)
python3 test/test_annotator.py   # 16 tests
```

The earlier feasibility spike lives under [`spike/`](spike/) (`feasibility.md`, `src/`, `test/`). Research notes used while designing the providers are under [`docs/research/`](docs/research/) (email headers redacted).

## Known gaps

- The Python annotator only links bundled glossary terms in real replies. The plugin can resolve terms through MDN, Wiktionary, and Wikipedia, but nothing in a reply currently triggers those lookups automatically. Terms like "functor" stay plain if they are not in the 30-term glossary.
- The LLM provider is implemented but turned off (`POST /define` returns 501). Enabling it, or letting the annotator query the online sources, would pick up glossary misses and terms the model coined itself.
- Paragraphs over 4800 characters, or whose directive body would exceed 2048 characters, are left unmarked (host limits). Names or definitions containing `"`, `{`, `}`, or a backslash are skipped, because attribute values are wrapped in double quotes with no escapes.

## Layout

- `src/` — provider chain, cache, termline parser, and plugin factory
- `test/` — Node tests plus `test_annotator.py`
- `desktop/plugin.js` — assembled disk plugin
- `scripts/assemble.mjs` — builds `desktop/plugin.js` from `src/`
- `skills/concept-links/SKILL.md` — instructs the assistant to emit `::termline`
- `plugin.yaml`, `__init__.py`, `dashboard/plugin_api.py` — Python half
- `docs/providers.md` — provider survey
- `spike/` — feasibility spike that preceded the plugin
