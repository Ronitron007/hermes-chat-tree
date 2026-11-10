// Plugin factory: wires providers to the Hermes SDK pieces injected by the caller.
// Plain ESM; no SDK, react or Node imports so it can run under node --test.

import { createRegistry } from './providers.js';
import { createInlineProvider } from './inline-provider.js';
import { createSessionProvider } from './session-glossary.js';
import { createStaticProvider } from './static-glossary.js';
import { createMdnProvider } from './mdn-provider.js';
import { createWikipediaProvider, createWiktionaryProvider } from './wiki-provider.js';
import { createCoinedProvider } from './coined-provider.js';
import { createLlmProvider } from './llm-provider.js';
import { materializeTermline } from './termline.js';

export const PLUGIN_ID = 'concept-links';
export const PANE_ID = 'glossary';
export const SETTINGS_PANE_ID = 'providers';
export const DIRECTIVE_NAME = 'term';
export const TERMLINE_DIRECTIVE_NAME = 'termline';
export const HOVER_DELAY_MS = 650;

const NO_DEF = 'No definition yet';
const CHIP_CLASS = 'inline cursor-pointer underline decoration-dotted underline-offset-2';
const PARAGRAPH_CLASS = 'leading-relaxed break-words';
// Inline so the chip does not depend on utilities missing from the Desktop CSS bundle (decoration-dotted).
const CHIP_STYLE = {
  display: 'inline',
  padding: 0,
  margin: 0,
  border: 'none',
  background: 'none',
  font: 'inherit',
  color: 'inherit',
  cursor: 'pointer',
  textDecoration: 'underline dotted',
  textUnderlineOffset: '2px',
};

const SAMPLE_TERMLINE = {
  v: 'A monoid lets you fold a list in any grouping, and a functor maps over it.',
  t: 'monoid=A set with an associative operation and an identity element;;functor=A mapping between categories that preserves structure',
};

// attrs are untrusted model output: only trimmed strings are used.
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const isThenable = (v) => v != null && typeof v.then === 'function';

export function createDefaultRegistry() {
  const registry = createRegistry();
  const session = createSessionProvider();
  session.bind(registry);
  for (const provider of [
    createInlineProvider(),
    session,
    createStaticProvider(),
    createMdnProvider(),
    createWiktionaryProvider(),
    createWikipediaProvider(),
    createCoinedProvider(),
    createLlmProvider(),
  ]) registry.register(provider);
  return registry;
}

