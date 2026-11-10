import { clipWords } from './providers.js';
import { createRemoteProvider } from './wiki-provider.js';

const hasText = (v) => typeof v === 'string' && v.trim() !== '';
const fold = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const strip = (s) => fold(String(s ?? '').replace(/[^\p{L}\p{N}\s]/gu, ' ')).trim();

function looseMatch(title, term) {
  const t = fold(title);
  const q = fold(term);
  return t === q || t.startsWith(q + ' ');
}

function pickDocument(documents, term) {
  if (!Array.isArray(documents) || documents.length === 0) return null;
  if (documents[0] && looseMatch(documents[0].title, term)) return documents[0];
  const q = strip(term);
  return q ? documents.find((d) => d && strip(d.title) === q) ?? null : null;
}

export function createMdnProvider() {
  return createRemoteProvider({
    id: 'mdn',
    label: 'MDN',
    restSource: 'mdn',
    urlFor: (term) => 'https://developer.mozilla.org/api/v1/search?q=' + encodeURIComponent(term) + '&locale=en-US',
    parse(data, term) {
      const doc = pickDocument(data?.documents, term);
      if (!doc || !hasText(doc.summary)) return null;
      return {
        short: clipWords(doc.summary, 25),
        long: clipWords(doc.summary, 120),
        source: 'MDN',
        kind: 'standard',
        providerId: 'mdn',
        url: hasText(doc.mdn_url) ? 'https://developer.mozilla.org' + doc.mdn_url : null,
        firstUse: null,
      };
    },
  });
}
