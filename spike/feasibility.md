# Concept links in Hermes Desktop chat: feasibility

For Rohan. Sources are the files in `evidence/` (cited as `01` to `04`) and the absolute paths they name under `/home/box/.hermes/hermes-agent`. Anything the evidence does not show is marked **unverified**. Nothing here was installed into live Desktop.

## Short answer

| Question | Answer |
|---|---|
| Q1. Can a plugin intercept or re-render an assistant turn's text? | No, not from `plugin.js` alone. |
| Q2. Inline tooltip, click opens right pane with the term? | Yes, using only the Hermes UI kit. |
| Q3. Where do definitions come from? | Simplest: the model emits `::term{...}` because a skill told it to. Automatic "any turn" layer: a Python `transform_llm_output` hook. |
| Q4. Spike | Stage 1 (headless, done in this repo). Stage 2 (real Desktop) is later. |

## Q1. Can a plugin intercept or re-render an assistant turn's text?

**Verdict: no, not from `plugin.js` alone.**

What exists (`01`, source `/home/box/.hermes/hermes-agent/apps/desktop/src/lib/transcript-directives.ts`):

- **`transcript.directives`** (`TRANSCRIPT_DIRECTIVE_AREA`). The plugin claims a name, such as `term`. The host parses `::term{key="value"}` out of the message markdown. Then it calls your `render({ attrs, source, streaming, sessionId })`. So the plugin never gets the whole turn. It only gets one already-parsed directive. It cannot wrap prose that the model did not mark.
- **`transcript.toolMedia`** (`TOOL_MEDIA_RENDERER_AREA`). Only for MEDIA files produced by the package's own tools. Not prose.
- **Markdown hooks.** None for plugins. `markdown-text.tsx` adds `remarkTranscriptDirectives` and uses `TranscriptDirectiveLeaf` itself (`01`). There is no markdown-component hook and no message renderer for ordinary prose.
- **`host.onEvent('message.start' | 'message.delta' | 'message.complete')`.** Observer only (`01`). A plugin can see the text. It cannot change what is shown or stored. The evidence does not show the event payload shape: **unverified**.
- **Composer middleware.** It exists: `COMPOSER_AREAS.middleware` (`'composer.middleware'`) runs `handler(draft)` over the user's outgoing draft (`composer-contrib.ts`). That is user input, not assistant output, so it cannot wrap a turn.

What `render` receives: parsed attributes (untrusted, string-only, keys lowercased, no backslash escapes), the original directive `source`, `streaming`, and `sessionId` (can be null). It returns a React node. It does not receive raw markdown for the turn and does not receive a React tree to wrap. Unclaimed or malformed directives stay as plain text. Renders sit in an error boundary (`01`).

### Mid-prose: docs and code disagree

- **Live source and tests**: a directive is recognised wherever a word starts. Regex lookbehind `(?<=^|\s)` means `std::vector` is not a directive. Test `transcript-directive.test.tsx` ("lifts a claimed directive out of the sentence around it") shows `'See ::inline{x="1"} and ::other here'` splitting into prose, directive, prose (`01`).
- **Website and copied SDK doc**: `/home/box/.hermes/hermes-agent/website/docs/developer-guide/desktop-plugin-sdk.md` line 1142 and `docs/references/sources/sdk/desktop-plugin-sdk.md` still say the directive must be the entire paragraph (`01`). That is stale for the installed source.

**Live source wins for this spike.** Stage 2 must confirm it on a real Desktop build.

### Fallbacks

1. **The agent emits `::term{name= def=}` mid-prose** because a skill told it to (`02`, path b). No second model call.
2. **A Python `transform_llm_output` hook** rewrites the finished reply and splices those directives in (`02`). It fires once per turn, before delivery and before the assistant row is stored, so the rewrite is what the session keeps. `hold_stream=True` is optional.

There is **no desktop API to patch a stored transcript row after `message.complete`** (`02`). `post_llm_call` is observer only.

