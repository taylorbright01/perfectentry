-- Auto-close stale signals using Twelve Data price checks
-- This runs as a pg_cron job every hour

-- First create the atomic weekly_stats increment function (fixes race condition)
create or replace function increment_weekly_stats(
  p_date date, p_score text, p_is_win boolean, p_ai_pass boolean
) returns void language plpgsql as $$
begin
  insert into weekly_stats (stat_date, score, wins, losses, currency_ai_wins, currency_ai_losses, last_updated)
  values (
    p_date, p_score,
    case when p_is_win then 1 else 0 end,
    case when not p_is_win then 1 else 0 end,
    case when p_ai_pass and p_is_win then 1 else 0 end,
    case when p_ai_pass and not p_is_win then 1 else 0 end,
    now()
  )
  on conflict (stat_date, score) do update set
    wins = weekly_stats.wins + case when p_is_win then 1 else 0 end,
    losses = weekly_stats.losses + case when not p_is_win then 1 else 0 end,
    currency_ai_wins = weekly_stats.currency_ai_wins + case when p_ai_pass and p_is_win then 1 else 0 end,
    currency_ai_losses = weekly_stats.currency_ai_losses + case when p_ai_pass and not p_is_win then 1 else 0 end,
    last_updated = now();
end;
$$;

-- Force-close signals older than 4 hours with no outcome
-- Uses worst case (sl) since we can't verify price
-- Run this manually whenever actives pile up, or schedule via pg_cron
create or replace function expire_stale_signals() returns integer language plpgsql as $$
declare
  expired_count integer;
begin
  update signals
  set 
    outcome = 'sl',
    close_price = entry,
    closed_at = now()
  where 
    outcome is null
    and created_at < now() - interval '4 hours'
    and extract(dow from created_at) between 1 and 5; -- weekdays only
  
  get diagnostics expired_count = row_count;
  return expired_count;
end;
$$;

-- To run manually anytime actives pile up:
-- select expire_stale_signals();

-- To schedule hourly via pg_cron (run this once):
-- select cron.schedule('expire-stale-signals', '0 * * * *', 'select expire_stale_signals()');

-- Check how many would be expired right now:
select count(*) as stale_signals,
  min(created_at) as oldest,
  max(created_at) as newest
from signals
where outcome is null
and created_at < now() - interval '4 hours';
