"""Tests for the chat-tree Python half: register(ctx) and POST /api/plugins/chat-tree/shared().

Run with an interpreter that has FastAPI and httpx, for example the Hermes venv:

    <hermes venv>/bin/python chat-tree/tests_py/test_digest.py

HERMES_AGENT_DIR (default ~/.hermes/hermes-agent) is put on sys.path for agent.plugin_llm and
agent.redact. HERMES_HOME is pointed at a temporary folder, so no test reads or writes a real
Hermes home. No test calls a model: the LLM is a stub or Hermes's make_plugin_llm_for_test with
a fake caller.
"""

import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

PLUGIN = Path(__file__).resolve().parents[1]
os.environ["HERMES_HOME"] = tempfile.mkdtemp(prefix="chat-tree-test-home-")
sys.path.insert(0, os.environ.get("HERMES_AGENT_DIR", str(Path.home() / ".hermes" / "hermes-agent")))

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


plugin_init = _load("chat_tree_plugin_under_test", PLUGIN / "__init__.py")
plugin_api = _load("hermes_dashboard_plugin_chat-tree", PLUGIN / "dashboard" / "plugin_api.py")


def shared():
    """The digest module the route uses now (unload drops it, so never cache it)."""
    return plugin_init._digest()


app = FastAPI()
app.include_router(plugin_api.router, prefix="/api/plugins/chat-tree")
client = TestClient(app)
URL = "/api/plugins/chat-tree/digest"


class StubLlm:
    """Records each complete_structured call and answers like PluginLlmStructuredResult."""

    def __init__(self, parsed=None, text="", error=None):
        self.parsed, self.text, self.error, self.calls = parsed, text, error, []

    def complete_structured(self, **kwargs):
        self.calls.append(kwargs)
        if self.error is not None:
            raise self.error
        return SimpleNamespace(parsed=self.parsed, text=self.text,
                               content_type="text" if self.parsed is None else "json")


def as_ctx(llm):
    """A plugin ctx as register(ctx) gets it: the route reads ctx.llm per call."""
    return SimpleNamespace(llm=llm)


def body(purpose="fork", exchanges=None, title="Rust lifetimes"):
    if exchanges is None:
        exchanges = [{"question": "What is a lifetime?", "answer": "The span a reference stays valid."}]
    return {"purpose": purpose, "title": title, "exchanges": exchanges}


def sent_text(call):
    return call["input"][0]["text"]


