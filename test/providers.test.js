import test from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry, normalizeTerm, clipWords } from '../src/providers.js';
import { createInlineProvider } from '../src/inline-provider.js';
import { createSessionProvider } from '../src/session-glossary.js';
import { createStaticProvider, DEFAULT_GLOSSARY } from '../src/static-glossary.js';

function fake(id, { can = true, result, counter } = {}) {
  return {
    id,
    label: id,
    canResolve: () => (typeof can === 'function' ? can() : can),
    resolve: () => {
      if (counter) counter.n++;
      return typeof result === 'function' ? result() : result;
    },
  };
}
const def = (short) => ({ short, long: short, source: 'fake', kind: 'standard', url: null, firstUse: null });
const ids = (registry) => registry.list().map((p) => p.id);

function fullRegistry() {
  const r = createRegistry();
  r.register(createInlineProvider());
  r.register(createSessionProvider());
  r.register(createStaticProvider());
  return r;
}

test('normalizeTerm trims, collapses whitespace and case-folds', () => {
  assert.equal(normalizeTerm('  Merkle   TREE\n'), 'merkle tree');
  assert.equal(normalizeTerm(''), '');
  assert.equal(normalizeTerm(null), '');
});

test('clipWords keeps short text, keeps exact limit, cuts with ellipsis', () => {
  assert.equal(clipWords('one two', 5), 'one two');
  assert.equal(clipWords('one two three', 3), 'one two three');
  assert.equal(clipWords('one two three four', 3), 'one two three\u2026');
  assert.equal(clipWords('  ', 3), '');
});

test('registry default order, setOrder, setDisabled, list and missing providers', () => {
  const r = createRegistry();
  assert.deepEqual(ids(r), []);
  assert.equal(r.lookupSync('x', {}), null);
  for (const id of ['llm', 'static', 'inline', 'session']) r.register(fake(id));
  assert.deepEqual(ids(r), ['inline', 'session', 'static', 'llm']);
  assert.equal(r.isDisabled('llm'), true);
  assert.equal(r.isDisabled('inline'), false);
  r.setOrder(['static', 'inline']);
  assert.deepEqual(ids(r), ['static', 'inline', 'session', 'llm']);
  r.setDisabled(['session', 'nope']);
  assert.equal(r.isDisabled('session'), true);
  assert.equal(r.isDisabled('nope'), false);
  assert.equal(r.isDisabled('llm'), false);
  assert.equal(ids(r).length, 4);
  assert.equal(r.get('static').id, 'static');
  assert.equal(r.get('nope'), null);
  r.register(fake('static', { result: def('replaced') }));
  assert.equal(r.list().length, 4);
  assert.equal(r.lookupSync('x', {}).short, 'replaced');
});

test('fallback: inline cannot resolve so static is used', async () => {
  const r = fullRegistry();
  const d = await r.lookup('Monoid', { sessionId: 's', attrs: null });
  assert.equal(d.providerId, 'static');
  assert.equal(d.source, 'Static glossary');
  const inline = await r.lookup('monoid', { sessionId: 't', attrs: { def: ' my own ' } });
  assert.equal(inline.providerId, 'inline');
  assert.equal(inline.short, 'my own');
});

test('fallback: session def beats static', async () => {
  const r = fullRegistry();
  r.recordUse({ name: 'monoid', def: 'session meaning', sessionId: 's1' });
  assert.equal((await r.lookup('monoid', { sessionId: 's1' })).providerId, 'session');
  assert.equal((await r.lookup('monoid', { sessionId: 's2' })).providerId, 'static');
});

test('disabled provider is skipped', async () => {
  const r = createRegistry();
  r.register(fake('inline', { result: def('A') }));
  r.register(fake('static', { result: def('B') }));
  r.setDisabled(['inline']);
  assert.equal((await r.lookup('t', {})).short, 'B');
  assert.equal(r.lookupSync('t', {}).short, 'B');
  r.setDisabled([]);
  r.clearCache();
  assert.equal((await r.lookup('t', {})).short, 'A');
});

test('lookup caches per session and sessions do not share entries', async () => {
  const counter = { n: 0 };
  const r = createRegistry();
  r.register(fake('static', { result: def('x'), counter }));
  const a = await r.lookup('Term', { sessionId: 'a' });
  assert.equal(a.providerId, 'static');
  await r.lookup('  term ', { sessionId: 'a' });
  assert.equal(counter.n, 1);
  assert.equal(r.peekCache('term', 'a'), a);
  assert.equal(r.peekCache('term', 'b'), null);
  await r.lookup('term', { sessionId: 'b' });
  assert.equal(counter.n, 2);
  r.clearCache('a');
  assert.equal(r.peekCache('term', 'a'), null);
  assert.notEqual(r.peekCache('term', 'b'), null);
  r.clearCache();
  assert.equal(r.peekCache('term', 'b'), null);
});

