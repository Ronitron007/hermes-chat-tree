---
name: concept-links
description: >
  Mark dense technical terms in assistant replies with the ::term directive so
  Hermes Desktop can show a hover definition and a Concepts pane. Use in any
  technical or coding explanation that introduces specialised vocabulary.
---

# Concept links

When you explain something technical, tag specialised terms in the middle of
your sentences with a `::term` directive. Hermes Desktop turns each one into a
dotted link with a hover definition and an entry in the Concepts pane.

Use this form:

```
::term{name="monoid" def="A set with an associative operation and an identity element"}
```

Example sentence: A reducer works well when the values form a
::term{name="monoid" def="A set with an associative operation and an identity element"} because order of grouping does not matter.

## Rules

- `name` is the term as the reader should see it. `def` is one plain sentence,
  at most about 25 words and under about 150 characters.
- Put a space or a line start before `::term`. Do not glue it to punctuation
  such as `(` or `"`.
- Tag only dense, specialised terms a reader may not know. Never tag everyday
  words.
- Tag the first mention only, and use at most 8 terms per reply.
- Never put a directive inside a code fence or inline code.
- Keep `def` quote-safe: wrap values in double quotes. Do not put `"`, `{` or
  `}` inside the definition. Do not use backslash escapes.
- If a paragraph is already very long, skip it. The host drops directives in
  paragraphs over 4800 characters.
- Write the definition for a reader who is smart but new to the topic.
- If you coined or introduced a term in this conversation, still tag the first
  mention. Prefer a short gloss of how you used it, not a made-up formal
  definition.
