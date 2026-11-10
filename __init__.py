"""Concept Links: mechanical ::termline annotator for Hermes (transform_llm_output)."""

import importlib.util
import re
import sys
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
    ("monad", "A design pattern that wraps values in a context and chains operations on them, handling the context such as failure or state automatically."),
    ("functor", "A container type that supports mapping a function over its contents while keeping the container structure unchanged."),
    ("hoisting", "JavaScript behavior where declarations are processed before code runs, so they can be used earlier in their scope than where they are written."),
    ("idempotency", "The property that repeating an operation has the same effect as doing it once, which makes retries safe."),
    ("flexbox", "A CSS layout model that arranges items along a row or column and distributes the space between them."),
    ("grid", "A CSS layout model that places items into rows and columns of a two-dimensional grid."),
    ("polyfill", "Code that adds a modern feature to an older environment that does not support it natively."),
    ("mutex", "A lock that lets only one thread at a time enter a critical section of code."),
    ("deadlock", "A state where two or more tasks each wait for the other to release a resource, so none can proceed."),
    ("race condition", "A bug where the result depends on the unpredictable timing or ordering of concurrent operations."),
    ("immutability", "The property of data that cannot be changed after creation, so updates produce new values instead."),
    ("lazy evaluation", "Delaying the computation of a value until it is actually needed, and then reusing the result."),
    ("event loop", "A loop that waits for events or queued tasks and runs their handlers one at a time."),
    ("middleware", "Code that sits between a request and its handler and can inspect, change, or short-circuit the exchange."),
    ("tail call", "A function call made as the very last step of another function, which can reuse the current stack frame."),
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


# Function words plus everyday verbs and nouns that must never become lookup candidates.
_STOP = frozenset("""
a about above across after again against all almost also although always am among an and another any anyone
anything are around as at away back be because been before being below best between both but by can cannot
case cases come comes could course data day days did do does doing done down during each either else enough
even ever every example examples fact few first for from get gets getting give given gives go goes going
good got great had has have having he her here hers him his how however i idea if important in into is it
its itself just keep kind know last least less let like list lists little long look looks lot made make makes
many may maybe me might more most much must my near need needs never new next no nor not note nothing now of
off often on once one only onto or other our out over own part parts people per perhaps place point put
quite rather really result results same see seem seems set several she should show shows side since so some
something sometimes still such take takes than that the their them then there these they thing things this
those though through thus time times tip to together too try tries turn two under until up upon us use used
uses using very want warning was way ways we well were what when where whether which while who whom whose
why will with within without work works would yes yet you your
effect effects matter matters retry retries sequence sequences step steps value values item items
""".split())

_BOLD = re.compile(r"\*\*(?=\S)(.+?)(?<=\S)\*\*|(?<!\w)__(?=\S)(.+?)(?<=\S)__(?!\w)")
_BOLD_PHRASE = re.compile(r"[A-Za-z0-9][\w .'/+#-]{0,58}")
_TOKEN = re.compile(r"(?<![\w./:@#$-])[A-Za-z]\w*(?:[.-]\w+)*(?![\w/@-]|\.\w)")
_CAMEL = re.compile(r"[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*|[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*")
_SNAKE = re.compile(r"[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+")
_DOTTED = re.compile(r"[A-Za-z][A-Za-z0-9_]+(?:\.[A-Za-z][A-Za-z0-9_]+)+")
_HYPHENATED = re.compile(r"[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+")
_CAPS = re.compile(r"(?<![\w.'/-])[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*(?![\w-]|\.\w)")
_CAP_WORD = re.compile(r"[A-Z][a-z]+")
_SENTENCE_END = re.compile(r"[.!?][\"')\]]*$")
_FILE_EXT = frozenset("md txt json yaml yml py ts tsx jsx html css png jpg svg csv toml lock sh pdf com org net io".split())
MAX_CAPS_WORDS = 4


def _lookup_module():
    """Load lookup_sources by path (the plugin root is not an importable package); None if unavailable."""
    name = "_concept_links_lookup_sources"
    mod = sys.modules.get(name)
    if mod is None:
        try:
            spec = importlib.util.spec_from_file_location(name, Path(__file__).resolve().parent / "lookup_sources.py")
            mod = importlib.util.module_from_spec(spec)
            sys.modules[name] = mod
            spec.loader.exec_module(mod)
        except Exception:
            sys.modules.pop(name, None)
            return None
    return mod


