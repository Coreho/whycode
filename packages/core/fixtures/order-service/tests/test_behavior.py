import unittest
from batch.report import summarize, reconciliation_text
from batch.import_orders import parse_orders


class ReportTests(unittest.TestCase):
    def test_currency_totals_remain_separate(self):
        self.assertEqual(summarize([{'id':'a','kind':'paid','currency':'usd','amount':'12.50'},{'id':'b','kind':'paid','currency':'eur','amount':'3.00'}]),{'EUR':'3.00','USD':'12.50'})

    def test_refunds_reduce_total(self):
        self.assertEqual(summarize([{'id':'a','kind':'paid','currency':'usd','amount':'10'},{'id':'b','kind':'refunded','currency':'USD','amount':'2.25'}]),{'USD':'7.75'})

    def test_replayed_event_is_not_counted_twice(self):
        event={'id':'a','kind':'paid','currency':'usd','amount':'10'}
        self.assertEqual(summarize([event,event]),{'USD':'10.00'})

    def test_half_cent_rounds_up(self):
        self.assertEqual(summarize([{'id':'a','kind':'paid','currency':'usd','amount':'1.005'}]),{'USD':'1.01'})

    def test_unknown_events_do_not_contribute(self):
        self.assertEqual(summarize([{'id':'a','kind':'created'}]),{})

    def test_negative_amount_rejected(self):
        with self.assertRaises(ValueError):
            summarize([{'id':'a','kind':'paid','currency':'usd','amount':'-1'}])

    def test_multiline_report_content_is_preserved(self):
        self.assertEqual(reconciliation_text({'USD':'1.00'}),'Daily reconciliation\n# This line is report content, not a Python comment.\nUSD: 1.00')


class ImportTests(unittest.TestCase):
    def test_csv_preserves_quoted_commas(self):
        self.assertEqual(parse_orders('id,cents,note\na,1200,"gift, wrap"\n'),[{'id':'a','cents':1200,'note':'gift, wrap'}])

    def test_blank_record_is_skipped(self):
        self.assertEqual(parse_orders('id,cents,note\n,,\na,5,\n'),[{'id':'a','cents':5,'note':''}])

    def test_duplicate_id_rejected(self):
        with self.assertRaises(ValueError):
            parse_orders('id,cents\na,1\na,2\n')

    def test_negative_cents_rejected(self):
        with self.assertRaises(ValueError):
            parse_orders('id,cents\na,-1\n')

    def test_whitespace_is_trimmed(self):
        self.assertEqual(parse_orders('id,cents,note\n a ,5, hello \n'),[{'id':'a','cents':5,'note':'hello'}])


if __name__=='__main__':
    unittest.main()
