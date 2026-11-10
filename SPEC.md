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
