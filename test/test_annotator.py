import importlib.util
import re
import unittest
from pathlib import Path

_spec = importlib.util.spec_from_file_location("concept_links", Path(__file__).resolve().parent.parent / "__init__.py")
cl = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cl)

MONOID = "An associative binary operation together with an identity element, such as addition with zero."
FUNCTOR = "A container type that supports mapping a function over its contents while keeping the container structure unchanged."
MONAD = "A design pattern that wraps values in a context and chains operations on them, handling the context such as failure or state automatically."
IDEMPOTENCY = "The property that repeating an operation has the same effect as doing it once, which makes retries safe."
SENTENCE = "A monoid lets you fold a list in any grouping, and a functor maps over it."
HASKELL = "In Haskell, a **monad** sequences effects, and idempotency matters for retries."
JS_GLOSSARY = Path(__file__).resolve().parent.parent / "src" / "static-glossary.js"


class AnnotatorTest(unittest.TestCase):
    def setUp(self):
        # No test may reach the network: any request is recorded and fails like an outage.
        lookup = cl._lookup_module()
        lookup.CACHE.clear()
        self.requests = []

        def offline(url, timeout=None):
            self.requests.append(url)
            raise lookup.UpstreamError("offline")

        original = lookup.get_json
        lookup.get_json = offline
        self.addCleanup(setattr, lookup, "get_json", original)
        self.addCleanup(lookup.CACHE.clear)

    def test_exact_haskell_monad_sentence(self):
        self.assertEqual(
            cl.annotate_terms(HASKELL),
            '::termline{v="%s" t="monad=%s;;idempotency=%s"}' % (HASKELL, MONAD, IDEMPOTENCY),
        )
        self.assertEqual(self.requests, [])

    def test_haskell_sentence_with_trailing_newline_keeps_it(self):
        self.assertTrue(cl.annotate_terms(HASKELL + "\n").endswith("}\n"))

    def test_bundled_glossary_has_the_common_terms(self):
        names = {t for t, _ in cl.GLOSSARY}
        for term in ("monad", "functor", "hoisting", "idempotency", "flexbox", "grid"):
            self.assertIn(term, names)
        out = cl.annotate_terms("Use flexbox for rows, and grid for tables, since hoisting surprises people.")
        self.assertEqual(len(re.findall(r";;", out)), 2)

    def test_python_and_js_glossaries_stay_in_sync(self):
        js = JS_GLOSSARY.read_text(encoding="utf-8")
        pairs = re.findall(r"\{ term: '([^']*)', def: '([^']*)' \}", js)
        self.assertEqual(pairs, [tuple(p) for p in cl.GLOSSARY])
        for term, definition in cl.GLOSSARY:
            self.assertNotRegex(term + definition, r'["{}\n]')

    def test_exact_monoid_functor_sentence(self):
        self.assertEqual(
            cl.annotate_terms(SENTENCE),
            '::termline{v="%s" t="monoid=%s;;functor=%s"}' % (SENTENCE, MONOID, FUNCTOR),
        )

    def test_mid_sentence_terms_become_one_termline(self):
        src = (
            'A ::term{name="monoid" def="combines values"} lets you fold a list, '
            "and a ::term{name='functor' def='maps over a box'} maps over it."
        )
        out = cl.annotate_terms(src)
        self.assertEqual(
            out,
            '::termline{v="A monoid lets you fold a list, and a functor maps over it." '
            't="monoid=combines values;;functor=maps over a box"}',
        )
        self.assertNotIn("::term{", out)

    def test_mid_sentence_term_without_def_and_glossary_fill(self):
        out = cl.annotate_terms('A ::term{name="functor"} next to a semigroup.')
        self.assertTrue(out.startswith('::termline{v="A functor next to a semigroup." t="functor=;;semigroup='))

    def test_whole_paragraph_term_is_rewritten(self):
        self.assertEqual(
            cl.annotate_terms('::term{name="monoid" def="d"}'),
            '::termline{v="monoid" t="monoid=d"}',
        )

    def test_only_prose_paragraphs_change_and_first_mention_wins(self):
        src = "Intro.\n\n%s\n\nA monoid again.\n" % SENTENCE
        out = cl.annotate_terms(src)
        self.assertTrue(out.startswith("Intro.\n\n::termline{"))
        self.assertTrue(out.endswith("\n\nA monoid again.\n"))
        self.assertEqual(out.count("::termline{"), 1)

    def test_fenced_code_is_untouched(self):
        self.assertIsNone(cl.annotate_terms("Here is code:\n```\nmonoid\n```\nDone."))
        self.assertIsNone(cl.annotate_terms("```\nmonoid\n```"))

    def test_heading_and_list_are_untouched(self):
        self.assertIsNone(cl.annotate_terms("# The monoid"))
        self.assertIsNone(cl.annotate_terms("- a monoid\n- a thing"))

    def test_inline_code_paragraph_is_untouched(self):
        self.assertIsNone(cl.annotate_terms("A monoid built from `x`."))

    def test_no_terms_returns_none(self):
        self.assertIsNone(cl.annotate_terms("Nothing special in this sentence."))
        self.assertIsNone(cl.annotate_terms(""))
        self.assertIsNone(cl.annotate_terms(None))

    def test_existing_termline_is_unchanged(self):
        src = '::termline{v="A monoid works." t="monoid=d"}'
        self.assertIsNone(cl.annotate_terms(src))
        self.assertIsNone(cl.annotate_terms(src + "\n\nA monoid again."))

    def test_custom_glossary_escapes_t_parts(self):
        out = cl.annotate_terms("Use a widget here.", [("widget", "x=y; z;;w \\ {q}")])
        self.assertEqual(out, '::termline{v="Use a widget here." t="widget=x\\=y\\; z\\;\\;w \\\\ q"}')
        body = out[len("::termline{"):-1]
        self.assertNotRegex(body, r"[{}\n]")

    def test_quotes_use_single_quote_attrs_or_are_stripped(self):
        out = cl.annotate_terms('Say "hi" to a monoid.')
        self.assertTrue(out.startswith("::termline{v='Say \"hi\" to a monoid.' t='monoid="))
        both = cl.annotate_terms("Say \"hi\" to a monoid isn't it.")
        self.assertNotIn('"hi"', both)
        self.assertTrue(both.startswith('::termline{v="Say hi to a monoid isn\'t it." t="monoid='))

    def test_unsafe_sentence_is_left_alone(self):
        self.assertIsNone(cl.annotate_terms("A monoid {x} here."))
        self.assertIsNone(cl.annotate_terms("A monoid \\ here."))

    def test_new_terms_are_untouched_in_fences_headings_and_lists(self):
        self.assertIsNone(cl.annotate_terms("```\nA monad and idempotency\n```"))
        self.assertIsNone(cl.annotate_terms("# Idempotency and the monad"))
        self.assertIsNone(cl.annotate_terms("- a **monad** here\n- a flexbox"))
        self.assertEqual(self.requests, [])

    def test_first_word_of_a_paragraph_is_not_a_candidate(self):
        seen = []
        out = cl.annotate_terms("Haskell is nice, and Erlang too.", resolver=lambda names: seen.append(names) or {})
        self.assertIsNone(out)
        self.assertEqual(seen, [["Erlang"]])

    def test_stopwords_and_plain_words_are_never_looked_up(self):
        seen = []
        out = cl.annotate_terms(
            "It sequences effects; see **list** and **matters** for retries.",
            resolver=lambda names: seen.append(names) or {},
        )
        self.assertIsNone(out)
        self.assertEqual(seen, [])

    def test_candidates_from_bold_caps_and_technical_tokens(self):
        seen = []
        cl.annotate_terms(
            "Call fooBar or snake_case on **Zebra Crossing** via os.path and Content-Type, with Erlang.",
            resolver=lambda names: seen.append(names) or {},
        )
        self.assertEqual(seen, [["fooBar", "snake_case", "Zebra Crossing", "os.path", "Content-Type", "Erlang"]])

    def test_resolved_definition_is_used_and_markup_stays_in_v(self):
        text = "Then a **zebra crossing** helps."
        out = cl.annotate_terms(text, resolver=lambda names: {"zebra crossing": "A place to cross."})
        self.assertEqual(out, '::termline{v="Then a **zebra crossing** helps." t="zebra crossing=A place to cross."}')

    def test_candidate_all_sources_miss_gets_no_fabricated_def(self):
        miss = lambda names: {n.lower(): None for n in names}
        # Bold and technical candidates become name= with an empty def.
        self.assertEqual(
            cl.annotate_terms("Then call fooBar here.", resolver=miss),
            '::termline{v="Then call fooBar here." t="fooBar="}',
        )
        self.assertEqual(
            cl.annotate_terms("Then a **blorp** here.", resolver=miss),
            '::termline{v="Then a **blorp** here." t="blorp="}',
        )
        # A capitalised phrase is dropped, so ordinary English never gets a chip.
        self.assertIsNone(cl.annotate_terms("We met Alice there.", resolver=miss))

    def test_unfinished_lookups_are_dropped_but_glossary_hits_stay(self):
        out = cl.annotate_terms("A monad with fooBar.", resolver=lambda names: {})
        self.assertEqual(out, '::termline{v="A monad with fooBar." t="monad=%s"}' % MONAD)

    def test_default_resolver_misses_over_stubbed_sources(self):
        lookup = cl._lookup_module()

        def missing(url, timeout=None):
            self.requests.append(url)
            raise lookup.NoDefinition("no definition")

        lookup.get_json = missing
        out = cl.annotate_terms("Then call fooBar here.")
        self.assertEqual(out, '::termline{v="Then call fooBar here." t="fooBar="}')
        self.assertEqual(len(self.requests), 3)

    def test_default_resolver_uses_a_source_definition(self):
        lookup = cl._lookup_module()
        lookup.get_json = lambda url, timeout=None: {
            "documents": [{"title": "Promise", "summary": "An object for a future value.", "mdn_url": "/x"}]
        }
        out = cl.annotate_terms("Then a Promise returns.")
        self.assertEqual(out, '::termline{v="Then a Promise returns." t="Promise=An object for a future value."}')

    def test_fetched_definitions_are_sanitised(self):
        out = cl.annotate_terms(
            'Then a **blorp** here.',
            resolver=lambda names: {"blorp": 'A "thing" {with} it\'s braces; and = signs'},
        )
        self.assertEqual(
            out,
            '::termline{v="Then a **blorp** here." t="blorp=A thing with it\u2019s braces\\; and \\= signs"}',
        )

    def test_term_cap_counts_resolved_terms_too(self):
        words = ["aaA", "bbB", "ccC", "ddD", "eeE", "ffF", "ggG", "hhH", "iiI", "jjJ"]
        out = cl.annotate_terms(
            "Then " + " ".join(words) + ".",
            resolver=lambda names: {n.lower(): "d" for n in names},
        )
        self.assertEqual(len(re.findall(r";;", out)), 7)

    def test_term_cap_and_size_caps(self):
        words = ["monoid", "semigroup", "idempotent", "CRDT", "backpressure", "closure", "currying", "memoization", "debounce", "throttle"]
        out = cl.annotate_terms("Words: " + " ".join(words) + ".")
        self.assertEqual(len(re.findall(r";;", out)), 7)
        self.assertIsNone(cl.annotate_terms("A monoid " + "x " * 2500))

    def test_multiline_paragraph_joins_to_one_line_and_tail_is_kept(self):
        out = cl.annotate_terms("A monoid\nfolds.\n")
        self.assertTrue(out.startswith('::termline{v="A monoid folds."'))
        self.assertTrue(out.endswith("}\n"))

    def test_hook_calls_annotator(self):
        self.assertEqual(cl._hook(SENTENCE), cl.annotate_terms(SENTENCE))


if __name__ == "__main__":
    unittest.main()
