"""Concept Links: mechanical ::term annotator for Hermes (transform_llm_output)."""

import re
from pathlib import Path

# Mirrors DEFAULT_GLOSSARY in src/static-glossary.js.
GLOSSARY = [
    ("monoid", "An associative binary operation together with an identity element, such as addition with zero."),
    ("semigroup", "A set with an associative binary operation, like a monoid but without a required identity element."),
    ("idempotent", "Describes an operation that gives the same result whether it is applied once or many times."),
    ("CRDT", "A conflict-free replicated data type, a structure whose replicas can be updated independently and always merge to the same state."),
    ("backpressure", "A signal from a slow consumer telling a fast producer to slow down so buffers do not overflow."),
    ("closure", "A function bundled with the variables from the scope where it was defined, so it can use them later."),
    ("currying", "Turning a function of several arguments into a chain of functions that each take one argument."),
    ("memoization", "Caching the result of a function call by its arguments so repeated calls return the stored value."),
    ("debounce", "Delaying an action until a burst of events has stopped for a set quiet period."),
    ("throttle", "Limiting how often an action may run, for example at most once per time interval."),
    ("referential transparency", "A property of an expression that can be replaced by its value without changing the behavior of the program."),
    ("side effect", "Any observable change an operation makes beyond returning a value, such as writing to disk or mutating state."),
    ("eventual consistency", "A guarantee that replicas will converge to the same value if updates stop, though reads may be stale meanwhile."),
    ("vector clock", "A set of per-node counters used to order events and detect concurrent updates in a distributed system."),
    ("Merkle tree", "A tree of hashes where each node hashes its children, allowing efficient verification of large data sets."),
    ("CAP theorem", "The result that a distributed system cannot guarantee consistency, availability, and partition tolerance all at once."),
    ("reentrancy", "The property of code that can be safely called again before an earlier call has finished."),
    ("soundness", "The guarantee that a type system or proof system never accepts a program or claim that is actually wrong."),
    ("variance", "How subtyping of type parameters relates to subtyping of the generic types built from them."),
    ("lifetime", "The span of program execution during which a reference or value is guaranteed to remain valid."),
    ("borrow checker", "A compiler pass, notably in Rust, that enforces ownership and borrowing rules to prevent invalid memory access."),
    ("continuation", "A representation of the rest of a computation, which can be captured and resumed later."),
    ("trampoline", "A loop that repeatedly calls returned thunks so deep recursion runs without growing the call stack."),
    ("type class", "A set of operations that a type can implement, letting functions be written generically over any type that supports them."),
    ("higher-kinded type", "A type that abstracts over type constructors, such as a generic over List or Option rather than over plain types."),
    ("unification", "Finding a substitution that makes two symbolic expressions identical, used in type inference and logic programming."),
    ("narrowing", "Refining a value type to a more specific one based on checks the compiler can see, such as a type test in a branch."),
    ("effect system", "A type system feature that tracks which side effects a function may perform in its signature."),
    ("orthogonal persistence", "A design where data lives beyond program runs without code treating persistent and temporary data differently."),
    ("nonce", "A number used once, supplied to an operation so that old messages cannot be replayed or reused."),
]

MAX_PARAGRAPH = 4800  # the host drops directives in longer paragraphs
MAX_BODY = 2048  # cap on the directive attribute body
MAX_TERMS = 8
_UNSAFE = re.compile(r'["{}\\\r\n]')
_FENCE = re.compile(r"^\s{0,3}(`{3,}|~{3,})")
_EXISTING = re.compile(r"::\w+\{[^}\n]*\}")
_NAME = re.compile(r'name="([^"]*)"')


def _safe(s):
    return bool(s) and not _UNSAFE.search(s)


def _build(glossary):
    defs = {}
    for term, definition in glossary:
        term, definition = " ".join(term.split()), " ".join(definition.split())
        if _safe(term) and _safe(definition):
            defs.setdefault(term.lower(), (term, definition))
    names = sorted(defs, key=len, reverse=True)
    if not names:
        return defs, None
    alts = "|".join(re.escape(n).replace(r"\ ", r"\s+") for n in names)
    # Whitespace-or-start before, so "(monoid)" or '"monoid"' is left alone.
    pattern = r"(?P<skip>(`+)[^`]*?\2(?!`)|::\w+\{[^}\n]*\})|(?<!\S)(?P<term>" + alts + r")(?![\w-])"
    return defs, re.compile(pattern, re.IGNORECASE)


def _paragraphs(text):
    """Yield (is_prose, chunk); fenced code and blank-line gaps are not prose."""
    fence, buf, prose = None, [], None

    def flush():
        nonlocal buf
        if buf:
            out.append((prose, "".join(buf)))
            buf = []

    out = []
    for line in text.splitlines(keepends=True):
        m = _FENCE.match(line)
        if fence:
            kind = False
            if m and m.group(1)[0] == fence[0] and len(m.group(1)) >= len(fence) and not line.strip().strip(fence[0]):
                fence = None
        elif m:
            flush()
            fence, kind = m.group(1), False
        else:
            kind = bool(line.strip())
        if buf and kind != prose:
            flush()
        prose = kind
        buf.append(line)
    flush()
    return out


def annotate_terms(text, glossary=None):
    """Wrap first mentions of glossary terms in ::term directives.

    Returns the new text, or None when nothing changed.
    """
    try:
        if not isinstance(text, str) or not text:
            return None
        defs, pattern = _build(GLOSSARY if glossary is None else glossary)
        if pattern is None:
            return None
        seen = set()
        for m in _EXISTING.finditer(text):
            n = _NAME.search(m.group(0))
            if n:
                seen.add(" ".join(n.group(1).split()).lower())

        def sub(m):
            if m.group("skip") is not None or len(seen) >= MAX_TERMS:
                return m.group(0)
            key = " ".join(m.group("term").split()).lower()
            if key in seen:
                return m.group(0)
            name = " ".join(m.group("term").split())
            body = 'name="%s" def="%s"' % (name, defs[key][1])
            if len(body) > MAX_BODY:
                return m.group(0)
            seen.add(key)
            return "::term{%s}" % body

        parts, changed = [], False
        for prose, chunk in _paragraphs(text):
            if prose and len(chunk) <= MAX_PARAGRAPH:
                new = pattern.sub(sub, chunk)
                changed = changed or new != chunk
                chunk = new
            parts.append(chunk)
        return "".join(parts) if changed else None
    except Exception:
        return None


def _hook(response_text, session_id=None, model=None, platform=None, **kwargs):
    return annotate_terms(response_text)


def register(ctx):
    ctx.register_hook("transform_llm_output", _hook)
    register_skill = getattr(ctx, "register_skill", None)
    if callable(register_skill):
        try:
            register_skill(
                "concept-links",
                Path(__file__).parent / "skills" / "concept-links" / "SKILL.md",
                "Mark dense technical terms with ::term directives for hover definitions.",
            )
        except Exception:
            pass
