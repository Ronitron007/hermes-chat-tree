"""Tests for the chat-tree plugin RPC method history.read (stored chat histories for the tree).

Run with the Python of the Hermes install, for example:

    <hermes venv>/bin/python chat-tree/tests_py/test_history.py

HERMES_HOME is pointed at a temporary folder before hermes_state is imported, and each test makes
its own state.db there with SessionDB's own API. No test reads or writes a real Hermes home, and no
test calls a model. hermes_state comes from the venv's own import path (its editable install), so
this file adds nothing to sys.path.
"""

import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

PLUGIN = Path(__file__).resolve().parents[1]
os.environ["HERMES_HOME"] = tempfile.mkdtemp(prefix="chat-tree-history-home-")

import hermes_state  # noqa: E402
from hermes_constants import reset_hermes_home_override, set_hermes_home_override  # noqa: E402

_spec = importlib.util.spec_from_file_location("chat_tree_history_under_test", PLUGIN / "__init__.py")
plugin = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(plugin)


class FakeCtx:
    def __init__(self):
        self.tasks, self.rpcs = [], {}

    def register_auxiliary_task(self, key, **kwargs):
        self.tasks.append((key, kwargs))

    def register_rpc(self, name, handler):
        self.rpcs[name] = handler


def handler():
    ctx = FakeCtx()
    plugin.register(ctx)
    return ctx.rpcs["history.read"]


def seed(home, sessions):
    """Write sessions {id: [(role, content, extra)]} to <home>/state.db with SessionDB's own API."""
    db = hermes_state.SessionDB(db_path=Path(home) / "state.db")
    try:
        for sid, rows in sessions.items():
            db.create_session(session_id=sid, source="cli", model="test/model")
            for role, content, extra in rows:
                db.append_message(session_id=sid, role=role, content=content, **extra)
    finally:
        db.close()


CALL = {"id": "c1", "type": "function", "function": {"name": "terminal", "arguments": "{}"}}
CHATS = {
    "chat-a": [
        ("user", "What is a lifetime?", {}),
        ("assistant", "", {"tool_calls": [CALL]}),  # a tool call with no text
        ("tool", "tool output", {"tool_call_id": "c1"}),
        ("assistant", "The span a reference stays valid.", {}),
        ("user", "[System: model switched]", {}),  # a gateway notice, never a user bubble
        ("system", "system text", {}),
        ("user", [{"type": "text", "text": "And "}, {"type": "text", "text": "borrowing?"}], {}),
        ("assistant", "A borrow is a reference.", {}),
    ],
    "chat-b": [
        ("user", "Branch question", {}),
        ("assistant", "Branch answer", {}),
    ],
    "chat-empty": [],
}


