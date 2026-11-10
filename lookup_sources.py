"""Public lookup sources (MDN, Wiktionary, Wikipedia) shared by the dashboard API and the annotator.

Nothing here imports FastAPI; callers translate NoDefinition / UpstreamError.
"""

import json
import re
import threading
import time
import urllib.error
import urllib.request
from urllib.parse import quote

USER_AGENT = "concept-links-hermes-plugin/0.1 (local Hermes Desktop plugin)"
TIMEOUT = 4  # default per-request timeout for the dashboard proxy

# Annotator budget: one annotate_terms call may spend this long on the network in total.
BUDGET = 1.5
MAX_REQUEST_TIMEOUT = 1.0
MIN_REQUEST_TIMEOUT = 0.05
MAX_LOOKUPS = 8
ANNOTATOR_SOURCES = ("mdn", "wiktionary", "wikipedia")

HIT_TTL = 3600
ERROR_TTL = 30
CACHE_SIZE = 256

_ENTITIES = {"&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'"}


class NoDefinition(Exception):
    """The source answered but has nothing for this term."""


class UpstreamError(Exception):
    """The source could not be reached or answered badly."""


def clip(text, n):
    words = str(text or "").split()
    return " ".join(words) if len(words) <= n else " ".join(words[:n]) + "\u2026"


def enc(term):
    return quote(term, safe="-_.!~*'()")


def fold(s):
    return " ".join(str(s or "").split()).lower()


def definition(text, source, provider_id, url):
    return {
        "short": clip(text, 25),
        "long": clip(text, 120),
        "source": source,
        "kind": "standard",
        "providerId": provider_id,
        "url": url,
        "firstUse": None,
    }


def get_json(url, timeout=TIMEOUT):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code == 404:
            raise NoDefinition("no definition")
        raise UpstreamError("upstream error")
    except (urllib.error.URLError, OSError, ValueError):
        raise UpstreamError("upstream unreachable")


def clean_html(html):
    text = re.sub(r"<[^>]+>", "", str(html or ""))
    text = re.sub(r"&(?:amp|lt|gt|quot|#39);", lambda m: _ENTITIES[m.group(0)], text)
    return " ".join(text.split())


# Each source takes (term, timeout, fetch); fetch(url, timeout) returns parsed JSON and defaults to get_json.

def wikipedia(term, timeout=TIMEOUT, fetch=None):
    data = (fetch or get_json)("https://en.wikipedia.org/api/rest_v1/page/summary/" + enc(term), timeout)
    if not isinstance(data, dict):
        raise NoDefinition("no definition")
    extract = data.get("extract")
    if data.get("type") in ("disambiguation", "disambig") or not (isinstance(extract, str) and extract.strip()):
        raise NoDefinition("no definition")
    page = ((data.get("content_urls") or {}).get("desktop") or {}).get("page")
    url = page if isinstance(page, str) and page.strip() else "https://en.wikipedia.org/wiki/" + enc(data.get("title") or term)
    return definition(extract, "Wikipedia", "wikipedia", url)


def wiktionary(term, timeout=TIMEOUT, fetch=None):
    data = (fetch or get_json)("https://en.wiktionary.org/api/rest_v1/page/definition/" + enc(term), timeout)
    if not isinstance(data, dict):
        raise NoDefinition("no definition")
    entries = data.get("en")
    if not isinstance(entries, list):
        entries = next((v for v in data.values() if isinstance(v, list)), [])
    for entry in entries:
        for d in (entry or {}).get("definitions") or []:
            text = clean_html((d or {}).get("definition"))
            if text:
                return definition(text, "Wiktionary", "wiktionary", "https://en.wiktionary.org/wiki/" + enc(term))
    raise NoDefinition("no definition")


