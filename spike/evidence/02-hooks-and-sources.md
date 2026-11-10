# Evidence: where definitions can come from

## (b) Skill / system prompt — model emits `::term{...}` inline

This is the path the SDK documents for directives: "Tell the agent about your directive in a skill (that's how it learns to emit it)."

A bundled plugin skill (or a user skill) instructs the model to replace a technical term, mid-sentence, with:

```
::term{name="monoid" def="A set with an associative operation and an identity element"}
```

The desktop plugin's `render` draws the word `name` as a hoverable, clickable chip. No second model call. Works on Desktop once the plugin is loaded. On CLI / TUI / messaging, the raw directive text would be visible unless a Python transform also strips it — risk.

This is the simplest spike. It depends on the model actually emitting the syntax, and on short quote-safe definitions.

## (a) Same LLM, second pass after the turn, extract JSON

A desktop plugin listening to `message.complete` can *see* the finished text, but it **cannot rewrite** the transcript row. There is no host API to patch message markdown after the fact.

The real rewrite hook is Python, not `plugin.js`:

`transform_llm_output` (from `hermes_cli/plugins.py` VALID_HOOKS and `website/docs/user-guide/features/hooks.md`):

- Fires once per turn after the tool loop, **before** delivery and **before** the assistant row is persisted. The replacement is what the session stores.
- Signature: `(response_text, session_id, model, platform, **kwargs) -> str | None`
- First non-empty string wins. Exceptions are logged; they do not crash the agent (unless `hold_stream=True`, see below).
- Without `hold_stream=True`, Desktop/TUI users watch the unannotated stream, then see it replaced by the rewrite.
- With `hold_stream=True`: Desktop shows only the busy indicator until the hook finishes; the rewrite is shown once. If the hook raises or times out and no rewrite was returned, the user gets a "reply withheld" notice, never the original.
- `hold_stream` applies only to this hook.
- Commentary / interim assistant messages do not pass through this hook; with hold_stream they are hidden.
- This hook can call another model (same or cheap) and splice `::term{...}` into the text, or call a purely mechanical annotator.

`post_llm_call` is observer-only (return ignored). It cannot change what was stored.

So option (a) **can** run in Hermes, but only as a **Python plugin half**, not as a desktop-only layer. A second LLM pass adds latency; with hold_stream the user waits; without it they see a flash of unlinked text.

## (c) Cheap model via a plugin backend route

Unified package layout (SDK doc): `~/.hermes/plugins/<id>/` with `plugin.yaml`, `dashboard/plugin_api.py` (`router = APIRouter()`, mounted at `/api/plugins/<id>/` at **gateway start**, imported only if the plugin is in `plugins.enabled` in `config.yaml`), and `desktop/plugin.js`.

`ctx.rest(path, opts?)` calls that namespace from the desktop half.

A desktop call to a cheap-model route **after** `message.complete` still cannot hyperlink the already-stored chat text. It could only fill a glossary pane (no inline tooltips in the transcript).

A cheap model is useful if it is invoked from `transform_llm_output` (same gateway process) to produce the glossary and the rewritten text. That is option (a) with a cheaper model, not a desktop-only route.

## Recommendation

- Simplest spike: **(b)** skill + `::term` directive + Tip + right pane.
- Closest to "a layer on any turn": **Python `transform_llm_output`** wrapping terms via a mechanical annotator first (no extra LLM), later a cheap model. Optional `hold_stream`.
- Do not start with (c) as a desktop-after-the-fact route if the goal is inline hyperlinks.

The headless spike should implement the mechanical annotator (the core of the automatic layer) and the directive parser (the core of (b)), so both paths are testable in Node without installing into live Desktop.
