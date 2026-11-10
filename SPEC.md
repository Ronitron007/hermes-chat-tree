# Concept Links — implementation spec

Build a Hermes Desktop plugin named `concept-links`. This file is the contract
for every `mr` task in this repo. Follow it exactly. Do not invent SDK APIs.
Do not install into `~/.hermes`. Do not add npm dependencies. Do not git push
or add a remote. Local commits are unnecessary during a task.

Disk `plugin.js` may import only `@hermes/plugin-sdk`, `react`, and
`react/jsx-runtime`. Headless sources under `src/` are plain ESM, no Node
built-ins, so they can later be concatenated into that file. Tests use
`node --test` and may import `node:test` / `node:assert/strict`.

## Definition provider interface

A provider is a plain object:

```js
{
  id: string,          // stable, unique, e.g. 'inline'
  label: string,       // shown in the pane and settings, e.g. 'Inline directive'
  canResolve(term, ctx): boolean,
  resolve(term, ctx): Definition | null | Promise<Definition | null>
}
```

`term` is a non-empty trimmed string (the visible name).

`ctx` (all fields optional except what a given provider needs):

```js
{
  sessionId: string | null,
  attrs: object | null,          // parsed ::term attributes (untrusted strings)
  source: string | null,         // raw directive text
  surrounding: string | null,    // optional sentence/paragraph for first-use quotes
  fetch: typeof fetch,           // injectable; network providers must use ctx.fetch, never global fetch directly, so tests can stub it
  rest: (path, opts?) => Promise, // optional ctx.rest to the Python plugin namespace
  userGlossary: Array<{term, def}> | Record<string, string>,
  now: number
}
```

A `Definition` is:

```js
{
  short: string,       // tooltip, target ≤ 25 words
  long: string,        // pane, target ≤ 120 words
  source: string,      // human label for where it came from, e.g. 'Wikipedia'
  kind: 'standard' | 'coined' | 'uncertain',
  providerId: string,  // the provider that produced it
  url: string | null,  // optional source link
  firstUse: { quote: string, sessionId: string | null } | null,
  // never invent a definition for a coined term. If kind is 'coined' and there
  // is no retrieved standard def, short/long must be the first-use quote and
  // long must start with or include the label "inferred from context".
}
```

Helpers to export from `src/providers.js`:

- `clipWords(text, maxWords)` — trim to at most maxWords, add an ellipsis if cut.
- `normalizeTerm(term)` — trim, collapse internal whitespace, case-fold for keys
  (locale-independent: `toLowerCase()`). The visible `name` stays as given.
- `emptyDefinition()` is not required.

## Registry, cache, fallback chain

`createRegistry(options?)` in `src/providers.js` returns:

```js
{
  register(provider),          // add or replace by id
  list(),                      // providers in current order (enabled and disabled)
  get(id),
  setOrder(ids),               // ids not named go at the end, in previous relative order
  setDisabled(ids),            // array of ids; unknown ids ignored
  isDisabled(id),
  recordUse({ name, def, sessionId, source, attrs, surrounding }),
  usesFor(name, sessionId),    // all recorded uses in that session, in order
  firstUse(name, sessionId),   // first recorded use, or null
  lookupSync(term, ctx),       // first successful SYNC provider in the enabled chain (ignores thenables, ignores network-only providers)
  lookup(term, ctx),           // async: first successful enabled provider; caches per session
  clearCache(sessionId?),      // one session, or all
  peekCache(term, sessionId)   // cached Definition or null, for tests
}
```

Cache key: `normalizeTerm(term) + '\0' + String(sessionId ?? '')`. Cache hits
skip later providers. A `null` result is not cached (so a later retry or a
newly recorded session def can succeed). Cache is in-memory only.

`lookup` / `lookupSync` walk the enabled chain in order. For each provider:
`canResolve` is called first; if it throws, skip the provider. If it returns
true, call `resolve`. If `resolve` throws, skip. If it returns a thenable,
`lookupSync` skips that provider (treat as not sync) and `lookup` awaits it.
A result is successful when it is a non-null object with a non-empty `short`
or `long` string. Attach `providerId` if missing.

Default chain order (must be this unless the user reorders):

1. `inline`
2. `session`
3. `static`
4. `mdn`
5. `wiktionary`
6. `wikipedia`
7. `coined`
8. `llm` (disabled by default)

Providers not yet registered are simply absent from `list()`; the registry
must not crash if only a subset is registered.

## Built-in providers (task 1)

### inline (`src/inline-provider.js`)

`createInlineProvider()`.

- `canResolve`: `ctx.attrs` has a non-empty trimmed `def` (string).
- `resolve`: `short` = clipWords(def, 25), `long` = clipWords(def, 120),
  `source` = 'Inline directive', `kind` = 'standard', `url` = null,
  `firstUse` = null, `providerId` = 'inline'.

### session (`src/session-glossary.js`)

`createSessionProvider(registry)` — it reads uses from the same registry
(`firstUse` / `usesFor`). The registry must be usable from the provider,
so construct the registry first, then register this provider, or allow
`createSessionProvider()` with a `bind(registry)` / pass the registry in ctx.

Preferred: `createSessionProvider()` and have `resolve`/`canResolve` use
`ctx.registry` which `lookup` must set to itself before walking the chain.
This avoids circular construction.

- `canResolve`: there is a previous use of this term in this session that
  has a non-empty `def`, OR a first-use quote exists (so the pane can still
  show "inferred from context" later — but session provider itself only
  succeeds when a stored `def` is non-empty).
- `resolve`: use the first stored non-empty def in this session. `source` =
  'Session glossary', `kind` = 'standard', `firstUse` = registry.firstUse(...).

`recordUse` is on the registry, not the provider. Each recorded use stores
`{ name, def, sessionId, source, at: incremental index, quote }`. `quote` is
`surrounding` if given, else the def, else the name.

### static (`src/static-glossary.js`)

`createStaticProvider(entries?)`.

Bundled default glossary (case-insensitive lookup): at least these terms,
short one-sentence defs (no quotes, braces, or newlines in the def text):

monoid, semigroup, idempotent, CRDT, backpressure, closure, currying,
memoization, debounce, throttle, referential transparency, side effect,
eventual consistency, vector clock, Merkle tree, CAP theorem, reentrancy,
soundness, variance, lifetime, borrow checker, continuation, trampoline,
type class, higher-kinded type, unification, narrowing, effect system,
orthogonal persistence, nonce.

- `canResolve`: term is in the bundled map or in `ctx.userGlossary`.
  User entries override bundled ones.
- `resolve`: `source` = 'User glossary' if it came from userGlossary, else
  'Static glossary'. `kind` = 'standard'.
- Export `DEFAULT_GLOSSARY` as an array of `{ term, def }`.
- Export `lookupGlossary(term, entries)` helper if useful.

## Tests for task 1 (`test/providers.test.js`)

Must cover, at minimum:

1. `normalizeTerm` / `clipWords` (including already-short text, exact limit, and cut).
2. Registry order, `setOrder`, `setDisabled`, `list`, missing providers tolerated.
3. Fallback: if inline cannot resolve, session/static is used.
4. Disabled provider is skipped.
5. Per-session cache: second `lookup` does not call `resolve` again (use a
   counting fake provider). Different sessions do not share a cache entry.
6. Failed / throwing providers are skipped; the next one can win.
7. `null` results are not cached.
8. `lookupSync` ignores a provider that returns a Promise.
9. Inline reads `attrs.def`, trims, rejects empty.
10. Session records first use and later uses; first def wins; uses are
    session-scoped.
11. Static finds bundled terms case-insensitively; userGlossary overrides;
    unknown terms do not resolve.
12. `canResolve` / `resolve` throwing does not break `lookup`.

All tests must pass with `npm test`.

## What task 1 must not do

Do not write plugin.js, network providers, docs, the skill, or Python files.
Do not import `@hermes/plugin-sdk`.

## Network and backend providers (task 2)

Create ONLY these files:

- src/wiki-provider.js
- src/mdn-provider.js
- src/coined-provider.js
- src/llm-provider.js
- test/network-providers.test.js

Do not modify existing src/ or test/ files except if a truly necessary bugfix in
the registry is required (prefer not to). Do not add npm dependencies.

