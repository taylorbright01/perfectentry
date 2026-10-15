"""Prepare MT5 M1/H1 exports from a ZIP for Perfect View. Does not upload data.

Vantage timestamps use New York time plus seven hours. Ambiguous/nonexistent
server-clock rows are quarantined, not guessed. Original files remain unchanged.
"""
import argparse, collections, csv, datetime as dt, functools, gzip, hashlib, io, json, math, pathlib, re, zipfile
from import_hourly_history import SYMBOLS, sunday

UTC = dt.timezone.utc
LIMIT = 100000

@functools.lru_cache(maxsize=64)
def boundaries(year):
    return sunday(year, 3, 2).replace(hour=7, tzinfo=UTC), sunday(year, 11, 1).replace(hour=6, tzinfo=UTC)

def vantage_candidates(clock):
    """Invert NY+7 using exact US transitions (exports here start after 2007)."""
    if clock.year < 2007:
        raise ValueError('Vantage clock conversion supports 2007 onwards.')
    start, end = boundaries(clock.year)
    candidates = []
    for offset in (120, 180):
        value = (clock-dt.timedelta(minutes=offset)).replace(tzinfo=UTC)
        if offset == (180 if start <= value < end else 120):
            candidates.append(int(value.timestamp()))
    return candidates

def subtract(ranges, holes):
    for a, b in holes:
        next_ranges = []
        for start, end in ranges:
            if b <= start or a >= end:
                next_ranges.append([start, end])
            else:
                if start < a: next_ranges.append([start, a])
                if b < end: next_ranges.append([b, end])
        ranges = next_ranges
    return ranges

def source_rows(text, step):
    reader = csv.DictReader(io.StringIO(text), delimiter='\t' if '\t' in text.splitlines()[0] else ',')
    rows = []
    for number, raw in enumerate(reader, 2):
        r = {k.strip('<>').lower(): v for k, v in raw.items() if k}
        clock = dt.datetime.fromisoformat(r['date'].replace('.', '-')+'T'+r['time'])
        prices = [float(r[k]) for k in ('open', 'high', 'low', 'close')]
        volume = int(r.get('tickvol', r.get('volume', '0')))
        if (not all(math.isfinite(v) and v > 0 for v in prices) or
            prices[1] < max(prices[0], prices[3]) or prices[2] > min(prices[0], prices[3]) or
            prices[1] < prices[2] or volume < 0 or
            clock.minute*60 % step or clock.second):
            raise ValueError('Invalid OHLC/time at row '+str(number))
        if rows and clock < rows[-1][0]: raise ValueError('Source timestamps are out of order.')
        rows.append((clock, prices, volume))
    # The export may contain an unfinished final candle even if imported later.
    return rows[:-1]

def normalize_source(text, step):
    source = source_rows(text, step)
    sparse_prefix = 0
    if step == 3600 and len(source) > 3:
        # Some broker H1 exports start with daily/coarse rows. Do not call these
        # hourly prices or leak their later highs/lows into earlier hours.
        first = next((i for i in range(len(source)-2)
                      if source[i+1][0]-source[i][0] == dt.timedelta(hours=1)
                      and source[i+2][0]-source[i+1][0] == dt.timedelta(hours=1)), None)
        if first is None: raise ValueError('No verified hourly sequence in H1 export.')
        sparse_prefix = first
        source = source[first:]
    result, holes = {}, []
    quarantined = 0
    for clock, prices, volume in source:
        candidates = vantage_candidates(clock)
        if len(candidates) != 1:
            quarantined += 1
            possible = [int((clock-dt.timedelta(hours=h)).replace(tzinfo=UTC).timestamp()) for h in (2, 3)]
            holes.append([min(possible), max(possible)+step])
            continue
        result[candidates[0]] = [candidates[0], *prices, volume]
    rows = [result[t] for t in sorted(result)][-LIMIT:]
    if not rows: raise ValueError('No completed bars after validation.')
    ranges = [[rows[0][0], rows[-1][0]+step]]
    # Long outages are unknown coverage, not a continuous closed market.
    holes += [[a[0]+step, b[0]] for a, b in zip(rows, rows[1:]) if b[0]-a[0] > 7*86400]
    return rows, subtract(ranges, holes), {'quarantined_clock_rows': quarantined, 'excluded_sparse_prefix': sparse_prefix}

def write_series(folder, symbol, step, rows, coverage):
    file = folder/(symbol+'_'+str(step)+'.csv')
    with file.open('w', newline='') as f:
        writer = csv.writer(f); writer.writerows(rows)
    with file.open() as f:
        if sum(1 for _ in f) != len(rows): raise ValueError('Validated series write was incomplete: '+file.name)
    file.with_suffix('.coverage.json').write_text(json.dumps(coverage))

