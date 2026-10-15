import datetime as dt, importlib.util, pathlib, sys, tempfile, unittest, gzip, json
sys.path.insert(0, str(pathlib.Path(__file__).parents[1]/'cloudflare/tools'))
import prepare_mt5_history as m

class PrepareTest(unittest.TestCase):
 def test_exact_vantage_transitions_and_ambiguous_crypto_clock(self):
  stamp=lambda value:int(dt.datetime.fromisoformat(value).timestamp())
  self.assertEqual(m.vantage_candidates(dt.datetime(2026,1,5,12)),[stamp('2026-01-05T10:00:00+00:00')])
  self.assertEqual(m.vantage_candidates(dt.datetime(2026,3,9,12)),[stamp('2026-03-09T09:00:00+00:00')])
  self.assertEqual(len(m.vantage_candidates(dt.datetime(2026,11,1,8))),2)
  self.assertEqual(m.vantage_candidates(dt.datetime(2026,3,8,9)),[])
 def test_forming_bar_and_daily_like_hourly_prefix_are_excluded(self):
  text='<DATE>\t<TIME>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\t<TICKVOL>\n'
  for date,time in [('2026.01.01','00:00:00'),('2026.01.02','00:00:00'),('2026.01.03','00:00:00'),('2026.01.03','01:00:00'),('2026.01.03','02:00:00'),('2026.01.03','03:00:00')]:
   text+=date+'\t'+time+'\t1\t1.2\t.9\t1.1\t20\n'
  rows,coverage,stats=m.normalize_source(text,3600)
  self.assertEqual(len(rows),3);self.assertEqual(stats['excluded_sparse_prefix'],2)
 def test_multi_market_batches_never_expand_minute_gaps_or_exceed_size_limits(self):
  with tempfile.TemporaryDirectory() as tmp:
   folder=pathlib.Path(tmp);start=1767225600
   for symbol in ['EURUSD','GBPUSD']:
    rows=[[start+i*60,1,1.2,.9,1.1,1] for i in range(250)]+[[start+3*86400,1,1.2,.9,1.1,1]]
    m.write_series(folder,symbol,60,rows,[[rows[0][0],rows[-1][0]+60]])
   result=m.make_batches(folder,folder,60)
   with gzip.open(folder/result['file'],'rt') as f:batches=[json.loads(line) for line in f]
   self.assertEqual(sum(len(s['candles']) for b in batches for s in b['streams']),502)
   self.assertTrue(all(len(b['streams'])==2 for b in batches))
   self.assertTrue(all(s['through']-s['from']<=200*60 for b in batches for s in b['streams']))

if __name__=='__main__':unittest.main()