def mdn(term, timeout=TIMEOUT, fetch=None):
    data = (fetch or get_json)("https://developer.mozilla.org/api/v1/search?q=" + enc(term) + "&locale=en-US", timeout)
    docs = [d for d in (data.get("documents") if isinstance(data, dict) else None) or [] if isinstance(d, dict)]
    q = fold(term)
    strip = lambda s: fold(re.sub(r"[^\w\s]", " ", str(s or "")))
    doc = None
    if docs and (fold(docs[0].get("title")) == q or fold(docs[0].get("title")).startswith(q + " ")):
        doc = docs[0]
    elif strip(term):
        doc = next((d for d in docs if strip(d.get("title")) == strip(term)), None)
    summary = doc.get("summary") if doc else None
    if not (isinstance(summary, str) and summary.strip()):
        raise NoDefinition("no definition")
    path = doc.get("mdn_url")
    url = "https://developer.mozilla.org" + path if isinstance(path, str) and path.strip() else None
    return definition(summary, "MDN", "mdn", url)


SOURCES = {"wikipedia": wikipedia, "wiktionary": wiktionary, "mdn": mdn}


class Cache:
    """Small thread-safe (term, source) cache; entries expire and the oldest are evicted first."""

    def __init__(self, size=CACHE_SIZE):
        self.size = size
        self._data = {}
        self._lock = threading.Lock()

    def get(self, key, now):
        with self._lock:
            hit = self._data.get(key)
            if hit is None:
                return None
            if hit[0] <= now:
                del self._data[key]
                return None
            return hit

    def put(self, key, kind, value, now, ttl):
        with self._lock:
            self._data.pop(key, None)
            self._data[key] = (now + ttl, kind, value)
            while len(self._data) > self.size:
                del self._data[next(iter(self._data))]

    def clear(self):
        with self._lock:
            self._data.clear()


CACHE = Cache()

HIT, MISS, ERROR = "hit", "miss", "error"
_UNKNOWN = object()


class Resolver:
    """Resolve terms to a short definition within one shared wall-time budget.

    Calling it returns {folded term: definition text, or None when every source
    answered with no definition}. Terms that were not finished (budget spent,
    lookup limit reached, or a source failed with no hit elsewhere) are left out.
    The clock starts at the first call that needs the network.
    """

    def __init__(self, budget=BUDGET, fetch=None, clock=time.monotonic, cache=None,
                 max_lookups=MAX_LOOKUPS, sources=ANNOTATOR_SOURCES):
        self.budget = budget
        self.fetch = fetch
        self.clock = clock
        self.cache = CACHE if cache is None else cache
        self.max_lookups = max_lookups
        self.sources = sources
        self.deadline = None
        self.results = {}
        self.scheduled = set()

    def __call__(self, terms):
        todo = []
        for term in terms:
            key = fold(term)
            if key and key not in self.results and key not in self.scheduled and len(self.scheduled) < self.max_lookups:
                self.scheduled.add(key)
                todo.append((key, term))
        if todo:
            if self.deadline is None:
                self.deadline = self.clock() + self.budget
            done, lock = {}, threading.Lock()
            # A daemon thread keeps a stuck socket from holding the hook past the deadline.
            worker = threading.Thread(target=self._work, args=(todo, done, lock), daemon=True)
            worker.start()
            worker.join(max(0.0, self.deadline - self.clock()))
            with lock:
                self.results.update(done)
        return {fold(t): self.results[fold(t)] for t in terms if fold(t) in self.results}

    def _work(self, todo, done, lock):
        for key, term in todo:
            if self.deadline - self.clock() < MIN_REQUEST_TIMEOUT:
                return
            found = self._lookup(key, term)
            if found is not _UNKNOWN:
                with lock:
                    done[key] = found

    def _lookup(self, key, term):
        errored = False
        for name in self.sources:
            ckey = (key, name)
            cached = self.cache.get(ckey, self.clock())
            if cached is not None:
                _, kind, value = cached
            else:
                remaining = self.deadline - self.clock()
                if remaining < MIN_REQUEST_TIMEOUT:
                    return _UNKNOWN
                timeout = min(remaining, MAX_REQUEST_TIMEOUT)
                try:
                    value = SOURCES[name](term, timeout=timeout, fetch=self.fetch)["short"]
                    kind, ttl = HIT, HIT_TTL
                except NoDefinition:
                    kind, value, ttl = MISS, None, HIT_TTL
                except Exception:
                    kind, value, ttl = ERROR, None, ERROR_TTL
                self.cache.put(ckey, kind, value, self.clock(), ttl)
            if kind == HIT:
                return value
            errored = errored or kind == ERROR
        return _UNKNOWN if errored else None