class DigestRouteTest(unittest.TestCase):
    def setUp(self):
        self.llm = StubLlm(parsed={"digest": "- A lifetime is the span a reference stays valid."})
        shared().bind(as_ctx(self.llm))

    def tearDown(self):
        shared().unbind(shared().bound())

    def test_ok_path_returns_the_digest(self):
        response = client.post(URL, json=body())
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"ok": True, "digest": "- A lifetime is the span a reference stays valid."})
        call = self.llm.calls[0]
        self.assertEqual(call["task"], "chat_tree_digest")
        self.assertEqual(call["purpose"], "chat-tree.digest.fork")
        self.assertEqual(call["temperature"], 0)
        self.assertEqual(call["json_schema"]["required"], ["digest"])
        self.assertLessEqual(call["max_tokens"], 512)
        self.assertLess(call["timeout"], 60)
        self.assertIn("Question: What is a lifetime?", sent_text(call))
        self.assertIn("Chat title: Rust lifetimes", sent_text(call))

    def test_unparsable_model_output_is_ok_false(self):
        shared().bind(as_ctx(StubLlm(parsed=None, text="Sure! Here is a digest: lifetimes.")))
        response = client.post(URL, json=body())
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()["ok"])
        self.assertIn("JSON", response.json()["error"])

    def test_empty_digest_is_ok_false(self):
        shared().bind(as_ctx(StubLlm(parsed={"digest": "   "})))
        response = client.post(URL, json=body())
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["ok"], False)

    def test_model_error_is_ok_false(self):
        shared().bind(as_ctx(StubLlm(error=TimeoutError("provider took too long"))))
        response = client.post(URL, json=body())
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["ok"], False)
        self.assertIn("provider took too long", response.json()["error"])

    def test_malformed_requests_are_400_and_never_call_the_model(self):
        cases = [
            ("not json", b"{not json"),
            ("a list body", json.dumps([1, 2]).encode()),
            ("no body", b""),
            ("bad purpose", json.dumps(body(purpose="summary")).encode()),
            ("title not a string", json.dumps({**body(), "title": 3}).encode()),
            ("exchanges not a list", json.dumps({**body(), "exchanges": "hi"}).encode()),
            ("no exchanges", json.dumps(body(exchanges=[])).encode()),
            ("only empty exchanges", json.dumps(body(exchanges=[{"question": " ", "answer": ""}])).encode()),
            ("answer missing", json.dumps(body(exchanges=[{"question": "q"}])).encode()),
            ("answer not a string", json.dumps(body(exchanges=[{"question": "q", "answer": 1}])).encode()),
        ]
        for label, raw in cases:
            with self.subTest(label):
                response = client.post(URL, content=raw, headers={"content-type": "application/json"})
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.json()["ok"], False)
                self.assertTrue(response.json()["error"])
        self.assertEqual(self.llm.calls, [])

    def test_input_truncation_drops_oldest_exchanges_first(self):
        big = "x" * 5_000
        exchanges = [{"question": f"question number {i}", "answer": big} for i in range(30)]
        response = client.post(URL, json=body(exchanges=exchanges))
        self.assertEqual(response.status_code, 200)
        text = sent_text(self.llm.calls[0])
        self.assertIn("question number 29", text)  # the newest exchange stays
        self.assertNotIn("question number 0\n", text)  # the oldest went first
        kept, dropped = shared().cap(shared().parse(body(exchanges=exchanges))["exchanges"])
        self.assertEqual([e["question"] for e in kept], [f"question number {i}" for i in range(30 - len(kept), 30)])
        self.assertLessEqual(sum(len(e["question"]) + len(e["answer"]) for e in kept), shared().MAX_INPUT_CHARS)
        self.assertEqual(dropped, 30 - len(kept))
        self.assertIn(f"The {dropped} oldest exchanges were left out", text)

    def test_one_huge_field_is_cut_and_kept(self):
        exchanges = [{"question": "old", "answer": "short"}, {"question": "new", "answer": "y" * 50_000}]
        client.post(URL, json=body(exchanges=exchanges))
        text = sent_text(self.llm.calls[0])
        self.assertIn("y" * shared().MAX_FIELD_CHARS + shared().CUT_MARK, text)
        self.assertNotIn("y" * (shared().MAX_FIELD_CHARS + 1), text)
        self.assertIn("Question: old", text)  # the cut newest exchange left room for the old one

    def test_many_exchanges_keep_the_newest_ones(self):
        exchanges = [{"question": f"q{i}", "answer": "a"} for i in range(shared().MAX_EXCHANGES + 50)]
        kept, dropped = shared().cap(shared().parse(body(exchanges=exchanges))["exchanges"])
        self.assertEqual(len(kept), shared().MAX_EXCHANGES)
        self.assertEqual(kept[-1]["question"], f"q{shared().MAX_EXCHANGES + 49}")
        self.assertEqual(dropped, 50)

    def test_fork_and_merge_get_different_instructions(self):
        client.post(URL, json=body(purpose="fork"))
        client.post(URL, json=body(purpose="merge"))
        fork, merge = self.llm.calls
        self.assertEqual(fork["purpose"], "chat-tree.digest.fork")
        self.assertEqual(merge["purpose"], "chat-tree.digest.merge")
        self.assertIn("3 to 5 bullet lines", fork["instructions"])
        self.assertIn("fewer than 80 words", fork["instructions"])
        self.assertIn("fewer than 120 words", merge["instructions"])
        for part in ("Asked:", "Concluded:", "Key facts:"):
            self.assertIn(part, merge["instructions"])
        for call in (fork, merge):
            self.assertIn("Use only facts that the exchanges state", call["instructions"])
        self.assertLess(fork["max_tokens"], merge["max_tokens"])

    def test_unbound_llm_is_ok_false(self):
        shared().unbind(shared().bound())
        response = client.post(URL, json=body())
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"ok": False, "error": shared().NOT_LOADED})

    def test_ctx_without_llm_is_ok_false(self):
        shared().bind(SimpleNamespace())
        response = client.post(URL, json=body())
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["ok"], False)
        self.assertIn("ctx.llm is not available", response.json()["error"])

    def test_secrets_are_redacted_before_the_model_call(self):
        key = "sk-ant-api03-" + "A" * 40
        client.post(URL, json=body(exchanges=[{"question": f"my key is {key}", "answer": "ok"}]))
        self.assertNotIn(key, sent_text(self.llm.calls[0]))


