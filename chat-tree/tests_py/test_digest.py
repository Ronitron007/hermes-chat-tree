"""Tests for the chat-tree Python half: register(ctx) and the plugin RPC method digest.write.

Run with the Python of the Hermes install, for example:

    <hermes venv>/bin/python chat-tree/tests_py/test_digest.py

HERMES_AGENT_DIR (default ~/.hermes/hermes-agent) is put on sys.path for agent.redact and
agent.plugin_llm. HERMES_HOME is pointed at a temporary folder, so no test reads or writes a real
Hermes home. No test calls a model: the LLM is a stub or Hermes's make_plugin_llm_for_test with a
fake caller.
"""

import contextvars
import importlib.util
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

PLUGIN = Path(__file__).resolve().parents[1]
os.environ["HERMES_HOME"] = tempfile.mkdtemp(prefix="chat-tree-test-home-")
sys.path.insert(0, os.environ.get("HERMES_AGENT_DIR", str(Path.home() / ".hermes" / "hermes-agent")))

_spec = importlib.util.spec_from_file_location("chat_tree_plugin_under_test", PLUGIN / "__init__.py")
plugin = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(plugin)

WAIT = 5  # seconds a test waits for the worker thread
CALLER_SCOPE = contextvars.ContextVar("caller_scope", default="none")


class StubLlm:
    """Records each complete_structured call and answers like PluginLlmStructuredResult."""

    def __init__(self, parsed=None, text="", error=None, gate=None):
        self.parsed, self.text, self.error, self.gate = parsed, text, error, gate
        self.calls, self.scopes = [], []

    def complete_structured(self, **kwargs):
        self.calls.append(kwargs)
        self.scopes.append(CALLER_SCOPE.get())
        if self.gate is not None:
            self.gate.wait(WAIT)
        if self.error is not None:
            raise self.error
        return SimpleNamespace(parsed=self.parsed, text=self.text,
                               content_type="text" if self.parsed is None else "json")


class FakeCtx:
    """The ctx surface register() uses, with emit_to_session captured."""

    def __init__(self, llm=None):
        if llm is not None:
            self.llm = llm
        self.tasks, self.rpcs, self.events = [], {}, []

    def register_auxiliary_task(self, key, **kwargs):
        self.tasks.append((key, kwargs))

    def register_rpc(self, name, handler):
        self.rpcs[name] = handler

    def emit_to_session(self, session_id, event, payload=None):
        self.events.append((session_id, event, payload))
        return True

    def wait_events(self, count):
        deadline = time.monotonic() + WAIT
        while time.monotonic() < deadline:
            if len(self.events) >= count:
                return list(self.events)
            time.sleep(0.01)
        raise AssertionError(f"expected {count} events, got {self.events}")


def params(purpose="fork", exchanges=None, title="Rust lifetimes"):
    if exchanges is None:
        exchanges = [{"question": "What is a lifetime?", "answer": "The span a reference stays valid."}]
    return {"session_id": "s-1", "purpose": purpose, "title": title, "exchanges": exchanges}


def loaded(llm):
    ctx = FakeCtx(llm)
    plugin.register(ctx)
    return ctx, ctx.rpcs["digest.write"]


class RegisterTest(unittest.TestCase):
    def test_register_adds_the_task_and_the_rpc_method(self):
        ctx = FakeCtx()  # no llm attribute: register() must not read ctx.llm
        plugin.register(ctx)
        self.assertEqual(ctx.tasks, [("chat_tree_digest", {
            "display_name": "Chat Tree digests",
            "description": "Fork and merge digests in the Chat Tree pane",
            "inherit_from": "title_generation",
        })])
        self.assertEqual(list(ctx.rpcs), ["digest.write"])


