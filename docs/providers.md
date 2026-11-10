# Definition providers

Concept Links turns `::term{name="..." def="..."}` directives into hover
definitions and a Concepts pane entry. A *provider* answers "what does this term
mean?". This page lists every provider we considered, what is built, and what
each one costs or risks. Provider interface and registry rules are in `SPEC.md`.

## Table

| Provider | Possible under the SDK? | Implemented? | Latency | Cost | Risks |
| --- | --- | --- | --- | --- | --- |
| inline (`attrs.def`) | Yes. Reads the directive attributes the host passes to the renderer. | Yes (`src/inline-provider.js`). | Sync, effectively 0 ms. | Free. | Attributes are untrusted strings written by the model. The definition is only as good as the model's sentence, and it can be wrong. |
| session glossary | Yes. In-memory use records per session, kept by the registry. | Yes (`src/session-glossary.js`). | Sync, effectively 0 ms. | Free. | Memory only, so it is lost on reload. It only returns a definition that an earlier directive supplied. |
| static / user glossary | Yes. A bundled list, plus `userGlossary` read from `ctx.storage`. | Yes (`src/static-glossary.js`). | Sync, effectively 0 ms. | Free. | Small bundled list (30 terms). A user entry overrides a bundled one, so a bad user entry shadows a good definition. |
| Wikipedia | Yes, through `ctx.fetch`, with `ctx.rest` fallback to the Python proxy. | Yes (`src/wiki-provider.js`). | One HTTP request, 4s timeout. | Free. | Direct renderer fetch may be blocked by CORS or CSP, so the proxy fallback matters. Page summaries can describe a different sense of the word. Disambiguation pages are treated as a miss. Sends the term to a third party. |
| Wiktionary | Yes, same route as Wikipedia. | Yes (`src/wiki-provider.js`). | One HTTP request, 4s timeout. | Free. | Same CORS/CSP risk. Gives dictionary senses, which are often too general for technical terms. The first definition is used. Sends the term to a third party. |
| MDN | Yes, same route as Wikipedia. | Yes (`src/mdn-provider.js`). | One HTTP request, 4s timeout. | Free. | Same CORS/CSP risk. Only web platform terms match. An unrelated first search hit is rejected rather than shown. Sends the term to a third party. |
| coined-term fallback | Yes. Uses the registry's first-use record. | Yes (`src/coined-provider.js`). | Sync work plus, when a network route exists, up to two existence checks (Wikipedia, Wiktionary), each one HTTP request with a 4s timeout. | Free. | Never invents a definition. It shows the first-use quote labelled "inferred from context", or "No definition found" when there is no quote. The quote may be misleading out of context. |
| LLM backend | Possible through `ctx.rest` plus `dashboard/plugin_api.py`, or through `ctx.llm`, which would need a declared capability. | Not as a live completion. The JS provider exists (`src/llm-provider.js`) and is disabled by default. `POST /define` returns 501 `{"ok": false, "reason": "not configured"}`. | Would be a model call. Not measured, because it is not live. | A future route would cost one model call per unresolved term. Not live, so nothing is charged. | Would send the term and surrounding text to a model. It could invent plausible but wrong definitions. This plugin requests no `llm.*` capability. |
| docs / codebase index | Possible only later. The SDK has no docs index. `ctx.files.requestFolder()` could grant a folder, but that is only access. | No. We did not build an indexer. | Not applicable. | Not applicable. | An index would go stale against the code. It would need a user folder grant and a way to rank matches. |
| Python `transform_llm_output` annotator hook | Yes. Declared in `plugin.yaml` as `provides_hooks`. Registered in `__init__.py`. | Yes (`annotate_terms` in `__init__.py`). | A local string pass, effectively 0 ms. | Free. | Registered without `hold_stream`, so users may briefly see unlinked text, then a rewrite. It only knows the bundled glossary terms. A match can be a different sense of the word. |

## Default chain order

1. `inline`
2. `session`
3. `static`
4. `mdn`
5. `wiktionary`
6. `wikipedia`
7. `coined`
8. `llm` (disabled by default)

The first provider that returns a definition wins. A throwing provider is
skipped. The user can reorder providers and switch them on or off in the
Concept providers pane. If the user saves a disabled list, it is the full
disabled set, so enabling `llm` there is possible but has no effect while
`POST /define` returns 501.

## Behaviour notes

- **Cache.** Results are cached in memory, per session, keyed by the term and
  the session id. A miss is not cached. Nothing is written to disk.
- **Hover delay.** 650 ms, the Wikipedia page-preview convention.
- **Network path.** Wikipedia, Wiktionary and MDN are fetched in JS with
  `ctx.fetch`. If that throws (for example CORS or CSP), the provider falls
  back once to the Python proxy at `GET /lookup?source=...&term=...`, which
  makes the same public request with a 4s timeout. The proxy returns 404 when
  there is no definition and never invents one.
- **Coined terms.** A term with no standard source never gets an invented
  definition. The pane shows the first-use quote labelled "inferred from
  context".
- **Two panes.** Concepts and Concept providers are separate panes, so closing
  Concepts does not disable the plugin.

## Limits and caveats

- **Paragraph cap.** The host drops directives in paragraphs over 4800
  characters. The annotator and the skill both skip those paragraphs.
- **Attribute body cap.** The directive attribute body is limited to 2048
  characters. The annotator skips a term whose body would be longer.
- **Quote-unsafe attributes.** Values are wrapped in double quotes with no
  escapes. A `"`, `{`, `}` or backslash in a name or definition breaks the
  directive, so the annotator and the skill avoid them.
- **Other surfaces.** The CLI, TUI and messaging platforms do not render the
  directive. Users there see the raw `::term{...}` text.
- **Docs versus source.** The official SDK docs still say a transcript directive
  must be an entire paragraph, but the installed Desktop source and its tests
  allow `::term` in the middle of a sentence. Confirm that on a live Desktop
  session. Treat a definition as a reading aid, not as the authority.
- **Who makes inline links appear.** A desktop plugin cannot rewrite unmarked
  chat. Links appear because the skill makes the assistant emit `::term`
  directives. The Python hook is the automatic layer on top, for the bundled
  terms only.
