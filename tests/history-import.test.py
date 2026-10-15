import datetime as dt, importlib.util, pathlib, tempfile, types, unittest
path=pathlib.Path(__file__).parents[1]/'cloudflare/tools/import_hourly_history.py'
spec=importlib.util.spec_from_file_location('history_import',path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class ImportTest(unittest.TestCase):
 def test_explicit_utc_and_broker_dst(self):
  utc=lambda value:int(dt.datetime.fromisoformat(value).timestamp())
  self.assertEqual(module.broker_time('2026-01-05T12:00:00Z',None,None,'none'),utc('2026-01-05T12:00:00+00:00'))
  self.assertEqual(module.broker_time('2026.01.05 12:00',120,180,'us'),utc('2026-01-05T10:00:00+00:00'))
  self.assertEqual(module.broker_time('2026.07.06 12:00',120,180,'us'),utc('2026-07-06T09:00:00+00:00'))
  self.assertEqual(module.broker_time('2026-07-06T12:00:00.000Z',None,None,'none'),utc('2026-07-06T12:00:00+00:00'))
 def test_unzoned_source_needs_explicit_offset(self):
  with self.assertRaises(ValueError):module.broker_time('2026.01.05 12:00',None,None,'none')
 def test_minute_source_cannot_be_mislabelled_hourly(self):
  with tempfile.TemporaryDirectory() as folder:
   p=pathlib.Path(folder)/'EURUSD_H1.csv';p.write_text('date,time,open,high,low,close,tick_volume\n2026.01.05,12:01,1,1.2,.9,1.1,20\n')
   with self.assertRaises(ValueError):module.read_file(p,types.SimpleNamespace(winter_offset=0,summer_offset=None,dst='none'))
if __name__=='__main__':unittest.main()