export function createPlugin(deps) {
  const { host, jsx, jsxs, atom, useValue, Tip, Button, ScrollArea, EmptyState, Badge, Switch, Separator } = deps;
  const registry = deps.registry ?? createDefaultRegistry();
  const fetchFn =
    deps.fetch ?? (typeof globalThis.fetch === 'function' ? (...args) => globalThis.fetch(...args) : undefined);

  const $selectedTerm = atom(null);
  const $prefsTick = atom(0);
  let storage = null;
  let rest;
  let userGlossary = [];
  let tick = 0;

  const sameTerm = (sel, name, sessionId) => sel && sel.name === name && sel.sessionId === sessionId;

  function persistPrefs() {
    const list = registry.list();
    storage?.set?.('providerPrefs', {
      order: list.map((p) => p.id),
      disabled: list.filter((p) => registry.isDisabled(p.id)).map((p) => p.id),
    });
    $prefsTick.set(++tick);
  }

  // The session provider replays recorded defs, so a disabled inline provider
  // must not leak its attribute def into the session store.
  const recordedDef = (def) => (def && !registry.isDisabled('inline') ? def : undefined);

  function makeChip({ name, def, sid, source, attrs, key }) {
    const lookupCtx = { sessionId: sid, attrs, source, userGlossary, fetch: fetchFn, rest };
    const sync = registry.lookupSync(name, lookupCtx);

    const text = sync?.short || NO_DEF;
    const label = jsxs('div', {
      children: [
        jsx('span', { children: text }),
        sync?.source ? jsx('span', { className: 'block text-xs opacity-70', children: sync.source }) : null,
        sync?.kind === 'coined' ? jsx(Badge, { children: 'coined' }) : null,
      ].filter(Boolean),
    });

    const onClick = () => {
      $selectedTerm.set({ name, sessionId: sid, definition: sync });
      if (typeof host?.revealPane === 'function') host.revealPane(`${PLUGIN_ID}:${PANE_ID}`);
      let pending;
      try {
        pending = Promise.resolve(registry.lookup(name, lookupCtx));
      } catch {
        return;
      }
      pending.then(
        (found) => {
          if (found && sameTerm($selectedTerm.get(), name, sid)) {
            $selectedTerm.set({ name, sessionId: sid, definition: found });
          }
        },
        () => {},
      );
    };

    const chip = jsx('button', { type: 'button', onClick, className: CHIP_CLASS, style: CHIP_STYLE, children: name });
    return jsx(Tip, { delayDuration: HOVER_DELAY_MS, label, children: chip }, key);
  }

  // Mid-sentence use still works for old chats and models that ignore the skill,
  // but the Desktop host splits a paragraph around every claimed directive
  // (markdown-text.tsx, MarkdownParagraph), so the chip lands in its own block.
  // Whole sentences go through `termline` instead.
  function renderTerm({ attrs, source, streaming, sessionId } = {}) {
    const name = str(attrs?.name);
    if (!name) return jsx('span', { children: source });
    const def = str(attrs?.def);
    const sid = sessionId ?? null;
    if (!streaming) registry.recordUse({ name, def: recordedDef(def), sessionId: sid, source, attrs });
    return makeChip({ name, def, sid, source, attrs });
  }

  function renderTermline({ attrs, source, streaming, sessionId } = {}) {
    const parsed = materializeTermline(attrs);
    if (!parsed.pieces.length) return jsx('span', { children: source });
    const sid = sessionId ?? null;
    const children = parsed.pieces.map((piece, i) => {
      if (piece.kind === 'text') return piece.text;
      const { name, def } = piece;
      const termAttrs = { name, def };
      if (!streaming) {
        registry.recordUse({
          name,
          def: recordedDef(def),
          sessionId: sid,
          source,
          attrs: termAttrs,
          surrounding: parsed.sentence,
        });
      }
      return makeChip({ name, def, sid, source, attrs: termAttrs, key: `t${i}` });
    });
    // Not a <p>: the host already gives a solo directive its own block.
    return jsxs('span', { className: PARAGRAPH_CLASS, style: { display: 'block' }, children });
  }

  // Rows for the provider list. Shared by the Concepts pane and the standalone
  // settings pane because the host may never tab the second pane.
  function providerRows() {
    useValue($prefsTick);
    const list = registry.list();
    const setDisabledFor = (id, off) => {
      const next = list.map((p) => p.id).filter((pid) => (pid === id ? off : registry.isDisabled(pid)));
      registry.setDisabled(next);
      persistPrefs();
    };
    const move = (index, delta) => {
      const ids = list.map((p) => p.id);
      const to = index + delta;
      if (to < 0 || to >= ids.length) return;
      [ids[index], ids[to]] = [ids[to], ids[index]];
      registry.setOrder(ids);
      persistPrefs();
    };
    const rows = [];
    list.forEach((provider, index) => {
      const enabled = !registry.isDisabled(provider.id);
      if (index > 0) rows.push(jsx(Separator, {}, `sep-${provider.id}`));
      rows.push(
        jsxs(
          'div',
          {
            className: 'flex items-center gap-2',
            children: [
              jsx('span', { className: 'flex-1 text-sm', children: `${provider.label} (${provider.id})` }),
              jsx(Switch, {
                checked: enabled,
                'aria-label': `Enable ${provider.label}`,
                onCheckedChange: (on) => setDisabledFor(provider.id, !on),
                onClick: () => setDisabledFor(provider.id, enabled),
              }),
              jsx(Button, { type: 'button', onClick: () => move(index, -1), children: 'Up' }),
              jsx(Button, { type: 'button', onClick: () => move(index, 1), children: 'Down' }),
            ],
          },
          provider.id,
        ),
      );
    });
    return rows;
  }

  function providersSection() {
    return jsxs('div', {
      className: 'flex flex-col gap-2',
      children: [jsx('h3', { className: 'text-sm font-semibold', children: 'Providers' }), ...providerRows()],
    });
  }

  function renderPane() {
    const selected = useValue($selectedTerm);
    const section = providersSection();
    const wrap = (children) =>
      jsx(ScrollArea, { children: jsxs('div', { className: 'flex flex-col gap-3 p-4', children }) });
    if (!selected) {
      return wrap([
        jsx(EmptyState, {
          title: 'No concept selected',
          description: 'Click a dotted term in the chat to see it here.',
        }),
        jsx(Separator, {}),
        jsxs('div', {
          className: 'flex flex-col gap-2',
          children: [
            jsx('h3', { className: 'text-sm font-semibold', children: 'Sample' }),
            renderTermline({
              attrs: SAMPLE_TERMLINE,
              source: '::termline',
              streaming: true,
              sessionId: 'sample',
            }),
          ],
        }),
        jsx(Separator, {}),
        section,
      ]);
    }
    const { name, sessionId, definition } = selected;
    const hasQuote = (v) => typeof v === 'string' && v.trim() !== '';
    const defTexts = [definition?.short, definition?.long].filter(hasQuote).map((t) => t.trim());
    const quotes = registry
      .usesFor(name, sessionId)
      .map((u) => u.quote)
      .filter(hasQuote);
    const fromDefinition = definition?.firstUse?.quote;
    const first =
      quotes[0] ?? (hasQuote(fromDefinition) && !defTexts.includes(fromDefinition.trim()) ? fromDefinition : null);
    const firstText = first ? first.trim() : null;
    const laterQuotes = [...new Set(quotes.map((q) => q.trim()))].filter((q) => q !== firstText);
    const kind = definition?.kind;
    return wrap(
      [
        jsx('h2', { className: 'text-base font-semibold', children: name }),
        kind === 'coined' || kind === 'uncertain' ? jsx(Badge, { children: kind }) : null,
        jsx('p', { className: 'text-sm', children: definition?.long || definition?.short || NO_DEF }),
        definition?.source ? jsx('p', { className: 'text-xs opacity-70', children: `Source: ${definition.source}` }) : null,
        definition?.providerId
          ? jsx('p', { className: 'text-xs opacity-70', children: `Provider: ${definition.providerId}` })
          : null,
        first ? jsx('p', { className: 'text-sm', children: `First use in this session: ${first}` }) : null,
        laterQuotes.length
          ? jsxs('div', {
              children: [
                jsx('h3', { className: 'text-sm font-semibold', children: 'Uses in this session' }),
                jsx('ul', {
                  className: 'text-sm',
                  children: laterQuotes.map((q, i) => jsx('li', { children: q }, i)),
                }),
              ],
            })
          : null,
        jsx(Button, { type: 'button', onClick: () => $selectedTerm.set(null), children: 'Clear' }),
        jsx(Separator, {}),
        section,
      ].filter(Boolean),
    );
  }

  function renderSettings() {
    return jsx(ScrollArea, { children: jsxs('div', { className: 'flex flex-col gap-2 p-4', children: providerRows() }) });
  }

  function applyPrefs(prefs) {
    if (prefs && typeof prefs === 'object') {
      if (Array.isArray(prefs.order)) registry.setOrder(prefs.order);
      if (Array.isArray(prefs.disabled)) registry.setDisabled(prefs.disabled);
    }
    $prefsTick.set(++tick);
  }

  function applyGlossary(value) {
    if (Array.isArray(value) || (value && typeof value === 'object')) userGlossary = value;
  }

  // Storage may be sync or promise-based; handle both.
  const read = (key, fallback, apply) => {
    let value;
    try {
      value = storage.get(key);
    } catch {
      return;
    }
    if (isThenable(value)) value.then((v) => apply(v ?? fallback), () => {});
    else apply(value ?? fallback);
  };

  function register(ctx) {
    rest = ctx?.rest;
    storage = ctx?.storage ?? null;
    ctx.register({ id: DIRECTIVE_NAME, area: 'transcript.directives', data: { name: DIRECTIVE_NAME, render: renderTerm } });
    ctx.register({
      id: TERMLINE_DIRECTIVE_NAME,
      area: 'transcript.directives',
      data: { name: TERMLINE_DIRECTIVE_NAME, render: renderTermline },
    });
    ctx.register({
      id: PANE_ID,
      area: 'panes',
      title: 'Concepts',
      data: { placement: 'right', width: '340px' },
      render: renderPane,
    });
    ctx.register({
      id: SETTINGS_PANE_ID,
      area: 'panes',
      title: 'Concept providers',
      data: { placement: 'right', width: '340px' },
      render: renderSettings,
    });
    ctx.register({
      id: 'open-concepts',
      area: 'palette',
      data: {
        id: 'open-concepts',
        label: 'Open concepts pane',
        keywords: ['concept', 'term', 'glossary', 'definition'],
        run: () => {
          if (typeof host?.revealPane === 'function') host.revealPane(`${PLUGIN_ID}:${PANE_ID}`);
        },
      },
    });
    ctx.register({
      id: 'open-provider-settings',
      area: 'palette',
      data: {
        id: 'open-provider-settings',
        label: 'Concept provider settings',
        keywords: ['provider', 'settings', 'glossary', 'concept'],
        run: () => {
          if (typeof host?.revealPane === 'function') host.revealPane(`${PLUGIN_ID}:${PANE_ID}`);
          if (typeof host?.undismissPane === 'function') host.undismissPane(`${PLUGIN_ID}:${SETTINGS_PANE_ID}`);
          if (typeof host?.revealPane === 'function') host.revealPane(`${PLUGIN_ID}:${SETTINGS_PANE_ID}`);
        },
      },
    });
    if (storage) {
      read('providerPrefs', {}, applyPrefs);
      read('userGlossary', [], applyGlossary);
    }
  }

  return {
    register,
    registry,
    $selectedTerm,
    $prefsTick,
    renderTerm,
    renderTermline,
    renderPane,
    renderSettings,
    PLUGIN_ID,
    PANE_ID,
    SETTINGS_PANE_ID,
    DIRECTIVE_NAME,
    TERMLINE_DIRECTIVE_NAME,
    HOVER_DELAY_MS,
  };
}
