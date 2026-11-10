import importlib.util
import threading
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

_spec = importlib.util.spec_from_file_location("lookup_sources_under_test", Path(__file__).resolve().parent.parent / "lookup_sources.py")
ls = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ls)

MDN_DOC = {"documents": [{"title": "Flexbox", "summary": "A CSS layout model.", "mdn_url": "/en-US/docs/Glossary/Flexbox"}]}
WIKTIONARY = {"en": [{"definitions": [{"definition": "A <b>small</b> &amp; useful thing."}]}]}
WIKIPEDIA = {"type": "standard", "title": "Monad", "extract": "A structure in math.", "content_urls": {"desktop": {"page": "https://en.wikipedia.org/wiki/Monad"}}}


def fake_transport(payloads):
    """Build a fetch(url, timeout) that answers by host; a missing host is a 404."""
    calls = []

    def fetch(url, timeout):
        calls.append((url, timeout))
        for host, payload in payloads.items():
            if host in url:
                if isinstance(payload, Exception):
                    raise payload
                return payload
        raise ls.NoDefinition("no definition")

    fetch.calls = calls
    return fetch


class SourceTest(unittest.TestCase):
    def test_mdn_hit_and_url(self):
        fetch = fake_transport({"developer.mozilla.org": MDN_DOC})
        d = ls.mdn("flexbox", timeout=0.5, fetch=fetch)
        self.assertEqual((d["short"], d["source"], d["providerId"]), ("A CSS layout model.", "MDN", "mdn"))
        self.assertEqual(d["url"], "https://developer.mozilla.org/en-US/docs/Glossary/Flexbox")
        self.assertEqual(fetch.calls, [("https://developer.mozilla.org/api/v1/search?q=flexbox&locale=en-US", 0.5)])

    def test_mdn_miss_when_title_does_not_match(self):
        fetch = fake_transport({"developer.mozilla.org": MDN_DOC})
        with self.assertRaises(ls.NoDefinition):
            ls.mdn("grid", fetch=fetch)
        with self.assertRaises(ls.NoDefinition):
            ls.mdn("grid", fetch=fake_transport({"developer.mozilla.org": {"documents": []}}))

    def test_wiktionary_hit_strips_markup(self):
        d = ls.wiktionary("thing", fetch=fake_transport({"wiktionary.org": WIKTIONARY}))
        self.assertEqual((d["short"], d["source"]), ("A small & useful thing.", "Wiktionary"))
        self.assertEqual(d["url"], "https://en.wiktionary.org/wiki/thing")

    def test_wiktionary_miss(self):
        with self.assertRaises(ls.NoDefinition):
            ls.wiktionary("thing", fetch=fake_transport({"wiktionary.org": {"en": [{"definitions": [{"definition": " "}]}]}}))
        with self.assertRaises(ls.NoDefinition):
            ls.wiktionary("thing", fetch=fake_transport({}))

    def test_wikipedia_hit_and_misses(self):
        d = ls.wikipedia("Monad", fetch=fake_transport({"wikipedia.org": WIKIPEDIA}))
        self.assertEqual((d["short"], d["source"], d["url"]), ("A structure in math.", "Wikipedia", "https://en.wikipedia.org/wiki/Monad"))
        for payload in ({"type": "disambiguation", "extract": "x"}, {"extract": " "}, []):
            with self.assertRaises(ls.NoDefinition):
                ls.wikipedia("Monad", fetch=fake_transport({"wikipedia.org": payload}))

    def test_upstream_error_propagates(self):
        with self.assertRaises(ls.UpstreamError):
            ls.wikipedia("x", fetch=fake_transport({"wikipedia.org": ls.UpstreamError("upstream error")}))

    def test_long_definitions_are_clipped(self):
        d = ls.wikipedia("x", fetch=fake_transport({"wikipedia.org": {"extract": " ".join(["w"] * 200)}}))
        self.assertTrue(d["short"].endswith("\u2026"))
        self.assertEqual(len(d["short"].split()), 25)

    def test_get_json_maps_http_errors_without_a_network(self):
        def raising(exc):
            return mock.patch.object(ls.urllib.request, "urlopen", side_effect=exc)

        with raising(urllib.error.HTTPError("u", 404, "nf", {}, None)):
            with self.assertRaises(ls.NoDefinition):
                ls.get_json("http://x", 1)
        with raising(urllib.error.HTTPError("u", 500, "err", {}, None)):
            with self.assertRaises(ls.UpstreamError):
                ls.get_json("http://x", 1)
        with raising(urllib.error.URLError("down")):
            with self.assertRaises(ls.UpstreamError):
                ls.get_json("http://x", 1)

    def test_get_json_passes_the_timeout_to_urlopen(self):
        with mock.patch.object(ls.urllib.request, "urlopen", side_effect=OSError("stop")) as op:
            with self.assertRaises(ls.UpstreamError):
                ls.get_json("http://x", 0.7)
        self.assertEqual(op.call_args.kwargs["timeout"], 0.7)


class FakeClock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


