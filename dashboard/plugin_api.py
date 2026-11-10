"""Concept Links dashboard API: public-source lookup proxy and bundled glossary."""

import importlib.util
import json
import re
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

router = APIRouter()

USER_AGENT = "concept-links-hermes-plugin/0.1 (local Hermes Desktop plugin)"
TIMEOUT = 4

_ENTITIES = {"&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'"}


def _glossary():
    # The plugin root is not a package from the dashboard's point of view, so load it by path.
    spec = importlib.util.spec_from_file_location("_concept_links_root", Path(__file__).resolve().parent.parent / "__init__.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.GLOSSARY


def _clip(text, n):
    words = str(text or "").split()
    return " ".join(words) if len(words) <= n else " ".join(words[:n]) + "\u2026"


def _enc(term):
    return quote(term, safe="-_.!~*'()")


def _fold(s):
    return " ".join(str(s or "").split()).lower()


def _definition(text, source, provider_id, url):
    return {
        "short": _clip(text, 25),
        "long": _clip(text, 120),
        "source": source,
        "kind": "standard",
        "providerId": provider_id,
        "url": url,
        "firstUse": None,
    }


def _get_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code == 404:
            raise HTTPException(404, "no definition")
        raise HTTPException(502, "upstream error")
    except (urllib.error.URLError, OSError, ValueError):
        raise HTTPException(502, "upstream unreachable")


def _clean_html(html):
    text = re.sub(r"<[^>]+>", "", str(html or ""))
    text = re.sub(r"&(?:amp|lt|gt|quot|#39);", lambda m: _ENTITIES[m.group(0)], text)
    return " ".join(text.split())


def _wikipedia(term):
    data = _get_json("https://en.wikipedia.org/api/rest_v1/page/summary/" + _enc(term))
    if not isinstance(data, dict):
        raise HTTPException(404, "no definition")
    extract = data.get("extract")
    if data.get("type") in ("disambiguation", "disambig") or not (isinstance(extract, str) and extract.strip()):
        raise HTTPException(404, "no definition")
    page = ((data.get("content_urls") or {}).get("desktop") or {}).get("page")
    url = page if isinstance(page, str) and page.strip() else "https://en.wikipedia.org/wiki/" + _enc(data.get("title") or term)
    return _definition(extract, "Wikipedia", "wikipedia", url)


def _wiktionary(term):
    data = _get_json("https://en.wiktionary.org/api/rest_v1/page/definition/" + _enc(term))
    if not isinstance(data, dict):
        raise HTTPException(404, "no definition")
    entries = data.get("en")
    if not isinstance(entries, list):
        entries = next((v for v in data.values() if isinstance(v, list)), [])
    for entry in entries:
        for d in (entry or {}).get("definitions") or []:
            text = _clean_html((d or {}).get("definition"))
            if text:
                return _definition(text, "Wiktionary", "wiktionary", "https://en.wiktionary.org/wiki/" + _enc(term))
    raise HTTPException(404, "no definition")


def _mdn(term):
    data = _get_json("https://developer.mozilla.org/api/v1/search?q=" + _enc(term) + "&locale=en-US")
    docs = [d for d in (data.get("documents") if isinstance(data, dict) else None) or [] if isinstance(d, dict)]
    q = _fold(term)
    strip = lambda s: _fold(re.sub(r"[^\w\s]", " ", str(s or "")))
    doc = None
    if docs and (_fold(docs[0].get("title")) == q or _fold(docs[0].get("title")).startswith(q + " ")):
        doc = docs[0]
    elif strip(term):
        doc = next((d for d in docs if strip(d.get("title")) == strip(term)), None)
    summary = doc.get("summary") if doc else None
    if not (isinstance(summary, str) and summary.strip()):
        raise HTTPException(404, "no definition")
    path = doc.get("mdn_url")
    url = "https://developer.mozilla.org" + path if isinstance(path, str) and path.strip() else None
    return _definition(summary, "MDN", "mdn", url)


_SOURCES = {"wikipedia": _wikipedia, "wiktionary": _wiktionary, "mdn": _mdn}


@router.get("/lookup")
def lookup(source: str = "", term: str = ""):
    handler = _SOURCES.get(source)
    term = " ".join(term.split())
    if handler is None or not term:
        raise HTTPException(400, "source must be wikipedia, wiktionary or mdn, and term must be non-empty")
    return handler(term)


@router.get("/glossary")
def glossary():
    return {"entries": [{"term": t, "def": d} for t, d in _glossary()]}


@router.post("/define")
def define(body: dict = None):
    # No LLM is wired up; the JS llm provider treats this payload as a miss.
    return JSONResponse(status_code=501, content={"ok": False, "reason": "not configured"})