def _is_tech(tok):
    if "-" in tok:
        return "." not in tok and "_" not in tok and bool(_HYPHENATED.fullmatch(tok)) and bool(re.search(r"\d|(?<=.)[A-Z]", tok))
    if "." in tok:
        return bool(_DOTTED.fullmatch(tok)) and tok.rsplit(".", 1)[1].lower() not in _FILE_EXT
    if "_" in tok:
        return bool(_SNAKE.fullmatch(tok))
    return bool(_CAMEL.fullmatch(tok))


def _mask(sentence):
    """Return (sentence with bold markers blanked out, [(start, phrase)] bold spans); same length."""
    chars, bold = list(sentence), []
    for m in _BOLD.finditer(sentence):
        g = 1 if m.group(1) is not None else 2
        for i in (m.start(), m.start() + 1, m.end() - 2, m.end() - 1):
            chars[i] = " "
        bold.append((m.start(g), m.group(g)))
    return "".join(chars), bold


def _extras(sentence, defs, taken, skip):
    """Non-glossary candidates as [(pos, key, name, kind)]; kind is bold, tech or caps.

    `taken` holds (start, end) spans already claimed; `skip` holds keys not to look up.
    """
    mask, bold = _mask(sentence)
    found = {}

    def add(start, name, kind):
        key = _key(name)
        end = start + len(name)
        if _known(name, defs) or key in skip or any(start < b and a < end for a, b in taken):
            return
        taken.append((start, end))
        found.setdefault(key, (start, key, name, kind))

    def plain(phrase):
        words = re.findall(r"[a-z]+", phrase.lower())
        return not words or all(w in _STOP for w in words)

    for start, phrase in bold:
        name = " ".join(phrase.split())
        if _BOLD_PHRASE.fullmatch(name) and len(name.split()) <= MAX_CAPS_WORDS and len(name) > 1 and not plain(name):
            add(start, name, "bold")
    for m in _TOKEN.finditer(mask):
        if _is_tech(m.group()):
            add(m.start(), m.group(), "tech")
    for m in _CAPS.finditer(mask):
        before = mask[:m.start()].rstrip()
        if not before or _SENTENCE_END.search(before):
            continue
        words = list(_CAP_WORD.finditer(m.group()))
        while words and words[0].group().lower() in _STOP:
            words.pop(0)
        while words and words[-1].group().lower() in _STOP:
            words.pop()
        if words and len(words) <= MAX_CAPS_WORDS:
            start = m.start() + words[0].start()
            add(start, sentence[start:m.start() + words[-1].end()], "caps")
    return sorted(found.values())


def _key(s):
    return " ".join(s.split()).lower()


def _inflections(word):
    """Lowercase forms `word` may stand for: itself, then singular and plural variants.

    A form only counts when it is a glossary key, so nothing is invented.
    Mirrors wordForms in src/static-glossary.js.
    """
    w = word.lower()
    out = [w]
    if len(w) > 3 and w.endswith("ies"):
        out.append(w[:-3] + "y")
    if len(w) > 2 and w.endswith("s") and not w.endswith("ss"):
        out.append(w[:-1])
    if len(w) > 3 and w.endswith("es"):
        out.append(w[:-2])
    if len(w) > 2 and w.endswith("y") and w[-2] not in "aeiou":
        out.append(w[:-1] + "ies")
    if not w.endswith("s"):
        out.append(w + "s")
    if w.endswith(("s", "x", "z", "ch", "sh")):
        out.append(w + "es")
    return out


def _gloss_key(words, defs):
    """Glossary key for a phrase given as words, inflecting only its last word; None on a miss."""
    head = [w.lower() for w in words[:-1]]
    for form in _inflections(words[-1]):
        key = " ".join(head + [form])
        if key in defs:
            return key
    return None


def _known(name, defs):
    words = name.split()
    return bool(words) and _gloss_key(words, defs) is not None