## Q2. Inline tooltip, click opens a right pane, pass a term

**Yes, with the kit** (`03`).

- **Tooltip.** `Tip({ label, children })` from the SDK. `label` is a ReactNode, so a short definition string works. `children` must be one element because `Tip` uses `TooltipTrigger asChild`. Use `<button type="button">` as the term. Hover only, 200 ms default delay, never blocks clicks.
- **Passing the term.** Make a nanostores `atom(null)` with the SDK's `atom` and read it in the pane with `useValue`. The click does `$selectedTerm.set({ name, def, sessionId })`. No event bus is needed. Do not patch app stores.
- **Opening the pane.** Right after the `set`, call `host.revealPane('concept-links:glossary')`. The id is `<pluginId>:<paneId>`. Check `typeof host.revealPane === 'function'` first.
- **Pane registration.** `area: 'panes'`, `data: { placement: 'right', width: '340px' }`, `title: 'Concepts'`. Never `type: 'pane'` or `area: 'right'`.
- **`host.paneVisibility(paneId)`** is a read-only atom that is true while the pane is on screen. It does not open the pane. Use it only to show state.
- **Palette** (`PALETTE_AREA`, `data: { id, label, keywords?, run }`) can add an "Open concepts pane" command. Optional, not in the spike.
- **Risk: closing the pane may disable the plugin** when it has only one pane (`03`, hermes-widgets assumption-corrections). Then directive rendering stops. Options: add a second cheap pane, accept it for the spike, or watch for it in Desktop.

Unverified: whether the host calls a pane's `render` as a React component (so hooks are legal inside it). The evidence shows `useValue` inside pane render, and the outline copies that. `Button`, `ScrollArea` and `EmptyState` are exported from `@hermes/plugin-sdk` (sdk/index.ts). Their exact props are still unverified; the outline uses conservative ones (`title` on EmptyState, `children` on ScrollArea).

## Q3. Where do definitions come from?

| Option | Can it run in Hermes? | Notes (`02`) |
|---|---|---|
| (a) Second LLM pass | Yes, but only as the **Python half**: `transform_llm_output`. A desktop-only listener on `message.complete` cannot rewrite the row. | Extra latency. With `hold_stream=True` the user waits and sees only a busy indicator. Without it they see unlinked text, then a swap. |
| (b) Skill-marked `::term` | Yes, on Desktop once the plugin loads. This is the path the SDK documents for directives. | No second call. Depends on the model emitting the syntax and short, quote-safe defs. Raw directive text shows on CLI, TUI and messaging unless a Python transform strips it. |
| (c) Cheap model via `plugin_api.py` / `ctx.rest` | The route runs (`dashboard/plugin_api.py`, mounted at `/api/plugins/<id>/` at gateway start, only if enabled in `config.yaml`). | A desktop call after the turn **cannot hyperlink the chat**. It could only fill a pane. A cheap model is useful when called from `transform_llm_output`, which is option (a) with a cheaper model. |

**Simplest: (b).** **Automatic "any turn" layer: Python `transform_llm_output`**, with a mechanical annotator first (no extra LLM) and a cheap model later. This matches the recommendation in `02`. Do not start with (c) as a desktop-after-the-fact route if the goal is inline links.

## Q4. Concrete spike design

### Files (Stage 1, in this repo)

| File | Role |
|---|---|
| `src/directive-parser.js` | `segmentTranscriptDirectives`, `parseAttrs`. Same regexes and limits as live (`01`). Core of path (b). |
| `src/annotate.js` | `annotateTerms(markdown, glossary)`. Core of the Python-hook layer. |
| `src/term-state.js` | `createTermStore()`: headless twin of the shared atom. |
| `src/plugin-outline.js` | `createPlugin({...})`: the real `plugin.js` shape with injected SDK pieces. |
| `src/skill.md` | The skill text that would ship for path (b). |
| `test/*.test.js` | Node built-in test runner. No dependencies. |

