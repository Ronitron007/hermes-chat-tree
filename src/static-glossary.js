import { clipWords, normalizeTerm } from './providers.js';

export const DEFAULT_GLOSSARY = [
  { term: 'monoid', def: 'An associative binary operation together with an identity element, such as addition with zero.' },
  { term: 'semigroup', def: 'A set with an associative binary operation, like a monoid but without a required identity element.' },
  { term: 'idempotent', def: 'Describes an operation that gives the same result whether it is applied once or many times.' },
  { term: 'CRDT', def: 'A conflict-free replicated data type, a structure whose replicas can be updated independently and always merge to the same state.' },
  { term: 'backpressure', def: 'A signal from a slow consumer telling a fast producer to slow down so buffers do not overflow.' },
  { term: 'closure', def: 'A function bundled with the variables from the scope where it was defined, so it can use them later.' },
  { term: 'currying', def: 'Turning a function of several arguments into a chain of functions that each take one argument.' },
  { term: 'memoization', def: 'Caching the result of a function call by its arguments so repeated calls return the stored value.' },
  { term: 'debounce', def: 'Delaying an action until a burst of events has stopped for a set quiet period.' },
  { term: 'throttle', def: 'Limiting how often an action may run, for example at most once per time interval.' },
  { term: 'referential transparency', def: 'A property of an expression that can be replaced by its value without changing the behavior of the program.' },
  { term: 'side effect', def: 'Any observable change an operation makes beyond returning a value, such as writing to disk or mutating state.' },
  { term: 'eventual consistency', def: 'A guarantee that replicas will converge to the same value if updates stop, though reads may be stale meanwhile.' },
  { term: 'vector clock', def: 'A set of per-node counters used to order events and detect concurrent updates in a distributed system.' },
  { term: 'Merkle tree', def: 'A tree of hashes where each node hashes its children, allowing efficient verification of large data sets.' },
  { term: 'CAP theorem', def: 'The result that a distributed system cannot guarantee consistency, availability, and partition tolerance all at once.' },
  { term: 'reentrancy', def: 'The property of code that can be safely called again before an earlier call has finished.' },
  { term: 'soundness', def: 'The guarantee that a type system or proof system never accepts a program or claim that is actually wrong.' },
  { term: 'variance', def: 'How subtyping of type parameters relates to subtyping of the generic types built from them.' },
  { term: 'lifetime', def: 'The span of program execution during which a reference or value is guaranteed to remain valid.' },
  { term: 'borrow checker', def: 'A compiler pass, notably in Rust, that enforces ownership and borrowing rules to prevent invalid memory access.' },
  { term: 'continuation', def: 'A representation of the rest of a computation, which can be captured and resumed later.' },
  { term: 'trampoline', def: 'A loop that repeatedly calls returned thunks so deep recursion runs without growing the call stack.' },
  { term: 'type class', def: 'A set of operations that a type can implement, letting functions be written generically over any type that supports them.' },
  { term: 'higher-kinded type', def: 'A type that abstracts over type constructors, such as a generic over List or Option rather than over plain types.' },
  { term: 'unification', def: 'Finding a substitution that makes two symbolic expressions identical, used in type inference and logic programming.' },
  { term: 'narrowing', def: 'Refining a value type to a more specific one based on checks the compiler can see, such as a type test in a branch.' },
  { term: 'effect system', def: 'A type system feature that tracks which side effects a function may perform in its signature.' },
  { term: 'orthogonal persistence', def: 'A design where data lives beyond program runs without code treating persistent and temporary data differently.' },
  { term: 'nonce', def: 'A number used once, supplied to an operation so that old messages cannot be replayed or reused.' },
  { term: 'monad', def: 'A design pattern that wraps values in a context and chains operations on them, handling the context such as failure or state automatically.' },
  { term: 'functor', def: 'A container type that supports mapping a function over its contents while keeping the container structure unchanged.' },
  { term: 'hoisting', def: 'JavaScript behavior where declarations are processed before code runs, so they can be used earlier in their scope than where they are written.' },
  { term: 'idempotency', def: 'The property that repeating an operation has the same effect as doing it once, which makes retries safe.' },
  { term: 'flexbox', def: 'A CSS layout model that arranges items along a row or column and distributes the space between them.' },
  { term: 'grid', def: 'A CSS layout model that places items into rows and columns of a two-dimensional grid.' },
  { term: 'polyfill', def: 'Code that adds a modern feature to an older environment that does not support it natively.' },
  { term: 'mutex', def: 'A lock that lets only one thread at a time enter a critical section of code.' },
  { term: 'deadlock', def: 'A state where two or more tasks each wait for the other to release a resource, so none can proceed.' },
  { term: 'race condition', def: 'A bug where the result depends on the unpredictable timing or ordering of concurrent operations.' },
  { term: 'immutability', def: 'The property of data that cannot be changed after creation, so updates produce new values instead.' },
  { term: 'lazy evaluation', def: 'Delaying the computation of a value until it is actually needed, and then reusing the result.' },
  { term: 'event loop', def: 'A loop that waits for events or queued tasks and runs their handlers one at a time.' },
  { term: 'middleware', def: 'Code that sits between a request and its handler and can inspect, change, or short-circuit the exchange.' },
  { term: 'tail call', def: 'A function call made as the very last step of another function, which can reuse the current stack frame.' },
];

