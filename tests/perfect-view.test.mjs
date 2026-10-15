import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBars, aggregateBars, ema, parseDataset, createDemoBars, validateDrawing } from '../assets/perfect-view/core.mjs';

const start = Date.parse('2026-10-01T00:00:00Z') / 1000;
const bars = Array.from({ length: 10 }, (_, i) => ({ time: start + i * 60,
  open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i, volume: i + 1 }));

test('normalizes milliseconds, sorts and replaces corrected duplicate candles', () => {
  const normalized = normalizeBars([{ ...bars[1], time: bars[1].time * 1000 }, bars[0], { ...bars[1], close: 102.5 }]);
  assert.equal(normalized.length, 2); assert.equal(normalized[0].time, start); assert.equal(normalized[1].close, 102.5);
});
test('rejects malformed OHLC, missing values and unaligned opening times', () => {
  for (const invalid of [{ high: 99 }, { close: '' }, { open: null }, { low: 120 }, { time: start + 1 }, { volume: -1 }]) {
    assert.throws(() => normalizeBars([{ ...bars[0], ...invalid }]));
  }
});
test('aggregates OHLC and volume into UTC buckets', () => {
  const result = aggregateBars(bars, 300, { now: start + 600 });
  assert.deepEqual(result[0], { time: start, open: 100, high: 106, low: 99, close: 105, volume: 15 });
  assert.equal(result.length, 2);
});
test('closed-only excludes current candles and incomplete higher-timeframe buckets', () => {
  assert.equal(aggregateBars(bars, 300, { now: start + 599 }).length, 1);
  assert.equal(aggregateBars(bars.slice(0, 4), 300, { now: start + 600 }).length, 0);
  assert.equal(aggregateBars([bars[0]], 60, { now: start + 59 }).length, 0);
  assert.equal(aggregateBars([bars[0]], 60, { now: start + 60 }).length, 1);
  assert.equal(aggregateBars(bars.slice(0, 4), 300, { closedOnly: false }).length, 1);
});
test('missing source candles are not silently filled into a complete HTF candle', () => {
  const result = aggregateBars(bars.filter((_, i) => i !== 2), 300, { now: start + 600 });
  assert.equal(result.length, 1); assert.equal(result[0].time, start + 300);
});
test('changing future candles does not change past EMA or closed HTF results', () => {
  const altered = bars.map((b, i) => i < 5 ? b : { ...b, high: b.high + 300, close: b.close + 100 });
  assert.deepEqual(ema(bars, 3).slice(0, 5), ema(altered, 3).slice(0, 5));
  assert.deepEqual(aggregateBars(bars, 300, { now: start + 300 }), aggregateBars(altered, 300, { now: start + 300 }));
});
test('rejects downsampling invented smaller candles from a coarse source', () => {
  assert.throws(() => aggregateBars(bars, 60, { baseTimeframe: 300 }));
});
test('reads common CSV and MT5 tab-separated exports in UTC', () => {
  const csv = 'time,open,high,low,close,volume\n"2026-10-01 00:00:00",100,102,99,101,10';
  assert.equal(parseDataset(csv).candles[0].time, start);
  const mt5 = '<DATE>\t<TIME>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\t<TICK_VOLUME>\n2026.10.01\t00:00:00\t100\t102\t99\t101\t19';
  const result = parseDataset(mt5); assert.equal(result.candles[0].time, start); assert.equal(result.candles[0].volume, 19);
});
test('JSON metadata provides symbol and source timeframe', () => {
  const data = parseDataset(JSON.stringify({ symbol: 'GBPUSD', baseTimeframe: 300, candles: [bars[0], bars[5]] }));
  assert.equal(data.symbol, 'GBPUSD'); assert.equal(data.baseTimeframe, 300);
  assert.throws(() => parseDataset('{"symbol":"<script>","candles":[]}'));
});
test('drawing validation rejects broken coordinates and retains plain text safely', () => {
  const drawing = { id: 'test', type: 'text', color: '#e3b975', points: [{ time: start, price: 100 }], text: '<img src=x onerror=alert(1)>' };
  assert.equal(validateDrawing(drawing).text, drawing.text);
  assert.equal(validateDrawing({ ...drawing, points: [{ time: NaN, price: 100 }] }), null);
  assert.equal(validateDrawing({ ...drawing, type: 'trend' }), null);
});
test('sample data is deterministic, historical and internally consistent', () => {
  const sample = createDemoBars(); assert.deepEqual(sample, createDemoBars());
  assert.equal(normalizeBars(sample).length, 2880);
  assert.ok(sample.at(-1).time < Date.parse('2026-10-06T00:00:00Z') / 1000);
});

test('30-second base produces causal complete minute and five-minute candles', () => {
  const source=normalizeBars(Array.from({length:10},(_,i)=>({time:start+i*30,open:100+i,high:102+i,low:99+i,close:101+i,volume:i+1})),30);
  const minutes=aggregateBars(source,60,{baseTimeframe:30,now:start+300});
  assert.equal(minutes.length,5);assert.deepEqual(minutes[0],{time:start,open:100,high:103,low:99,close:102,volume:3});
  const five=aggregateBars(source,300,{baseTimeframe:30,now:start+300});
  assert.deepEqual(five,[{time:start,open:100,high:111,low:99,close:110,volume:55}]);
  assert.deepEqual(aggregateBars(source,300,{baseTimeframe:30,now:start+299}),[]);
});
test('missing half-minute candles are not silently turned into complete higher timeframes', () => {
  const source=normalizeBars([{time:start,open:1,high:1,low:1,close:1},{time:start+60,open:1,high:1,low:1,close:1}],30);
  assert.deepEqual(aggregateBars(source,60,{baseTimeframe:30,now:start+120}),[]);
});