def _bold_phrases(sentence, defs, taken):
    """Multiword bold phrases that miss the glossary as a whole but contain a known sub-term.

    Returns [(start, key, name, def)] for the visible phrase (edge stopwords trimmed) and
    adds its span to `taken`, so the sub-term and its modifiers are not chipped on their own.
    """
    out = []
    for start, phrase in _mask(sentence)[1]:
        toks = list(re.finditer(r"\w[\w+#/-]*", phrase))
        while toks and toks[0].group().lower() in _STOP:
            toks.pop(0)
        while toks and toks[-1].group().lower() in _STOP:
            toks.pop()
        if len(toks) < 2 or len(toks) > MAX_CAPS_WORDS or not _BOLD_PHRASE.fullmatch(" ".join(phrase.split())):
            continue
        a, b = start + toks[0].start(), start + toks[-1].end()
        if any(a < y and x < b for x, y in taken):
            continue
        words = [t.group() for t in toks]
        if _gloss_key(words, defs):
            continue  # the whole phrase is a glossary term; the normal pass chips it
        n = len(words)
        windows = [words[n - k:] for k in range(n - 1, 0, -1)]
        windows += [words[i:i + k] for k in range(n - 1, 0, -1) for i in range(n - k)]
        for window in windows:
            key = _gloss_key(window, defs)
            if key:
                taken.append((a, b))
                out.append((a, key, sentence[a:b], defs[key][1]))
                break
    return out


def _stem_matches(mask, defs, taken):
    """Glossary terms written in an inflected form, as [(start, end, key)]; exact forms are left to the regex."""
    words = list(re.finditer(r"(?<!\S)[\w-]+(?![\w-])", mask))
    longest = max((k.count(" ") + 1 for k in defs), default=1)
    out, i = [], 0
    while i < len(words):
        for n in range(min(longest, len(words) - i), 0, -1):
            run = words[i:i + n]
            if any(not mask[p.end():q.start()].isspace() for p, q in zip(run, run[1:])):
                continue
            a, b = run[0].start(), run[-1].end()
            if any(a < y and x < b for x, y in taken):
                continue
            key = _gloss_key([m.group() for m in run], defs)
            if key:
                out.append((a, b, key))
                taken.append((a, b))
                i += n - 1
                break
        i += 1
    return out


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


def annotate_terms(text, glossary=None, resolver=None):
    """Rewrite each prose paragraph that has linked terms as one ::termline.

    Linked terms are mid-sentence ::term directives (stripped back to the plain
    word) and first mentions of glossary terms. The plain sentence goes in v and
    the terms in t as "name=def;;name=def". Returns the new text, or None when
    nothing changed.

    Bold phrases, mid-sentence capitalised phrases and technical tokens are also
    looked up in public sources through `resolver` (a callable taking names and
    returning {lowercased name: def or None}); the default shares one 1.5s budget
    across the call. A definition is never made up: a term no source knows is
    dropped, or kept with an empty def when it is bold or technical.
    """
    try:
        if not isinstance(text, str) or not text:
            return None
        defs, pattern = _build(GLOSSARY if glossary is None else glossary)
        if resolver is None:
            mod = _lookup_module()
            resolver = mod.Resolver() if mod else None
        seen = set()
        parts, changed = [], False
        for prose, chunk in _paragraphs(text):
            if prose and len(chunk) <= MAX_PARAGRAPH:
                if _TERMLINE.match(chunk):
                    _note_termline(chunk, seen)
                else:
                    new = _termline(chunk, defs, pattern, seen, resolver)
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


def _termline(chunk, defs, pattern, seen, resolver=None):
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
    taken = [(c[0], c[0] + len(c[2])) for c in cands]
    mask = _mask(sentence)[0]
    for start, key, name, definition in _bold_phrases(sentence, defs, taken):
        if key not in explicit:
            cands.append((start, key, name, definition))
    if pattern is not None:
        for m in pattern.finditer(mask):
            key = _key(m.group("term"))
            if key not in explicit and not any(m.start() < b and a < m.end() for a, b in taken):
                cands.append((m.start(), key, " ".join(m.group("term").split()), defs[key][1]))
                taken.append(m.span())
    for a, b, key in _stem_matches(mask, defs, taken):
        if key not in explicit:
            cands.append((a, key, sentence[a:b], defs[key][1]))
    cands.extend(_resolve_extras(sentence, defs, taken, explicit | seen, resolver))
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


def _resolve_extras(sentence, defs, taken, skip, resolver):
    extras = _extras(sentence, defs, taken, skip)
    if not extras or resolver is None:
        return []
    try:
        found = resolver([name for _, _, name, _ in extras[:MAX_TERMS]])
    except Exception:
        return []
    out = []
    for pos, key, name, kind in extras:
        if key not in found:
            continue
        text = found[key]
        if isinstance(text, str) and text.strip():
            out.append((pos, key, name, " ".join(_BRACES.sub("", text).replace('"', "").replace("'", "\u2019").split())))
        elif text is None and kind != "caps":
            out.append((pos, key, name, ""))
    return out


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
