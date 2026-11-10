import { clipWords, normalizeTerm } from './providers.js';

const hasText = (v) => typeof v === 'string' && v.trim() !== '';
const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

function requestInit() {
  const init = { headers: { Accept: 'application/json' } };
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    init.signal = AbortSignal.timeout(4000);
  }
  return init;
}

// Throws only when ctx.fetch itself throws; HTTP errors and bad JSON give null.
async function getJson(url, ctx) {
  const res = await ctx.fetch(url, requestInit());
  const ok = res && (res.ok ?? (res.status >= 200 && res.status < 300));
  if (!ok) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function fromRest(payload, providerId, defaults) {
  if (!isObject(payload) || !(hasText(payload.short) || hasText(payload.long))) return null;
  const long = hasText(payload.long) ? payload.long : payload.short;
  const short = hasText(payload.short) ? payload.short : payload.long;
  return {
    ...payload,
    short: clipWords(short, 25),
    long: clipWords(long, 120),
    source: hasText(payload.source) ? payload.source : defaults.source,
    kind: payload.kind ?? defaults.kind,
    providerId,
    url: payload.url ?? null,
    firstUse: payload.firstUse ?? null,
  };
}

async function restLookup(ctx, source, term, providerId, label) {
  if (typeof ctx.rest !== 'function') return null;
  try {
    const payload = await ctx.rest('/lookup?source=' + source + '&term=' + encodeURIComponent(term));
    return fromRest(payload, providerId, { source: label, kind: 'standard' });
  } catch {
    return null;
  }
}

export function createRemoteProvider({ id, label, restSource, urlFor, parse }) {
  return {
    id,
    label,
    canResolve(term, ctx) {
      return (typeof ctx?.fetch === 'function' || typeof ctx?.rest === 'function') && normalizeTerm(term) !== '';
    },
    async resolve(term, ctx) {
      let data = null;
      let threw = typeof ctx?.fetch !== 'function';
      if (!threw) {
        try {
          data = await getJson(urlFor(term), ctx);
        } catch {
          threw = true;
        }
      }
      if (threw) return restLookup(ctx ?? {}, restSource, term, id, label);
      if (data == null) return null;
      try {
        return parse(data, term);
      } catch {
        return null;
      }
    },
  };
}

export function createWikipediaProvider() {
  return createRemoteProvider({
    id: 'wikipedia',
    label: 'Wikipedia',
    restSource: 'wikipedia',
    urlFor: (term) => 'https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(term),
    parse(data, term) {
      if (!isObject(data) || data.type === 'disambiguation' || data.type === 'disambig') return null;
      if (!hasText(data.extract)) return null;
      const page = data.content_urls?.desktop?.page;
      return {
        short: clipWords(data.extract, 25),
        long: clipWords(data.extract, 120),
        source: 'Wikipedia',
        kind: 'standard',
        providerId: 'wikipedia',
        url: hasText(page) ? page : 'https://en.wikipedia.org/wiki/' + encodeURIComponent(hasText(data.title) ? data.title : term),
        firstUse: null,
      };
    },
  });
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };

function cleanHtml(html) {
  return String(html ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&(?:amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m])
    .replace(/\s+/g, ' ')
    .trim();
}

export function createWiktionaryProvider() {
  return createRemoteProvider({
    id: 'wiktionary',
    label: 'Wiktionary',
    restSource: 'wiktionary',
    urlFor: (term) => 'https://en.wiktionary.org/api/rest_v1/page/definition/' + encodeURIComponent(term),
    parse(data, term) {
      if (!isObject(data)) return null;
      const entries = Array.isArray(data.en) ? data.en : Object.values(data).find(Array.isArray);
      if (!entries) return null;
      for (const entry of entries) {
        for (const d of Array.isArray(entry?.definitions) ? entry.definitions : []) {
          const text = cleanHtml(d?.definition);
          if (text) {
            return {
              short: clipWords(text, 25),
              long: clipWords(text, 120),
              source: 'Wiktionary',
              kind: 'standard',
              providerId: 'wiktionary',
              url: 'https://en.wiktionary.org/wiki/' + encodeURIComponent(term),
              firstUse: null,
            };
          }
        }
      }
      return null;
    },
  });
}