All network calls go through `ctx.fetch` (required). Never call the global
`fetch` so tests can stub it. If `ctx.fetch` is missing, `canResolve` is false
(except `llm`, which uses `ctx.rest`). Timeouts: pass
`{ signal: AbortSignal.timeout(4000) }` when `AbortSignal.timeout` exists, else
no signal. On HTTP errors, non-JSON, or thrown fetch, return null / do not
resolve.

If `ctx.fetch` fails (throws) and `ctx.rest` is a function, fall back once to:

```
ctx.rest('/lookup?source=SOURCE&term=' + encodeURIComponent(term))
```

where SOURCE is `wikipedia`, `wiktionary`, or `mdn`. The rest payload, when
successful, is a JSON object already in Definition shape (`short`, `long`,
`source`, `kind`, `url`, …). Use it as the result (still clip short/long).
A rest throw or a non-success payload means the provider returns null.

### wikipedia (`createWikipediaProvider()`)

GET `https://en.wikipedia.org/api/rest_v1/page/summary/` + encodeURIComponent(term)
with header `Accept: application/json`.

- 200 with `type` of `disambiguation` or `disambig`: return null.
- 200 with a non-empty `extract` string: success.
  - `short` = clipWords(extract, 25)
  - `long` = clipWords(extract, 120)
  - `source` = 'Wikipedia'
  - `kind` = 'standard'
  - `providerId` = 'wikipedia'
  - `url` = `content_urls.desktop.page` if present, else
    `https://en.wikipedia.org/wiki/` + encodeURIComponent(title or term)
- otherwise null.

`canResolve`: `typeof ctx.fetch === 'function'` or `typeof ctx.rest === 'function'`,
and the term is non-empty after normalize. (Actual 404 is handled in resolve.)

`label`: 'Wikipedia'

### wiktionary (`createWiktionaryProvider()`)

GET `https://en.wiktionary.org/api/rest_v1/page/definition/` + encodeURIComponent(term)
with header `Accept: application/json`.

The JSON is `{ "en": [ { partOfSpeech, definitions: [ { definition } ] } ] }`
(other language keys may exist). Prefer the `en` array; if missing, use the
first present language array. `definition` may contain HTML — strip tags with a
simple replace (`/<[^>]+>/g` → ''), decode `&amp; &lt; &gt; &quot; &#39;` only,
collapse whitespace.

Use the first remaining non-empty definition text.

- `short` = clipWords(text, 25), `long` = clipWords(text, 120)
- `source` = 'Wiktionary', `kind` = 'standard', `providerId` = 'wiktionary'
- `url` = `https://en.wiktionary.org/wiki/` + encodeURIComponent(term)

`canResolve` / rest fallback: same pattern as Wikipedia, source `wiktionary`.
`label`: 'Wiktionary'

### mdn (`createMdnProvider()`)

GET `https://developer.mozilla.org/api/v1/search?q=` + encodeURIComponent(term)
+ `&locale=en-US` with header `Accept: application/json`.

Use `documents[0]` only when its `title` equals the term case-insensitively, OR
the title starts with the term followed by a space or end (e.g. term `fetch`
matches `fetch` or `fetch()` or `Fetch API`), OR there is a document whose
title match is exact after stripping `()` and punctuation. If nothing is a
reasonable match, return null (do not take an unrelated first hit).

`summary` is the definition text. `mdn_url` is a path like
`/en-US/docs/Web/API/fetch` — url is `https://developer.mozilla.org` + mdn_url.

- `source` = 'MDN', `kind` = 'standard', `providerId` = 'mdn'
- `canResolve` / rest fallback: same pattern, source `mdn`.
- `label`: 'MDN'

### coined (`createCoinedProvider()`)

Last-resort. Never invent a definition of the term itself.

`canResolve`: the term is non-empty AND (`ctx.registry` has a firstUse for this
term in this session, OR `ctx.fetch` or `ctx.rest` is available so existence
can be checked).

`resolve`:

1. Check Wikipedia and Wiktionary existence with the same URLs as those
   providers (via `ctx.fetch`, and rest fallback with those sources). If
   either returns a usable standard extract/definition, return null — a
   standard source exists, this provider should not invent or shadow it.
2. If both miss (404 or empty or disambiguation) or cannot be reached:
   - If `ctx.registry.firstUse(term, sessionId)` has a quote, return
     `kind: 'coined'`, `source: 'First use in session'`, `providerId: 'coined'`,
     `url: null`, `firstUse: { quote, sessionId }`,
     `short` = clipWords(quote, 25),
     `long` = `'inferred from context. ' + clipWords(quote, 120)` (the label
     "inferred from context" must appear in `long`).
   - Else return `kind: 'uncertain'`, `source: 'Not found'`,
     `short` and `long` = 'No definition found in the glossary or Wikipedia/Wiktionary.',
     `providerId: 'coined'`, `url: null`, `firstUse: null`.

`label`: 'Coined-term fallback'

### llm (`createLlmProvider()`)

Disabled by default at the registry (already in DEFAULT_DISABLED). This
provider itself always can be constructed; the registry keeps it off.

- `canResolve`: `typeof ctx.rest === 'function'` and term is non-empty.
- `resolve`: `await ctx.rest('/define', { method: 'POST', body: { term, sessionId: ctx.sessionId ?? null, surrounding: ctx.surrounding ?? null } })`.
  On throw or a payload that is not a success Definition, return null.
  Clip short/long. `source` defaults to 'LLM', `kind` defaults to 'uncertain',
  `providerId` = 'llm'. Never call fetch. Never invent a payload client-side.
- `label`: 'LLM (backend)'

## Tests for task 2

`test/network-providers.test.js` must cover, with a fake `ctx.fetch` (and
`ctx.rest` where relevant), at least:

1. Wikipedia success maps extract to short/long/url; disambiguation is null;
   404 is null; thrown fetch with rest fallback uses the rest payload;
   thrown fetch and no rest is null; missing fetch and no rest → canResolve false.
2. Wiktionary success strips HTML and decodes entities; missing en uses another
   language; empty is null.
3. MDN accepts an exact or close title match and rejects an unrelated first hit.
4. Coined: both wikis miss + firstUse quote → kind coined, long contains
   "inferred from context", short/long come from the quote (no invented def).
   Either wiki hits → resolve returns null.
   Both miss, no firstUse → kind uncertain, fixed "No definition found..." text.
5. LLM: no rest → canResolve false; rest success is clipped and tagged llm;
   rest throw → null.
6. A registry with all eight providers (task 1 + task 2) walks the default
   order: inline wins when def is present; with inline disabled and no session
   def, static can win; with those empty, a stub wiki fetch can win; llm is
   disabled by default so it is not called.

Do not hit the real network. All tests must pass (`npm test`, including task 1).

## Plugin factory and UI (task 3)

Create ONLY these files:

- src/plugin-factory.js
- test/plugin-factory.test.js

Do not modify existing src/ or test/ files, package.json, README.md, SPEC.md,
or .gitignore. No npm dependencies. No ~/.hermes install. No git push.

`src/plugin-factory.js` is plain ESM that imports other `./` modules and
exports factory functions. It must not import `@hermes/plugin-sdk`, `react`,
or Node built-ins. All SDK pieces are injected as arguments, the same way the
spike's `createPlugin` worked, so tests can run under Node.

### `createDefaultRegistry()`

Constructs a registry, then registers, in any insertion order (the registry's
default chain order is what matters):

inline, session (via ctx.registry; also bind if you want), static, mdn,
wiktionary, wikipedia, coined, llm.

Returns the registry.

### `createPlugin(deps)`

`deps` (all injected):

```
{
  host, jsx, jsxs, atom, useValue,
  Tip, Button, ScrollArea, EmptyState, Badge, Switch, Separator,
  registry,          // optional; default createDefaultRegistry()
  fetch,             // optional; default: globalThis.fetch if it is a function
}
```

Constants to export (and also return from the plugin object):

- PLUGIN_ID = 'concept-links'
- PANE_ID = 'glossary'
- SETTINGS_PANE_ID = 'providers'
- DIRECTIVE_NAME = 'term'
- HOVER_DELAY_MS = 650

`register(ctx)` must register all of the following (and only these):

1. Transcript directive
   - id: 'term'
   - area: 'transcript.directives'
   - data: { name: 'term', render: renderTerm }

2. Concepts pane
   - id: 'glossary'
   - area: 'panes'
   - title: 'Concepts'
   - data: { placement: 'right', width: '340px' }
   - render: renderPane

