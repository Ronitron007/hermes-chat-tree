import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPlugin,
  createDefaultRegistry,
  PLUGIN_ID,
  PANE_ID,
  SETTINGS_PANE_ID,
  DIRECTIVE_NAME,
  HOVER_DELAY_MS,
} from '../src/plugin-factory.js';

const el = (type, props) => ({ type, props });
const Tip = function Tip() {};
const Button = function Button() {};
const ScrollArea = function ScrollArea() {};
const EmptyState = function EmptyState() {};
const Badge = function Badge() {};
const Switch = function Switch() {};
const Separator = function Separator() {};

function atom(initial) {
  let value = initial;
  const subs = new Set();
  return {
    get: () => value,
    set(next) {
      value = next;
      subs.forEach((fn) => fn(value));
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

function memoryStorage(seed = {}) {
  const data = { ...seed };
  return { data, get: (k) => data[k], set: (k, v) => void (data[k] = v) };
}

// Never let a test reach the real network: the factory defaults to globalThis.fetch.
const offline = async () => ({ ok: false, status: 404, json: async () => ({}) });

function setup({ host = {}, registry, storage, fetch = offline } = {}) {
  const registered = [];
  const plugin = createPlugin({
    host, jsx: el, jsxs: el, atom, useValue: (s) => s.get(),
    Tip, Button, ScrollArea, EmptyState, Badge, Switch, Separator, registry, fetch,
  });
  plugin.register({ register: (c) => registered.push(c), storage });
  const byId = (id) => registered.find((c) => c.id === id);
  return {
    plugin, registered, storage,
    directive: byId('term'),
    pane: byId('glossary'),
    settings: byId('providers'),
    palette: registered.find((c) => c.area === 'palette'),
  };
}

// Depth-first collection of every node (and string) in a mock tree.
function walk(node, out = []) {
  out.push(node);
  if (node && typeof node === 'object') {
    const kids = node.props?.children;
    for (const k of Array.isArray(kids) ? kids : kids === undefined ? [] : [kids]) walk(k, out);
    if (node.props?.label) walk(node.props.label, out);
  }
  return out;
}
const texts = (tree) => walk(tree).filter((n) => typeof n === 'string');
const hasText = (tree, needle) => texts(tree).some((t) => t.includes(needle));
const findAll = (tree, type) => walk(tree).filter((n) => n && n.type === type);
const buttonNamed = (tree, label) => findAll(tree, Button).find((b) => b.props.children === label);
const render = (directive, attrs, extra = {}) =>
  directive.data.render({ attrs, source: '::term', streaming: false, sessionId: 's1', ...extra });
const tick = () => new Promise((r) => setTimeout(r, 0));

test('constants are exported and returned by the plugin', () => {
  assert.deepEqual([PLUGIN_ID, PANE_ID, SETTINGS_PANE_ID, DIRECTIVE_NAME, HOVER_DELAY_MS],
    ['concept-links', 'glossary', 'providers', 'term', 650]);
  const { plugin } = setup();
  assert.equal(plugin.PLUGIN_ID, PLUGIN_ID);
  assert.equal(plugin.HOVER_DELAY_MS, 650);
});

test('createDefaultRegistry lists eight providers in chain order, llm disabled, static resolves', () => {
  const registry = createDefaultRegistry();
  assert.deepEqual(registry.list().map((p) => p.id),
    ['inline', 'session', 'static', 'mdn', 'wiktionary', 'wikipedia', 'coined', 'llm']);
  assert.equal(registry.isDisabled('llm'), true);
  assert.equal(registry.isDisabled('inline'), false);
  const def = registry.lookupSync('monoid', {});
  assert.equal(def.providerId, 'static');
});

test('register contributes directive, two right panes and the palette command', () => {
  const calls = [];
  const { registered, directive, pane, settings, palette } = setup({ host: { revealPane: (id) => calls.push(id) } });
  assert.equal(registered.length, 4);
  assert.equal(directive.area, 'transcript.directives');
  assert.equal(directive.data.name, 'term');
  assert.equal(typeof directive.data.render, 'function');
  const panes = registered.filter((c) => c.area === 'panes');
  assert.equal(panes.length, 2);
  for (const p of panes) assert.deepEqual(p.data, { placement: 'right', width: '340px' });
  assert.equal(pane.title, 'Concepts');
  assert.equal(settings.title, 'Concept providers');
  assert.equal(palette.data.id, 'open-concepts');
  assert.equal(palette.data.label, 'Open concepts pane');
  assert.deepEqual(palette.data.keywords, ['concept', 'term', 'glossary', 'definition']);
  palette.data.run();
  assert.deepEqual(calls, ['concept-links:glossary']);
});

test('palette run without revealPane does not throw', () => {
  const { palette } = setup();
  assert.doesNotThrow(() => palette.data.run());
});

test('renderTerm: Tip delay, single button, click selects, reveals and records use', () => {
  const calls = [];
  const registry = createDefaultRegistry();
  const { plugin, directive } = setup({ host: { revealPane: (id) => calls.push(id) }, registry });
  const tree = render(directive, { name: 'widget', def: 'A small gadget' });
  assert.equal(tree.type, Tip);
  assert.equal(tree.props.delayDuration, 650);
  const chip = tree.props.children;
  assert.equal(chip.type, 'button');
  assert.equal(chip.props.type, 'button');
  assert.equal(chip.props.children, 'widget');
  assert.ok(!/#|rgb|\[/.test(chip.props.className));
  assert.ok(registry.usesFor('widget', 's1').length >= 1);
  chip.props.onClick();
  const sel = plugin.$selectedTerm.get();
  assert.equal(sel.name, 'widget');
  assert.equal(sel.sessionId, 's1');
  assert.equal(sel.definition.short, 'A small gadget');
  assert.deepEqual(calls, ['concept-links:glossary']);
});

test('renderTerm: click without revealPane still sets state', () => {
  const { plugin, directive } = setup({ host: {} });
  const tree = render(directive, { name: 'widget', def: 'x' }, { sessionId: undefined });
  assert.doesNotThrow(() => tree.props.children.props.onClick());
  assert.equal(plugin.$selectedTerm.get().name, 'widget');
  assert.equal(plugin.$selectedTerm.get().sessionId, null);
});

test('renderTerm without a name returns a span with the source', () => {
  const { directive } = setup();
  for (const attrs of [{}, { name: '   ' }, null, { name: 42 }]) {
    const tree = render(directive, attrs, { source: '::term{x}' });
    assert.equal(tree.type, 'span');
    assert.equal(tree.props.children, '::term{x}');
  }
});

test('tooltip label shows the short definition and source; no definition falls back', () => {
  const { directive } = setup();
  const tip = render(directive, { name: 'widget', def: 'A small gadget' });
  assert.ok(hasText(tip.props.label, 'A small gadget'));
  assert.ok(hasText(tip.props.label, 'Inline directive'));
  assert.equal(findAll(tip.props.label, Badge).length, 0);

  const bare = render(directive, { name: 'zzz-unknown-term' });
  assert.equal(bare.props.children.props.children, 'zzz-unknown-term');
  assert.ok(hasText(bare.props.label, 'No definition yet'));
});

test('tooltip shows a coined badge when the sync result is coined', () => {
  const registry = createDefaultRegistry();
  registry.setDisabled(registry.list().map((p) => p.id));
  registry.register({
    id: 'stub-coined',
    label: 'Stub',
    canResolve: () => true,
    resolve: () => ({ short: 'inferred', long: 'inferred from context. x', source: 'First use in session', kind: 'coined' }),
  });
  registry.setDisabled(['inline', 'session', 'static', 'mdn', 'wiktionary', 'wikipedia', 'coined', 'llm']);
  const { directive } = setup({ registry });
  const tip = render(directive, { name: 'blorp' });
  const badges = findAll(tip.props.label, Badge);
  assert.equal(badges.length, 1);
  assert.equal(badges[0].props.children, 'coined');
});

test('coined fallback end to end: only coined enabled, first-use quote, wikis miss', async () => {
  const registry = createDefaultRegistry();
  registry.setDisabled(registry.list().map((p) => p.id).filter((id) => id !== 'coined'));
  const { plugin, directive, pane } = setup({ registry });
  const tip = render(directive, { name: 'blorp' });
  assert.ok(hasText(tip.props.label, 'No definition yet'));
  tip.props.children.props.onClick();
  await tick();
  const def = plugin.$selectedTerm.get().definition;
  assert.equal(def.kind, 'coined');
  assert.ok(def.long.includes('inferred from context'));
  const tree = pane.render();
  assert.equal(findAll(tree, Badge)[0].props.children, 'coined');
});

test('pane: empty state, then name, long text, source, provider, uses and Clear', () => {
  const { plugin, directive, pane } = setup();
  assert.equal(pane.render().type, EmptyState);
  assert.equal(pane.render().props.title, 'No concept selected');

  render(directive, { name: 'widget', def: 'A small gadget' });
  render(directive, { name: 'widget', def: 'A small gadget' });
  plugin.$selectedTerm.set({
    name: 'widget',
    sessionId: 's1',
    definition: { short: 's', long: 'The long text', source: 'Some Source', providerId: 'prov', kind: 'standard', firstUse: null },
  });
  const tree = pane.render();
  assert.equal(tree.type, ScrollArea);
  assert.ok(hasText(tree, 'widget'));
  assert.ok(hasText(tree, 'The long text'));
  assert.ok(hasText(tree, 'Some Source'));
  assert.ok(hasText(tree, 'prov'));
  assert.ok(hasText(tree, 'First use'));
  assert.equal(walk(tree).filter((n) => n?.type === 'li').length, 2);
  assert.equal(findAll(tree, Badge).length, 0);

  buttonNamed(tree, 'Clear').props.onClick();
  assert.equal(plugin.$selectedTerm.get(), null);
  assert.equal(pane.render().type, EmptyState);
});

test('pane shows uncertain badge', () => {
  const { plugin, pane } = setup();
  plugin.$selectedTerm.set({ name: 'q', sessionId: null, definition: { short: 'n', long: 'n', kind: 'uncertain' } });
  assert.equal(findAll(pane.render(), Badge)[0].props.children, 'uncertain');
});

test('click then async lookup upgrades the selected definition', async () => {
  const registry = createDefaultRegistry();
  registry.register({
    id: 'rich',
    label: 'Rich',
    canResolve: () => true,
    resolve: async () => ({ short: 'rich short', long: 'rich long', source: 'Rich', kind: 'standard' }),
  });
  registry.setOrder(['rich']);
  const { plugin, directive } = setup({ registry });
  const tree = render(directive, { name: 'monoid' });
  tree.props.children.props.onClick();
  assert.equal(plugin.$selectedTerm.get().definition.providerId, 'static');
  await tick();
  assert.equal(plugin.$selectedTerm.get().definition.long, 'rich long');
  assert.equal(plugin.$selectedTerm.get().definition.providerId, 'rich');
});

test('async lookup does not clobber a later selection or a cleared pane', async () => {
  const registry = createDefaultRegistry();
  let release;
  registry.register({
    id: 'slow',
    label: 'Slow',
    canResolve: (t) => t === 'monoid',
    resolve: () => new Promise((r) => (release = () => r({ short: 'late', long: 'late', source: 'S' }))),
  });
  registry.setOrder(['slow']);
  const { plugin, directive } = setup({ registry });
  render(directive, { name: 'monoid' }).props.children.props.onClick();
  render(directive, { name: 'semigroup' }).props.children.props.onClick();
  release();
  await tick();
  assert.equal(plugin.$selectedTerm.get().name, 'semigroup');
  assert.notEqual(plugin.$selectedTerm.get().definition?.long, 'late');
});

test('async lookup errors are swallowed', async () => {
  const registry = createDefaultRegistry();
  registry.lookup = () => Promise.reject(new Error('boom'));
  const { plugin, directive } = setup({ registry });
  render(directive, { name: 'monoid' }).props.children.props.onClick();
  await tick();
  assert.equal(plugin.$selectedTerm.get().name, 'monoid');
});

test('settings: lists providers, Switch toggles disabled via onCheckedChange and onClick, persists', () => {
  const storage = memoryStorage();
  const registry = createDefaultRegistry();
  const { settings } = setup({ registry, storage });
  let tree = settings.render();
  const switches = () => findAll(tree, Switch);
  assert.equal(switches().length, 8);
  assert.ok(hasText(tree, 'Inline directive (inline)'));
  assert.equal(switches()[0].props.checked, true);
  assert.equal(switches()[7].props.checked, false);

  switches()[2].props.onCheckedChange(false);
  assert.equal(registry.isDisabled('static'), true);
  assert.equal(registry.isDisabled('llm'), true);
  assert.deepEqual(storage.data.providerPrefs.disabled.sort(), ['llm', 'static']);

  tree = settings.render();
  assert.equal(switches()[2].props.checked, false);
  switches()[2].props.onClick();
  assert.equal(registry.isDisabled('static'), false);
  assert.deepEqual(storage.data.providerPrefs.disabled, ['llm']);

  tree = settings.render();
  switches()[7].props.onCheckedChange(true);
  assert.equal(registry.isDisabled('llm'), false);
  assert.deepEqual(storage.data.providerPrefs.disabled, []);
});

test('settings: Up/Down reorder, no-op at the ends, and persist', () => {
  const storage = memoryStorage();
  const registry = createDefaultRegistry();
  const { settings } = setup({ registry, storage });
  const ids = () => registry.list().map((p) => p.id);
  const rowButtons = (row, label) =>
    walk(findAll(settings.render(), 'div').filter((d) => d.props.className?.includes('items-center'))[row])
      .find((n) => n?.type === Button && n.props.children === label);

  rowButtons(1, 'Up').props.onClick();
  assert.deepEqual(ids().slice(0, 3), ['session', 'inline', 'static']);
  assert.deepEqual(storage.data.providerPrefs.order, ids());

  rowButtons(0, 'Up').props.onClick();
  assert.deepEqual(ids().slice(0, 2), ['session', 'inline']);

  rowButtons(0, 'Down').props.onClick();
  assert.deepEqual(ids().slice(0, 2), ['inline', 'session']);

  rowButtons(7, 'Down').props.onClick();
  assert.equal(ids()[7], 'llm');
});

test('settings work without storage', () => {
  const registry = createDefaultRegistry();
  const { settings } = setup({ registry });
  findAll(settings.render(), Switch)[0].props.onCheckedChange(false);
  assert.equal(registry.isDisabled('inline'), true);
});

test('register applies stored providerPrefs and userGlossary', () => {
  const registry = createDefaultRegistry();
  const storage = memoryStorage({
    providerPrefs: { order: ['static', 'inline'], disabled: ['mdn'] },
    userGlossary: [{ term: 'frobnicate', def: 'To fiddle with.' }],
  });
  const { directive } = setup({ registry, storage });
  assert.deepEqual(registry.list().slice(0, 3).map((p) => p.id), ['static', 'inline', 'session']);
  assert.equal(registry.isDisabled('mdn'), true);
  assert.equal(registry.isDisabled('llm'), false);
  const tip = render(directive, { name: 'frobnicate' });
  assert.ok(hasText(tip.props.label, 'To fiddle with.'));
  assert.ok(hasText(tip.props.label, 'User glossary'));
});

test('register keeps the default disabled set when providerPrefs has no disabled', () => {
  const registry = createDefaultRegistry();
  setup({ registry, storage: memoryStorage({ providerPrefs: { order: ['static'] } }) });
  assert.equal(registry.list()[0].id, 'static');
  assert.equal(registry.isDisabled('llm'), true);
});

test('register accepts promise-based storage', async () => {
  const registry = createDefaultRegistry();
  const data = { providerPrefs: { disabled: [] } };
  const storage = { get: async (k) => data[k], set: async () => {} };
  setup({ registry, storage });
  await tick();
  assert.equal(registry.isDisabled('llm'), false);
});

test('lookup ctx carries rest captured at register time and the injected fetch', async () => {
  const seen = [];
  const registry = createDefaultRegistry();
  registry.register({
    id: 'spy',
    label: 'Spy',
    canResolve: (t, ctx) => (seen.push(ctx), false),
    resolve: () => null,
  });
  registry.setOrder(['spy']);
  const registered = [];
  const rest = () => {};
  const fetch = () => {};
  const plugin = createPlugin({
    host: {}, jsx: el, jsxs: el, atom, useValue: (s) => s.get(),
    Tip, Button, ScrollArea, EmptyState, Badge, Switch, Separator, registry, fetch,
  });
  plugin.register({ register: (c) => registered.push(c), rest });
  registered[0].data.render({ attrs: { name: 'monoid' }, source: '', sessionId: 's9' });
  assert.equal(seen[0].rest, rest);
  assert.equal(seen[0].fetch, fetch);
  assert.equal(seen[0].sessionId, 's9');
});
