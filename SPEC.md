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
