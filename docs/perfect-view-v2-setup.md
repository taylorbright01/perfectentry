# Perfect View v0.2 setup

This update adds native standard studies with editable inputs and component switches, long/short positions, rays and vertical lines, Whop sign-in and a separate account layout store, protected live-signals delivery, and a retained UTC history archive. None of the deployment or database changes below have been run against your accounts. The website defaults to `accountApiUrl: null` and `requireMembership: false`, so merging the code does not activate a paywall or require Whop secrets.

## First: chart controls

Merge the reviewed changes through your normal GitHub workflow, then hard refresh Perfect View. Existing drawing keys and saved EMA settings are migrated in place. Try the Add indicator selector, settings cog, show/hide boxes, RSI/MACD panels, and the Long/Short tools (entry → stop → target). There are up to 12 saved indicators and four visible oscillator panes. Position drawing colours affect the entry; green/red retain their profit/loss meaning. Price and time are shown while drawing, and daily axes include the year.

Seven moving averages are available: SMA, EMA, WMA, Wilder/RMA, HMA, DEMA and TEMA. Other studies are RSI, Stochastic RSI, MACD, Bollinger Bands, ATR, Stochastic and tick volume. Tick volume is broker quote activity, not centralized exchange volume. Formulas are causal and use completed displayed-timeframe candles. Standard studies calculate locally without extra candle API requests.

## Retain history going forward

On Windows, open a terminal at the repository root (where package.json is):

```powershell
npm.cmd ci
npx.cmd wrangler login
npx.cmd wrangler deploy --config cloudflare/collector/wrangler.jsonc
```

This updates the existing `perfect-view-collector`, retains the `perfect-view-v1` singleton and the existing SQLite namespace, and reuses bucket `perfect-view`. Keep the existing collector secret in Cloudflare and the EA destination/token unchanged. The migration tag is still v1; do not delete or recreate the Durable Object namespace.

