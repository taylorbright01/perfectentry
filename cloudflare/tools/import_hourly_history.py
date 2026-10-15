"""Import broker H1 CSV exports into the retained UTC archive, all pairs per batch.
Usage: python import_hourly_history.py --data PATH --url https://...workers.dev --winter-offset 120 --summer-offset 180 --dst us
All timestamps must either carry UTC/zone offsets, or use an explicitly configured broker-clock rule.
"""
import argparse, bisect, csv, re, datetime as dt, getpass, hashlib, io, json, pathlib, time, urllib.request, urllib.error
SYMBOLS='AUDCAD AUDCHF AUDNZD AUDUSD BTCUSD CADJPY CHFJPY ETHUSD EURAUD EURCAD EURGBP EURJPY EURNZD EURUSD GBPAUD GBPCAD GBPCHF GBPJPY GBPUSD NAS100 NZDCAD NZDCHF NZDJPY NZDUSD USDCAD USDCHF USDJPY XAGUSD XAUUSD'.split()
UTC=dt.timezone.utc

def sunday(year,month,n):
    first=dt.datetime(year,month,1)
    if n>0:return first+dt.timedelta(days=(6-first.weekday())%7+7*(n-1))
    last=(dt.datetime(year+1,1,1) if month==12 else dt.datetime(year,month+1,1))-dt.timedelta(days=1)
    return last-dt.timedelta(days=(last.weekday()-6)%7)

def broker_time(text,winter,summer,rule):
    text=re.sub(r'^(\d{4})\.(\d{2})\.(\d{2})',r'\1-\2-\3',text.strip())
    try:
        value=dt.datetime.fromisoformat(text.replace('Z','+00:00'))
    except ValueError:
        value=dt.datetime.strptime(text,'%Y-%m-%d %H:%M')
    if value.tzinfo:return int(value.timestamp())
    if winter is None:raise ValueError('Unzoned broker timestamps need --winter-offset and an explicit --dst rule; never assume UTC.')
    offset=winter
    if rule!='none':
        if summer is None:raise ValueError('--summer-offset is required with DST.')
        # Broker clock changes must match these dates. Forex weekend transitions
        # normally contain no quotes; ambiguous crypto transition hours need UTC exports.
        start,end=(sunday(value.year,3,2),sunday(value.year,11,1)) if rule=='us' else (sunday(value.year,3,-1),sunday(value.year,10,-1))
        if start<=value<end:offset=summer
    return int((value-dt.timedelta(minutes=offset)).replace(tzinfo=UTC).timestamp())

def read_file(path,args):
    data=path.read_bytes()
    if data.startswith((b'\xff\xfe',b'\xfe\xff')):text=data.decode('utf-16')
    elif b'\x00' in data[:100]:text=data.decode('utf-16-le')
    else:text=data.decode('utf-8-sig')
    reader=csv.DictReader(io.StringIO(text),delimiter='\t' if '\t' in text.splitlines()[0] else ';' if ';' in text.splitlines()[0] else ',')
    result={}
    if args.dst!='none' and path.stem.upper().startswith(('BTCUSD','ETHUSD')) and args.winter_offset is not None:
        raise ValueError(path.name+': use a UTC/offset-aware export for crypto with DST; an ambiguous broker clock cannot be resolved safely.')
    for raw in reader:
        row={k.strip().strip('<>').lower():v.strip() for k,v in raw.items() if k}
        stamp=(row.get('date','')+' '+row.get('time','')).strip() or row.get('timestamp','')
        when=broker_time(stamp,args.winter_offset,args.summer_offset,args.dst)
        prices=[float(row[k]) for k in ('open','high','low','close')]
        volume=int(float(row.get('tickvol',row.get('tick_volume',row.get('volume','0')))))
        if when%3600:raise ValueError(path.name+': source must be H1 with hourly UTC alignment.')
        if when+3600>time.time():continue
        if min(prices)<=0 or prices[1]<max(prices[0],prices[3]) or prices[2]>min(prices[0],prices[3]) or prices[2]>prices[1] or volume<0:raise ValueError(path.name+': invalid OHLC.')
        result[when]=[when,*prices,volume]
    if not result:raise ValueError(path.name+': no completed hourly bars.')
    ordered=[result[k] for k in sorted(result)]
    if len(ordered)>20 and min(ordered[i][0]-ordered[i-1][0] for i in range(1,len(ordered)))>=23*3600:
        raise ValueError(path.name+': this looks like daily data, not H1. Export hourly candles.')
    return ordered

