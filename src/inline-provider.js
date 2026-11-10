import { clipWords } from './providers.js';

const inlineDef = (ctx) => {
  const def = ctx?.attrs?.def;
  return typeof def === 'string' ? def.trim() : '';
};

export function createInlineProvider() {
  return {
    id: 'inline',
    label: 'Inline directive',
    canResolve: (term, ctx) => inlineDef(ctx) !== '',
    resolve(term, ctx) {
      const def = inlineDef(ctx);
      if (!def) return null;
      return {
        short: clipWords(def, 25),
        long: clipWords(def, 120),
        source: 'Inline directive',
        kind: 'standard',
        providerId: 'inline',
        url: null,
        firstUse: null,
      };
    },
  };
}
