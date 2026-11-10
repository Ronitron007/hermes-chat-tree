import { clipWords, normalizeTerm } from './providers.js';

const hasText = (v) => typeof v === 'string' && v.trim() !== '';

export function createLlmProvider() {
  return {
    id: 'llm',
    label: 'LLM (backend)',
    canResolve(term, ctx) {
      return typeof ctx?.rest === 'function' && normalizeTerm(term) !== '';
    },
    async resolve(term, ctx) {
      let payload;
      try {
        payload = await ctx.rest('/define', {
          method: 'POST',
          body: { term, sessionId: ctx.sessionId ?? null, surrounding: ctx.surrounding ?? null },
        });
      } catch {
        return null;
      }
      if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) return null;
      if (!hasText(payload.short) && !hasText(payload.long)) return null;
      const short = hasText(payload.short) ? payload.short : payload.long;
      const long = hasText(payload.long) ? payload.long : payload.short;
      return {
        ...payload,
        short: clipWords(short, 25),
        long: clipWords(long, 120),
        source: hasText(payload.source) ? payload.source : 'LLM',
        kind: payload.kind ?? 'uncertain',
        providerId: 'llm',
        url: payload.url ?? null,
        firstUse: payload.firstUse ?? null,
      };
    },
  };
}
