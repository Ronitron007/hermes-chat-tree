import { clipWords } from './providers.js';

const hasText = (v) => typeof v === 'string' && v.trim() !== '';

export function createSessionProvider(boundRegistry) {
  let bound = boundRegistry ?? null;
  const reg = (ctx) => ctx?.registry ?? bound;
  const storedDef = (term, ctx) => {
    const registry = reg(ctx);
    if (!registry) return null;
    const use = registry.usesFor(term, ctx?.sessionId ?? null).find((u) => hasText(u.def));
    return use ? use.def.trim() : null;
  };

  return {
    id: 'session',
    label: 'Session glossary',
    bind(registry) {
      bound = registry;
    },
    canResolve(term, ctx) {
      const registry = reg(ctx);
      if (!registry) return false;
      return storedDef(term, ctx) !== null || registry.firstUse(term, ctx?.sessionId ?? null) !== null;
    },
    resolve(term, ctx) {
      const def = storedDef(term, ctx);
      if (def === null) return null;
      const first = reg(ctx).firstUse(term, ctx?.sessionId ?? null);
      return {
        short: clipWords(def, 25),
        long: clipWords(def, 120),
        source: 'Session glossary',
        kind: 'standard',
        providerId: 'session',
        url: null,
        firstUse: first ? { quote: first.quote, sessionId: first.sessionId } : null,
      };
    },
  };
}
