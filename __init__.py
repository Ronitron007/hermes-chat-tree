"""Concept Links: mechanical ::termline annotator for Hermes (transform_llm_output)."""

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
# The host has no escape inside quoted attrs, and `{`/`}` would end the body early.
_BODY_UNSAFE = re.compile(r"[{}\\\r\n]")
_BRACES = re.compile(r"[{}]")
# Paragraphs that open with block markdown (lists, headings, quotes, tables) are not plain prose.
_BLOCK = re.compile(r"^\s*(#|[-*+]\s|>|\||\d+[.)]\s)")
_FENCE = re.compile(r"^\s{0,3}(`{3,}|~{3,})")
_TERM = re.compile(r"::term\{([^}\n]*)\}")
_TERMLINE = re.compile(r"^\s*::termline\{[^}\n]*\}\s*$")
_ANY_DIRECTIVE = re.compile(r"::\w+\{")
_ATTR = re.compile(r"""(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)')""")
_T_ATTR = re.compile(r"""\bt\s*=\s*(?:"([^"]*)"|'([^']*)')""")
_T_ESCAPE = re.compile(r"([\\;=])")


def _key(s):
    return " ".join(s.split()).lower()


def _esc(s):
    """Escape a `t` part so a name or definition may contain `\\`, `;` and `=`."""
    return _T_ESCAPE.sub(r"\\\1", s)


def _build(glossary):
    defs = {}
    for term, definition in glossary:
        term, definition = " ".join(term.split()), " ".join(_BRACES.sub("", definition).split())
        if term and not _BODY_UNSAFE.search(term):
            defs.setdefault(term.lower(), (term, definition))
    names = sorted(defs, key=len, reverse=True)
    if not names:
        return defs, None
    alts = "|".join(re.escape(n).replace(r"\ ", r"\s+") for n in names)
    # Whitespace-or-start before, so "(monoid)" or '"monoid"' is left alone.
    pattern = r"(?<!\S)(?P<term>" + alts + r")(?![\w-])"
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
    """Rewrite each prose paragraph that has linked terms as one ::termline.

    Linked terms are mid-sentence ::term directives (stripped back to the plain
    word) and first mentions of glossary terms. The plain sentence goes in v and
    the terms in t as "name=def;;name=def". Returns the new text, or None when
    nothing changed.
    """
    try:
        if not isinstance(text, str) or not text:
            return None
        defs, pattern = _build(GLOSSARY if glossary is None else glossary)
        seen = set()
        parts, changed = [], False
        for prose, chunk in _paragraphs(text):
            if prose and len(chunk) <= MAX_PARAGRAPH:
                if _TERMLINE.match(chunk):
                    _note_termline(chunk, seen)
                else:
                    new = _termline(chunk, defs, pattern, seen)
                    if new is not None:
                        changed, chunk = True, new
            parts.append(chunk)
        return "".join(parts) if changed else None
    except Exception:
        return None


def _note_termline(chunk, seen):
    """Count terms already carried by an existing ::termline as used."""
    m = _T_ATTR.search(chunk)
    if not m:
        return
    for pair in (m.group(1) or m.group(2) or "").split(";;"):
        name = pair.split("=", 1)[0]
        if name.strip():
            seen.add(_key(name))


def _termline(chunk, defs, pattern, seen):
    """Return chunk rewritten as one ::termline directive, or None to leave it alone.

    `seen` is updated only when the paragraph is rewritten.
    """
    body = chunk.rstrip("\r\n")
    tail = chunk[len(body):]
    raw = " ".join(body.split())
    if not raw or _BLOCK.match(body) or "`" in raw or "[[" in raw or "]]" in raw:
        return None

    plain, cands, last, size = [], [], 0, 0
    for m in _TERM.finditer(raw):
        attrs = {k: a or b for k, a, b in _ATTR.findall(m.group(1))}
        name = " ".join((attrs.get("name") or "").split())
        if not name:
            return None
        lead = raw[last:m.start()]
        plain.append(lead)
        size += len(lead)
        cands.append((size, _key(name), name, " ".join(_BRACES.sub("", attrs.get("def") or "").split())))
        plain.append(name)
        size += len(name)
        last = m.end()
    plain.append(raw[last:])
    sentence = "".join(plain)
    if _ANY_DIRECTIVE.search(sentence) or _BODY_UNSAFE.search(sentence):
        return None
    explicit = {c[1] for c in cands}
    has_term = bool(cands)
    if pattern is not None:
        for m in pattern.finditer(sentence):
            key = _key(m.group("term"))
            if key not in explicit:
                cands.append((m.start(), key) + defs[key])
    if not cands:
        return None

    pending, used = set(seen), []
    for _, key, name, definition in sorted(cands, key=lambda c: c[0]):
        if len(pending) >= MAX_TERMS or key in pending:
            continue
        pending.add(key)
        used.append((key, name, definition))
    if not used and not has_term:
        return None

    pairs = ";;".join("%s=%s" % (_esc(name), _esc(definition)) for _, name, definition in used)
    v, t, quote = sentence, pairs, '"'
    if '"' in v + t:
        if "'" in v + t:
            v, t = v.replace('"', ""), t.replace('"', "")
        else:
            quote = "'"
    if not v.strip():
        return None
    directive = "::termline{v=%s%s%s t=%s%s%s}" % (quote, v, quote, quote, t, quote)
    if len(directive) - len("::termline{}") > MAX_BODY:
        return None
    seen.update(key for key, _, _ in used)
    return directive + tail


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
                "Mark dense technical terms with ::termline paragraphs for hover definitions.",
            )
        except Exception:
            pass
