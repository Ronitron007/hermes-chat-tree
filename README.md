# Side chats and a chat tree for Hermes Desktop

This repository is one entry with three Hermes Desktop plugins:

- **side-chat** asks a side question in a fork of the open chat. The fork can run on a cheaper model. The main chat gets no new message.

- **chat-tree** draws the open chat, its forks, and its side chats as a git graph in a side pane. Each node is one exchange: one user message and its replies.

- **concept-links** puts chips on technical terms in replies. A hover shows a short definition. A click opens the definition in a side pane.

The entry uses only the public plugin framework of Hermes. It changes no Hermes code.

## What the entry does

- A side question runs in a fork of the open chat, so the main chat stays on topic. You can give the fork a cheaper model and a provider.

- The tree has one lane for each chat. A fork leaves its parent lane at the exact exchange where the child chat starts. A merge curves back into a `Merged: …` node on the parent lane.

- The tree uses two colours. Blue marks the path from the first exchange to the open node. Grey marks all other nodes.

- A long run of exchanges folds into one `+N` row. A click on the row opens the run.

- A merge brings a side chat back into its parent. You choose the merge mode:

  - **Full text** (the default) copies each question and answer of the side chat.

  - **Merge record** writes the side chat title and its id only.

  - **Digest** writes the side question and the final answer of the side chat.

- Each merge text starts with the line `From side chat: <title>`. The tree uses this line to draw the merge.

- The merge removes concept-link markup from the text and keeps the plain sentences.

## Install

You need Hermes 0.23 or later and Hermes Desktop.

1. Clone this repository.

2. Run the install script. Give it your Hermes home if it is not `~/.hermes`.

   ```bash
   bash scripts/install.sh            # installs into ~/.hermes
   bash scripts/install.sh /path/to/hermes-home
   ```

3. Run the commands that the script prints:

   ```bash
   hermes plugins disable concept-links
   hermes plugins enable concept-links
   hermes gateway restart -y --detach
   ```

4. Quit and relaunch Hermes Desktop.

5. If a pane does not show, open **Capabilities → Plugins** in Hermes Desktop and turn the plugin on.

The script copies files only. It runs no `hermes` command. It writes these files:

| Plugin | Files in the Hermes home |
|---|---|
| side-chat | `desktop-plugins/side-chat/plugin.js` |
| chat-tree | `desktop-plugins/chat-tree/plugin.js` |
| concept-links | `desktop-plugins/concept-links/plugin.js`, `plugins/concept-links/`, `skills/concept-links/SKILL.md` |

side-chat and chat-tree are Desktop-only plugins. They have no Python half, so the script puts nothing for them in `plugins/`.

## How to use

### Ask a side question

1. Open a chat.

2. Open the **Side chat** pane. The command palette has **Open side chat**.

3. Type the question. To use a cheaper model, type its name in the side model field.

4. Click **Ask**. The answer shows in the pane.

5. To read the whole side chat, click **Open**.

### Merge a side chat back

1. Choose the merge mode on the side chat entry.

2. Click the merge button. The pane checks that the text fits in the context window of the main chat.

3. Edit the text in the main chat composer, then send it. The pane never sends it for you.

### Read the tree

1. Open the **Chat tree** pane. The command palette has **Open chat tree**.

2. Point to a node to see the chat title and its model.

3. Click a node to open its chat.

4. Click a `+N` row to show the exchanges in it.

### Preview the panes without Hermes

The render harness renders the real pane code with fixture chats to static HTML files.

```bash
npm install
npm run render     # writes dev/out/chat-tree.html and dev/out/side-chat.html
```

Open the files in a browser. The fixture chats are in `dev/fixtures/chats.json`.

## Limits

- Hermes has no API to scroll a chat to one message. A click on a node opens the chat of that node, at its usual scroll position.

- A merge is staged in the composer. The pane never sends it.

- Digest is the side question and its final answer. No model writes a summary.

- The main chat must be idle when you ask a side question. Hermes refuses to fork a busy chat.

- The tree reads the newest 500 chats and at most 30 chats of one lineage.

- A fork starts after the last exchange of the chat. A fork from an earlier message is not available yet.

## How this differs from study-tree