def stream_chunks(path, step):
    ranges = json.loads(path.with_suffix('.coverage.json').read_text())
    with path.open(newline='') as f:
        reader = csv.reader(f)
        row = next(reader, None)
        for start, end in ranges:
            if step == 60:
                # No derived days depend on minute coverage; omit empty sessions.
                while row is not None and int(row[0]) < start: row = next(reader, None)
                while row is not None and int(row[0]) < end:
                    first = int(row[0]); bars = []
                    while row is not None and int(row[0]) < min(end, first+200*step) and len(bars) < 100:
                        bars.append([int(row[0]), *map(float, row[1:5]), int(row[5])]); row = next(reader, None)
                    yield first, bars[-1][0]+step, bars
            else:
                # Explicit source coverage permits session gaps in UTC daily OHLC.
                while start < end:
                    stop = min(end, start+100*step); bars = []
                    while row is not None and int(row[0]) < stop:
                        if int(row[0]) >= start: bars.append([int(row[0]), *map(float, row[1:5]), int(row[5])])
                        row = next(reader, None)
                    yield start, stop, bars
                    start = stop

def make_batches(series_folder, output, step):
    streams = {p.stem.split('_')[0]: iter(stream_chunks(p, step)) for p in sorted(series_folder.glob('*_'+str(step)+'.csv'))}
    file = output/('minute' if step == 60 else 'hourly')
    file = file.with_suffix('.jsonl.gz'); count = candles = 0
    with gzip.open(file, 'wt', encoding='utf-8', compresslevel=6) as f:
        while streams:
            parts = []
            for symbol, iterator in list(streams.items()):
                chunk = next(iterator, None)
                if chunk is None: del streams[symbol]; continue
                start, end, rows = chunk
                parts.append({'symbol': symbol, 'from': start, 'through': end, 'candles': rows})
                candles += len(rows)
            if not parts: break
            batch = {'version': 2, 'base_timeframe': step, 'streams': parts}
            digest = hashlib.sha256(json.dumps(batch, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
            batch['batch_id'] = 'mt5_'+str(step)+'_'+digest[:48]
            f.write(json.dumps(batch, separators=(',', ':'))+'\n'); count += 1
    return {'file': file.name, 'batches': count, 'candles': candles, 'sha256': hashlib.sha256(file.read_bytes()).hexdigest()}

def prepare(source, output):
    output.mkdir(parents=True, exist_ok=True)
    series = output/'validated-series'; series.mkdir(exist_ok=True)
    report = {'broker': 'Vantage', 'clock': 'New York + 7 hours (US DST)', 'retention_bars': LIMIT, 'series': [], 'duplicates': []}
    with zipfile.ZipFile(source) as z:
        groups = collections.defaultdict(list)
        for item in z.infolist():
            match = re.match(r'^([A-Z0-9]+)_(M1|H1)_', pathlib.PurePosixPath(item.filename).name)
            if match and match[1] in SYMBOLS:
                groups[(match[1], 60 if match[2] == 'M1' else 3600)].append(item)
        for (symbol, step), files in sorted(groups.items()):
            files.sort(key=lambda item: pathlib.PurePosixPath(item.filename).name)
            merged, ranges, notes = {}, [], []
            for item in files:
                rows, coverage, stats = normalize_source(z.read(item).decode('utf-8-sig'), step)
                merged.update((r[0], r) for r in rows); ranges += coverage
                notes.append({'file': pathlib.PurePosixPath(item.filename).name, **stats})
            rows = [merged[t] for t in sorted(merged)][-LIMIT:]
            # Intersect duplicate snapshots' excluded clock gaps conservatively.
            ranges.sort(); coverage = []
            for a, b in ranges:
                a = max(a, rows[0][0]); b = min(b, rows[-1][0]+step)
                if a >= b: continue
                if coverage and a <= coverage[-1][1]: coverage[-1][1] = max(b, coverage[-1][1])
                else: coverage.append([a, b])
            write_series(series, symbol, step, rows, coverage)
            report['series'].append({'symbol': symbol, 'timeframe': step, 'bars': len(rows), 'first_utc': rows[0][0], 'last_utc': rows[-1][0], 'sources': notes})
            if len(files) > 1: report['duplicates'].append({'symbol': symbol, 'timeframe': step, 'snapshots': len(files)})
            print(symbol, 'M1' if step == 60 else 'H1', len(rows), 'validated bars', flush=True)
    report['missing_m1'] = sorted(set(SYMBOLS)-{r['symbol'] for r in report['series'] if r['timeframe'] == 60})
    report['batches'] = [make_batches(series, output, step) for step in (60, 3600)]
    for item, step in zip(report['batches'], (60, 3600)):
        if item['candles'] != sum(s['bars'] for s in report['series'] if s['timeframe'] == step):
            raise ValueError('Prepared batch candle count does not match validated sources.')
    (output/'audit.json').write_text(json.dumps(report, indent=2))
    return report

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--zip', type=pathlib.Path, required=True)
    parser.add_argument('--out', type=pathlib.Path, required=True)
    args = parser.parse_args(); prepare(args.zip, args.out)
