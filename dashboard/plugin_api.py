"""Concept Links dashboard API: public-source lookup proxy and bundled glossary."""

import importlib.util
import sys
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

router = APIRouter()

TIMEOUT = 4


def _load(name, filename):
    # The plugin root is not a package from the dashboard's point of view, so load siblings by path.
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, Path(__file__).resolve().parent.parent / filename)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    try:
        spec.loader.exec_module(mod)
    except BaseException:
        sys.modules.pop(name, None)
        raise
    return mod


sources = _load("_concept_links_lookup_sources", "lookup_sources.py")


def _glossary():
    return _load("_concept_links_root", "__init__.py").GLOSSARY


def _run(handler):
    def call(term):
        try:
            return handler(term, timeout=TIMEOUT)
        except sources.NoDefinition as e:
            raise HTTPException(404, str(e))
        except sources.UpstreamError as e:
            raise HTTPException(502, str(e))

    return call


_SOURCES = {name: _run(handler) for name, handler in sources.SOURCES.items()}


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