3. Providers pane (second pane, so closing Concepts does not disable the plugin)
   - id: 'providers'
   - area: 'panes'
   - title: 'Concept providers'
   - data: { placement: 'right', width: '340px' }
   - render: renderSettings

4. Palette command
   - area: 'palette'
   - data: { id: 'open-concepts', label: 'Open concepts pane', keywords: ['concept', 'term', 'glossary', 'definition'], run: () => reveal glossary pane if host.revealPane is a function }

On register, if `ctx.storage` exists:

- read `providerPrefs` (fallback `{}`) with shape `{ order?: string[], disabled?: string[] }`
  and apply with `setOrder` / `setDisabled`. If `disabled` is absent, keep the
  registry default (llm disabled). If `disabled` is present (including `[]`),
  use it as the full disabled set.
- read `userGlossary` (fallback `[]`) and keep it in a plugin-local variable
  that is passed as `ctx.userGlossary` to lookups.

Shared state:

- `$selectedTerm = atom(null)` — `{ name, sessionId, definition }` or null.
  `definition` is a Definition object (or null while loading).
- Optionally `$prefsTick = atom(0)` (or similar) so the settings pane
  re-renders after a reorder; tests can use `useValue` on whatever you pick.

### renderTerm({ attrs, source, streaming, sessionId })

Untrusted attrs: only trimmed strings. If `name` is empty, return
`jsx('span', { children: source })`.

Otherwise:

1. `registry.recordUse({ name, def: attrs.def, sessionId: sessionId ?? null, source, attrs })`.
2. `sync = registry.lookupSync(name, lookupCtx)` where lookupCtx includes
   `sessionId`, `attrs`, `source`, `userGlossary`, `fetch` (and `rest: ctx.rest`
   if it was captured at register time — store a reference).
3. Build a Tip:
   - `delayDuration` = 650
   - `label` is a short tooltip node: the sync short text (or def, or 'No definition yet'),
     the source if present, and a coined badge (`jsx(Badge, { children: 'coined' })`)
     when `sync?.kind === 'coined'`. If Tip label must be a React node, use
     `jsxs('div', { children: [...] })`. If there is no sync result and no def,
     still render the chip; the label may be 'No definition yet'.
   - children: exactly one `jsx('button', { type: 'button', onClick, className, children: name })`.
     className should be an underline-dotted utility string, no hardcoded colors
     (e.g. `'cursor-pointer underline decoration-dotted underline-offset-2'`).

4. onClick:
   - `$selectedTerm.set({ name, sessionId: sessionId ?? null, definition: sync })`
   - if `typeof host?.revealPane === 'function'`, call
     `host.revealPane('concept-links:glossary')`. Missing revealPane must not throw.
   - then start `registry.lookup(name, lookupCtx)` (may return a Promise). When
     it settles to a Definition, update `$selectedTerm` only if the still-selected
     name is this term (do not clobber a later click). Errors are swallowed.

### renderPane()

Hook: `const selected = useValue($selectedTerm)`.

If no selected term: `jsx(EmptyState, { title: 'No concept selected', description: 'Click a dotted term in the chat to see it here.' })`.

Else a ScrollArea whose children include (as plain elements / kit components):

- The term name
- A Badge 'coined' when definition.kind === 'coined', and 'uncertain' when kind === 'uncertain'
- The long text (definition.long or definition.short or 'No definition yet')
- Which provider answered: definition.source and definition.providerId
- First use: definition.firstUse.quote, or registry.firstUse(name, sessionId)?.quote, labelled clearly
- All uses in the session from registry.usesFor(name, sessionId), listed in order (at least the quote or the def or the name for each)
- A Button that clears the selection (`$selectedTerm.set(null)`), children 'Clear'

### renderSettings()

`useValue` something so tests can re-render after changes.

List `registry.list()` in current order. For each provider show:

- `provider.label` (and id)
- A Switch: checked when NOT disabled. `onCheckedChange` / `onChange` / `checked` —
  support both `onCheckedChange(boolean)` (kit) and a fallback `onClick` that
  toggles, so a simple mock works. Toggling updates `setDisabled` to the new
  full set (remember llm should stay disabled unless the user enables it).
  Persist prefs to `ctx.storage.set('providerPrefs', { order, disabled })` when
  storage exists.
- A Button 'Up' and a Button 'Down' to move the provider in the order (no-op at
  ends). Persist the new order.

Do not invent other settings UI.

### Tests (`test/plugin-factory.test.js`)

Use the same mock style as a typical jsx tree: `jsx/jsxs = (type, props) => ({ type, props })`,
function components for Tip/Button/etc, an atom mock with get/set/subscribe, useValue = store.get().
A helper to walk the tree is fine.

Must cover:

1. createDefaultRegistry lists eight providers in the default chain order;
   llm is disabled; lookupSync can resolve a bundled static term (e.g. monoid)
   with no attrs.
2. register() contributes the term directive, glossary pane, providers pane
   (both area 'panes', placement 'right', width '340px'), and the palette
   command. Palette run calls revealPane('concept-links:glossary') when present.
3. renderTerm with name+def: Tip delayDuration is 650, child is a single
   button whose children is the name; click sets $selectedTerm and calls
   revealPane('concept-links:glossary'); recordUse was called (usesFor length
   >= 1). Click without revealPane still sets state and does not throw.
4. renderTerm without a name returns a span of the source text.
5. Tooltip label includes the short definition (inline def) and, when the
   definition kind is coined, a Badge with children 'coined'. You can force
   coined by pre-recording a first use, disabling inline/session/static/mdn
   /wiktionary/wikipedia (so coined wins on lookupSync if it can), or by
   injecting a tiny stub provider — prefer a realistic path: disable every
   provider except coined, record a first-use quote, no fetch, then render
   a term with no def.
6. Pane: empty state when nothing selected; after a selection with a
   definition, the tree contains the name, the long text, the source or
   providerId, and a Clear button that nulls the selection. When uses exist,
   they appear. After click, if lookup resolves later with a richer
   definition, the selected term updates (use a fake async provider).
7. Settings: toggling a Switch (onCheckedChange(false) or onClick) disables
   that provider and, when ctx.storage is present, writes providerPrefs.
   Up/Down changes order and persists. register() reads providerPrefs and
   userGlossary from storage and applies them (e.g. pre-seed storage with
   disabled:['static'] and a userGlossary entry, then a lookupSync of that
   user term works and static bundled terms are skipped if you also disable
   nothing else... actually if only static is disabled, user glossary is
   still served by the static provider — user glossary is an input to static.
   So to test storage apply: seed order that puts static first, or disable
   'llm' and 'mdn', and assert isDisabled/list order).
8. Closing risk: two panes are registered, not one.

All existing tests plus these must pass under `npm test`.

## Skill, providers table, and Python half (task 4)

Create ONLY these files:

- docs/providers.md
- skills/concept-links/SKILL.md
- plugin.yaml
- __init__.py
- dashboard/plugin_api.py

Do not modify existing src/, test/, package.json, README.md, SPEC.md, or
.gitignore. No npm dependencies. No ~/.hermes install. No git push.

### skills/concept-links/SKILL.md

YAML frontmatter:

```yaml
---
name: concept-links
description: >
  Mark dense technical terms in assistant replies with the ::term directive so
  Hermes Desktop can show a hover definition and a Concepts pane. Use in any
  technical or coding explanation that introduces specialised vocabulary.
---
```

Body must tell the agent to emit mid-sentence directives of the form:

```
::term{name="monoid" def="A set with an associative operation and an identity element"}
```

Rules (all of these):

- `name` is the term as the reader should see it. `def` is one plain sentence,
  at most about 25 words, under about 150 characters.
- Put a space or a line start before `::term`. Do not glue it to punctuation
  such as `(` or `"`.
- Only dense, specialised terms a reader may not know. Never everyday words.
- First mention only, at most 8 terms per reply.
- Never put a directive inside a code fence or inline code.
- Keep `def` quote-safe: wrap values in double quotes; do not put `"`, `{` or
  `}` inside the definition; no backslash escapes.
- If a paragraph is already very long, skip it (the host drops directives in
  paragraphs over 4800 characters).
- Write the definition for a reader who is smart but new to the topic.
- If you coined or introduced a term in this conversation, still tag the first
  mention. Prefer a short gloss of how you used it, not a made-up formal
  definition.

