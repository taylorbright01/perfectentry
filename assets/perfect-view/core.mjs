// Original Perfect View data and indicator foundation. No charting dependencies.
export const TIMEFRAMES = [30, 60, 300, 900, 3600, 14400, 86400];
export const MAX_BARS = 50000;

export function timestamp(value) {
  if (typeof value === 'number' || /^\d+(\.\d+)?$/.test(String(value))) {
    const n = Number(value);
    return Math.floor(n > 1e12 ? n / 1000 : n);
  }
  let text = String(value).trim().replace(' ', 'T');
  if (!/Z$|[+-]\d\d:\d\d$/i.test(text)) text += 'Z';
  const n = Date.parse(text);
  return Math.floor(n / 1000);
}

export function normalizeBars(rows, baseTimeframe = 60) {
  if (!Array.isArray(rows) || !rows.length || rows.length > MAX_BARS) {
    throw new Error(`Supply between 1 and ${MAX_BARS.toLocaleString()} candles.`);
  }
  if (!TIMEFRAMES.includes(baseTimeframe)) throw new Error('Unsupported source timeframe.');
  const map = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object') throw new Error('A candle must be an object.');
    const time = timestamp(row.time ?? row.timestamp);
    const values = ['open', 'high', 'low', 'close'].map(k => {
      if (row[k] === undefined || row[k] === null || row[k] === '') return NaN;
      return Number(row[k]);
    });
    const [open, high, low, close] = values;
    const volume = Number(row.volume ?? row.tick_volume ?? 0);
    if (!Number.isFinite(time) || time < 0 || time > 4102444800 ||
        !values.every(n => Number.isFinite(n) && n > 0) ||
        !Number.isFinite(volume) || volume < 0 || high < Math.max(open, close) ||
        low > Math.min(open, close) || high < low || time % baseTimeframe !== 0) {
      throw new Error('Invalid candle: check UTC opening times, timeframe alignment and OHLC values.');
    }
    map.set(time, { time, open, high, low, close, volume });
  }
  return [...map.values()].sort((a, b) => a.time - b.time);
}

// Bars are timestamped at OPEN. Never use a partial bucket as a closed HTF bar.
// Missing source bars are not interpolated or manufactured.
export function aggregateBars(bars, timeframe, { baseTimeframe = 60, closedOnly = true, now = Date.now() / 1000 } = {}) {
  if (!TIMEFRAMES.includes(timeframe) || timeframe < baseTimeframe || timeframe % baseTimeframe) {
    throw new Error('Choose a timeframe at least as large as the source candles.');
  }
  const result = [];
  let bucket;
  for (const bar of bars) {
    const time = Math.floor(bar.time / timeframe) * timeframe;
    if (!bucket || bucket.time !== time) {
      bucket = { ...bar, time, count: 1, first: bar.time, last: bar.time };
      result.push(bucket);
    } else {
      bucket.high = Math.max(bucket.high, bar.high);
      bucket.low = Math.min(bucket.low, bar.low);
      bucket.close = bar.close;
      bucket.volume += bar.volume;
      bucket.count++;
      bucket.last = bar.time;
    }
  }
  return result.filter(b => !closedOnly || (
    b.time + timeframe <= now && b.count === timeframe / baseTimeframe &&
    b.first === b.time && b.last === b.time + timeframe - baseTimeframe
  )).map(({ count, first, last, ...b }) => b);
}

export function ema(bars, period = 20) {
  if (!Number.isInteger(period) || period < 1) throw new Error('Invalid moving average period.');
  let value;
  const alpha = 2 / (period + 1);
  return bars.map((bar, index) => {
    value = index === 0 ? bar.close : value + alpha * (bar.close - value);
    return { time: bar.time, value };
  });
}

// Converted indicators register here, independent of the chart UI.
export class IndicatorRegistry {
  constructor() { this.definitions = new Map(); }
  register(definition) {
    if (!definition?.id || typeof definition.calculate !== 'function') throw new Error('Invalid indicator definition.');
    this.definitions.set(definition.id, definition);
  }
  calculate(id, bars, settings = {}) {
    const definition = this.definitions.get(id);
    if (!definition) throw new Error(`Unknown indicator: ${id}`);
    return definition.calculate(bars, { ...definition.defaults, ...settings });
  }
}

export const indicators = new IndicatorRegistry();
indicators.register({
  id: 'ema', name: 'Moving average', defaults: { period: 20, color: '#b4a2ff' },
  calculate: (bars, settings) => ({ lines: [{ points: ema(bars, settings.period), color: settings.color }], zones: [], markers: [] })
});