test('cache hit skips later providers even if earlier ones change', async () => {
  const counter = { n: 0 };
  let early = null;
  const r = createRegistry();
  r.register(fake('inline', { result: () => early }));
  r.register(fake('static', { result: def('late'), counter }));
  assert.equal((await r.lookup('t', {})).short, 'late');
  early = def('early');
  assert.equal((await r.lookup('t', {})).short, 'late');
  assert.equal(counter.n, 1);
});

test('throwing and failing providers are skipped', async () => {
  const r = createRegistry();
  r.register({ id: 'inline', label: 'i', canResolve() { throw new Error('boom'); }, resolve: () => def('no') });
  r.register({ id: 'session', label: 's', canResolve: () => true, resolve() { throw new Error('boom'); } });
  r.register(fake('static', { result: Promise.reject(new Error('async boom')) }));
  r.register(fake('mdn', { result: def('') }));
  r.register(fake('wiktionary', { result: null }));
  r.register(fake('wikipedia', { result: def('winner') }));
  const d = await r.lookup('t', {});
  assert.equal(d.short, 'winner');
  assert.equal(d.providerId, 'wikipedia');
  assert.equal(r.lookupSync('t', {}).short, 'winner');
});

test('null results are not cached', async () => {
  let value = null;
  const counter = { n: 0 };
  const r = createRegistry();
  r.register(fake('static', { result: () => value, counter }));
  assert.equal(await r.lookup('t', { sessionId: 's' }), null);
  assert.equal(r.peekCache('t', 's'), null);
  value = def('now');
  assert.equal((await r.lookup('t', { sessionId: 's' })).short, 'now');
  assert.equal(counter.n, 2);
});

test('lookupSync ignores providers that return a Promise', async () => {
  const r = createRegistry();
  r.register(fake('inline', { result: Promise.resolve(def('async')) }));
  r.register(fake('static', { result: def('sync') }));
  assert.equal(r.lookupSync('t', {}).short, 'sync');
  assert.equal((await r.lookup('t', {})).short, 'async');
});

test('inline reads attrs.def, trims, rejects empty', () => {
  const p = createInlineProvider();
  assert.equal(p.id, 'inline');
  assert.equal(p.canResolve('t', { attrs: { def: '  hello world  ' } }), true);
  const d = p.resolve('t', { attrs: { def: '  hello world  ' } });
  assert.equal(d.short, 'hello world');
  assert.equal(d.source, 'Inline directive');
  assert.equal(d.kind, 'standard');
  assert.equal(d.providerId, 'inline');
  assert.equal(d.url, null);
  assert.equal(d.firstUse, null);
  for (const ctx of [{}, undefined, { attrs: null }, { attrs: {} }, { attrs: { def: '   ' } }, { attrs: { def: 5 } }]) {
    assert.equal(p.canResolve('t', ctx), false);
  }
  const long = Array.from({ length: 200 }, (_, i) => `w${i}`).join(' ');
  const clipped = p.resolve('t', { attrs: { def: long } });
  assert.equal(clipped.short.split(' ').length, 25);
  assert.ok(clipped.short.endsWith('\u2026'));
  assert.equal(clipped.long.split(' ').length, 120);
});

test('session records first use and later uses, first def wins, session scoped', async () => {
  const r = fullRegistry();
  const p = r.get('session');
  assert.equal(p.canResolve('foo', { registry: r, sessionId: 's1' }), false);
  r.recordUse({ name: 'Foo', def: '', sessionId: 's1', surrounding: 'Foo appears here' });
  assert.equal(p.canResolve('foo', { registry: r, sessionId: 's1' }), true);
  assert.equal(p.resolve('foo', { registry: r, sessionId: 's1' }), null);
  r.recordUse({ name: 'foo', def: 'first def', sessionId: 's1' });
  r.recordUse({ name: 'FOO', def: 'second def', sessionId: 's1' });
  r.recordUse({ name: 'foo', def: 'other session', sessionId: 's2' });

  const uses = r.usesFor('foo', 's1');
  assert.equal(uses.length, 3);
  assert.deepEqual(uses.map((u) => u.at), [...uses.map((u) => u.at)].sort((a, b) => a - b));
  assert.equal(uses[0].quote, 'Foo appears here');
  assert.equal(uses[1].quote, null);
  assert.equal(r.firstUse('foo', 's1'), uses[0]);
  assert.equal(r.usesFor('foo', 's2').length, 1);
  assert.equal(r.firstUse('bar', 's1'), null);
  r.recordUse({ name: 'bare', sessionId: 's1' });
  assert.equal(r.firstUse('bare', 's1').quote, null);

  const d = await r.lookup('foo', { sessionId: 's1' });
  assert.equal(d.short, 'first def');
  assert.equal(d.source, 'Session glossary');
  assert.equal(d.kind, 'standard');
  assert.deepEqual(d.firstUse, { quote: 'Foo appears here', sessionId: 's1' });
  assert.equal((await r.lookup('foo', { sessionId: 's2' })).short, 'other session');
  assert.equal(await r.lookup('foo', { sessionId: 's3' }), null);
});