### plugin.yaml

Native Hermes plugin manifest:

- name: concept-links
- label: Concept Links
- kind: standalone
- version: 0.1.0
- author: Rohan Malik
- license: MIT
- description: one short paragraph about hover definitions and the Concepts pane
- provides_hooks: [transform_llm_output]
- requires_hermes: ">=0.23"
- no requires_env, no capabilities (do not request llm.* )

### __init__.py

`register(ctx)`:

1. `ctx.register_hook("transform_llm_output", hook)` with no hold_stream.
   The hook signature is `(response_text, session_id, model, platform, **kwargs) -> str | None`.
   It runs a mechanical annotator: wrap first mentions of known glossary terms
   (the same bundled terms as the static provider) in `::term{name= def=}`
   using the same quote-safety, fence/inline-code/existing-directive skip,
   longest-term-first, paragraph 4800 and body 2048 limits described in the
   spike (whitespace-or-start only, so `(monoid)` is left alone). If nothing
   changes, return None (not the original string). Never raise.
2. If `ctx.register_skill` exists, register `concept-links` pointing at
   `skills/concept-links/SKILL.md` with a short description.

Export `annotate_terms(text, glossary=None) -> str | None` so it can be tested
by importing the module.

The glossary used by the hook must include at least the bundled term set from
`src/static-glossary.js` (copy the terms and defs into a Python list in this
file; do not try to import the JS).

### dashboard/plugin_api.py

FastAPI `router = APIRouter()`.

- GET `/lookup?source={wikipedia|wiktionary|mdn}&term=...`
  Proxies the same public REST URLs the JS providers use. Timeout 4 seconds.
  User-Agent: `concept-links-hermes-plugin/0.1 (local Hermes Desktop plugin)`.
  Accept: application/json. Map a successful payload into a Definition-shaped
  JSON object (`short`, `long`, `source`, `kind`, `providerId`, `url`,
  `firstUse: null`) using the same clipping and matching rules in spirit
  (clip short to 25 words, long to 120; Wikipedia disambiguation → 404;
  MDN unrelated first hit → 404; Wiktionary strip tags). 400 on a bad source
  or empty term. 404 when there is no definition. Never follow this with an
  invented definition.
- GET `/glossary` — `{ "entries": [ { "term", "def" }, ... ] }` of the bundled
  glossary.
- POST `/define` — JSON body `{ term, sessionId?, surrounding? }`. Do **not**
  call an LLM. Respond 501 with
  `{ "ok": false, "reason": "not configured" }`.
  The JS llm provider treats a non-Definition payload as a miss.

Use only the Python standard library plus FastAPI/HTTPException (already
available in the Hermes gateway). Use urllib or stdlib to fetch. No new
dependencies. Do not log the term's surrounding text in a way that would
ship conversation content off-box other than the lookup URL itself
(Wikipedia/Wiktionary/MDN).

### docs/providers.md

A rich but accurate markdown document with a table of every provider
considered, with columns:

| Provider | Possible under the SDK? | Implemented? | Latency | Cost | Risks |

Rows must include: inline, session glossary, static/user glossary,
Wikipedia, Wiktionary, MDN, coined-term fallback, LLM backend, docs/codebase
index, and the Python `transform_llm_output` annotator hook.

Be honest:

- Latency: sync providers are effectively 0 ms; network providers are one
  HTTP request with a 4s timeout (do not invent benchmark numbers; say
  "one HTTP request, 4s timeout").
- Cost: all implemented providers are free except a future LLM route, which
  would be one model call per unresolved term and is **not** live (POST
  /define returns 501, and the llm provider is disabled by default).
- Wikipedia/Wiktionary/MDN are implemented in JS via `ctx.fetch` with
  `ctx.rest` fallback to this Python proxy, because direct renderer fetch
  may be blocked by CORS or CSP. Mark that risk.
- docs/codebase index is **possible only later**: there is no SDK docs
  index; `ctx.files.requestFolder()` could grant a folder but we did not
  build an indexer. Status: not implemented, with that reason.
- LLM: possible via `ctx.rest` + `plugin_api` or `ctx.llm` (would need a
  declared capability). Not implemented as a live completion.
- Mention the 4800-character paragraph cap, 2048-character attribute body
  cap, quote-unsafe attrs, raw `::term` text on CLI/TUI/messaging, mid-prose
  docs vs live source disagreement, and that a skill-emitted directive is
  what makes inline links appear (a desktop plugin cannot rewrite unmarked
  chat). The hook is the automatic layer, without hold_stream, so users may
  briefly see unlinked text then a rewrite.
- Default chain order and that llm is disabled by default.
- Cache is in-memory, per session.
- Hover delay is 650 ms (Wikipedia page-preview convention).
- Coined terms never get an invented definition; the pane shows the first-use
  quote labelled "inferred from context".

No market-research or product-comparison content beyond what is needed to
explain these providers.

## Desktop bugfix (task 5) — three live bugs

The plugin was tested in real Hermes Desktop (screenshots under
`/tmp/computer-use/`, launch log `/tmp/hd.log`). Fix the three bugs below
in the plugin. Do not modify Hermes Desktop itself. Do not install into
`~/.hermes`. Do not add npm dependencies. Do not git push.

### Bug 1 — mid-sentence `::term` renders as separate blocks

**Root cause (host, not our chip):** in the installed source

`/home/box/.hermes/hermes-agent/apps/desktop/src/components/assistant-ui/markdown-text.tsx`
(the `MarkdownParagraph` function, around lines 616–630), a paragraph that
contains a claimed directive is *split*. Each prose run becomes its own
`<p>`, and each directive is a sibling `TranscriptDirectiveLeaf`. The
comment even says a sentence that ends in a directive is "its sentence
followed by the card". There is no inline flag on
`TranscriptDirectiveContribution` (`transcript-directives.ts`). ContribBoundary
`variant="chip"` does not put the leaf back inside the `<p>`.

So even if our render returns an inline `<button>` or `<span>`, the host
still breaks "A ::term{...} lets you ... ::term{...} maps over it." into:

```
A
monoid
lets you fold a list in any grouping, and a
functor
maps over it.
```

That is what the Desktop test showed. We cannot change the host. The
feasible workaround is a **paragraph-level directive** whose body is the
whole sentence, so the paragraph is exactly one claimed directive and the
host renders "the card alone". Our render then draws one `<p>` (or a
single block element with the same paragraph class) containing inline
chips and the surrounding words.

#### `src/termline.js`

Export:

- `MARKER_OPEN = '[['`
- `MARKER_SEP = '|'`
- `MARKER_CLOSE = ']]'`
- `parseTermline(value)` → `{ pieces: Array<{kind:'text', text:string}|{kind:'term', name:string, def:string}>, sentence: string }`
  `sentence` is the pieces joined with each term replaced by its `name` (the
  readable sentence, no markers).
- `formatTermline(pieces)` → the encoded string (inverse of parse, for tests
  and docs). Terms become `[[name|def]]`.
- `sanitizeTermlinePart(s)` — strip `|`, `[`, `]`, `{`, `}`, `"`, `'`,
  backslashes and newlines from a name or def so the marker encoding and
  the directive attr body stay valid.

A text piece that is empty may be omitted. Parsing is greedy on `[[...]]`.
A `[[` without a matching `]]` is left as text. If there is no `|`, the
inside is the name and `def` is `''`.

#### Directive `termline`

Register a second transcript directive, `name: 'termline'`, alongside `term`.

`renderTermline({ attrs, source, streaming, sessionId })`:

- Read `attrs.v` (or `attrs.text`) as the encoded sentence. If empty,
  return `jsx('span', { children: source })`.
- `parsed = parseTermline(value)`.
- For each term piece, `recordUse({ name, def, sessionId, source, surrounding: parsed.sentence })`
  but **not while `streaming` is true**. Registry dedupe (below) still
  applies so later re-renders of the settled message do not triple-count.
- Return a single `jsx('p', { className: same paragraph-ish wrap class, children })`
  whose children are text nodes/spans and the same Tip-wrapped inline chips
  used by `renderTerm` (delay 650, underline-dotted, click selects +
  `revealPane('concept-links:glossary')` + async lookup). The chip element
  must be inline (`button` with a class that includes `inline`, or a
  `span` with `role="button"` and keyboard click). Do not wrap the sentence
  in a `div` that is only the chip.

