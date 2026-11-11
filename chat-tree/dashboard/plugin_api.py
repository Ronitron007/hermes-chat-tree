"""Chat Tree dashboard API. Hermes mounts this router at /api/plugins/chat-tree/.

POST /digest  {"purpose": "fork" | "merge", "title": str, "exchanges": [{"question": str, "answer": str}]}
  200 {"ok": true, "digest": str} or {"ok": false, "error": str} (model or parse failure)
  400 {"ok": false, "error": str} (malformed input)

The digest logic and the ctx.llm binding live in digest.py. Read its docstring for why the route
can reach the ctx.llm that register(ctx) received.
"""

import asyncio
import importlib.util
import json
import sys
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

router = APIRouter()

_SHARED_NAME = "chat_tree_digest"  # digest.SHARED_NAME; ../__init__.py uses the same name
_DIGEST_FILE = Path(__file__).resolve().with_name("digest.py")


def _digest():
    """The one copy of digest.py in this process (shared with register(ctx) in ../__init__.py)."""
    module = sys.modules.get(_SHARED_NAME)
    if module is not None:
        return module
    spec = importlib.util.spec_from_file_location(_SHARED_NAME, _DIGEST_FILE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return sys.modules.setdefault(_SHARED_NAME, module)


def _bad_request(error):
    return JSONResponse(status_code=400, content={"ok": False, "error": error})


@router.post("/digest")
async def digest(request: Request):
    try:
        body = json.loads(await request.body() or b"null")
    except ValueError:
        return _bad_request("the body is not valid JSON")
    shared = _digest()
    try:
        checked = shared.parse(body)
    except shared.BadRequest as exc:
        return _bad_request(str(exc))
    # The model call blocks: run it in a worker thread so the event loop stays free.
    # asyncio.to_thread copies the request context, so ctx.llm runs in the request's profile scope.
    return await asyncio.to_thread(shared.answer, checked)
