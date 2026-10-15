export const SYMBOLS = ['AUDCAD','AUDCHF','AUDNZD','AUDUSD','BTCUSD','CADJPY','CHFJPY','ETHUSD','EURAUD','EURCAD','EURGBP','EURJPY','EURNZD','EURUSD','GBPAUD','GBPCAD','GBPCHF','GBPJPY','GBPUSD','NAS100','NZDCAD','NZDCHF','NZDJPY','NZDUSD','USDCAD','USDCHF','USDJPY','XAGUSD','XAUUSD'];
export const MAX_BYTES = 1024 * 1024;
export function validateBatch(raw, now = Math.floor(Date.now()/1000)) {
  const fail = message => { throw new Error(message); };
  if (!raw || raw.version !== 1 || raw.base_timeframe !== 30 || !/^[A-Za-z0-9_-]{1,48}$/.test(raw.collector_id ?? '') || !/^[A-Za-z0-9_-]{1,120}$/.test(raw.batch_id ?? '')) fail('Invalid batch header');
  if (!Array.isArray(raw.streams) || !raw.streams.length || raw.streams.length > SYMBOLS.length) fail('Invalid streams');
  let count = 0; const seen = new Set();
  const streams = raw.streams.map(s => {
    if (!SYMBOLS.includes(s?.symbol) || seen.has(s.symbol) || typeof s.broker_symbol !== 'string' || !s.broker_symbol.length || s.broker_symbol.length > 80) fail('Invalid or duplicate symbol');
    seen.add(s.symbol);
    if (!Array.isArray(s.candles) || s.candles.length > 120 || !Number.isInteger(s.through) || s.through % 30 || s.through > now || s.through < now-86400*7) fail('Invalid stream range');
    let previous = -1;
    const candles = s.candles.map(b => {
      const numbers = ['open','high','low','close'].map(k=>b?.[k]);
      if (!Number.isInteger(b?.time) || b.time%30 || b.time <= previous || b.time+30 > s.through || b.time < now-86400*7 || !numbers.every(n=>typeof n==='number' && Number.isFinite(n) && n>0) || b.high<Math.max(b.open,b.close) || b.low>Math.min(b.open,b.close) || b.low>b.high || !Number.isSafeInteger(b.volume) || b.volume<0 || typeof b.empty !== 'boolean' || (b.empty && (b.volume!==0 || !numbers.every(n=>n===b.open)))) fail('Invalid or unfinished candle');
      previous=b.time; count++; return {time:b.time,open:b.open,high:b.high,low:b.low,close:b.close,volume:b.volume,empty:b.empty};
    });
    return {symbol:s.symbol,broker_symbol:s.broker_symbol,through:s.through,candles};
  });
  if (count>3000) fail('Batch too large');
  return {version:1,collector_id:raw.collector_id,batch_id:raw.batch_id,base_timeframe:30,streams};
}
export async function readLimited(request) {
  const reader=request.body?.getReader(); if (!reader) throw new Error('Missing body');
  let bytes=0; const chunks=[];
  try { for (;;) { const {done,value}=await reader.read(); if(done)break; bytes+=value.byteLength; if(bytes>MAX_BYTES)throw new Error('Body too large');chunks.push(value); } }
  finally { reader.releaseLock(); }
  const all=new Uint8Array(bytes);let at=0;for(const chunk of chunks){all.set(chunk,at);at+=chunk.length;}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(all));
}