Keep `::term{name= def=}` working for mid-sentence use (old chats, a model
that ignores the skill). It will still split in this Desktop build; that is
the host's behaviour. document it in a short comment above `renderTerm`.
Still record uses (when not streaming), but pass `surrounding` only if we
have a real sentence — never use the definition as the quote.

### Bug 2 — "First use" / "Uses" show the definition, three times

**Root cause (ours):** `recordUse` in `src/providers.js` falls back to `def`
(then `name`) when `surrounding` is missing. `renderTerm` calls
`recordUse` on every render and passes `source` (the raw `::term{...}`
string) but no `surrounding`. The pane then prints `definition.firstUse.quote`
or `use.quote`, which is the definition text. Because `recordUse` is a
side effect of render, streaming re-renders and the settle flip record the
same occurrence three times.

Fixes in `createRegistry().recordUse`:

- `quote` is `surrounding` when that is a non-empty string. Do **not** fall
  back to `def`. If there is no surrounding, `quote` is `null` (the pane
  must not display a "First use" / use line for a null quote).
- **Dedupe** when `source` is a non-empty string: if this session already
  has a use of the same normalised name whose `source` is identical, or
  one is a prefix of the other (streaming grew the directive), do not push
  a new use. Update the existing record's `def` / `surrounding` / `quote`
  / `source` when the new one is more complete (longer source, or a
  surrounding that the old one lacked). Return the existing record.
- When `source` is missing, keep recording a new use each call (existing
  tests that record several uses without a source stay valid, except any
  that asserted `quote === def` — update those: without surrounding, quote
  is null).
- `renderTerm` / `renderTermline` must not call `recordUse` while
  `streaming === true`.

Pane copy:

- "First use in this session: {sentence}" only when there is a real quote
  (the surrounding sentence, not the definition). Prefer
  `registry.firstUse(...)?.quote` if it is a sentence; do not show
  `definition.firstUse.quote` when that quote equals the definition text.
- "Uses in this session" lists unique quotes (or unique uses after
  registry dedupe). Do not list the definition three times. Skip uses
  whose quote is null.

### Bug 3 — "Concept providers" pane never appeared

The second pane was registered (`id: 'providers'`, area `panes`,
placement `right`), but the Desktop test only showed tabs Widget Control,
Notes, and Concepts. The palette command was "Open concepts pane" and
did not mention providers, so even if the palette worked it would not
open settings. Likely the host only tabs a plugin pane once it has been
revealed (Concepts appeared after `revealPane` on click; providers was
never revealed).

Make settings reachable even if the second pane never tabs:

- Put a **Providers** section inside the Concepts pane itself: the list
  of providers with Switch + Up/Down, the same as `renderSettings` today.
  It must be visible both when a term is selected (below the term, after
  a Separator) and when nothing is selected (below the EmptyState). Reuse
  the same toggle/reorder/persist logic; do not duplicate it poorly —
  extract a `providerRows()` helper used by both the section and the
  standalone providers pane.
- Keep registering the standalone providers pane (so the plugin still has
  two panes, against the one-pane-close-disables-plugin risk).
- Palette: keep "Open concepts pane". Add a second palette command
  "Concept provider settings" (`id: 'open-provider-settings'`, keywords
  including `provider`, `settings`, `glossary`) that calls
  `host.revealPane('concept-links:glossary')` and, if `host.revealPane` and
  `host.undismissPane` exist, also reveals/undismisses
  `concept-links:providers`. Feature-detect; missing methods must not
  throw. Give each palette contribution a top-level `id` as well as
  `data.id`.

### Tests

Update existing tests that assumed `quote` falls back to `def` or `name`.
Add tests (in `test/termline.test.js` and/or the existing test files) for:

1. `parseTermline` / `formatTermline` round-trip, a sentence with two terms,
   unmatched `[[`, a term with no def, sanitise.
2. `renderTermline` returns a single `p` whose children include the prose
   and two Tip/chips in order, not a stack of block wrappers. Click on a
   chip still sets `$selectedTerm` and reveals the glossary pane.
3. `recordUse` with the same `source` (and a streaming prefix of that
   source) does not grow `usesFor`. A missing `source` still adds a new
   use. Quote comes from `surrounding`, not `def`.
4. `renderTerm` with `streaming: true` does not record a use; a later
   `streaming: false` render records one; a third render does not add
   another.
5. The Concepts pane shows the surrounding sentence under First use / Uses,
   not the definition, and only once. When quote is null, those lines are
   absent.
6. The Concepts pane contains the Providers section (labels, Switch, Up,
   Down) even when no term is selected. The standalone providers pane is
   still registered. Two palette commands exist; the settings one reveals
   the glossary pane (and providers when revealPane is present).

`npm test` must stay all-green (existing suites included).

### Files for task 5 (only these)

- src/termline.js          (new)
- src/providers.js         (modify)
- src/plugin-factory.js    (modify)
- test/termline.test.js    (new)
- test/providers.test.js   (modify)
- test/plugin-factory.test.js (modify)

Do not modify skill, Python, docs, desktop/plugin.js, package.json, SPEC.md,
or README in this task. Those follow in a later task after this one is green.

## Skill and annotator follow-up (task 6)

Update the skill and the Python mechanical annotator so they emit the
paragraph-level `::termline` workaround, not mid-sentence `::term`. Mid-sentence
`::term` still renders in Desktop but splits the sentence into blocks (see
task 5). Also note the three Desktop bugfixes briefly in `docs/providers.md`.

Create or modify ONLY these files:

- skills/concept-links/SKILL.md
- __init__.py
- docs/providers.md

Do not modify src/, test/, desktop/, package.json, SPEC.md, plugin.yaml, or
dashboard/plugin_api.py. No npm/Python dependencies. No ~/.hermes install. No
git push.

### skills/concept-links/SKILL.md

Keep the existing frontmatter (name, description) but extend the description
so it mentions `::termline` for technical answers.

The body must tell the agent that in Hermes Desktop a mid-sentence
`::term{name= def=}` is lifted out of the sentence and shown as a separate
block. To keep the sentence together, the **entire paragraph** must be a
single `::termline` directive, with no prose before or after it on that
paragraph.

Syntax (the attribute body cannot contain `{`, `}`, `"`, or the marker
characters `[`, `]`, `|`):

```
::termline{v="A [[monoid|A set with an associative operation and an identity element]] lets you fold a list in any grouping, and a [[functor|A mapping between categories that preserves structure]] maps over it."}
```

Rules:

- The paragraph is only the directive. Do not put other text on that
  paragraph, or Desktop will split it.
- Wrap each dense term as `[[name|def]]` inside `v`. `name` is the word as
  the reader should see it. `def` is one plain sentence, at most about 25
  words and under about 150 characters.
- `v` is wrapped in double quotes. Do not put `"`, `{`, `}`, `[`, `]`, `|`
  or backslashes inside a name or a definition (rephrase instead).
- First mention only, at most 8 terms per reply, only dense specialised
  terms, never inside a code fence or inline code, skip a paragraph that is
  already very long (host drops directives in paragraphs over 4800
  characters, and the attribute body cap is 2048).
- Write definitions for a reader who is smart but new to the topic. If you
  coined a term, prefer a short gloss of how you used it, not a made-up
  formal definition.
- Do not use mid-sentence `::term{name= def=}` in Desktop replies. That form
  still exists for older messages, but it breaks the sentence into blocks.

### __init__.py

Change `annotate_terms` so that, for each prose paragraph that contains
bundled glossary terms, it replaces the **entire paragraph** with one
`::termline{v="..."}` (markers `[[name|def]]`, first mention only, max 8
terms across the reply, skip fences / inline code / existing directives,
longest-term first, whitespace-or-start only so `(monoid)` is left alone).

If the resulting directive body would exceed 2048 characters, or the
paragraph exceeds 4800, leave that paragraph unmarked. Do not fall back to
mid-sentence `::term`. If nothing changes, return None. Never raise.

Keep `register`, `_hook`, and `GLOSSARY`. You may add small helpers in this
file (sanitise, format). Export `annotate_terms` as today.

If a user later verifies: a short sentence containing monoid (not in a
fence) is rewritten as a `::termline` whose `v` contains `[[monoid|` and
does not contain mid-sentence `::term{`. A fenced monoid is left alone
(returns None).

### docs/providers.md

