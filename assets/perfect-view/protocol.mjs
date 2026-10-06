export const GROUPS = [
 ['AUDCAD','AUDCHF','AUDNZD','AUDUSD','BTCUSD','CADJPY','CHFJPY','ETHUSD'],
 ['EURAUD','EURCAD','EURGBP','EURJPY','EURNZD','EURUSD','GBPAUD','GBPCAD'],
 ['GBPCHF','GBPJPY','GBPUSD','NAS100','NZDCAD','NZDCHF','NZDJPY','NZDUSD'],
 ['USDCAD','USDCHF','USDJPY','XAGUSD','XAUUSD']
];
export const groupFor = symbol => GROUPS.findIndex(group => group.includes(symbol));
export const hourOf = time => Math.floor(time / 3600) * 3600;
export const rowOf = b => [b.time,b.open,b.high,b.low,b.close,b.volume,b.empty ? 1 : 0];
export function mergeRows(before, incoming) {
 const rows = new Map(before.map(row => [row[0],row]));
 for (const row of incoming) rows.set(row[0],row);
 return [...rows.values()].sort((a,b)=>a[0]-b[0]);
}
export const liveKey = group => `pv/v1/live/g${group}.json`;
export const hourKey = (group,hour) => `pv/v1/history/g${group}/${hour}.json`;