class HandlerTest(unittest.TestCase):
    def test_job_returns_at_once_and_the_thread_emits_the_digest(self):
        gate = threading.Event()
        llm = StubLlm(parsed={"digest": "- A lifetime is the span a reference stays valid."}, gate=gate)
        ctx, write = loaded(llm)
        answer = write(params(), session_id="s-1")
        self.assertEqual(set(answer), {"job"})
        self.assertRegex(answer["job"], r"^[0-9a-f]{32}$")
        self.assertEqual(ctx.events, [])  # the model has not answered yet
        gate.set()
        (session_id, event, payload), = ctx.wait_events(1)
        self.assertEqual((session_id, event), ("s-1", "digest.written"))
        self.assertEqual(payload, {"job": answer["job"], "digest": "- A lifetime is the span a reference stays valid."})
        call = llm.calls[0]
        self.assertEqual(call["task"], "chat_tree_digest")
        self.assertEqual(call["purpose"], "chat-tree.digest.fork")
        self.assertEqual(call["temperature"], 0)
        self.assertEqual(call["json_schema"]["required"], ["digest"])
        self.assertLessEqual(call["max_tokens"], 512)
        self.assertIn("Question: What is a lifetime?", call["input"][0]["text"])

    def test_bad_input_raises_value_error_and_starts_no_call(self):
        llm = StubLlm(parsed={"digest": "- d"})
        ctx, write = loaded(llm)
        bad = [
            ("no session", params(), None),
            ("empty session", params(), ""),
            ("params not an object", ["x"], "s-1"),
            ("bad purpose", params(purpose="summary"), "s-1"),
            ("title not a string", dict(params(), title=3), "s-1"),
            ("exchanges not a list", dict(params(), exchanges="hi"), "s-1"),
            ("no exchanges", params(exchanges=[]), "s-1"),
            ("only empty exchanges", params(exchanges=[{"question": " ", "answer": ""}]), "s-1"),
            ("answer missing", params(exchanges=[{"question": "q"}]), "s-1"),
            ("answer not a string", params(exchanges=[{"question": "q", "answer": 1}]), "s-1"),
        ]
        for label, value, session_id in bad:
            with self.subTest(label):
                with self.assertRaises(ValueError):
                    write(value, session_id=session_id)
        self.assertEqual(llm.calls, [])
        self.assertEqual(ctx.events, [])

    def test_unparsable_reply_emits_an_error(self):
        ctx, write = loaded(StubLlm(parsed=None, text="Sure! Here is a digest."))
        job = write(params(), session_id="s-1")["job"]
        (_, _, payload), = ctx.wait_events(1)
        self.assertEqual(set(payload), {"job", "error"})
        self.assertEqual(payload["job"], job)
        self.assertIn("JSON", payload["error"])

    def test_empty_digest_emits_an_error(self):
        ctx, write = loaded(StubLlm(parsed={"digest": "  "}))
        write(params(), session_id="s-1")
        (_, _, payload), = ctx.wait_events(1)
        self.assertIn("error", payload)

    def test_model_failure_emits_an_error(self):
        ctx, write = loaded(StubLlm(error=TimeoutError("provider took too long")))
        write(params(), session_id="s-1")
        (_, _, payload), = ctx.wait_events(1)
        self.assertIn("provider took too long", payload["error"])

    def test_a_fifth_call_is_refused_while_four_run(self):
        gate = threading.Event()
        llm = StubLlm(parsed={"digest": "- d"}, gate=gate)
        ctx, write = loaded(llm)
        for _ in range(plugin.MAX_IN_FLIGHT):
            write(params(), session_id="s-1")
        with self.assertRaises(RuntimeError):
            write(params(), session_id="s-1")
        gate.set()
        ctx.wait_events(plugin.MAX_IN_FLIGHT)
        write(params(), session_id="s-1")  # the slots are free again
        ctx.wait_events(plugin.MAX_IN_FLIGHT + 1)
        self.assertEqual(len(llm.calls), plugin.MAX_IN_FLIGHT + 1)

    def test_text_is_redacted_with_force_before_the_model_call(self):
        llm = StubLlm(parsed={"digest": "- d"})
        ctx, write = loaded(llm)
        with mock.patch("agent.redact.redact_sensitive_text", return_value="REDACTED TEXT") as redact:
            write(params(), session_id="s-1")
        ctx.wait_events(1)
        self.assertEqual(redact.call_count, 1)
        self.assertEqual(redact.call_args.kwargs, {"force": True})
        self.assertIn("Question: What is a lifetime?", redact.call_args.args[0])
        self.assertEqual(llm.calls[0]["input"][0]["text"], "REDACTED TEXT")

    def test_a_real_secret_never_reaches_the_model(self):
        key = "sk-ant-api03-" + "A" * 40
        llm = StubLlm(parsed={"digest": "- d"})
        ctx, write = loaded(llm)
        write(params(exchanges=[{"question": f"my key is {key}", "answer": "ok"}]), session_id="s-1")
        ctx.wait_events(1)
        self.assertNotIn(key, llm.calls[0]["input"][0]["text"])

    def test_the_thread_keeps_the_caller_context(self):
        llm = StubLlm(parsed={"digest": "- d"})
        ctx, write = loaded(llm)
        token = CALLER_SCOPE.set("profile-a")
        try:
            write(params(), session_id="s-1")
        finally:
            CALLER_SCOPE.reset(token)
        ctx.wait_events(1)
        self.assertEqual(llm.scopes, ["profile-a"])

    def test_fork_and_merge_get_different_instructions(self):
        llm = StubLlm(parsed={"digest": "- d"})
        ctx, write = loaded(llm)
        write(params(purpose="fork"), session_id="s-1")
        ctx.wait_events(1)
        write(params(purpose="merge"), session_id="s-1")
        ctx.wait_events(2)
        fork, merge = llm.calls
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


