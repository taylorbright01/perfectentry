# Perfect Entry

**We Make Profitable Traders**

Live site: [perfectentry.store](https://perfectentry.store)

## Pages

- `index.html` — Home page
- `screener.html` — AI Session Screener (free tool)
- `signals.html` — Live Signals Dashboard (Supabase realtime)
- `data.html` — Reversal Sniper Data Explorer

## Assets

All images, videos, and logos are in the `assets/` folder.

## Signals Backend

The live signals dashboard connects to Supabase. Webhook endpoint:
`https://nmfsqgqwjihpudiqnuwh.supabase.co/functions/v1/receive-signal`

TradingView alert message format:
`{"sym":"{{ticker}}","tf":"{{interval}}","entry":{{close}},"sl":{{plot_2}},"tp":{{plot_3}}}`
