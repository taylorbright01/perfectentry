// Public configuration only. Never put Whop secrets or Supabase service keys here.
export const config = Object.freeze({
  feedUrl: 'null',
  // This stage serves public broker candles. Whop membership checks are not deployed yet.
  realtimeUrl: 'null',
  realtimeKey: 'null', // Existing public anon key; never a service-role key.
  feedBaseTimeframe: 30,
  refreshSeconds: 30,
  availableSymbols: ['AUDCAD','AUDCHF','AUDNZD','AUDUSD','BTCUSD','CADJPY','CHFJPY','ETHUSD','EURAUD','EURCAD','EURGBP','EURJPY','EURNZD','EURUSD','GBPAUD','GBPCAD','GBPCHF','GBPJPY','GBPUSD','NAS100','NZDCAD','NZDCHF','NZDJPY','NZDUSD','USDCAD','USDCHF','USDJPY','XAGUSD','XAUUSD'],
  loginUrl: null, // Set when the shared server-side Whop OAuth flow is deployed.
  workspaceUrl: null // Reserved for authenticated, per-account server persistence.
});
