# Concept links

Hermes Desktop can turn a dense technical term into a hoverable link with a short definition. Use the `::term` directive for that.

## Syntax

Write the directive in place of the term, in the middle of the sentence:

```
A ::term{name="monoid" def="A set with an associative operation and an identity element"} lets you fold a list in any grouping.
```

- `name` is the term exactly as the reader should see it.
- `def` is one plain sentence, under about 150 characters.
- Put a space (or a line start) before `::term`. Do not glue it to punctuation like `(` or `"`.

## Rules

- Use it only for dense, specialised terms a reader may not know: `monoid`, `idempotent`, `CRDT`, `backpressure`.
- Never use it for everyday words, or for the same term more than once per reply (first mention only).
- Never put it inside a code fence or inline code. Leave code untouched.
- Keep `def` quote-safe: use double quotes around values, and do not use `"`, `{` or `}` inside the definition. No backslash escapes.
- Keep it to a handful of terms per reply. If a paragraph is already very long, skip it.
- Write the definition for a reader who is smart but new to the topic.