Add a short "Desktop layout" note (a subsection is fine): mid-sentence
`::term` is split into block siblings by the host
(`markdown-text.tsx` `MarkdownParagraph`); the workaround is a paragraph
that is only `::termline{v=...}`; the Concepts pane now shows the surrounding
sentence (once) rather than the definition, and provider settings live in
the Concepts pane as well as the standalone providers pane and a palette
command. Do not invent other behaviour. Do not add market-research content.

## Desktop bugfix (task 7) — termline rendered as a plain un-chipped sentence

### Diagnosis (already established; do not re-investigate, do not patch Desktop)

A Desktop retest of `::termline` in session "Reproduce exact paragraph with termline syntax" (id `local-ef3a22774c654e6c639784a3b5ad87428b8d82a05febffabd48e776e8c29121d`, ~13:58 IST on 2026-11-10) showed the assistant reply as one plain line:

> A monoid lets you fold a list in any grouping, and a functor maps over it.

No dotted chips, no 650 ms tooltip, and a click did nothing (Concepts stayed on "No concept selected"). The Providers section and both palette commands still worked.

Layer check, all read-only against `~/.hermes/state.db` and logs:

- **(a) Model stripped the markup: no.** The stored assistant `content` is still the full 212-character string `::termline{v="A [[monoid|A set with an associative operation and an identity element]] lets you fold a list in any grouping, and a [[functor|A mapping between categories that preserves structure]] maps over it."}` (ASCII `[[`, `|`, `]]`, `v="..."`). Model was Opus 4.6, `finish_reason=stop`.
- **(b) `transform_llm_output` stripped or rewrote it: no.** The hook runs before persist. The stored row still has the markup, so the annotator did not drop it.
- **(c) Host `segmentTranscriptDirectives` / `parseAttrs` cannot parse `[[`, `|`, or the quoting, on the stored raw string: no.** Run on that exact string, the host regex yields `name=termline` and `attrs.v` with the markers intact. No concept-links or termline errors in `desktop.log` / `gateway.log` / `errors.log` around 13:58 (the 13:57:52 svg `height="auto"` lines are the Board Smoke widget; earlier 500s are `home-dashboard`).
- **(d) Our render produced the visible sentence without chips.** The on-screen text is exactly `parseTermline(v).sentence`. Given that same `v`, `renderTermline` *does* build Tip/button chips in unit tests and in a `renderToStaticMarkup` check. So the live path either handed our render a `v` that no longer contained `[[name|def]]` (a chip-less `<p>` of the sentence), or the chips did not present as clickable dotted terms.

The host's directive restore (markdown-preprocess.ts `liftDirectives`) backslash-escapes every inline markdown metachar in a directive body, including `[` and `]`. The parser therefore receives `\[\[monoid|def\]\]`. That is the same byte pattern as LaTeX display math `\[...\]`. `[[` / `]]` inside `v` is a fragile encoding on this host: if escapes are left in place, `parseTermline` looks for literal `[[` and will not match (`\[\[` has no consecutive `[[`); if some later stage collapses the span, `v` becomes the bare sentence and we render no chips. Do not patch Desktop. Change our encoding and harden the renderer.

Also: `decoration-dotted` is not present in the shipped Desktop `main-*.css` (while `underline` and `underline-offset-2` are). Chip appearance must not depend on that missing utility.

### What to implement

#### 1. Bracket-free termline encoding (`src/termline.js`)

Keep `parseTermline` / `formatTermline` / `sanitizeTermlinePart` working for the legacy `[[name|def]]` form, but:

