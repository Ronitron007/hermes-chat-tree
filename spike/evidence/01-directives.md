# Evidence: transcript directives (live Hermes Desktop source)

Source of truth: `/home/box/.hermes/hermes-agent/apps/desktop/src/lib/transcript-directives.ts`
Renderer: `.../components/assistant-ui/transcript-directive.tsx`
Markdown pipeline: `.../components/assistant-ui/markdown-text.tsx` adds `remarkTranscriptDirectives` and uses `TranscriptDirectiveLeaf`.
Mid-prose test: `.../components/assistant-ui/transcript-directive.test.tsx` (`useResolvedParagraph` — "lifts a claimed directive out of the sentence around it").

## There is no hook that rewrites an arbitrary assistant turn

Contribution areas that touch the transcript are only:

- `TRANSCRIPT_DIRECTIVE_AREA` = `'transcript.directives'`
- `TOOL_MEDIA_RENDERER_AREA` = `'transcript.toolMedia'` (only MEDIA files produced by the package's own tools)

There is no markdown-component hook, no message renderer for ordinary prose, and no desktop API that lets a plugin replace or wrap already-rendered assistant text. `host.onEvent('message.start'|'message.delta'|'message.complete')` is observer-only.

A plugin cannot intercept "any output on the chat text" from `plugin.js` alone.

## How directives work (live source, not the stale website paragraph)

A plugin registers:

```js
ctx.register({
  id: 'task-card',
  area: TRANSCRIPT_DIRECTIVE_AREA, // 'transcript.directives'
  data: {
    name: 'task', // model writes ::task{id="BB-12"}
    render: ({ attrs, source, streaming, sessionId }) => /* ReactNode */
  }
})
```

`render` receives `{ attrs, source, streaming, sessionId }`.

- `attrs`: parsed, untrusted `key="value"` or `key='value'` pairs; keys lowercased; string-only. Plugins must validate. No backslash escapes inside quotes.
- `source`: original directive text.
- `streaming`: true while the surrounding message is still streaming.
- `sessionId`: chat id (stored, else runtime), or null. Feature-detect `props.sessionId !== undefined`.

Name rules: lowercase, `[a-z][a-z0-9-]{0,63}`, unique; first registration wins. Namespace adventurous names.

Unclaimed or malformed directives stay as the text they always were.

Renders sit in a contribution error boundary (inline error chip, not a dead message).

## Mid-prose (IMPORTANT docs/code split)

Live source comments and tests: a directive is recognised **wherever it starts a word**, and the paragraph around it keeps rendering as prose. Position used to require a whole paragraph; that was relaxed because models put the directive at the end of a sentence.

Test case:

```
'See ::inline{x="1"} and ::other here'
→ [
  { kind: 'prose', text: 'See ' },
  { kind: 'directive', source: '::inline{x="1"}' },
  { kind: 'prose', text: ' and ::other here' }  // ::other unclaimed, folded back to prose
]
```

Lookbehind `(?<=^|\s)` so `std::vector` is never a directive.

STALE: `/home/box/.hermes/hermes-agent/website/docs/developer-guide/desktop-plugin-sdk.md` line 1142 and the copied `docs/references/sources/sdk/desktop-plugin-sdk.md` still say "The directive must be the entire paragraph — ::name mid-prose stays prose". That is **wrong for the installed source**. The spike must be tested against the live Desktop, and must mention this docs lag.

## Parser limits (from live `transcript-directives.ts`)

- `DIRECTIVE_BODY_MAX = 2048` (brace body).
- `segmentTranscriptDirectives(text)` returns `null` if `!text.includes('::')` OR `text.length > 4800`. A paragraph longer than 4800 chars will **not** be segmented, so raw `::term{...}` would show as text.
- A name match whose `{` is unclosed or over the cap is left as text (not a card with dropped attrs).
- Autolink URLs inside attributes are folded back by `remarkTranscriptDirectives`.

Regex (live):

```
SEGMENT_RE = /(?<=^|\s)::([a-z][a-z0-9-]{0,63})(?:\{([^{}]{0,2048})\})?/g
ATTR_RE = /([a-z][\w-]{0,63})=(?:"([^"]*)"|'([^']*)')/gi
```

Attribute values cannot contain their own quoting character. Definitions with both `"` and `'` will break the attr parser unless the plugin stores the long definition out of band (id → glossary) or strips/rephrases quotes.

Core ships `::preview{file="…"}` as the reference consumer. The model must be told the directive exists (bundled skill or tool description).
