import test from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry } from '../src/providers.js';
import { createInlineProvider } from '../src/inline-provider.js';
import { createSessionProvider } from '../src/session-glossary.js';
import { createStaticProvider } from '../src/static-glossary.js';
import { createWikipediaProvider, createWiktionaryProvider } from '../src/wiki-provider.js';
import { createMdnProvider } from '../src/mdn-provider.js';
import { createCoinedProvider } from '../src/coined-provider.js';
import { createLlmProvider } from '../src/llm-provider.js';

const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const notFound = () => json({ title: 'Not found' }, 404);

// Routes by URL prefix; records every call.
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    for (const [prefix, handler] of Object.entries(routes)) {
      if (url.startsWith(prefix)) return typeof handler === 'function' ? handler(url) : handler;
    }
    return notFound();
  };
  fn.calls = calls;
  return fn;
}

const WIKI = 'https://en.wikipedia.org/api/rest_v1/page/summary/';
const WIKT = 'https://en.wiktionary.org/api/rest_v1/page/definition/';
const MDN = 'https://developer.mozilla.org/api/v1/search?q=';

test('wikipedia: success maps extract, url and request shape', async () => {
  const fetch = fakeFetch({
    [WIKI]: json({ type: 'standard', title: 'Monad (functional programming)', extract: 'A monad is a design pattern.', content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Monad' } } }),
  });
  const p = createWikipediaProvider();
  assert.equal(p.id, 'wikipedia');
  assert.equal(p.label, 'Wikipedia');
  assert.equal(p.canResolve('monad', { fetch }), true);
  const def = await p.resolve('monad thing', { fetch });
  assert.equal(def.short, 'A monad is a design pattern.');
  assert.equal(def.source, 'Wikipedia');
  assert.equal(def.kind, 'standard');
  assert.equal(def.providerId, 'wikipedia');
  assert.equal(def.url, 'https://en.wikipedia.org/wiki/Monad');
  assert.equal(fetch.calls[0].url, WIKI + 'monad%20thing');
  assert.equal(fetch.calls[0].init.headers.Accept, 'application/json');
});

test('wikipedia: url falls back to title, extract is clipped', async () => {
  const extract = Array.from({ length: 200 }, (_, i) => 'w' + i).join(' ');
  const fetch = fakeFetch({ [WIKI]: json({ title: 'A B', extract }) });
  const def = await createWikipediaProvider().resolve('ab', { fetch });
  assert.equal(def.url, 'https://en.wikipedia.org/wiki/A%20B');
  assert.equal(def.short.split(' ').length, 25);
  assert.ok(def.short.endsWith('\u2026'));
  assert.equal(def.long.split(' ').length, 120);
});

test('wikipedia: disambiguation and 404 are null', async () => {
  const p = createWikipediaProvider();
  for (const type of ['disambiguation', 'disambig']) {
    assert.equal(await p.resolve('mercury', { fetch: fakeFetch({ [WIKI]: json({ type, extract: 'Mercury may refer to' }) }) }), null);
  }
  assert.equal(await p.resolve('zzz', { fetch: fakeFetch({}) }), null);
  assert.equal(await p.resolve('zzz', { fetch: fakeFetch({ [WIKI]: json({ extract: '  ' }) }) }), null);
});

test('wikipedia: non-JSON body is null and does not use rest', async () => {
  const fetch = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad'); } });
  const rest = async () => assert.fail('rest must not be called');
  assert.equal(await createWikipediaProvider().resolve('x', { fetch, rest }), null);
});

test('wikipedia: thrown fetch falls back to rest once and clips the payload', async () => {
  const long = Array.from({ length: 150 }, (_, i) => 'w' + i).join(' ');
  const restCalls = [];
  const rest = async (path) => {
    restCalls.push(path);
    return { short: long, long, source: 'Wikipedia', kind: 'standard', url: 'https://example.test/x' };
  };
  const fetch = async () => { throw new Error('offline'); };
  const def = await createWikipediaProvider().resolve('a b', { fetch, rest });
  assert.deepEqual(restCalls, ['/lookup?source=wikipedia&term=a%20b']);
  assert.equal(def.short.split(' ').length, 25);
  assert.equal(def.long.split(' ').length, 120);
  assert.equal(def.providerId, 'wikipedia');
  assert.equal(def.url, 'https://example.test/x');
});

test('wikipedia: rest throw or non-success payload is null; no rest is null', async () => {
  const p = createWikipediaProvider();
  const fetch = async () => { throw new Error('offline'); };
  assert.equal(await p.resolve('x', { fetch, rest: async () => { throw new Error('boom'); } }), null);
  assert.equal(await p.resolve('x', { fetch, rest: async () => ({ error: 'nope' }) }), null);
  assert.equal(await p.resolve('x', { fetch, rest: async () => null }), null);
  assert.equal(await p.resolve('x', { fetch }), null);
});

test('wikipedia: canResolve false without fetch and rest, or with empty term', () => {
  const p = createWikipediaProvider();
  assert.equal(p.canResolve('x', {}), false);
  assert.equal(p.canResolve('x', undefined), false);
  assert.equal(p.canResolve('  ', { fetch: async () => json({}) }), false);
  assert.equal(p.canResolve('x', { rest: async () => ({}) }), true);
});

test('wikipedia: rest alone (no fetch) is used', async () => {
  const rest = async () => ({ short: 'S', long: 'L', source: 'Wikipedia', kind: 'standard', url: null });
  const def = await createWikipediaProvider().resolve('x', { rest });
  assert.equal(def.short, 'S');
});

test('wiktionary: strips HTML, decodes entities, collapses whitespace', async () => {
  const fetch = fakeFetch({
    [WIKT]: json({ en: [{ partOfSpeech: 'Noun', definitions: [{ definition: '' }, { definition: '<a href="/x">A</a>  &lt;thing&gt; &amp; &quot;it&quot; isn&#39;t\n  &nbsp;' }] }] }),
  });
  const p = createWiktionaryProvider();
  assert.equal(p.label, 'Wiktionary');
  const def = await p.resolve('thing', { fetch });
  assert.equal(def.short, 'A <thing> & "it" isn\'t &nbsp;');
  assert.equal(def.source, 'Wiktionary');
  assert.equal(def.kind, 'standard');
  assert.equal(def.providerId, 'wiktionary');
  assert.equal(def.url, 'https://en.wiktionary.org/wiki/thing');
  assert.equal(fetch.calls[0].url, WIKT + 'thing');
});

test('wiktionary: uses another language when en is missing; empty is null', async () => {
  const p = createWiktionaryProvider();
  const fr = fakeFetch({ [WIKT]: json({ fr: [{ definitions: [{ definition: 'un chat' }] }] }) });
  assert.equal((await p.resolve('chat', { fetch: fr })).short, 'un chat');
  assert.equal(await p.resolve('x', { fetch: fakeFetch({ [WIKT]: json({ en: [{ definitions: [{ definition: '<b></b>' }] }] }) }) }), null);
  assert.equal(await p.resolve('x', { fetch: fakeFetch({ [WIKT]: json({}) }) }), null);
  assert.equal(await p.resolve('x', { fetch: fakeFetch({}) }), null);
});

test('wiktionary: rest fallback uses source wiktionary', async () => {
  const paths = [];
  const rest = async (path) => { paths.push(path); return { short: 'S', long: 'L', source: 'Wiktionary' }; };
  const def = await createWiktionaryProvider().resolve('x', { fetch: async () => { throw new Error('x'); }, rest });
  assert.deepEqual(paths, ['/lookup?source=wiktionary&term=x']);
  assert.equal(def.providerId, 'wiktionary');
});

test('mdn: exact and close title matches are accepted', async () => {
  const p = createMdnProvider();
  assert.equal(p.label, 'MDN');
  const doc = (title) => ({ title, summary: 'The fetch method.', mdn_url: '/en-US/docs/Web/API/fetch' });
  for (const title of ['fetch', 'Fetch', 'fetch()', 'Fetch API']) {
    const fetch = fakeFetch({ [MDN]: json({ documents: [doc(title)] }) });
    const def = await p.resolve('fetch', { fetch });
    assert.equal(def.short, 'The fetch method.', title);
    assert.equal(def.url, 'https://developer.mozilla.org/en-US/docs/Web/API/fetch');
    assert.equal(def.source, 'MDN');
    assert.equal(def.providerId, 'mdn');
    assert.equal(def.kind, 'standard');
  }
  const fetch = fakeFetch({ [MDN]: json({ documents: [] }) });
  await p.resolve('a b', { fetch });
  assert.equal(fetch.calls[0].url, MDN + 'a%20b&locale=en-US');
});

test('mdn: a later punctuation-stripped exact match is accepted', async () => {
  const documents = [
    { title: 'Window.fetchLater', summary: 'unrelated', mdn_url: '/a' },
    { title: 'fetch()', summary: 'The real one.', mdn_url: '/b' },
  ];
  const def = await createMdnProvider().resolve('fetch', { fetch: fakeFetch({ [MDN]: json({ documents }) }) });
  assert.equal(def.short, 'The real one.');
});

test('mdn: unrelated first hit is rejected; rest fallback works', async () => {
  const p = createMdnProvider();
  const documents = [{ title: 'Prefetch', summary: 'nope', mdn_url: '/x' }, { title: 'Other', summary: 'nope', mdn_url: '/y' }];
  assert.equal(await p.resolve('fetch', { fetch: fakeFetch({ [MDN]: json({ documents }) }) }), null);
  assert.equal(await p.resolve('fetch', { fetch: fakeFetch({}) }), null);
  assert.equal(p.canResolve('fetch', {}), false);
  const paths = [];
  const rest = async (path) => { paths.push(path); return { short: 'S', long: 'L', source: 'MDN', kind: 'standard' }; };
  const def = await p.resolve('fetch', { fetch: async () => { throw new Error('x'); }, rest });
  assert.deepEqual(paths, ['/lookup?source=mdn&term=fetch']);
  assert.equal(def.providerId, 'mdn');
});

const wikiHit = json({ extract: 'Standard definition.' });
const wiktHit = json({ en: [{ definitions: [{ definition: 'Standard word.' }] }] });
const quoteRegistry = () => {
  const registry = createRegistry();
  registry.recordUse({ name: 'flarb', def: null, sessionId: 's1', surrounding: 'We flarb the queue before every deploy.' });
  return registry;
};

test('coined: both wikis miss with first use gives an inferred-from-context definition', async () => {
  const p = createCoinedProvider();
  assert.equal(p.label, 'Coined-term fallback');
  const ctx = { fetch: fakeFetch({}), sessionId: 's1', registry: quoteRegistry() };
  assert.equal(p.canResolve('flarb', ctx), true);
  const def = await p.resolve('flarb', ctx);
  assert.equal(def.kind, 'coined');
  assert.equal(def.source, 'First use in session');
  assert.equal(def.providerId, 'coined');
  assert.equal(def.url, null);
  assert.equal(def.short, 'We flarb the queue before every deploy.');
  assert.equal(def.long, 'inferred from context. We flarb the queue before every deploy.');
  assert.deepEqual(def.firstUse, { quote: 'We flarb the queue before every deploy.', sessionId: 's1' });
});

test('coined: works with no network when a first use exists; unreachable counts as a miss', async () => {
  const p = createCoinedProvider();
  const registry = quoteRegistry();
  assert.equal((await p.resolve('flarb', { sessionId: 's1', registry })).kind, 'coined');
  const fetch = async () => { throw new Error('offline'); };
  assert.equal((await p.resolve('flarb', { fetch, sessionId: 's1', registry })).kind, 'coined');
  assert.equal(p.canResolve('flarb', { sessionId: 's1', registry }), true);
  assert.equal(p.canResolve('flarb', { sessionId: 'other', registry }), false);
  assert.equal(p.canResolve('', { fetch }), false);
});

test('coined: either wiki hit returns null', async () => {
  const p = createCoinedProvider();
  const base = { sessionId: 's1', registry: quoteRegistry() };
  assert.equal(await p.resolve('flarb', { ...base, fetch: fakeFetch({ [WIKI]: wikiHit }) }), null);
  assert.equal(await p.resolve('flarb', { ...base, fetch: fakeFetch({ [WIKT]: wiktHit }) }), null);
  const rest = async (path) => (path.includes('source=wiktionary') ? { short: 'S', long: 'L' } : null);
  assert.equal(await p.resolve('flarb', { ...base, fetch: async () => { throw new Error('x'); }, rest }), null);
});

test('coined: both miss without first use gives uncertain fixed text', async () => {
  const p = createCoinedProvider();
  const def = await p.resolve('flarb', { fetch: fakeFetch({}), sessionId: 's2', registry: quoteRegistry() });
  const text = 'No definition found in the glossary or Wikipedia/Wiktionary.';
  assert.equal(def.kind, 'uncertain');
  assert.equal(def.source, 'Not found');
  assert.equal(def.short, text);
  assert.equal(def.long, text);
  assert.equal(def.providerId, 'coined');
  assert.equal(def.url, null);
  assert.equal(def.firstUse, null);
});

test('llm: canResolve needs rest and a term', () => {
  const p = createLlmProvider();
  assert.equal(p.id, 'llm');
  assert.equal(p.label, 'LLM (backend)');
  assert.equal(p.canResolve('x', {}), false);
  assert.equal(p.canResolve('x', { fetch: async () => json({}) }), false);
  assert.equal(p.canResolve(' ', { rest: async () => ({}) }), false);
  assert.equal(p.canResolve('x', { rest: async () => ({}) }), true);
});

test('llm: rest success is clipped and tagged; defaults applied; fetch untouched', async () => {
  const long = Array.from({ length: 150 }, (_, i) => 'w' + i).join(' ');
  const calls = [];
  const rest = async (path, opts) => { calls.push({ path, opts }); return { short: long, long }; };
  const fetch = async () => assert.fail('fetch must not be called');
  const def = await createLlmProvider().resolve('x', { rest, fetch, sessionId: 's1', surrounding: 'ctx sentence' });
  assert.equal(calls[0].path, '/define');
  assert.equal(calls[0].opts.method, 'POST');
  assert.deepEqual(calls[0].opts.body, { term: 'x', sessionId: 's1', surrounding: 'ctx sentence' });
  assert.equal(def.short.split(' ').length, 25);
  assert.equal(def.long.split(' ').length, 120);
  assert.equal(def.providerId, 'llm');
  assert.equal(def.source, 'LLM');
  assert.equal(def.kind, 'uncertain');
  const kept = await createLlmProvider().resolve('x', { rest: async () => ({ short: 'S', source: 'Model', kind: 'standard', providerId: 'evil' }) });
  assert.equal(kept.source, 'Model');
  assert.equal(kept.kind, 'standard');
  assert.equal(kept.providerId, 'llm');
  assert.equal(kept.long, 'S');
  assert.deepEqual(calls.length, 1);
});

test('llm: rest throw or non-definition payload is null', async () => {
  const p = createLlmProvider();
  assert.equal(await p.resolve('x', { rest: async () => { throw new Error('boom'); } }), null);
  assert.equal(await p.resolve('x', { rest: async () => ({ error: 'bad' }) }), null);
  assert.equal(await p.resolve('x', { rest: async () => 'text' }), null);
  assert.equal(await p.resolve('x', { rest: async () => null }), null);
});

function fullRegistry() {
  return createRegistry({
    providers: [
      createInlineProvider(),
      createSessionProvider(),
      createStaticProvider(),
      createMdnProvider(),
      createWiktionaryProvider(),
      createWikipediaProvider(),
      createCoinedProvider(),
      createLlmProvider(),
    ],
  });
}

test('registry: all eight providers walk the default order', async () => {
  const registry = fullRegistry();
  assert.deepEqual(registry.list().map((p) => p.id), ['inline', 'session', 'static', 'mdn', 'wiktionary', 'wikipedia', 'coined', 'llm']);
  assert.equal(registry.isDisabled('llm'), true);

  const restCalls = [];
  const rest = async (path) => { restCalls.push(path); return { short: 'LLM', long: 'LLM' }; };
  const fetch = fakeFetch({ [WIKI]: json({ extract: 'Wiki says hello.' }) });
  const ctx = { sessionId: 's1', fetch, rest };

  const inline = await registry.lookup('monoid', { ...ctx, attrs: { def: 'Inline wins.' } });
  assert.equal(inline.providerId, 'inline');
  assert.equal(fetch.calls.length, 0);

  registry.setDisabled(['llm', 'inline']);
  const stat = await registry.lookup('semigroup', { ...ctx, attrs: { def: 'ignored' } });
  assert.equal(stat.providerId, 'static');
  assert.equal(fetch.calls.length, 0);

  const wiki = await registry.lookup('zorblax', { ...ctx, sessionId: 's2' });
  assert.equal(wiki.providerId, 'wikipedia');
  assert.equal(wiki.short, 'Wiki says hello.');
  assert.deepEqual(fetch.calls.map((c) => c.url.split('/')[2]), ['developer.mozilla.org', 'en.wiktionary.org', 'en.wikipedia.org']);

  assert.deepEqual(restCalls, []);
});

test('registry: coined is the last enabled resort and llm stays off', async () => {
  const registry = fullRegistry();
  const restCalls = [];
  const rest = async (path) => { restCalls.push(path); return null; };
  const fetch = fakeFetch({});
  registry.recordUse({ name: 'flarb', sessionId: 's1', surrounding: 'We flarb it.' });
  const def = await registry.lookup('flarb', { sessionId: 's1', fetch, rest });
  assert.equal(def.providerId, 'coined');
  assert.equal(def.kind, 'coined');
  assert.equal(restCalls.includes('/define'), false);
  assert.equal(registry.lookupSync('flarb', { sessionId: 's1', fetch }), null);
});