- Export `unescapeTermlineValue(s)` that applies the same unescape the host's markdown parser is supposed to: replace `\\` followed by one of `` \`*_~[]<>$& `` with that character. (`MARKDOWN_INLINE_META_RE` in the host is `/[\\`*_~[\]<>$&]/g` with a `\\` prefix.)
- `parseTermline` must run that unescape on its input *before* scanning for markers, so a value like `A \[\[monoid|def\]\] works` still yields a monoid term chip and the sentence `A monoid works`.
- Add a second, preferred encoding that never puts `[`, `]`, or `|` in `v`:
  - `v` (or `text`) is the plain visible sentence, e.g. `A monoid lets you fold a list in any grouping, and a functor maps over it.`
  - `t` is a list of `name=def` pairs separated by `;;`, e.g. `monoid=A set with an associative operation and an identity element;;functor=A mapping between categories that preserves structure`. Split on `;;`, then on the first `=` in each pair. Trim. Skip empty names.
  - Export `parseTermList(t)` and `materializeTermline(attrs)` (names can vary slightly if documented in tests, but these two are preferred).
  - `materializeTermline({ v, text, t })` unescapes `v`/`text`, then: if `parseTermline` finds any term pieces, return that result (legacy messages). Otherwise walk the plain sentence and, for each `t` pair in order, chip the first remaining whole-word occurrence of `name` (case-insensitive match, chip label is the sentence's original spelling). If a name is not found, skip it. The returned `sentence` is the plain visible sentence.

`sanitizeTermlinePart` should still strip characters that would break a directive body (`{`, `}`, `"`, backslash, newlines) and, for safety, the legacy markers.

#### 2. `renderTermline` (`src/plugin-factory.js`)

- Build pieces with `materializeTermline(attrs)` (so both encodings work).
- If there is no `v`/`text` and no materializable content, keep today's fallback: a `span` of `source`.
- Do **not** wrap the line in a `<p>` (the host already treats a solo claimed directive as the card alone; a nested `<p>` is invalid in some wrappers). Use a `span` with `className` `PARAGRAPH_CLASS` and `style: { display: 'block' }` (or equivalent). Use `jsxs`, not `jsx`, because there are multiple children.
- Chip `<button>` style must include **inline** CSS so appearance does not depend on Tailwind utilities that may be missing from the Desktop bundle:

  `display: 'inline', padding: 0, margin: 0, border: 'none', background: 'none', font: 'inherit', color: 'inherit', cursor: 'pointer', textDecoration: 'underline dotted', textUnderlineOffset: '2px'`

  You may keep `CHIP_CLASS` in addition, not instead.
- Click, 650 ms `Tip`, `recordUse` with `surrounding: parsed.sentence`, streaming skip, and `attrs.text` remain as today.

#### 3. Sample sentence in the Concepts empty state

When no concept is selected, below the existing EmptyState (and above the Providers section), render a short heading or paragraph "Sample" and a `renderTermline` of this known-good payload, with `streaming: true` (so the sample is not recorded as a session use) and a stable `sessionId` such as `'sample'`:

- `v="A monoid lets you fold a list in any grouping, and a functor maps over it."`
- `t="monoid=A set with an associative operation and an identity element;;functor=A mapping between categories that preserves structure"`

Hover and click on those chips must work the same as chat chips (tooltip, `revealPane`, select the term). This is the model-independent retest surface.

#### 4. Annotator and skill

`__init__.py`: for a prose paragraph that mentions glossary terms, emit the new encoding, not `[[name|def]]` inside `v`. Example:

```
::termline{v="A monoid lets you fold a list in any grouping." t="monoid=An associative binary operation together with an identity element, such as addition with zero."}
```

Same rules as today (first mention only, max 8 terms, skip fences / inline code / existing directives / block markdown, 2048 body cap, 4800 paragraph cap, never raise, return None if nothing changes). The sentence in `v` must stay plain (no `[[` markers). `t` pairs use glossary names and definitions, `;;`-separated, in mention order. Reject a rewrite if `v` or `t` would include `"`, `{`, `}`, backslash, or newlines. Export `annotate_terms` as today.

`skills/concept-links/SKILL.md`: document `v` + `t` as the required form. Tell the model **not** to put `[[name|def]]` (or `{`, `}`, `"` ) in `v`. Keep `::termline` as a whole paragraph. You may mention mid-sentence `::term` only as a fallback the plugin still understands for old chats. Update the example to the monoid/functor sentence using `v` and `t`.

### Tests

In `test/termline.test.js` and/or `test/plugin-factory.test.js`:

- `unescapeTermlineValue` / `parseTermline` on `A \\[\\[monoid|def\\]\\] works` yields a monoid term and sentence `A monoid works`.
- Legacy `[[name|def]]` (unescaped) still parses as today.
- `materializeTermline` on `{ v: 'A monoid lets you fold, and a functor maps over it.', t: 'monoid=combines values;;functor=maps over a box' }` yields two term chips in order and that sentence.
- `renderTermline` with the `t` encoding: wrapper is a `span` (not `p`), two Tips/buttons, inline `textDecoration` includes `underline`, click still reveals `concept-links:glossary`.
- `renderTermline` with legacy `[[` in `v` still chips.
- Empty state of the Concepts pane includes the sample monoid and functor chips.

After writing, run `npm test` and this check, and do not finish until they pass:

```
python3 -m py_compile __init__.py
python3 -c "from pathlib import Path; import importlib.util; s=importlib.util.spec_from_file_location('cl', Path('__init__.py')); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); out=m.annotate_terms('A monoid lets you fold a list.'); assert out and '::termline{' in out and 'v=\"A monoid lets you fold a list.\"' in out and 't=\"monoid=' in out and '[[monoid|' not in out and '::term{' not in out.replace('::termline',''); assert m.annotate_terms('Here is code:\\n```\\nmonoid\\n```\\nDone.') is None; print('annotate-ok', out)"
```

### Files

Create or modify ONLY these files:

- src/termline.js
- src/plugin-factory.js
- test/termline.test.js
- test/plugin-factory.test.js
- __init__.py
- skills/concept-links/SKILL.md

Do not modify package.json, README.md, SPEC.md, .gitignore, docs, desktop/plugin.js, plugin.yaml, or dashboard/.
Do not add npm dependencies. Do not install into ~/.hermes. Do not git push or add a remote. Local commits are unnecessary.
Do not import @hermes/plugin-sdk, react, or Node built-ins from src/ (tests may import node:test and node:assert/strict).
Do not patch Hermes Desktop or write to ~/.hermes/state.db.

## Desktop bugfix (task 8) — annotator still leaves or emits mid-sentence `::term`

### Diagnosis (already established; do not re-investigate Desktop, do not patch it)

Desktop test 3: the Concepts pane **Sample** line (JS `::termline`) passes — chips, 650 ms tooltip, click-to-pane all work. The real-reply path fails: the assistant message is split into block siblings `'A' / 'monoid' / 'lets you fold a list...'`, which is the host `MarkdownParagraph` layout for mid-sentence `::term`.

Two cooperating causes, both in the Python annotator / hook, not in the JS renderer:

1. The first shipped annotator (still sitting in `~/.hermes/plugins/concept-links/__pycache__/__init__.cpython-314.pyc`, mtime 13:41 IST) wrapped glossary hits as mid-sentence `::term{name= def=}`. The long-running gateway may still be holding that module. The source in `__init__.py` was later changed to `::termline`, but that is not sufficient on its own.
2. Today's `_termline` returns `None` as soon as the paragraph contains `::`. So even with the new source loaded, a model that still emits mid-sentence `::term` (skill not followed) is left untouched, and the host splits the sentence.

### What to implement

#### `__init__.py` (the `transform_llm_output` annotator)

`annotate_terms` must rewrite every **prose** paragraph that contains linked terms into **one** paragraph-level directive, and leave everything else untouched.

Output encoding (same as the JS side parses via `materializeTermline` / `parseTermList`):

```
::termline{v="<plain paragraph text>" t="name=def;;name=def"}
```

`v` is the visible sentence with no `::term`, no `::termline`, and no `[[name|def]]` markers. `t` lists first-mention terms in appearance order, at most 8 across the whole reply.

Linked terms come from either or both of:

- Mid-sentence (or whole-paragraph) `::term{...}` already in the text. Strip each `::term{...}` out of the sentence, putting the `name` attr back as the visible word, and take `name` / `def` from the directive attrs (`name="..."` / `def="..."` or single quotes; missing `def` is fine). Do not treat `::termline` as a term to strip — a paragraph that is already a `::termline` is left unchanged.
- First whole-word mentions of bundled (or caller-supplied) glossary terms in the recovered plain sentence, skipping names already collected from `::term` in this reply.

Leave **untouched** (do not wrap, do not return a rewrite for that chunk):

- Fenced code blocks
- Headings, lists, block quotes, tables (same `_BLOCK` rule as today)
- Paragraphs with no glossary terms and no `::term`
- Paragraphs that are already a `::termline`
- Inline code (`...` in the paragraph): skip the paragraph rather than corrupting it
- Paragraphs over 4800 characters, or a resulting directive body over 2048 characters

Do **not** skip a prose paragraph merely because it contains `::term`. That is the bug.

**Escaping, consistent with `src/termline.js`** (add the JS helpers in the same task):

- In `t` parts, escape `\`, `;`, and `=` as `\\`, `\;`, `\=` so a definition may contain those characters; join pairs with `;;`; split on unescaped `;;` and the first unescaped `=`.
- Attribute quoting: prefer `v="..." t="..."`. If `v` or `t` contains `"`, use single quotes for both attrs if neither contains `'`. If both `"` and `'` would appear, strip `"` from the values rather than producing a body the host `parseAttrs` cannot read (the host has no escape inside quoted attrs). Never emit `{`, `}`, or raw newlines inside the body. If after sanitising there is nothing safe to emit, leave the paragraph unmarked.

`annotate_terms` still returns the rewritten full text, or `None` when nothing changed, and must never raise. Keep `register`, `_hook`, and `GLOSSARY`. `_hook` still calls `annotate_terms(response_text)`.

The exact annotated output for this input (no trailing extra newline if the input has none):

```
A monoid lets you fold a list in any grouping, and a functor maps over it.
```

must be (functor is not in the bundled glossary, so only monoid is in `t`):

```
::termline{v="A monoid lets you fold a list in any grouping, and a functor maps over it." t="monoid=An associative binary operation together with an identity element, such as addition with zero."}
```

A paragraph that already has mid-sentence `::term` for monoid and functor must become one `::termline` whose `v` is the plain sentence (the names in place of the directives) and whose `t` includes both terms, using the `def` from the directives when present.

#### `src/termline.js` and its tests

Export `escapeTermListPart` / `unescapeTermListPart` (or equivalent documented names) and teach `parseTermList` to split on unescaped `;;` and the first unescaped `=`, then unescape each part. Existing unescaped `t="monoid=def;;functor=def"` must still parse as today. Add tests for a def that contains `=` and `;`.

#### Skill

`skills/concept-links/SKILL.md` must instruct the agent to emit **only** paragraph-level `::termline{v= t=}`, never mid-sentence `::term`. Keep the monoid/functor example in the `v` + `t` form. State clearly that inline `::term` splits the sentence into blocks on Desktop.

#### Python tests

Add `test/test_annotator.py` (unittest, stdlib only). Cover at least:

- The exact monoid/functor sentence above equals the exact `::termline` string above.
- Mid-sentence `::term` for two terms is rewritten to one `::termline` with a plain `v` and both names in `t`.
- A fenced code block containing `monoid` returns `None`.
- A heading and a markdown list containing `monoid` are left unmarked (`None`).
- A paragraph with no glossary terms and no `::term` returns `None`.
- An already-wrapped `::termline` paragraph is left unchanged (`None`).
- Custom glossary: a def containing `=` and `;` is escaped in `t`, and the body stays within the host attr rules.

Run them with `python3 -m unittest test.test_annotator` or `python3 test/test_annotator.py`. Do not add pytest or any dependency.

### Files

Create or modify ONLY these files:

- __init__.py
- test/test_annotator.py          (new)
- skills/concept-links/SKILL.md
- src/termline.js
- test/termline.test.js
- plugin.yaml                     (optional: if you touch it, change the description so it talks about `::termline`, not mid-sentence `::term`)

Do not modify package.json, README.md, SPEC.md, .gitignore, docs, desktop/plugin.js, dashboard/, or other plugins.
Do not add npm or Python dependencies. Do not install into ~/.hermes. Do not git push or add a remote. Local commits are unnecessary.
Do not import @hermes/plugin-sdk, react, or Node built-ins from src/ (JS tests may import node:test and node:assert/strict).
Do not patch Hermes Desktop or write to ~/.hermes/state.db.

After writing, run `npm test` and the unittest file, and do not finish until both are green. Also run:

```
python3 -c "from pathlib import Path; import importlib.util; s=importlib.util.spec_from_file_location('cl', Path('__init__.py')); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); src='A monoid lets you fold a list in any grouping, and a functor maps over it.'; out=m.annotate_terms(src); print(out); assert out == '::termline{v=\"A monoid lets you fold a list in any grouping, and a functor maps over it.\" t=\"monoid=An associative binary operation together with an identity element, such as addition with zero.\"}'"
```

## Desktop bugfix (task 9a) — pane Uses duplicates first use; click ignores disabled Inline

### Bug 3

The Concepts pane lists the same sentence under "First use in this session" and "Uses in this session". In `renderPane`, `first` is `quotes[0]` (or a `definition.firstUse` fallback) and `uniqueQuotes` is every distinct quote, including that first one.

Fix: after deduping quotes by exact trimmed text, the first-use quote is shown only under "First use in this session". "Uses in this session" lists the remaining unique quotes (later occurrences), and the Uses heading/list is omitted when that list is empty. Do not show the definition text as a use. Update the existing plugin-factory pane test that currently expects the gizmo sentence under both headings (it should appear once, under First use, with no Uses list). Add a test where two different sentences were recorded: first under First use, the second only under Uses.

### Bug 4

With the Inline provider toggled off, the hover tooltip no longer comes from the enabled chain, but click can still open the Inline entry. Two holes:

- `makeChip` builds the tooltip from `lookupSync(...)?.short || def`. The `def` fallback is the inline attribute and is used even when `inline` is disabled.
- `registry.lookup` returns a cache hit without checking that the cached `providerId` is still enabled. Click then `lookup()` can resurrect a stale Inline result. `lookupSync` does not use that cache, so hover and click disagree.

Fix:

- Hover label and the click's initial `definition` both come from the same resolution: `lookupSync` over the **enabled** chain only. Do not fall back to `attrs.def` unless the inline provider is enabled and would have produced that def (i.e. let the inline provider be the only source of `attrs.def`).
- `lookup` must not return a cached def whose `providerId` is currently disabled. `setDisabled` (and `setOrder` if it could change outcomes) must evict stale cache entries, or `lookup`/`peekCache` must skip them.
- Click still runs async `lookup` and upgrades the pane when the same term is selected; that lookup also honors enabled/order.

Add tests:

- Disable `inline`, render a termline/term whose only def is the inline attr and that misses later sync providers: the tooltip label is not the inline def (e.g. "No definition yet" or a later enabled sync provider), and click + `lookup()` must not yield `providerId: 'inline'`.
- With inline enabled, lookupSync/tooltip still show the inline def (existing behaviour).
- Cache: lookup succeeds via inline, then disable inline, then lookup again must not return the cached inline def.

### Files (task 9a only)

- src/providers.js
- src/plugin-factory.js
- test/providers.test.js
- test/plugin-factory.test.js

Do not modify other files. Do not install into ~/.hermes. Do not git push. After writing, run `npm test` and do not finish until it is green.

## Desktop bugfix (task 9b) — termline drops inline markdown

`v` is stored as the paragraph text, which may contain `**bold**`, `*italic*` / `_italic_`, `` `code` ``, and `[label](url)`. Today `renderTermline` paints text pieces as raw strings, so the user sees literal `**`.

Prefer rendering, not stripping. In the termline path only (not the mid-sentence `::term` chip):

- Parse a conservative inline-markdown subset: `**bold**` or `__bold__`, `*italic*` or `_italic_` (not mid-word underscores in identifiers), backtick code spans, and `[label](url)` links. No images, no raw HTML, no nested arbitrary markdown. Parse markers around a term so `**monad**` does not leave stray `**` in a neighbouring text piece.
- Render through `jsx`/`jsxs` only: `strong`, `em`, `code`, and `a` (for links: `href` from the markdown, `target: '_blank'`, `rel: 'noreferrer noopener'`). Never `dangerouslySetInnerHTML` or HTML strings.
- Term chips still appear for names in `t` / legacy `[[ ]]`. A term inside a bold/italic/link span should remain a chip (the chip may sit inside that `strong`/`em`/`a`, or the chip may wrap the styled name — either is fine if the name is chipped and the markers are not visible).
- Export the parser from `src/termline.js` so tests can cover it without the factory. Existing termline tests stay green (plain `v` / `t` still works).

Add tests for: `**monad**` renders as a chip not preceded/followed by literal `**`; italic, code, and a link in the same sentence; a typo like `**unclosed` stays literal.

### Files (task 9b only)

- src/termline.js
- src/plugin-factory.js
- test/termline.test.js
- test/plugin-factory.test.js

Do not modify other files. Do not install into ~/.hermes. Do not git push. After writing, run `npm test` and do not finish until it is green.

## Desktop bugfix (task 9c) — annotator misses common technical terms

The Python annotator only chips first mentions that already sit in the 30-term bundled glossary. Real replies therefore get no chips for common CS terms such as monad, hoisting, idempotency, flexbox, and grid (closure and eventual consistency are already in the glossary as exact phrases; "idempotency" is not the same string as "idempotent").

Fix:

1. Expand `DEFAULT_GLOSSARY` in `src/static-glossary.js` and `GLOSSARY` in `__init__.py` so they stay in sync. Add at least: monad, functor, hoisting, idempotency, flexbox, grid, plus a few other cheap, short, standard CS/web terms if you like. Keep definitions to one plain sentence, no `"`, `{`, `}`, or raw newlines.

2. Also resolve **candidate terms** through the existing public lookup sources (MDN, then Wiktionary, then Wikipedia — same matching rules as `dashboard/plugin_api.py`). Extract the shared lookup helpers into a new module (e.g. `lookup_sources.py`) and have `plugin_api.py` import them so behaviour cannot drift. Never invent a definition string. If no source returns a def, either omit the term or add it as `name=` with an empty def (JS coined fallback). Prefer empty def only for marked-up or clearly technical candidates (bolded, camelCase, etc.), never for ordinary English.

3. Candidate selection, tight budget:
   - Always consider bundled-glossary hits (including the new terms).
   - Also consider: `**bold**` / `__bold__` phrases, mid-sentence capitalised noun phrases (do not treat the first word of a paragraph as a candidate just because it is capitalised), and technical tokens (camelCase, snake_case, dotted or hyphenated API-like words).
   - Skip a stopword / very-common-English list (include function words and everyday verbs/nouns like "matters", "retries", "sequences", "effects", "list"). "grid" may be in the glossary and can still match as a glossary hit.
   - Max 8 terms per turn (same cap as today, first mention only, across the whole reply).
   - Total wall time for network lookups ≤ 1.5s per `annotate_terms` call. Use a process-wide small cache (term+source). Per-request timeouts must fit the remaining budget (do not use a 4s timeout). If time runs out, keep glossary hits and any lookups already finished; do not block the hook.

4. `v` must keep the original inline markdown (e.g. `**monad**` stays in `v` so the JS renderer from task 9b can style it). `t` names are the visible words (e.g. `monad`).

The exact annotated output for this input (no extra trailing newline if the input has none), using the bundled glossary defs you add (network must not be required for this string):

```
In Haskell, a **monad** sequences effects, and idempotency matters for retries.
```

must be of the form:

```
::termline{v="In Haskell, a **monad** sequences effects, and idempotency matters for retries." t="monad=<your monad def>;;idempotency=<your idempotency def>"}
```

Do not chip "Haskell" (sentence-leading capital), nor "sequences", "effects", "matters", or "retries". Order in `t` is appearance order (monad then idempotency). Put the exact string (with your defs) in a unittest.

Add Python tests (stdlib unittest, no new deps) for: the exact sentence above; a mid-sentence `::term` still rewritten; fences/headings/lists untouched; a candidate that all sources miss is not given a fabricated def; a lookup helper with a fake/stubbed transport (do not hit the network in CI) for MDN/Wiktionary/Wikipedia hit and miss; the time budget / cap (can stub clock and transport). JS tests that mention the 30-term list must be updated if they assert the exact previous set.

### Files (task 9c only)

You may create or modify:

- __init__.py
- lookup_sources.py          (new, or a similar name)
- dashboard/plugin_api.py
- src/static-glossary.js
- test/test_annotator.py
- test/test_lookup_sources.py  (new, if you add it)
- test/providers.test.js     (only if a glossary-length assertion must change)

Do not modify package.json, README.md, SPEC.md, desktop/plugin.js, or other plugins. Do not install into ~/.hermes. Do not git push. After writing, run `npm test` and `python3 test/test_annotator.py` (and the new lookup tests if any) and do not finish until they are green. Also assert the exact Haskell/monad sentence as specified.