### Hook used

`transcript.directives` with `name: 'term'` (`01`). For the automatic layer, the Python `transform_llm_output` hook (`02`), which Stage 1 only models as the annotator function.

### Data flow

```
path (b):  skill -> model writes "::term{name= def=}" mid-sentence
path (a):  reply -> transform_llm_output -> annotateTerms(reply, glossary) -> stored reply
                                   |
Desktop:   message markdown -> host parses directive -> render({attrs,...})
           -> Tip(label=def) > button(name)
           -> click: $selectedTerm.set({name,def,sessionId}); host.revealPane('concept-links:glossary')
           -> pane render: useValue($selectedTerm) -> name + def (or EmptyState)
```

### Plugin outline

The real outline is `src/plugin-outline.js` (about 90 lines). In the shipped `plugin.js`, only these imports are allowed (`04`): `@hermes/plugin-sdk`, `react`, `react/jsx-runtime`. No JSX, no eval, no dynamic import, no Node built-ins. The core, using `jsx()` only:

```js
import { jsx, jsxs } from 'react/jsx-runtime'
import { atom, useValue, Tip /* , Button, ScrollArea, EmptyState: unverified */ } from '@hermes/plugin-sdk'

const PLUGIN_ID = 'concept-links', PANE_ID = 'glossary', DIRECTIVE_NAME = 'term'

export function createPlugin({ host, jsx, jsxs, atom, useValue, Tip, Button, ScrollArea, EmptyState }) {
  const $selectedTerm = atom(null)                       // { name, def, sessionId } | null
  const paneId = `${PLUGIN_ID}:${PANE_ID}`
  const str = v => (typeof v === 'string' ? v.trim() : '')  // attrs are untrusted

  function renderTerm({ attrs, source, sessionId }) {
    const name = str(attrs?.name), def = str(attrs?.def)
    if (!name) return jsx('span', { children: source })
    const open = () => {
      $selectedTerm.set({ name, def, sessionId: sessionId ?? null })
      if (typeof host?.revealPane === 'function') host.revealPane(paneId)
    }
    const chip = jsx('button', { type: 'button', onClick: open, children: name })
    return jsx(Tip, { label: def, children: chip })      // Tip needs ONE element child
  }

  function renderPane() {
    const term = useValue($selectedTerm)
    if (!term) return jsx(EmptyState, { title: 'No concept selected' })
    return jsx(ScrollArea, { children: jsxs('div', { children: [
      jsx('h2', { children: term.name }),
      jsx('p', { children: term.def }),
      jsx(Button, { type: 'button', onClick: () => $selectedTerm.set(null), children: 'Clear' })
    ] }) })
  }

  function register(ctx) {
    ctx.register({ id: 'term', area: 'transcript.directives',
      data: { name: DIRECTIVE_NAME, render: renderTerm } })
    ctx.register({ id: PANE_ID, area: 'panes', title: 'Concepts',
      data: { placement: 'right', width: '340px' }, render: renderPane })
  }
  return { register, $selectedTerm, PANE_ID, PLUGIN_ID, DIRECTIVE_NAME }
}
```

The disk plugin export shape is documented in the official SDK (`desktop-plugin-sdk.md`) and used by hermes-widgets: `export default { id, name, register(ctx) }`, with `id` matching the folder name. The outline's `createPlugin` is the body of `register`.

### Stage 1: headless, this repo, now

Test steps: run `npm test` (`node --test test/*.test.js`).

Pass criteria:

- Parser: mid-prose `::term{...}` gives prose, directive, prose with `{name, def}`. `std::vector` is not a directive. An unclosed brace stays prose. A 4801-char paragraph returns `null`. Single-quoted attrs work. Keys are lowercased.
- Annotator: marks a term in prose. Skips fenced and inline code. Does not re-mark inside an existing `::term{...}`. Longest term first. Defs with `"` come out parseable. A 5000-char paragraph is left unmarked. Output parses back through the parser.
- State: `get`, `set`, `subscribe` (immediate call, change calls, unsubscribe).
- Plugin outline: both contributions registered with the right area, name and placement. `::term` render gives `Tip` > `button`. Click calls `store.set` and `host.revealPane('concept-links:glossary')`. No call, and no error, when `revealPane` is missing.

