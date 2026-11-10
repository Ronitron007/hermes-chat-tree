# Evidence: plugin constraints and spike rules

- Hermes Desktop plugin SDK v0.23.0 (same as hermes-widgets). Checkout: `/home/box/.hermes/hermes-agent`.
- A disk plugin is a single ESM `plugin.js` that may import only `@hermes/plugin-sdk`, `react`, and `react/jsx-runtime`.
- No JSX in disk plugins (loaded uncompiled). Use `jsx()` / `jsxs()` / `createElement`.
- No eval, no `new Function`, no dynamic `import()`, no Node built-ins in the shipped plugin.
- Rohan's decision: use only the Hermes UI kit. No bundled external component libraries. Do not push past the SDK.
- Panes: `area: 'panes'` + `data.placement: 'right'`.
- Do not install anything into the live Hermes Desktop in this spike.
- Do not touch `/home/box/mr`, hermes-widgets-pr2 `src/`, `desktop/`, or `tests/`, or other bots' worktrees.
- Headless work lives in this repo (`/workspace/concept-links-spike`). Node built-in test runner only (`node --test`). No new npm dependencies.
- Local git commits inside this scratch repo are allowed only as needed for a clean tree. Do not `git push`. Do not add a remote.

# Desired user experience (Rohan t129u)

LLMs invent or assume terms that are dense for a human reading a deep coding explanation. Build a layer that takes a turn's output and hyperlinks concepts/definitions. Simple spike: any marked term in the chat text has tooltip access; clicking it opens something in the side pane.
