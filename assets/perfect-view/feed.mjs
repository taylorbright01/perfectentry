import { MAX_BARS, parseDataset } from './core.mjs';

// Merge verified closed-candle updates without discarding history or drawings.
export function parseFeedResponse(text, symbol, baseTimeframe, previous = null) {
  if (text.length > 8 * 1024 * 1024) throw new Error('Feed response is too large.');
  const raw = JSON.parse(text);
  if (raw?.symbol !== symbol || raw?.baseTimeframe !== baseTimeframe || !Array.isArray(raw?.candles)) {
    throw new Error('The feed returned a different market or source timeframe.');
  }
  if (previous && (previous.symbol !== symbol || previous.baseTimeframe !== baseTimeframe)) throw new Error('Cannot merge different markets.');
  if (!raw.candles.length) {
    if (!previous?.candles.length) throw new Error('No completed candles have arrived for this market yet.');
    return previous;
  }
  const data = parseDataset(text, symbol, baseTimeframe);
  if (!previous) return data;
  const candles = new Map(previous.candles.map(bar => [bar.time, bar]));
  for (const bar of data.candles) candles.set(bar.time, bar);
  return { ...data, candles: [...candles.values()].sort((a, b) => a.time - b.time).slice(-MAX_BARS) };
}
