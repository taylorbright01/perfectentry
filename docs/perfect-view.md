# Perfect View foundation

An original, dependency-free Canvas 2D chart workspace in the existing static
Perfect Entry website. No Vela, Lightweight Charts or PineTS code is included.
There is no third-party chart attribution or chart-library subscription.

## Current behaviour

- Candles or a close-price line; keyboard/button/wheel zoom and pointer pan.
- Timeline dates mark UTC day boundaries, with a date retained in single-day views.
- UTC 1m, 5m, 15m, 1h, 4h and 1D aggregation. Smaller-than-source timeframes are
  disabled. Missing source bars are never manufactured.
- Closed candles are the default. A closed higher-timeframe bucket must contain
  every source bar and have passed its end time. The optional partial-candle view
  does not imply that partial bars are safe inputs for trading signals.
- Focus view hides price scale and OHLC hover values. There is no animated price
  ticker, flashing price change, notification sound or tick subscription.
- Horizontal levels, trendlines, rectangles and plain-text notes. Click one or
  two anchors, select/drag handles or objects, delete, undo/redo, export/restore.
- Drawings are stored as UTC time/price anchors, shared across timeframes for
  the same symbol and data source. Sample, imported and feed workspaces are isolated.
- Drawing colours and custom workspace names are editable through explicit row
  controls. Notes retain their chart text when the workspace item is renamed.
- Indicators and their names, colours and settings stay active across instruments;
  drawings are remembered separately for each market. Older per-market studies
  migrate once to the shared configuration. Removing a shared study does not
  resurrect it from an older market workspace.
- Workspace labels are read-only/non-selectable; deliberate Rename opens a normal
  editable field. Keyboard access to buttons, checkboxes and selectors is preserved.
- A native EMA illustrates the indicator interface. Its seed is the first close
  in the loaded history; parity with Pine EMA must be checked with equivalent
  warm-up history. No Perfect Entry proprietary indicator has been migrated yet.
- Responsive layout and a latest-candles HTML table for accessible inspection.

## Preview versus production

The shipped configuration loads explicitly labelled, deterministic synthetic
historical candles. They are not broker quotes or a live demo. Real CSV/JSON files
can be imported (8 MB / 50,000-bar limit). Import times are interpreted as UTC;
convert MT5 broker-server times to UTC before loading. Choose the actual source
candle size; do not label M5 rows as M1. MT5 DATE/TIME tab-separated headers work.

Small workspace documents are saved to localStorage. Imported candles are
cached in IndexedDB. Both are local to the browser/device and can be deleted by
clearing site storage. Export drawings to keep a portable backup. Reopen the
same original file and symbol before restoring an imported workspace; its content
fingerprint identifies its drawings. No files are uploaded by this preview.
If browser storage is blocked, market drawings remain in memory while switching
within the current session; export is needed to retain them beyond that session.

Whop OAuth, membership enforcement, cross-device saving and a deployed MT5 feed
are **not implemented or active in this foundation**. A static page cannot keep
OAuth secrets or protect data by hiding frontend controls. The current Signals
page and its public data paths have not been paywalled by this change.

## Connect the candle feed

`assets/perfect-view/config.mjs` contains public configuration only. Set `feedUrl`
to a deployed HTTPS backend. The frontend calls it with `symbol=EURUSD` and
`timeframe=60`, uses a session cookie with `credentials: include`, and replaces
the full returned history on each scheduled snapshot. A bounded M1 history window
is expected. Incremental pagination/backfill is a later extension.

```json
{
  "symbol": "EURUSD",
  "baseTimeframe": 60,
  "candles": [
    { "time": 1790812800, "open": 1.1000, "high": 1.1006,
      "low": 1.0998, "close": 1.1004, "volume": 120 }
  ]
}
```

`time` is UTC candle opening time, in Unix seconds (milliseconds also accepted).
Source sizes must be 60, 300, 900, 3600, 14400 or 86400 seconds. OHLC must be finite,
positive and consistent; volume is optional non-negative tick volume. Snapshots
should include sufficient warm-up history and all M1 bars inside any completed
higher-timeframe bucket. Incomplete/missing buckets are omitted in closed-only view.

Snapshots refresh at 60 seconds by default or 30 seconds if selected. Requests do
not overlap; hidden tabs pause and visible tabs resume with a fresh snapshot. The
backend must retain full underlying OHLC highs/lows between refreshes, not build
candles from occasional price samples. A fetch failure leaves previous candles
visible with an unavailable/stale warning; it never falls back silently to sample
prices. Enforce membership before returning candles/indicator outputs. Use correct
credentialled CORS if the API is on another origin. Do not expose Whop credentials
or a Supabase service-role key in frontend configuration.

## Native indicator interface

Pure calculations live separately from rendering in `core.mjs`. Register a
definition with `id`, `defaults` and `calculate(bars, settings)`:

```js
indicators.register({
  id: 'example', defaults: { period: 20 },
  calculate(bars, settings) {
    return {
      lines: [{ color: '#b4a2ff', points: [{ time: bars[0].time, value: bars[0].close }] }],
      zones: [{ from: bars[0].time, to: bars.at(-1).time, high: 1.11, low: 1.10, color: '#e3b975' }],
      markers: [{ time: bars[0].time, price: bars[0].close, text: 'Example', color: '#80cec6' }]
    };
  }
});
```

This initial renderer supports price-pane lines, fixed price zones and markers.
Oscillator panes, filled series, editable indicator-specific settings and
multi-timeframe indicator inputs can be added when supplied scripts require them.
An API for executing arbitrary user-provided scripts is intentionally absent.

For proprietary paid logic, reuse pure calculation modules in the backend and
return their output models. Public JS shipped by this repo can be inspected, so
do not put secret indicator algorithms in a browser bundle or a public repository.
For each conversion, compare matching candles/history/settings, warm-up and NA
behaviour, session timezone, HTF bar-close timing and live-vs-historical output.
Appending or modifying future candles must not alter already confirmed signals.
The basic EMA and aggregation tests do not prove parity for any future indicator.

## Shared Whop foundation to implement next

1. Register OAuth redirect URI on a server backend. Implement authorization code
   flow with PKCE, state/nonce checks and a secure HttpOnly session.
2. Store stable Whop user ID on a local account. Check separate entitlements for
   `perfect_view` and `signals`, with explicit verified grants for legacy lifetimes.
3. Enforce those checks on page data endpoints and realtime subscriptions; audit
   existing public Supabase REST views/RLS before calling Signals paid-only.
4. Revalidate access and process verified membership webhooks, observing paid
   access through the actual expiry date. Retain saved workspaces after expiry.
5. Save workspace JSON through authenticated endpoints. Derive owner from the
   server session, never a caller-supplied Whop user ID. Use database ownership/RLS,
   schema validation and revision checks to avoid cross-device overwrite conflicts.
6. Wire the public `loginUrl` and the persistence adapter. The `workspaceUrl` field
   is reserved only; there is no active cross-device saving implementation yet.

Keep the existing static website host. A Supabase Edge Function or another server
deployment can provide the login/data/storage backend; there is no need to move
the whole website or introduce a paid chart engine.

## Verification

`node --test tests/perfect-view.test.mjs` checks UTC parsing, OHLC validation,
aggregation/closed-bar boundaries, missing candles, future-data invariance for
the example EMA, imports and drawing validation. Serve over HTTP for browser QA:
`python3 -m http.server 8000`. Modules do not work by double-clicking an HTML file.