[study-tree](https://github.com/IpastorSan/study-tree) is also a Hermes plugin for side questions. The two work in different ways:

| | study-tree | This entry |
|---|---|---|
| Where you ask | In the main chat. An agent tool parks the question. | In a side pane. The main chat gets no message. |
| Parts | An agent half (tools, hooks, a skill) and a Desktop half | Desktop only for side-chat and chat-tree |
| What comes back | One checked takeaway sentence | Full text, Merge record, or Digest, as you choose |
| How it comes back | The plugin puts the takeaway in the main thread | The text waits in the composer. You send it. |
| Tree | Side threads as a tree | One node for each exchange, with exact fork points and merge curves |

## Credits

- Built by Rohan Malik with Claude Code.

- The lineage rules of the tree come from `apps/desktop/src/lib/session-branch-tree.ts` in [Hermes Agent](https://github.com/NousResearch/hermes-agent) by Nous Research.

- [study-tree](https://github.com/IpastorSan/study-tree) by IpastorSan is prior art for side questions in Hermes.

---

# Concept Links

A Hermes Desktop plugin that turns terms in chat output into dotted-underline chips. Hover a chip for a short definition tooltip; click it to open a right-hand Concepts side pane with the definition, its source, and where the term was first used in the session.

It has two halves:

- A disk UI plugin (`desktop/plugin.js`) that renders the chips, tooltip, and panes, and looks terms up through a definition-provider chain.
- A Python plugin (`plugin.yaml`, `__init__.py`, `lookup_sources.py`, `dashboard/plugin_api.py`) that annotates replies after they are generated, plus a small lookup proxy. A skill (`skills/concept-links/SKILL.md`) tells the assistant to emit the paragraph-level markup when it already knows a definition.

## Encoding: `::termline{v= t=}`

Annotated paragraphs are encoded as a single paragraph-level directive:

```
::termline{v="In Haskell, a **monad** sequences effects, and idempotency matters for retries." t="monad=A design pattern that wraps values in a context and chains operations on them, handling the context such as failure or state automatically.;;idempotency=The property that repeating an operation has the same effect as doing it once, which makes retries safe."}
```

- `v` is the sentence, including a conservative subset of inline markdown (`**bold**` / `__bold__`, `*italic*` / `_italic_`, backtick code, and `[label](url)` links). The termline renderer turns those markers into `strong` / `em` / `code` / `a` elements (no raw HTML).
- `t` is a list of `name=definition` pairs, separated by `;;`. Names and definitions may contain `\`, `;`, and `=` by escaping them.

This exists because of two host constraints in Hermes Desktop:

1. The host splits a Markdown paragraph at every `::directive`, so a mid-sentence `::term{...}` broke the sentence into separate `<p>` blocks (plain text, then the chip, then the rest).
2. The host's `liftDirectives` preprocessor backslash-escapes `[` and `]`, which broke an earlier `[[name|def]]` encoding inside the directive body.

A paragraph-level `::termline` keeps the sentence in one block. Legacy `[[name|def]]` markup in `v` is still accepted after unescaping, and older `::term{name= def=}` directives still render, but new annotation uses the `v` / `t` form. Shipped CSS lacks `decoration-dotted`, so chips set `textDecoration: 'underline dotted'` inline.

The Python annotator (`transform_llm_output`, registered without `hold_stream`) rewrites whole paragraphs this way. It does not hold the stream, so a reply may appear briefly as plain text before the tagged version replaces it.

## Definition providers

A provider is an object:

```
{id, label, canResolve(term, ctx), resolve(term, ctx) -> {short, long, source, kind: standard|coined|uncertain, firstUse?, url?, providerId}}
```

Providers are registered in an ordered fallback chain, with a per-session in-memory cache. The first provider that returns a definition wins. A throwing provider is skipped. You can reorder providers and switch each on or off in the Concepts pane (or the standalone Concept providers pane). Hover and click use the same enabled-chain resolution: a disabled provider (and any cached result from it) is not used, and the inline attribute is not a back door when the Inline provider is off.

Default order:

1. **inline** — definitions written into the reply itself (directive attributes).
2. **session glossary** — terms already defined earlier in the session.
3. **static / user glossary** — a bundled glossary of common CS/web terms (case-insensitive, with simple plural/inflection matching), plus terms you add (`ctx.storage`).
4. **MDN** — the web developer reference.
5. **Wiktionary**
6. **Wikipedia** — `ctx.fetch`, with a `ctx.rest` proxy fallback and a 4s timeout.
7. **coined fallback** — never invents a definition; shows the first-use quote labelled "inferred from context", or "No definition found".
8. **LLM backend** — built (`src/llm-provider.js`) but disabled by default. `POST /define` returns 501.

A **docs / codebase index** provider was ruled out. The Hermes plugin SDK has no index API, and `ctx.files.requestFolder()` would only grant folder access, not a searchable index.

The Python annotator chips first mentions from the bundled glossary (case-insensitive, with simple plural/inflection stemming so `Monads` hits `monad`), then also looks up a small set of other candidates (bold phrases — including at the start of a paragraph — mid-sentence capitalised noun phrases, and technical tokens such as camelCase) through the same MDN → Wiktionary → Wikipedia helpers the dashboard proxy uses (`lookup_sources.py`). Multiword bold phrases such as `CSS Flexbox` try the full phrase, then the head noun, then known sub-terms, and the chip covers the visible phrase. Lookups share a 1.5s budget and a small process-wide cache, and cap at 8 terms per turn. A definition is never invented: a miss is omitted, or tagged with an empty def so the UI coined fallback can run (bold and technical candidates only).

Each turn also writes one diagnostic line to the Hermes log (`hermes_plugins.concept_links`): candidate/resolved counts and skip reasons per paragraph.

The hook is `transform_llm_output` without `hold_stream`, so a reply can appear as plain text for a short time and then be replaced by the tagged `::termline` version. That delay is annotation timing, not a chip re-render flash.

Details, costs, and risks are in [`docs/providers.md`](docs/providers.md). The full design notes are in [`SPEC.md`](SPEC.md).

## Install

Copy the three pieces into your Hermes config, then enable the plugin and restart the gateway.

```bash
# UI plugin
mkdir -p ~/.hermes/desktop-plugins/concept-links
cp desktop/plugin.js ~/.hermes/desktop-plugins/concept-links/plugin.js

# Python plugin (annotator hook, lookup sources, lookup proxy, /define stub)
mkdir -p ~/.hermes/plugins/concept-links
cp plugin.yaml __init__.py lookup_sources.py ~/.hermes/plugins/concept-links/
mkdir -p ~/.hermes/plugins/concept-links/dashboard
cp dashboard/plugin_api.py ~/.hermes/plugins/concept-links/dashboard/
mkdir -p ~/.hermes/plugins/concept-links/skills/concept-links
cp skills/concept-links/SKILL.md ~/.hermes/plugins/concept-links/skills/concept-links/SKILL.md
find ~/.hermes/plugins/concept-links -type d -name __pycache__ -exec rm -rf {} +

# Skill
mkdir -p ~/.hermes/skills/concept-links
cp skills/concept-links/SKILL.md ~/.hermes/skills/concept-links/SKILL.md

hermes plugins disable concept-links
hermes plugins enable concept-links
hermes gateway restart -y --detach
# Relaunch Hermes Desktop so it picks up the disk plugin.
```

Rebuild the UI plugin after editing `src/` with `npm run assemble` (writes `desktop/plugin.js`). The assembled file may import only `@hermes/plugin-sdk`, `react`, and `react/jsx-runtime`.

## Tests

```bash
npm test                         # 115 tests (Node built-in test runner, no extra dependencies)
python3 test/test_annotator.py   # 52 tests
python3 test/test_lookup_sources.py  # 22 tests
```

The earlier feasibility spike lives under [`spike/`](spike/) (`feasibility.md`, `src/`, `test/`). Research notes used while designing the providers are under [`docs/research/`](docs/research/) (email headers redacted).

## Known gaps

- Mid-sentence `::term{...}` still splits a Desktop paragraph into separate blocks. New annotation emits a whole-paragraph `::termline` instead, and the annotator rewrites leftover mid-sentence `::term` into `::termline` when it can. The skill tells the model not to emit mid-sentence `::term`.
- The annotator leaves headings, lists, tables, block quotes, fenced code, and paragraphs that contain `[[` unmarked. Ordinary prose with inline code, links, emphasis, quotes, em-dashes, and emails is annotated; terms that appear only inside inline code are not chipped. Lists are left unmarked so list markdown is not rewritten.
- Hover tooltips use only synchronous providers (inline, session, static). MDN, Wiktionary, Wikipedia, and coined resolve asynchronously on click and then upgrade the Concepts pane.
- The LLM provider is implemented but turned off (`POST /define` returns 501).
- Paragraphs over 4800 characters, or whose directive body would exceed 2048 characters, are left unmarked (host limits). `{`, `}`, and raw newlines cannot appear in `v` or `t`. Attribute quoting is limited (double quotes inside the sentence force single-quoted attrs, or are stripped).
- Network lookups share a 1.5s wall-time budget per turn (max 8 terms). Unresolved ordinary capitalised words are dropped; a source miss is never replaced with a made-up definition.
- Short glossary entries such as `grid` will also chip ordinary uses of those words.

## Layout

- `src/` — provider chain, cache, termline parser (including inline markdown), and plugin factory
- `test/` — Node tests plus `test_annotator.py`, `test_lookup_sources.py`, and `fixtures/real-replies/` (captured live Desktop replies)
- `desktop/plugin.js` — assembled disk plugin
- `scripts/assemble.mjs` — builds `desktop/plugin.js` from `src/`
- `skills/concept-links/SKILL.md` — instructs the assistant to emit `::termline`
- `plugin.yaml`, `__init__.py`, `lookup_sources.py`, `dashboard/plugin_api.py` — Python half
- `docs/providers.md` — provider survey
- `spike/` — feasibility spike that preceded the plugin