test('recordUse: quote is the surrounding sentence, never the definition', () => {
  const r = createRegistry();
  assert.equal(r.recordUse({ name: 'a', def: 'the def', sessionId: 's' }).quote, null);
  assert.equal(r.recordUse({ name: 'b', def: 'the def', sessionId: 's', surrounding: 'A real sentence.' }).quote, 'A real sentence.');
  assert.equal(r.recordUse({ name: 'c', def: 'the def', sessionId: 's', surrounding: '   ' }).quote, null);
});

test('recordUse: same source or a streaming prefix is one use; no source always adds', () => {
  const r = createRegistry();
  const first = r.recordUse({ name: 'Foo', sessionId: 's', source: '::term{name="Foo"' });
  const again = r.recordUse({ name: 'foo', def: 'grown', sessionId: 's', source: '::term{name="Foo" def="grown"}' });
  assert.equal(again, first);
  assert.equal(r.usesFor('foo', 's').length, 1);
  assert.equal(first.source, '::term{name="Foo" def="grown"}');
  assert.equal(first.def, 'grown');

  // Shorter prefix arriving later does not shrink the stored source.
  r.recordUse({ name: 'foo', sessionId: 's', source: '::term{name="Foo"' });
  assert.equal(r.usesFor('foo', 's').length, 1);
  assert.equal(first.source, '::term{name="Foo" def="grown"}');

  // Same source gains a quote it lacked.
  r.recordUse({ name: 'foo', sessionId: 's', source: '::term{name="Foo" def="grown"}', surrounding: 'Foo is here.' });
  assert.equal(r.usesFor('foo', 's').length, 1);
  assert.equal(first.quote, 'Foo is here.');
  assert.equal(first.surrounding, 'Foo is here.');
  assert.equal(r.firstUse('foo', 's'), first);

  // Different source, other session, and missing source are separate uses.
  r.recordUse({ name: 'foo', sessionId: 's', source: 'unrelated' });
  r.recordUse({ name: 'foo', sessionId: 't', source: '::term{name="Foo"' });
  assert.equal(r.usesFor('foo', 's').length, 2);
  assert.equal(r.usesFor('foo', 't').length, 1);
  r.recordUse({ name: 'foo', sessionId: 's' });
  r.recordUse({ name: 'foo', sessionId: 's' });
  assert.equal(r.usesFor('foo', 's').length, 4);
});

test('session provider can be bound to a registry directly', () => {
  const r = createRegistry();
  const p = createSessionProvider(r);
  r.recordUse({ name: 'x', def: 'bound', sessionId: 's' });
  assert.equal(p.resolve('x', { sessionId: 's' }).short, 'bound');
});

test('static finds bundled terms case-insensitively, user glossary overrides', () => {
  const p = createStaticProvider();
  assert.ok(DEFAULT_GLOSSARY.length >= 30);
  for (const { term, def: text } of DEFAULT_GLOSSARY) {
    assert.equal(p.canResolve(term.toUpperCase(), {}), true, term);
    assert.doesNotMatch(text, /["'{}\n]/, term);
  }
  const d = p.resolve('crdt', {});
  assert.equal(d.source, 'Static glossary');
  assert.equal(d.kind, 'standard');
  assert.equal(d.providerId, 'static');
  assert.equal(p.canResolve('  Vector   Clock ', {}), true);

  assert.equal(p.canResolve('zzz unknown', {}), false);
  assert.equal(p.canResolve('constructor', { userGlossary: {} }), false);

  const arr = { userGlossary: [{ term: 'Monoid', def: 'mine' }] };
  assert.equal(p.resolve('monoid', arr).short, 'mine');
  assert.equal(p.resolve('monoid', arr).source, 'User glossary');
  const rec = { userGlossary: { Zzz: 'custom' } };
  assert.equal(p.canResolve('zzz', rec), true);
  assert.equal(p.resolve('ZZZ', rec).source, 'User glossary');
});

test('throwing canResolve / resolve never breaks lookup', async () => {
  const r = fullRegistry();
  r.register({ id: 'mdn', label: 'm', canResolve() { throw new Error('x'); }, resolve: () => null });
  r.register({ id: 'wikipedia', label: 'w', canResolve: () => true, resolve() { throw new Error('y'); } });
  assert.equal((await r.lookup('nonce', { sessionId: 's' })).providerId, 'static');
  assert.equal(await r.lookup('unknown term', { sessionId: 's' }), null);
  assert.equal(r.lookupSync('unknown term', {}), null);
});