class HistoryReadTest(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="chat-tree-history-profile-")
        seed(self.home, CHATS)
        self.token = set_hermes_home_override(self.home)  # the profile scope a plugin RPC runs in

    def tearDown(self):
        reset_hermes_home_override(self.token)

    def test_reads_two_stored_chats_with_user_and_assistant_rows_only(self):
        result = handler()({"session_ids": ["chat-a", "chat-b"]}, session_id=None)
        self.assertEqual(result["missing"], [])
        rows_a = result["histories"]["chat-a"]
        self.assertEqual([(r["role"], r["text"]) for r in rows_a], [
            ("user", "What is a lifetime?"),
            ("assistant", "The span a reference stays valid."),
            ("user", "And borrowing?"),
            ("assistant", "A borrow is a reference."),
        ])
        ids = [r["row_id"] for r in rows_a]
        self.assertEqual(ids, sorted(ids))  # oldest first
        self.assertTrue(all(isinstance(i, int) for i in ids))
        self.assertEqual([(r["role"], r["text"]) for r in result["histories"]["chat-b"]],
                         [("user", "Branch question"), ("assistant", "Branch answer")])

    def test_accepts_the_open_chat_session_id(self):
        result = handler()({"session_ids": ["chat-b"], "session_id": "local-runtime"}, session_id="local-runtime")
        self.assertEqual(len(result["histories"]["chat-b"]), 2)

    def test_reports_missing_ids_and_an_empty_chat(self):
        result = handler()({"session_ids": ["nope", "chat-empty", "chat-b"]}, session_id=None)
        self.assertEqual(result["missing"], ["nope"])
        self.assertEqual(result["histories"]["chat-empty"], [])
        self.assertEqual(sorted(result["histories"]), ["chat-b", "chat-empty"])

    def test_dedupes_ignores_non_strings_and_caps_at_30(self):
        ids = ["chat-b", "chat-b", 7, None, {"x": 1}, "", "  ", "x" * 201] + [f"gone-{i}" for i in range(40)]
        result = handler()({"session_ids": ids}, session_id=None)
        self.assertEqual(list(result["histories"]), ["chat-b"])
        self.assertEqual(result["missing"], [f"gone-{i}" for i in range(29)])
        self.assertEqual(len(result["histories"]) + len(result["missing"]), plugin.MAX_HISTORY_IDS)

    def test_rejects_bad_params(self):
        read = handler()
        for bad in (None, [], "chat-a", {"session_ids": "chat-a"}, {"session_ids": None}, {}):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                read(bad, session_id=None)

    def test_one_read_only_open_per_call_in_the_calling_profile(self):
        opened = []
        real = hermes_state.SessionDB

        def spy(*args, **kwargs):
            db = real(*args, **kwargs)
            opened.append((args, kwargs, db.db_path))
            return db

        with mock.patch.object(hermes_state, "SessionDB", spy):
            handler()({"session_ids": ["chat-a", "chat-b", "nope"]}, session_id=None)
        self.assertEqual(len(opened), 1)
        self.assertEqual(opened[0][:2], ((), {"read_only": True}))
        self.assertEqual(Path(opened[0][2]).resolve(), (Path(self.home) / "state.db").resolve())

    def test_another_profile_scope_reads_its_own_store(self):
        other = tempfile.mkdtemp(prefix="chat-tree-history-other-")
        seed(other, {"chat-b": [("user", "Other profile", {}), ("assistant", "Other answer", {})]})
        token = set_hermes_home_override(other)
        try:
            result = handler()({"session_ids": ["chat-a", "chat-b"]}, session_id=None)
        finally:
            reset_hermes_home_override(token)
        self.assertEqual(result["missing"], ["chat-a"])
        self.assertEqual([r["text"] for r in result["histories"]["chat-b"]], ["Other profile", "Other answer"])

    def test_the_read_does_not_write_the_store(self):
        db_file = Path(self.home) / "state.db"
        before = (db_file.stat().st_size, db_file.stat().st_mtime_ns)
        handler()({"session_ids": ["chat-a", "chat-b"]}, session_id=None)
        self.assertEqual((db_file.stat().st_size, db_file.stat().st_mtime_ns), before)

    def test_empty_list_opens_nothing(self):
        with mock.patch.object(hermes_state, "SessionDB", side_effect=AssertionError("opened")):
            self.assertEqual(handler()({"session_ids": []}, session_id=None), {"histories": {}, "missing": []})


class ProjectionTest(unittest.TestCase):
    def test_hidden_rows_and_bad_shapes_are_dropped(self):
        rows = plugin.project_history([
            {"role": "user", "content": "kept", "_row_id": 3},
            {"role": "assistant", "content": "scaffold", "display_kind": "hidden"},
            {"role": "assistant", "content": {"text": "dict text"}, "_row_id": True},
            "not a row",
            {"role": "user", "content": None},
        ])
        self.assertEqual(rows, [{"role": "user", "text": "kept", "row_id": 3},
                                {"role": "assistant", "text": "dict text"}])
        self.assertEqual(plugin.project_history(None), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
