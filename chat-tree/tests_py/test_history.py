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


def seed(home, sessions, meta=None):
    """Write sessions {id: [(role, content, extra)]} to <home>/state.db with SessionDB's own API.

    meta: {id: create_session kwargs (parent_session_id, model_config), plus hidden=True or archived=True}.
    Parents come before their children in ``sessions``."""
    db = hermes_state.SessionDB(db_path=Path(home) / "state.db")
    try:
        for sid, rows in sessions.items():
            extra = dict((meta or {}).get(sid, {}))
            hidden, archived = extra.pop("hidden", False), extra.pop("archived", False)
            db.create_session(session_id=sid, source="cli", model="test/model", **extra)
            for role, content, kwargs in rows:
                db.append_message(session_id=sid, role=role, content=content, **kwargs)
            if hidden:
                db.set_session_hidden(sid, True)
            if archived:
                db.set_session_archived(sid, True, notify=False)
    finally:
        db.close()


def branch_of(parent, **flags):
    return {"parent_session_id": parent, "model_config": {"_branched_from": parent}, **flags}


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
    "chat-c": [("user", "Grandchild question", {}), ("assistant", "Grandchild answer", {})],
    "chat-hidden": [("user", "Hidden question", {}), ("assistant", "Hidden answer", {})],
    "chat-archived": [("user", "Archived question", {}), ("assistant", "Archived answer", {})],
    "chat-reset": [("user", "After /new", {}), ("assistant", "A new conversation", {})],
    "other": [("user", "Unrelated question", {}), ("assistant", "Unrelated answer", {})],
    "other-kid": [("user", "Unrelated branch", {}), ("assistant", "Unrelated branch answer", {})],
}
# One lineage: chat-a and its branches chat-b, chat-empty, chat-c (an older fork with only
# parent_session_id), chat-hidden and chat-archived. chat-reset (/new from chat-a) and other with
# other-kid are other lineages.
META = {
    "chat-b": branch_of("chat-a"),
    "chat-empty": branch_of("chat-a"),
    "chat-c": {"parent_session_id": "chat-b"},
    "chat-hidden": branch_of("chat-a", hidden=True),
    "chat-archived": branch_of("chat-a", archived=True),
    "chat-reset": {"parent_session_id": "chat-a", "model_config": {"_reset_from": "chat-a"}},
    "other-kid": branch_of("other"),
}