The upgraded collector retains completed H1 bars and derives complete UTC daily bars under **pv/v2/archive/**. Your existing four-day lifecycle must stay scoped to **pv/v1/history/**; do not extend it to this archive. Hours with incomplete 30-second coverage are excluded instead of fabricated. Valid no-quote sessions can advance coverage with no price bar. Backfill fills missing historical periods later. Automatic archive catch-up from the rolling buffer is bounded to two hours per batch; it can take about 24 minutes to catch up four days while the normal feed continues.

A chart initially loads recent 30-second history as before. H1/H4 can additionally load about one year (13 calendar month parts), and daily about five years (six calendar year parts), once those files actually exist. Daily bars in this archive are UTC days, which can differ from the broker's native D1 session boundaries. H4 requires complete H1 coverage; no invented lower-timeframe candles. Higher-timeframe history is rechecked at most every five minutes per selected chart; raw recent candles continue to update on the normal schedule.

## Import older data

1. In MT5 compile `cloudflare/tools/PerfectViewExportHourly.mq5` as a Script. It does not trade or contact a network endpoint. Run it on a chart, choosing five years and the correct symbol prefix/suffix/NAS100 alias. MT5 may supply less history than requested; the script reports the earliest exported candle. The MQL source was reviewed but cannot be compiled by the Linux test environment; compile it in MetaEditor before running.
2. The files appear under MT5 → File → Open Data Folder → MQL5 → Files → PerfectViewHistory. They are **broker-clock H1**, not UTC. Confirm the broker's historical winter/summer UTC offsets and whether changes follow US, EU or no DST. Do not guess from the current server offset. Prefer offset-aware UTC CSVs when available.
3. Run the importer from the repository root. Example **only if the broker confirms UTC+2 winter, UTC+3 summer, US transition dates**:

```powershell
py cloudflare/tools/import_hourly_history.py --data "C:\PATH\TO\PerfectViewHistory" --url https://perfect-view-collector.perfectentry.workers.dev --winter-offset 120 --summer-offset 180 --dst us --confirm-h1
```

It privately prompts for the existing EA collector token, batches up to 29 markets together, and safely retries by deterministic batch ID. No Supabase reads or credentials are involved. Duplicate uploads are acknowledged without repeating the writes. It does not upload files to a third-party history provider. BTCUSD/ETHUSD exports with ambiguous unzoned DST clocks are rejected; use UTC/offset-aware exports for those instruments in a separate run. For UTC files use `--dst none` and omit broker offsets. Check a known historical candle around both winter and summer before uploading the full set. A first partial UTC day is excluded deliberately.

This imports H1 and derives daily OHLC from the covered hourly data; it never attempts to expand daily candles into smaller bars. An incomplete or cropped source cannot establish full historical coverage. Inspect exports for holes before importing. Daily-looking files and misaligned minute files are rejected, but confirmation of source completeness remains required.

## Whop accounts and layouts

The new account Worker uses a separate Cloudflare D1 database; the existing Supabase project is not used for layouts. It uses Whop OAuth 2.1 with PKCE, state and nonce. Whop access/refresh tokens remain server-side and are discarded/revoked after identity is read. The browser receives only a revocable, app-specific session token, stored in sessionStorage for this tab (up to seven days). This works across the current GitHub-hosted website and a workers.dev API without third-party cookies. New tabs/devices may require signing in again. Membership is checked server-side at most every five minutes and at most that much revocation delay is possible.

1. In Whop create/select a production OAuth app for Perfect Entry. Record its public `app_...` client ID. Register the exact callback after deploying: `https://perfect-view-accounts.YOUR-SUBDOMAIN.workers.dev/auth/callback`. Enable the required token-exchange permission described by Whop. OAuth scopes used are `openid profile`; no email is requested.
2. Identify the eligible **product IDs** (`prod_...`), including legacy monthly/lifetime products. The current monthly and lifetime products can share access. Set separate comma-separated allowlists if Signals and Perfect View should have different memberships. Stripe-only lifetime buyers need a corresponding Whop entitlement; a Discord role or old TradingView username is not sufficient proof.
3. Obtain a company API key permitted to check access to those products. Keep it and the OAuth client secret private; never put either in GitHub, the website config or chat.
4. Create the database:

```powershell
npx.cmd wrangler d1 create perfect-view-accounts
```

Paste the returned database ID into `cloudflare/accounts/wrangler.jsonc`. Fill in `WHOP_CLIENT_ID`, `PERFECT_VIEW_PRODUCTS`, `SIGNALS_PRODUCTS`. Keep `WHOP_SANDBOX` false for production; use separate sandbox IDs/keys for a sandbox test.

```powershell
npx.cmd wrangler d1 migrations apply perfect-view-accounts --remote --config cloudflare/accounts/wrangler.jsonc
npx.cmd wrangler deploy --config cloudflare/accounts/wrangler.jsonc
npx.cmd wrangler secret put WHOP_CLIENT_SECRET --config cloudflare/accounts/wrangler.jsonc
npx.cmd wrangler secret put WHOP_COMPANY_API_KEY --config cloudflare/accounts/wrangler.jsonc
```

5. Set `accountApiUrl` in `assets/perfect-view/config.mjs` to the printed public Worker URL, initially leaving `requireMembership: false`. Publish that configuration. Sign in, test Save layout, and test loading the same layout from another device. Layouts contain the indicator settings, chart preferences and market-specific drawings, not the candle history. Up to 20 named layouts per account, 12 studies and 3,000 drawings total per layout, with a 256 KiB request cap. Saves are explicit: click Save layout; the chart does not write a cloud document on every candle. Browser-local drawing saves continue independently.
6. Verify an eligible account grants access, an ineligible account is denied, signing out invalidates the server session, and two accounts cannot see each other's layouts. Revision conflicts are shown instead of silently overwriting edits made on another device. The hour/day archive is public market data; personal layouts are never written to the public bucket.

## Activate the paywall and protect live signals

A static page overlay is not a security boundary. The account APIs and live-signal proxy enforce membership on the server. The chart shell and raw broker prices remain public; don't put proprietary custom indicator source in this public repository and assume the login screen makes it private. A member-checked private bundle endpoint (`/indicators`) is prepared for Pine conversions. Add a separate, non-public R2 bucket bound as `PRIVATE_INDICATORS`; never use the public candle bucket. Publish a self-contained `custom-indicators.bundle.mjs` exporting `registerCustomIndicators(registry)` and a matching `custom-indicators.schema.json` (array of pe_-prefixed definitions with number/boolean inputs) only after the actual ports are tested. The client downloads that bundle with its authenticated app session; unknown custom settings are rejected by the server unless present in the private schema. JavaScript delivered to a paid client can still be inspected by that client. No proprietary studies are included in this update because their Pine sources have not been supplied.

The existing public signal feed also serves the public performance pages. The rollout separates active signals from historical transparency:

1. Add `SUPABASE_URL=https://nmfsqgqwjihpudiqnuwh.supabase.co` to the **account Worker's** vars or secrets. Add its private read credential server-side:

```powershell
npx.cmd wrangler secret put SUPABASE_SERVICE_ROLE_KEY --config cloudflare/accounts/wrangler.jsonc
```

This key is used only for the bounded live-signals proxy. Never put it in browser files. The proxy serves today's approved M1/M5 signals, capped at 2,000 rows, and shares a 30-second cache within each edge location, after checking membership. It never sends its source credential to the browser.

2. Run `cloudflare/accounts/supabase/audit-before-paywall.sql` in the Perfect Entry project. Review anonymous grants, RLS policies, dependent views and RPCs, and any EA that still reads raw `signals` anonymously. Such readers must be moved to an authenticated server path before revoking access.
3. Run `0001-public-history.sql`. This creates the safe public closed-trade source, delayed 15 minutes after closure. The existing public performance pages retain their current source until `requireMembership` is switched on.
4. Confirm the account API `/signals` works for eligible members. Set `requireMembership: true` and publish the website config. Perfect View and Signals now show Whop membership gates; public performance pages select the historical source. Existing chart tabs recheck membership every five minutes.
5. Run `0002-protect-live-signals.sql` only after the new paths are verified. It removes direct anonymous/authenticated SELECT on **both** `public_signal_feed` and raw `signals`, while preserving server access. It does not change trade INSERT/UPDATE grants. Audit other views/RPCs too; leaving an alternate live-data route public would defeat the paywall.
6. Test signed out, eligible, ineligible and revoked accounts. Check performance dashboards, public historical reports and every copier/EA. Do not call the live-signals paywall complete until direct unauthenticated access is denied in the production database. These production settings and checks are not performed by the automated tests.

## Custom indicator ports

Send one Pine script first, with its expected inputs and example chart output. `custom-indicators.mjs` and the shared definition contract are an integration point, not converted indicators. Real ports must preserve timing, source/timeframe behavior, numerical inputs, component switches, drawings and alert conditions, with causal comparisons on fixed candle fixtures. No arbitrary Pine or JavaScript evaluation is added.

## Costs and validation

The existing collector still sends one all-market batch every 30 seconds. Archives are written on completed hours, not on every viewer update. Normal R2 writes are estimated around 0.76 million/month (about 0.69m rolling-feed writes plus up to 0.063m archive writes), with an initial five-year H1 import adding roughly 0.08m writes for all 29 markets, depending on available history, retries and month boundaries. These are estimates, not a hard cap or guarantee of free usage. Other account workloads share allowances. H1/H4 load about a year; D1 about five years; the archived objects are outside the four-day rolling deletion prefix. Standard indicators do not add feed requests. Signals and account APIs use Worker/D1 quotas; 50 continuously open Signals pages plus chart account rechecks can approach the daily Workers Free request limit.

Validation: 23 chart/study/layout/CDN/script checks; 8 real local Worker/D1/archive tests; 3 Python importer tests; DOM/controller with native canvas checks for drawing persistence, RSI/MACD panels, settings editing, position tools and named layout save/load; both Wrangler bundle dry runs; npm audit zero known vulnerabilities with pinned Wrangler 4.151.0. No real Whop code exchange, production membership, broker-timezone mapping, MT5 compilation or live database change is claimed as tested.

Official integration references:
- https://docs.whop.com/developer/guides/oauth
- https://whop.com/blog/add-user-authentication/
- Whop official `@whop/sdk` 2.5.0 source: GET `/api/v1/users/{id}/access/{resource_id}`, API version date `2026-10-13-1`.
- https://developers.cloudflare.com/r2/pricing/
- https://developers.cloudflare.com/durable-objects/platform/pricing/
