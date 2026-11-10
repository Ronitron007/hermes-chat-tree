import { clipWords, normalizeTerm } from './providers.js';
import { createWikipediaProvider, createWiktionaryProvider } from './wiki-provider.js';

const hasText = (v) => typeof v === 'string' && v.trim() !== '';
const NOT_FOUND = 'No definition found in the glossary or Wikipedia/Wiktionary.';

export function createCoinedProvider() {
  const standard = [createWikipediaProvider(), createWiktionaryProvider()];
  const firstUseOf = (term, ctx) => ctx?.registry?.firstUse?.(term, ctx?.sessionId ?? null) ?? null;

  return {
    id: 'coined',
    label: 'Coined-term fallback',
    canResolve(term, ctx) {
      if (normalizeTerm(term) === '') return false;
      return firstUseOf(term, ctx) !== null || typeof ctx?.fetch === 'function' || typeof ctx?.rest === 'function';
    },
    async resolve(term, ctx) {
      for (const provider of standard) {
        let found = null;
        try {
          found = await provider.resolve(term, ctx);
        } catch {
          found = null;
        }
        if (found) return null;
      }
      const first = firstUseOf(term, ctx);
      const quote = first && hasText(first.quote) ? first.quote : null;
      if (quote) {
        const sessionId = ctx?.sessionId ?? null;
        return {
          short: clipWords(quote, 25),
          long: 'inferred from context. ' + clipWords(quote, 120),
          source: 'First use in session',
          kind: 'coined',
          providerId: 'coined',
          url: null,
          firstUse: { quote, sessionId },
        };
      }
      return {
        short: NOT_FOUND,
        long: NOT_FOUND,
        source: 'Not found',
        kind: 'uncertain',
        providerId: 'coined',
        url: null,
        firstUse: null,
      };
    },
  };
}
