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

export const PLUGIN_ID = 'concept-links';
export const PANE_ID = 'glossary';
export const SETTINGS_PANE_ID = 'providers';
export const DIRECTIVE_NAME = 'term';
export const HOVER_DELAY_MS = 650;

const NO_DEF = 'No definition yet';
const CHIP_CLASS = 'cursor-pointer underline decoration-dotted underline-offset-2';

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

  function renderTerm({ attrs, source, sessionId } = {}) {
    const name = str(attrs?.name);
    if (!name) return jsx('span', { children: source });
    const def = str(attrs?.def);
    const sid = sessionId ?? null;
    registry.recordUse({ name, def: def || undefined, sessionId: sid, source, attrs });
    const lookupCtx = { sessionId: sid, attrs, source, userGlossary, fetch: fetchFn, rest };
    const sync = registry.lookupSync(name, lookupCtx);

    const text = sync?.short || def || NO_DEF;
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

    const chip = jsx('button', { type: 'button', onClick, className: CHIP_CLASS, children: name });
    return jsx(Tip, { delayDuration: HOVER_DELAY_MS, label, children: chip });
  }

  function renderPane() {
    const selected = useValue($selectedTerm);
    if (!selected) {
      return jsx(EmptyState, {
        title: 'No concept selected',
        description: 'Click a dotted term in the chat to see it here.',
      });
    }
    const { name, sessionId, definition } = selected;
    const first = definition?.firstUse?.quote ?? registry.firstUse(name, sessionId)?.quote ?? null;
    const uses = registry.usesFor(name, sessionId);
    const kind = definition?.kind;
    const children = [
      jsx('h2', { className: 'text-base font-semibold', children: name }),
      kind === 'coined' || kind === 'uncertain' ? jsx(Badge, { children: kind }) : null,
      jsx('p', { className: 'text-sm', children: definition?.long || definition?.short || NO_DEF }),
      definition?.source ? jsx('p', { className: 'text-xs opacity-70', children: `Source: ${definition.source}` }) : null,
      definition?.providerId
        ? jsx('p', { className: 'text-xs opacity-70', children: `Provider: ${definition.providerId}` })
        : null,
      first ? jsx('p', { className: 'text-sm', children: `First use in this session: ${first}` }) : null,
      uses.length
        ? jsxs('div', {
            children: [
              jsx('h3', { className: 'text-sm font-semibold', children: 'Uses in this session' }),
              jsx('ul', {
                className: 'text-sm',
                children: uses.map((u) => jsx('li', { children: u.quote || u.def || u.name }, u.at)),
              }),
            ],
          })
        : null,
      jsx(Button, { type: 'button', onClick: () => $selectedTerm.set(null), children: 'Clear' }),
    ].filter(Boolean);
    return jsx(ScrollArea, { children: jsxs('div', { className: 'flex flex-col gap-3 p-4', children }) });
  }

  function renderSettings() {
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
    return jsx(ScrollArea, { children: jsxs('div', { className: 'flex flex-col gap-2 p-4', children: rows }) });
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
    renderPane,
    renderSettings,
    PLUGIN_ID,
    PANE_ID,
    SETTINGS_PANE_ID,
    DIRECTIVE_NAME,
    HOVER_DELAY_MS,
  };
}