class HistoryReadTest(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="chat-tree-history-profile-")
        seed(self.home, CHATS, META)
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
        # session.branch counts the [System: notice (branch index 2) that the tree never shows, so a
        # branch after "And borrowing?" keeps 4 + 1 = 5 rows, not 4.
        self.assertEqual([r["branch_index"] for r in rows_a], [0, 1, 3, 4])
        self.assertEqual([(r["role"], r["text"]) for r in result["histories"]["chat-b"]],
                         [("user", "Branch question"), ("assistant", "Branch answer")])

    def test_reads_only_the_lineage_of_the_open_chat(self):
        ids = ["chat-a", "chat-b", "chat-c", "other", "other-kid", "chat-reset"]
        result = handler()({"session_ids": ids, "session_id": "chat-c"}, session_id="chat-c")
        self.assertEqual(list(result["histories"]), ["chat-a", "chat-b", "chat-c"])
        self.assertEqual(result["skipped"], ["other", "other-kid", "chat-reset"])
        self.assertEqual(result["missing"], [])
        self.assertFalse(result["truncated"])

    def test_the_lineage_of_another_open_chat(self):
        ids = ["chat-a", "chat-b", "other", "other-kid"]
        result = handler()({"session_ids": ids, "session_id": "other"}, session_id="other")
        self.assertEqual(list(result["histories"]), ["other", "other-kid"])
        self.assertEqual(result["skipped"], ["chat-a", "chat-b"])

    def test_skips_hidden_and_archived_chats(self):
        ids = ["chat-hidden", "chat-archived", "chat-b"]
        result = handler()({"session_ids": ids, "session_id": "chat-a"}, session_id="chat-a")
        self.assertEqual(list(result["histories"]), ["chat-b"])
        self.assertEqual(result["skipped"], ["chat-hidden", "chat-archived"])

    def test_an_open_chat_that_is_not_stored_reads_nothing(self):
        result = handler()({"session_ids": ["chat-a", "chat-b", "nope"], "session_id": "local-runtime"},
                           session_id="local-runtime")
        self.assertEqual(result["histories"], {})
        self.assertEqual(result["skipped"], ["chat-a", "chat-b"])
        self.assertEqual(result["missing"], ["nope"])

    def test_a_sessionless_call_reads_the_lineage_of_its_first_readable_chat(self):
        ids = ["nope", "chat-hidden", "other", "chat-a", "other-kid"]
        result = handler()({"session_ids": ids}, session_id=None)
        self.assertEqual(list(result["histories"]), ["other", "other-kid"])
        self.assertEqual(result["skipped"], ["chat-hidden", "chat-a"])
        self.assertEqual(result["missing"], ["nope"])

    def test_reports_missing_ids_and_an_empty_chat(self):
        result = handler()({"session_ids": ["nope", "chat-empty", "chat-b"]}, session_id=None)
        self.assertEqual(result["missing"], ["nope"])
        self.assertEqual(result["skipped"], [])
        self.assertEqual(result["histories"]["chat-empty"], [])
        self.assertEqual(sorted(result["histories"]), ["chat-b", "chat-empty"])

    def test_the_reply_text_is_capped_and_says_so(self):
        with mock.patch.object(plugin, "MAX_REPLY_CHARS", 60):
            result = handler()({"session_ids": ["chat-a", "chat-b"], "session_id": "chat-a"}, session_id="chat-a")
        self.assertTrue(result["truncated"])
        rows = [row for chat in result["histories"].values() for row in chat]
        self.assertLessEqual(sum(len(row["text"]) for row in rows), 60)
        self.assertEqual(len(result["histories"]["chat-a"]), 4)  # every row stays, with its row id
        self.assertTrue(all(isinstance(row["row_id"], int) for row in rows))
        self.assertEqual([row["text"] for row in result["histories"]["chat-a"]],
                         ["", "", "And borrowing?", "A borrow is a reference."])
        self.assertEqual([row["text"] for row in result["histories"]["chat-b"]], ["", ""])

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

        class Spy(hermes_state.SessionDB):  # a subclass: Hermes code reads class helpers off the module name
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                opened.append((args, kwargs, self.db_path))

        with mock.patch.object(hermes_state, "SessionDB", Spy):
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
            self.assertEqual(handler()({"session_ids": []}, session_id=None),
                             {"histories": {}, "missing": [], "skipped": [], "truncated": False})


class ProjectionTest(unittest.TestCase):
    def test_hidden_rows_and_bad_shapes_are_dropped(self):
        rows = plugin.project_history([
            {"role": "user", "content": "kept", "_row_id": 3},
            {"role": "assistant", "content": "scaffold", "display_kind": "hidden"},
            {"role": "assistant", "content": {"text": "dict text"}, "_row_id": True},
            "not a row",
            {"role": "user", "content": None},
        ])
        self.assertEqual(rows, [{"role": "user", "text": "kept", "branch_index": 0, "row_id": 3},
                                {"role": "assistant", "text": "dict text", "branch_index": 2}])
        self.assertEqual(plugin.project_history(None), [])

    def test_branch_index_counts_the_rows_that_session_branch_keeps(self):
        rows = plugin.project_history([
            {"role": "user", "content": "q1"},  # 0
            {"role": "assistant", "content": "a1"},  # 1
            {"role": "assistant", "content": "scaffold", "display_kind": "hidden"},  # 2, not returned
            {"role": "user", "content": [{"type": "image_url", "image_url": {"url": "x"}}]},  # 3, no text
            {"role": "tool", "content": "tool output"},  # not a user or assistant row
            {"role": "user", "content": "[System: model switched]"},  # 4, not returned
            {"role": "user", "content": "q2"},  # 5
            {"role": "assistant", "content": "   "},  # blank: session.branch drops it too
            {"role": "assistant", "content": [{"type": "text", "text": "a2"}]},  # 6
        ])
        self.assertEqual([(r["text"], r["branch_index"]) for r in rows], [("q1", 0), ("a1", 1), ("q2", 5), ("a2", 6)])

    def test_branch_text_blank_tests(self):
        for content, blank in (("", True), ("  ", True), (None, True), ([], True), ({"type": "text", "text": ""}, True),
                               ("x", False), ([{"type": "input_image"}], False), ({"type": "input_audio"}, False),
                               ({"note": 1}, False), ([{"text": " "}, {"unknown": 1}], True)):
            with self.subTest(content=content):
                self.assertEqual(not plugin.branch_text(content).strip(), blank)