class RegisterTest(unittest.TestCase):
    def test_register_binds_ctx_llm_and_registers_the_task(self):
        llm = StubLlm(parsed={"digest": "- d"})
        unloads, tasks = [], []
        ctx = SimpleNamespace(
            llm=llm,
            register_auxiliary_task=lambda key, **kw: tasks.append((key, kw)),
            on_unload=unloads.append,
        )
        plugin_init.register(ctx)
        self.assertEqual(tasks, [("chat_tree_digest", {
            "display_name": "Chat Tree digests",
            "description": "Fork and merge digests in the Chat Tree pane",
            "inherit_from": "title_generation",
        })])
        self.assertEqual(client.post(URL, json=body()).json(), {"ok": True, "digest": "- d"})
        for callback in unloads:
            callback()
        self.assertEqual(client.post(URL, json=body()).json()["ok"], False)
        # The route and register(ctx) share one module per process, loaded again after unload.
        self.assertIs(plugin_api._digest(), plugin_init._digest())

    def test_register_does_not_touch_ctx_llm(self):
        # The `hermes plugins validate` probe ctx has no llm attribute: register() must not read it.
        unloads = []
        ctx = SimpleNamespace(register_auxiliary_task=lambda key, **kw: None, on_unload=unloads.append)
        plugin_init.register(ctx)
        self.assertIs(shared().bound(), ctx)
        for callback in unloads:
            callback()
        self.assertIsNone(plugin_init._digest().bound())


class RealFacadeTest(unittest.TestCase):
    """The real agent.plugin_llm.PluginLlm with an injected caller: no config, no provider."""

    def _facade(self, content):
        from agent.plugin_llm import _TrustPolicy, make_plugin_llm_for_test
        self.seen = []

        def caller(**kw):
            self.seen.append(kw)
            message = SimpleNamespace(content=content)
            return "stub-provider", "stub-model", SimpleNamespace(choices=[SimpleNamespace(message=message)], usage=None)

        return make_plugin_llm_for_test(plugin_id="chat-tree", policy=_TrustPolicy(plugin_id="chat-tree"),
                                        sync_caller=caller)

    def _post_with(self, llm, registered=True):
        tasks = [{"plugin": "chat-tree", "key": "chat_tree_digest"}] if registered else []
        ctx = as_ctx(llm)
        shared().bind(ctx)
        try:
            with mock.patch("hermes_cli.plugins.get_plugin_auxiliary_tasks", return_value=tasks):
                return client.post(URL, json=body(purpose="merge"))
        finally:
            shared().unbind(ctx)

    def test_valid_json_reply(self):
        response = self._post_with(self._facade('{"digest": "Asked: x. Concluded: y."}'))
        self.assertEqual(response.json(), {"ok": True, "digest": "Asked: x. Concluded: y."})
        kw = self.seen[0]
        self.assertEqual(kw["task"], "chat_tree_digest")
        self.assertEqual(kw["temperature"], 0)
        self.assertEqual(kw["extra_body"]["response_format"]["type"], "json_schema")

    def test_fenced_json_reply_is_parsed_by_the_host(self):
        response = self._post_with(self._facade('```json\n{"digest": "- fenced"}\n```'))
        self.assertEqual(response.json(), {"ok": True, "digest": "- fenced"})

    def test_prose_reply_is_ok_false(self):
        response = self._post_with(self._facade("I cannot answer in JSON."))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["ok"], False)

    def test_reply_against_the_schema_is_ok_false(self):
        response = self._post_with(self._facade('{"digest": 5}'))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["ok"], False)

    def test_unregistered_task_is_refused_by_the_trust_gate(self):
        response = self._post_with(self._facade('{"digest": "- d"}'), registered=False)
        self.assertEqual(response.json()["ok"], False)
        self.assertIn("PluginLlmTrustError", response.json()["error"])
        self.assertEqual(self.seen, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
