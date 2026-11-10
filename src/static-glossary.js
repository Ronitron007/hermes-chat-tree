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

export function lookupGlossary(term, entries) {
  const def = toMap(entries).get(normalizeTerm(term));
  return def && def.trim() ? def.trim() : null;
}

export function createStaticProvider(entries = DEFAULT_GLOSSARY) {
  const bundled = toMap(entries);
  const find = (term, ctx) => {
    const user = lookupGlossary(term, ctx?.userGlossary);
    if (user) return { def: user, source: 'User glossary' };
    const def = bundled.get(normalizeTerm(term));
    return def && def.trim() ? { def: def.trim(), source: 'Static glossary' } : null;
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