class FakeDb:
    """get_session over a dict, to walk parent links that a real store refuses to hold."""

    def __init__(self, rows):
        self.rows, self.reads = rows, []

    def get_session(self, sid):
        self.reads.append(sid)
        return self.rows.get(sid)


class LineageRootTest(unittest.TestCase):
    def root(self, rows, sid):
        return plugin.lineage_root(FakeDb(rows), sid, {}, {})

    def test_parent_rules(self):
        rows = {
            "root": {},
            "branch": {"_branched_from": "root", "parent_session_id": "elsewhere"},
            "old-fork": {"parent_session_id": "branch"},
            "reset": {"_reset_from": "root", "parent_session_id": "root"},
            "orphan": {"parent_session_id": "deleted"},
        }
        self.assertEqual(self.root(rows, "old-fork"), "root")
        self.assertEqual(self.root(rows, "reset"), "reset")  # /new starts its own lineage
        self.assertEqual(self.root(rows, "orphan"), "orphan")  # a parent not in the store ends the walk

    def test_a_cycle_has_no_root(self):
        rows = {"x": {"parent_session_id": "y"}, "y": {"parent_session_id": "x"}, "z": {"parent_session_id": "x"}}
        self.assertIsNone(self.root(rows, "z"))

    def test_a_walk_past_the_cap_has_no_root(self):
        rows = {"n0": {}}
        for i in range(1, plugin.MAX_PARENT_LINKS + 3):
            rows[f"n{i}"] = {"parent_session_id": f"n{i - 1}"}
        self.assertIsNone(self.root(rows, f"n{plugin.MAX_PARENT_LINKS + 2}"))
        self.assertEqual(self.root(rows, f"n{plugin.MAX_PARENT_LINKS}"), "n0")

    def test_a_shared_ancestor_is_read_once(self):
        db = FakeDb({"root": {}, "a": {"parent_session_id": "root"}, "b": {"parent_session_id": "root"}})
        rows, roots = {}, {}
        self.assertEqual([plugin.lineage_root(db, sid, rows, roots) for sid in ("a", "b")], ["root", "root"])
        self.assertEqual(sorted(db.reads), ["a", "b", "root"])


class CapTest(unittest.TestCase):
    def test_the_oldest_exchanges_lose_their_text_in_every_chat_at_once(self):
        def chat(*texts):
            roles = ("assistant",) + ("user", "assistant") * 3
            return [{"role": role, "text": text, "row_id": i} for i, (role, text) in enumerate(zip(roles, texts))]

        # 36 characters: exchange 0 holds 24 (the greeting goes with it), exchange 1 holds 8, exchange 2 holds 4.
        histories = {"parent": chat("greeting", "q0", "a0", "q1", "a1", "q2", "a2"),
                     "branch": chat("greeting", "q0", "a0", "q1", "b1")}
        with mock.patch.object(plugin, "MAX_REPLY_CHARS", 11):
            self.assertTrue(plugin.cap_histories(histories))
        # A row before the first user row goes with exchange 0. Rows and row ids all stay.
        self.assertEqual([r["text"] for r in histories["parent"]], ["", "", "", "", "", "q2", "a2"])
        self.assertEqual([r["text"] for r in histories["branch"]], ["", "", "", "", ""])
        self.assertEqual([r["row_id"] for r in histories["parent"]], list(range(7)))
        with mock.patch.object(plugin, "MAX_REPLY_CHARS", 1000):
            self.assertFalse(plugin.cap_histories(histories))


if __name__ == "__main__":
    unittest.main(verbosity=2)