class SizeCapTest(unittest.TestCase):
    def test_oldest_exchanges_are_dropped_first(self):
        exchanges = [{"question": f"question number {i}", "answer": "x" * 5_000} for i in range(30)]
        llm = StubLlm(parsed={"digest": "- d"})
        ctx, write = loaded(llm)
        write(params(exchanges=exchanges), session_id="s-1")
        ctx.wait_events(1)
        text = llm.calls[0]["input"][0]["text"]
        kept, dropped = plugin.cap(plugin.parse(params(exchanges=exchanges))["exchanges"])
        self.assertEqual([e["question"] for e in kept], [f"question number {i}" for i in range(30 - len(kept), 30)])
        self.assertLessEqual(sum(len(e["question"]) + len(e["answer"]) for e in kept), plugin.MAX_INPUT_CHARS)
        self.assertGreater(dropped, 0)
        self.assertIn("question number 29", text)
        self.assertNotIn("question number 0\n", text)
        self.assertIn(f"The {dropped} oldest exchanges were left out", text)

    def test_one_huge_field_is_cut_and_kept(self):
        exchanges = [{"question": "old", "answer": "short"}, {"question": "new", "answer": "y" * 50_000}]
        kept, dropped = plugin.cap(plugin.parse(params(exchanges=exchanges))["exchanges"])
        self.assertEqual(dropped, 0)
        self.assertEqual(kept[-1]["answer"], "y" * plugin.MAX_FIELD_CHARS + plugin.CUT_MARK)

    def test_many_exchanges_keep_the_newest_ones(self):
        exchanges = [{"question": f"q{i}", "answer": "a"} for i in range(plugin.MAX_EXCHANGES + 50)]
        kept, dropped = plugin.cap(plugin.parse(params(exchanges=exchanges))["exchanges"])
        self.assertEqual(len(kept), plugin.MAX_EXCHANGES)
        self.assertEqual(kept[-1]["question"], f"q{plugin.MAX_EXCHANGES + 49}")
        self.assertEqual(dropped, 50)


class RealFacadeTest(unittest.TestCase):
    """The real agent.plugin_llm.PluginLlm with an injected caller: no config, no provider."""

    def _run(self, content, registered=True):
        from agent.plugin_llm import _TrustPolicy, make_plugin_llm_for_test
        seen = []

        def caller(**kw):
            seen.append(kw)
            message = SimpleNamespace(content=content)
            return "stub-provider", "stub-model", SimpleNamespace(choices=[SimpleNamespace(message=message)], usage=None)

        llm = make_plugin_llm_for_test(plugin_id="chat-tree", policy=_TrustPolicy(plugin_id="chat-tree"),
                                       sync_caller=caller)
        tasks = [{"plugin": "chat-tree", "key": "chat_tree_digest"}] if registered else []
        ctx, write = loaded(llm)
        with mock.patch("hermes_cli.plugins.get_plugin_auxiliary_tasks", return_value=tasks):
            write(params(purpose="merge"), session_id="s-1")
            (_, _, payload), = ctx.wait_events(1)
        return payload, seen

    def test_valid_json_reply(self):
        payload, seen = self._run('{"digest": "Asked: x. Concluded: y."}')
        self.assertEqual(payload["digest"], "Asked: x. Concluded: y.")
        self.assertEqual(seen[0]["task"], "chat_tree_digest")
        self.assertEqual(seen[0]["extra_body"]["response_format"]["type"], "json_schema")

    def test_fenced_json_reply_is_parsed_by_the_host(self):
        payload, _ = self._run('```json\n{"digest": "- fenced"}\n```')
        self.assertEqual(payload["digest"], "- fenced")

    def test_prose_reply_emits_an_error(self):
        payload, _ = self._run("I cannot answer in JSON.")
        self.assertIn("error", payload)

    def test_reply_against_the_schema_emits_an_error(self):
        payload, _ = self._run('{"digest": 5}')
        self.assertIn("error", payload)

    def test_unregistered_task_is_refused_by_the_trust_gate(self):
        payload, seen = self._run('{"digest": "- d"}', registered=False)
        self.assertIn("PluginLlmTrustError", payload["error"])
        self.assertEqual(seen, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
