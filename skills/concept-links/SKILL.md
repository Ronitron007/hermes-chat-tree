---
name: concept-links
description: >
  Mark dense technical terms in assistant replies so Hermes Desktop can show a
  hover definition and a Concepts pane. Use a ::termline paragraph (one
  directive that holds the whole sentence) in any technical or coding
  explanation that introduces specialised vocabulary.
---

# Concept links

When you explain something technical, tag specialised terms so Hermes Desktop
can turn each one into a dotted link with a hover definition and an entry in
the Concepts pane.

In Hermes Desktop, a mid-sentence `::term{name= def=}` is lifted out of the
sentence and shown as a separate block, which breaks the sentence apart. To
keep the sentence together, make the **entire paragraph** a single `::termline`
directive. Put no prose before or after it on that paragraph.

Use this form: `v` is the plain sentence and `t` lists the terms as
`name=def` pairs separated by `;;`.

```
::termline{v="A monoid lets you fold a list in any grouping, and a functor maps over it." t="monoid=A set with an associative operation and an identity element;;functor=A mapping between categories that preserves structure"}
```

Do **not** put `[[name|def]]` markers in `v`. Desktop backslash-escapes `[` and
`]` in directive bodies, which breaks that older encoding. Keep `v` plain text
and put every definition in `t`. `v` and `t` cannot contain `{`, `}`, `"` or
backslashes.

## Rules

- The paragraph is only the directive. Do not put other text on that
  paragraph, or Desktop will split it.
- List each dense term in `t` as `name=def`, in the order it appears in `v`,
  separated by `;;`. `name` is the word exactly as it appears in `v`. `def` is
  one plain sentence, at most about 25 words and under about 150 characters.
  `name` cannot contain `=`, and neither part can contain `;;`.
- `v` and `t` are wrapped in double quotes. Do not put `"`, `{`, `}`, `[[`,
  `]]` or backslashes inside `v`, a name or a definition. Rephrase instead.
- Tag the first mention only, and use at most 8 terms per reply. Tag only
  dense, specialised terms a reader may not know. Never tag everyday words.
- Never put a directive inside a code fence or inline code.
- If a paragraph is already very long, skip it. The host drops directives in
  paragraphs over 4800 characters, and the attribute body cap is 2048
  characters.
- Write definitions for a reader who is smart but new to the topic.
- If you coined or introduced a term in this conversation, still tag the first
  mention. Prefer a short gloss of how you used it, not a made-up formal
  definition.
- Do not use mid-sentence `::term{name= def=}` in Desktop replies. That form
  is only a fallback the plugin still understands for old chats, and it breaks
  the sentence into blocks.