function toMap(entries) {
  const map = new Map();
  if (Array.isArray(entries)) {
    for (const e of entries) if (e && typeof e.def === 'string') map.set(normalizeTerm(e.term), e.def);
  } else if (entries && typeof entries === 'object') {
    for (const [term, def] of Object.entries(entries)) if (typeof def === 'string') map.set(normalizeTerm(term), def);
  }
  return map;
}

// Conservative inflections of one lowercase word: itself first, then singular
// forms (ies -> y, es, s but not ss) and plural forms. A form only counts when
// it is an actual glossary key, so nothing is invented. Mirrors _inflections in
// __init__.py.
function wordForms(word) {
  const w = word.toLowerCase();
  const out = [w];
  if (w.length > 3 && w.endsWith('ies')) out.push(`${w.slice(0, -3)}y`);
  if (w.length > 2 && w.endsWith('s') && !w.endsWith('ss')) out.push(w.slice(0, -1));
  if (w.length > 3 && w.endsWith('es')) out.push(w.slice(0, -2));
  if (w.length > 2 && w.endsWith('y') && !'aeiou'.includes(w[w.length - 2])) out.push(`${w.slice(0, -1)}ies`);
  if (!w.endsWith('s')) out.push(`${w}s`);
  if (/(?:s|x|z|ch|sh)$/.test(w)) out.push(`${w}es`);
  return out;
}

function phraseHit(map, words) {
  const head = words.slice(0, -1).map((w) => w.toLowerCase());
  for (const form of wordForms(words[words.length - 1])) {
    const def = map.get([...head, form].join(' '));
    if (def && def.trim()) return def.trim();
  }
  return null;
}

// Full phrase, then the head noun (and longer trailing sub-terms), then any
// other sub-term, so "CSS Flexbox" finds "flexbox" and "Monads" finds "monad".
function findDefinition(map, term) {
  const words = normalizeTerm(term).split(' ').filter(Boolean);
  if (words.length === 0) return null;
  const whole = phraseHit(map, words);
  if (whole || words.length === 1) return whole;
  for (let n = words.length - 1; n >= 1; n--) {
    const hit = phraseHit(map, words.slice(words.length - n));
    if (hit) return hit;
  }
  for (let n = words.length - 1; n >= 1; n--) {
    for (let i = 0; i + n < words.length; i++) {
      const hit = phraseHit(map, words.slice(i, i + n));
      if (hit) return hit;
    }
  }
  return null;
}

export function lookupGlossary(term, entries) {
  return findDefinition(toMap(entries), term);
}

export function createStaticProvider(entries = DEFAULT_GLOSSARY) {
  const bundled = toMap(entries);
  const find = (term, ctx) => {
    const user = lookupGlossary(term, ctx?.userGlossary);
    if (user) return { def: user, source: 'User glossary' };
    const def = findDefinition(bundled, term);
    return def ? { def, source: 'Static glossary' } : null;
  };

  return {
    id: 'static',
    label: 'Static glossary',
    canResolve: (term, ctx) => find(term, ctx) !== null,
    resolve(term, ctx) {
      const hit = find(term, ctx);
      if (!hit) return null;
      return {
        short: clipWords(hit.def, 25),
        long: clipWords(hit.def, 120),
        source: hit.source,
        kind: 'standard',
        providerId: 'static',
        url: null,
        firstUse: null,
      };
    },
  };
}