def send(url,token,batch):
    encoded=json.dumps(batch,separators=(',',':')).encode()
    for attempt in range(6):
        try:
            request=urllib.request.Request(url+'/history',encoded,{'Content-Type':'application/json','X-Perfect-View-Token':token})
            with urllib.request.urlopen(request,timeout=60) as response:ack=json.load(response)
            if ack.get('accepted') is not True or ack.get('batch_id')!=batch['batch_id']:raise RuntimeError('Invalid upload acknowledgement.')
            return
        except urllib.error.HTTPError as error:
            if error.code not in (429,500,502,503,504) or attempt==5:raise RuntimeError('History upload rejected: HTTP '+str(error.code)) from None
        except (urllib.error.URLError,TimeoutError):
            if attempt==5:raise RuntimeError('Connection failed; rerun safely to resume.') from None
        time.sleep(min(30,2**attempt))

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data',type=pathlib.Path,required=True);parser.add_argument('--url',required=True)
    parser.add_argument('--winter-offset',type=int);parser.add_argument('--summer-offset',type=int);parser.add_argument('--dst',choices=['none','us','eu'],required=True)
    parser.add_argument('--years',type=int,default=5);parser.add_argument('--confirm-h1',action='store_true',help='Confirm all files are H1, not M1 or daily exports.')
    args=parser.parse_args()
    if not args.confirm_h1:parser.error('Inspect the source files and add --confirm-h1. Never label daily or minute rows as hourly candles.')
    if not args.url.startswith('https://') or not 1<=args.years<=7:parser.error('Use HTTPS and 1–7 years.')
    files={}
    for path in args.data.glob('*'):
        if path.suffix.lower() not in ('.csv','.tsv','.txt'):continue
        symbol=next((s for s in SYMBOLS if path.stem.upper().startswith(s)),None)
        if symbol:
            if symbol in files:raise ValueError('Multiple files for '+symbol+'. Supply one H1 file per symbol.')
            files[symbol]=path
    if not files:raise ValueError('Name each file with its symbol, for example EURUSD_H1.csv.')
    all_rows={s:read_file(p,args) for s,p in files.items()};cutoff=int(time.time())-args.years*366*86400
    all_rows={s:[r for r in rows if r[0]>=cutoff] for s,rows in all_rows.items()}
    cursors={s:(rows[0][0]//86400)*86400 for s,rows in all_rows.items() if rows}
    # A file's first partial day is excluded, rather than pretending it is a full UTC day.
    for s in cursors:
        if all_rows[s][0][0]!=cursors[s]:cursors[s]+=86400
    times={s:[r[0] for r in rows] for s,rows in all_rows.items()}
    ends={s:rows[-1][0]+3600 for s,rows in all_rows.items() if rows}
    print('Ready:', ', '.join(s+': '+str(len(rows))+' H1 bars' for s,rows in all_rows.items()))
    token=getpass.getpass('Existing EA collector token (hidden): ')
    batches=0
    while any(cursors[s]<ends[s] for s in cursors):
        streams=[]
        for s,start in cursors.items():
            stop=min(ends[s],start+100*3600)
            if stop<=start:continue
            rows=all_rows[s][bisect.bisect_left(times[s],start):bisect.bisect_left(times[s],stop)]
            streams.append({'symbol':s,'from':start,'through':stop,'candles':rows})
        batch={'version':2,'base_timeframe':3600,'streams':streams}
        batch['batch_id']='hourly_'+hashlib.sha256(json.dumps(batch,sort_keys=True,separators=(',',':')).encode()).hexdigest()[:48]
        send(args.url.rstrip('/'),token,batch)
        for s in streams:cursors[s['symbol']]=s['through']
        batches+=1
        if batches%10==0:print('Published',batches,'multi-market history batches.')
        time.sleep(.25)
    print('Complete. Daily UTC candles were derived from the covered H1 history. Reopen the chart or wait for its archive check.')
if __name__=='__main__':
    try:main()
    except (ValueError,RuntimeError) as error:raise SystemExit(str(error))