All of the above are covered by the tests in `test/`. They run only against mocks, so they do **not** prove the host behaves this way.

### Stage 2: real Desktop (later, not done)

Disk plugin plus bundled skill, in a real Desktop session. Not performed. Pass criteria:

1. Plugin loads. The `term` directive is claimed. Pane `Concepts` appears under the right placement.
2. A reply containing mid-prose `::term{name="monoid" def="..."}` renders a dotted term inside the sentence, with surrounding prose intact (confirms the live-source behaviour over the stale docs).
3. Hover shows the definition tip. Click shows the term and definition in the right pane, and the pane opens if closed.
4. Click on a second term replaces the first.
5. `host.revealPane` exists in the installed build. If missing, the click still updates state and nothing crashes.
6. While streaming, a half-written `::term{name="x"` shows as text, then becomes a term once complete.
7. Closing the pane does not disable directive rendering (or the behaviour is documented).
8. With the skill active, the model emits valid, quote-safe directives for a real technical answer and avoids code fences.
9. Python `transform_llm_output` path: a finished reply is rewritten and the stored row contains the directives (with and without `hold_stream=True`).

### Open risks

- **4800-char paragraph cap.** The parser returns `null` above 4800 chars, so raw `::term{...}` shows as text (`01`). The annotator skips replacements that would pass 4800 in a paragraph. The model path (b) has no such guard.
- **2048-char body cap.** An over-cap body stays as text (`01`). The annotator skips such defs.
- **Quote-unsafe attrs.** Values cannot contain their own quote char, and braces cannot appear in the body (`01`). The annotator picks quotes safely, swaps `"` for `'` when both appear, and swaps `{}` for `()`. Models will not always do that. Out-of-band definitions (id to glossary) are the alternative.
- **Raw `::term` on CLI / TUI / messaging** (`02`). Needs a Python strip step or Desktop-only enabling.
- **Model reliability for (b).** It depends on the model remembering the syntax and keeping defs short (`02`). Not measured.
- **`hold_stream` withhold.** With `hold_stream=True`, a hook failure or timeout gives a "reply withheld" notice, never the original (`02`). Commentary messages are hidden too.
- **Stale SDK docs.** The website and copied SDK doc contradict the live mid-prose behaviour (`01`). The spike must be checked against the live build.
- **One-pane close.** Closing the only pane may disable the plugin (`03`).
- **Annotator limits.** It only marks terms preceded by whitespace or at the start of the text, because that is all the parser accepts. `(monoid)` and `**monoid**` are skipped. It is case-sensitive.
- **Unverified.** Event payloads for `message.*`, the exact props of `Button`/`ScrollArea`/`EmptyState`, and the skill file format (`src/skill.md` is plain markdown, no front matter; a bundled plugin skill may need a different layout under `skills/`).

## Verdict

A plugin alone cannot rewrite or wrap an assistant reply, so "link any term on any turn" cannot be done from `plugin.js`. It can still do the visible half: a marked term becomes a dotted word with a hover definition, and clicking it opens a right-hand pane with the term, all with the Hermes UI kit. The marks have to come from somewhere else. The cheapest start is a skill that tells the model to write `::term{...}` in the middle of sentences. The automatic layer is a Python `transform_llm_output` hook that adds the marks after the turn, first with a plain word-list annotator, later with a cheap model. The headless Node spike covers the parser, the annotator, the shared state and a mocked plugin, and all of it passes. What remains is Stage 2, which needs a real Desktop to confirm mid-prose directives work as the live source says, and to see how often the model gets the syntax right.
