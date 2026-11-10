import importlib.util
import re
import unittest
from pathlib import Path

_spec = importlib.util.spec_from_file_location("concept_links", Path(__file__).resolve().parent.parent / "__init__.py")
cl = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cl)

MONOID = "An associative binary operation together with an identity element, such as addition with zero."
SENTENCE = "A monoid lets you fold a list in any grouping, and a functor maps over it."


class AnnotatorTest(unittest.TestCase):
    def test_exact_monoid_functor_sentence(self):
        self.assertEqual(
            cl.annotate_terms(SENTENCE),
            '::termline{v="%s" t="monoid=%s"}' % (SENTENCE, MONOID),
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