class ResolverTest(unittest.TestCase):
    def resolver(self, fetch, clock=None, **kw):
        kw.setdefault("cache", ls.Cache())
        return ls.Resolver(fetch=fetch, clock=clock or FakeClock(), **kw)

    def test_sources_are_tried_in_order_and_stop_at_the_first_hit(self):
        fetch = fake_transport({"wiktionary.org": WIKTIONARY, "wikipedia.org": WIKIPEDIA})
        self.assertEqual(self.resolver(fetch)(["Thing"]), {"thing": "A small & useful thing."})
        hosts = [u.split("/")[2] for u, _ in fetch.calls]
        self.assertEqual(hosts, ["developer.mozilla.org", "en.wiktionary.org"])

    def test_falls_through_to_wikipedia(self):
        fetch = fake_transport({"wikipedia.org": WIKIPEDIA})
        self.assertEqual(self.resolver(fetch)(["Monad"]), {"monad": "A structure in math."})
        self.assertEqual(len(fetch.calls), 3)

    def test_all_sources_miss_is_none_not_a_definition(self):
        self.assertEqual(self.resolver(fake_transport({}))(["blorp"]), {"blorp": None})

    def test_failing_sources_leave_the_term_unresolved(self):
        err = ls.UpstreamError("down")
        fetch = fake_transport({"mozilla": err, "wiktionary": err, "wikipedia": err})
        self.assertEqual(self.resolver(fetch)(["blorp"]), {})

    def test_a_later_hit_wins_over_an_earlier_error(self):
        fetch = fake_transport({"mozilla": ls.UpstreamError("down"), "wikipedia.org": WIKIPEDIA})
        self.assertEqual(self.resolver(fetch)(["Monad"]), {"monad": "A structure in math."})

    def test_cache_is_keyed_by_term_and_source_and_shared(self):
        cache = ls.Cache()
        fetch = fake_transport({"mozilla": MDN_DOC})
        self.assertEqual(self.resolver(fetch, cache=cache)(["Flexbox"]), {"flexbox": "A CSS layout model."})
        again = fake_transport({})
        self.assertEqual(self.resolver(again, cache=cache)(["flexbox"]), {"flexbox": "A CSS layout model."})
        self.assertEqual(again.calls, [])
        self.assertIn(("flexbox", "mdn"), cache._data)

    def test_misses_and_errors_are_cached_too(self):
        cache = ls.Cache()
        self.resolver(fake_transport({}), cache=cache)(["blorp"])
        quiet = fake_transport({"wikipedia.org": WIKIPEDIA})
        self.assertEqual(self.resolver(quiet, cache=cache)(["blorp"]), {"blorp": None})
        self.assertEqual(quiet.calls, [])

    def test_cache_entries_expire_and_the_cache_is_bounded(self):
        cache = ls.Cache(size=2)
        cache.put(("a", "mdn"), ls.HIT, "x", now=0, ttl=10)
        self.assertIsNotNone(cache.get(("a", "mdn"), 5))
        self.assertIsNone(cache.get(("a", "mdn"), 11))
        for k in "bcd":
            cache.put((k, "mdn"), ls.HIT, "x", now=0, ttl=10)
        self.assertEqual(sorted(k[0] for k in cache._data), ["c", "d"])

    def test_request_timeouts_fit_the_remaining_budget(self):
        clock, timeouts = FakeClock(), []

        def fetch(url, timeout):
            timeouts.append(round(timeout, 3))
            clock.now += 0.6
            raise ls.NoDefinition("no definition")

        out = self.resolver(fetch, clock)(["one", "two", "three"])
        self.assertEqual(timeouts, [1.0, 0.9, 0.3])
        self.assertEqual(out, {"one": None})  # "two" and "three" never got a request
        self.assertTrue(all(t <= ls.BUDGET for t in timeouts))

    def test_finished_lookups_are_kept_when_time_runs_out(self):
        clock = FakeClock()

        def fetch(url, timeout):
            if "alpha" in url:
                clock.now += 0.1
                return {"documents": [{"title": "alpha", "summary": "First."}]}
            clock.now += 2.0
            raise ls.UpstreamError("slow")

        requested = []
        out = self.resolver(lambda u, t: requested.append(u) or fetch(u, t), clock)(["alpha", "beta", "gamma"])
        self.assertEqual(out, {"alpha": "First."})
        self.assertFalse(any("gamma" in u for u in requested))

    def test_lookup_cap_per_resolver(self):
        fetch = fake_transport({})
        r = self.resolver(fetch, sources=("mdn",))
        names = ["t%d" % i for i in range(12)]
        out = r(names)
        self.assertEqual(sorted(out), sorted(n for n in names[:ls.MAX_LOOKUPS]))
        self.assertEqual(len(fetch.calls), ls.MAX_LOOKUPS)
        self.assertEqual(r(["t11"]), {})
        self.assertEqual(len(fetch.calls), ls.MAX_LOOKUPS)

    def test_budget_is_shared_across_calls(self):
        clock, calls = FakeClock(), []

        def fetch(url, timeout):
            calls.append(timeout)
            clock.now += 1.0
            raise ls.NoDefinition("no definition")

        r = self.resolver(fetch, clock, sources=("mdn",))
        self.assertEqual(r(["a"]), {"a": None})
        self.assertEqual(r(["b"]), {"b": None})  # 0.5s left
        self.assertEqual(r(["c"]), {})  # spent
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[1], 0.5)

    def test_a_stuck_transport_cannot_hold_the_caller_past_the_budget(self):
        release = threading.Event()
        self.addCleanup(release.set)
        r = ls.Resolver(budget=0.2, fetch=lambda u, t: release.wait(5), cache=ls.Cache())
        started = ls.time.monotonic()
        self.assertEqual(r(["stuck"]), {})
        self.assertLess(ls.time.monotonic() - started, 1.0)


if __name__ == "__main__":
    unittest.main()