// RFC-style quoted fields; commas, semicolons and tab-separated MT5 exports.
export function parseCSV(text) {
  const first = text.replace(/^\uFEFF/, '').split(/\r?\n/)[0];
  const delimiter = first.includes('\t') ? '\t' : first.includes(';') ? ';' : ',';
  const rows = [];
  let row = [], field = '', quoted = false;
  const source = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '"') {
      if (quoted && source[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && (ch === delimiter || ch === '\n')) {
      row.push(field.trim()); field = '';
      if (ch === '\n') { if (row.some(Boolean)) rows.push(row); row = []; }
    } else if (ch !== '\r' || quoted) field += ch;
  }
  if (quoted) throw new Error('Unclosed CSV quote.');
  row.push(field.trim()); if (row.some(Boolean)) rows.push(row);
  const header = rows.shift()?.map(x => x.toLowerCase().replace(/[<>]/g, '').trim());
  if (!header || !['open', 'high', 'low', 'close'].every(k => header.includes(k))) {
    throw new Error('CSV needs time, open, high, low and close headers (or MT5 DATE and TIME headers).');
  }
  if (!header.includes('time') && !header.includes('timestamp')) throw new Error('CSV needs a time column.');
  return rows.map(cells => {
    const entry = Object.fromEntries(header.map((key, i) => [key, cells[i]]));
    if (entry.date) {
      const date = entry.date.replaceAll('.', '-');
      entry.time = `${date}T${entry.time}Z`;
    } else if (entry.time && !/^\d+(\.\d+)?$/.test(entry.time)) {
      const date = entry.time.trim().replace(' ', 'T');
      // Unzoned candle timestamps are explicitly interpreted as UTC.
      entry.time = /Z$|[+-]\d\d:\d\d$/.test(date) ? date : `${date}Z`;
    }
    return entry;
  });
}

export function parseDataset(text, fallbackSymbol = 'EURUSD', fallbackTimeframe = 60) {
  let raw, symbol = fallbackSymbol, baseTimeframe = fallbackTimeframe;
  if (text.trimStart().startsWith('[') || text.trimStart().startsWith('{')) {
    const json = JSON.parse(text);
    raw = Array.isArray(json) ? json : json.candles;
    if (!Array.isArray(json)) {
      symbol = String(json.symbol ?? symbol).toUpperCase();
      baseTimeframe = Number(json.baseTimeframe ?? baseTimeframe);
    }
  } else raw = parseCSV(text);
  if (!/^[A-Z0-9._-]{2,24}$/.test(symbol)) throw new Error('Invalid symbol.');
  return { symbol, baseTimeframe, candles: normalizeBars(raw, baseTimeframe) };
}

export function validateDrawing(d) {
  if (!d || !['horizontal', 'trend', 'rectangle', 'text'].includes(d.type) ||
      typeof d.id !== 'string' || d.id.length > 80) return null;
  const needed = ['trend', 'rectangle'].includes(d.type) ? 2 : 1;
  if (!Array.isArray(d.points) || d.points.length !== needed ||
      !d.points.every(p => Number.isFinite(p.time) && p.time >= 0 && p.time < 4102444800 &&
        Number.isFinite(p.price) && p.price > 0)) return null;
  return { id: d.id, type: d.type, points: d.points.map(p => ({ time: p.time, price: p.price })),
    color: /^#[0-9a-f]{6}$/i.test(d.color) ? d.color : '#e3b975',
    name: typeof d.name === 'string' ? d.name.trim().slice(0, 80) : '',
    text: typeof d.text === 'string' ? d.text.slice(0, 160) : '' };
}

export function validateStudies(raw) {
  return Array.isArray(raw) ? raw.slice(0, 8).filter(s => s?.id === 'ema' &&
    typeof s.key === 'string' && s.key.length < 80 && Number.isInteger(s.period) && s.period >= 1 && s.period <= 500 &&
    /^#[0-9a-f]{6}$/i.test(s.color)).map(s => ({ id: s.id, key: s.key, period: s.period, color: s.color,
      name: typeof s.name === 'string' ? s.name.trim().slice(0, 80) : '' })) : [];
}

export function createDemoBars(symbol = 'EURUSD') {
  // Fixed, reproducible synthetic data, never represented as live market prices.
  const bases = { EURUSD: 1.104, GBPUSD: 1.312, USDJPY: 148.6, XAUUSD: 2600 };
  const base = bases[symbol] ?? 1.104, scale = base * 0.00011;
  const start = Date.parse('2026-10-01T00:00:00Z') / 1000;
  let seed = [...symbol].reduce((n, c) => n + c.charCodeAt(0), 42), price = base;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  return Array.from({ length: 2880 }, (_, i) => {
    const open = price;
    price = open + (random() - 0.49) * scale * 2.3 + Math.sin(i / 67) * scale * 0.16;
    return { time: start + i * 60, open, close: price,
      high: Math.max(open, price) + random() * scale,
      low: Math.min(open, price) - random() * scale, volume: Math.round(20 + random() * 300) };
  });
}
