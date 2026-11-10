# concept-links

Hermes Desktop plugin: mark dense terms in chat with `::term{...}` directives,
show a short definition on hover, and open a right-hand Concepts pane on click.

Definitions come from a pluggable **definition provider** module (inline
directive, session glossary, static/user glossary, Wikipedia, Wiktionary, MDN,
and a coined-term fallback). See `SPEC.md` and `docs/providers.md`.

```
npm test
```

Do not `git push`. Local commits are only to keep the tree clean for `mr`.
