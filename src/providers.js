// Definition provider registry, per-session cache and fallback chain.
// Plain ESM with no imports so it can be concatenated into plugin.js.

const DEFAULT_ORDER = ['inline', 'session', 'static', 'mdn', 'wiktionary', 'wikipedia', 'coined', 'llm'];
const DEFAULT_DISABLED = ['llm'];

export function normalizeTerm(term) {
  return String(term ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function clipWords(text, maxWords) {
  const words = String(text ?? '').trim().split(/\s+/).filter(Boolean);
  if (!(maxWords > 0)) return '';
  if (words.length <= maxWords) return words.join(' ');
  return words.slice(0, maxWords).join(' ') + '\u2026';
}

const sessionKey = (sessionId) => String(sessionId ?? '');
const termKey = (term, sessionId) => normalizeTerm(term) + '\0' + sessionKey(sessionId);
const isThenable = (v) => v != null && typeof v.then === 'function';
const hasText = (v) => typeof v === 'string' && v.trim() !== '';

function isSuccess(def) {
  return def != null && typeof def === 'object' && (hasText(def.short) || hasText(def.long));
}

export function createRegistry(options = {}) {
  const providers = new Map();
  let order = DEFAULT_ORDER.slice();
  let disabled = new Set(DEFAULT_DISABLED);
  const uses = new Map();
  const cache = new Map();
  let useCounter = 0;

  const known = (id) => providers.has(id) || order.includes(id);
  const enabledChain = () => order.filter((id) => providers.has(id) && !disabled.has(id)).map((id) => providers.get(id));

  function attempt(provider, term, ctx) {
    try {
      if (!provider.canResolve(term, ctx)) return undefined;
      return provider.resolve(term, ctx);
    } catch {
      return undefined;
    }
  }

  function accept(provider, def) {
    if (!isSuccess(def)) return null;
    return def.providerId ? def : { ...def, providerId: provider.id };
  }

  const registry = {
    register(provider) {
      providers.set(provider.id, provider);
      if (!order.includes(provider.id)) order.push(provider.id);
      return registry;
    },
    list() {
      return order.filter((id) => providers.has(id)).map((id) => providers.get(id));
    },
    get(id) {
      return providers.get(id) ?? null;
    },
    setOrder(ids) {
      const named = [];
      for (const id of Array.isArray(ids) ? ids : []) if (!named.includes(id)) named.push(id);
      order = named.concat(order.filter((id) => !named.includes(id)));
    },
    setDisabled(ids) {
      disabled = new Set((Array.isArray(ids) ? ids : []).filter(known));
    },
    isDisabled(id) {
      return disabled.has(id);
    },
    recordUse({ name, def, sessionId, source, attrs, surrounding } = {}) {
      if (!hasText(name)) return null;
      const quote = hasText(surrounding) ? surrounding : hasText(def) ? def : name;
      const use = {
        name,
        def: def ?? null,
        sessionId: sessionId ?? null,
        source: source ?? null,
        attrs: attrs ?? null,
        surrounding: surrounding ?? null,
        at: useCounter++,
        quote,
      };
      const key = termKey(name, sessionId);
      if (!uses.has(key)) uses.set(key, []);
      uses.get(key).push(use);
      return use;
    },
    usesFor(name, sessionId) {
      return (uses.get(termKey(name, sessionId)) ?? []).slice();
    },
    firstUse(name, sessionId) {
      return (uses.get(termKey(name, sessionId)) ?? [])[0] ?? null;
    },
    lookupSync(term, ctx) {
      const full = { ...ctx, registry };
      for (const provider of enabledChain()) {
        const out = attempt(provider, term, full);
        if (out === undefined || isThenable(out)) continue;
        const def = accept(provider, out);
        if (def) return def;
      }
      return null;
    },
    async lookup(term, ctx) {
      const key = termKey(term, ctx?.sessionId);
      const hit = cache.get(key);
      if (hit) return hit.def;
      const full = { ...ctx, registry };
      for (const provider of enabledChain()) {
        let out = attempt(provider, term, full);
        if (out === undefined) continue;
        if (isThenable(out)) {
          try {
            out = await out;
          } catch {
            continue;
          }
        }
        const def = accept(provider, out);
        if (def) {
          cache.set(key, { session: sessionKey(ctx?.sessionId), def });
          return def;
        }
      }
      return null;
    },
    clearCache(sessionId) {
      if (sessionId === undefined) return cache.clear();
      const session = sessionKey(sessionId);
      for (const [key, entry] of cache) if (entry.session === session) cache.delete(key);
    },
    peekCache(term, sessionId) {
      return cache.get(termKey(term, sessionId))?.def ?? null;
    },
  };

  for (const provider of options.providers ?? []) registry.register(provider);
  return registry;
}
