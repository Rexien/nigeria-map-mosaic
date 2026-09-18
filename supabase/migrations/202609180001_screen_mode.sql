-- The projected welcome screen is a display choice, not a quiz activity.
-- Keep active_activity for scoring and question selection.
alter table public.event_settings
  add column if not exists screen_mode text not null default 'welcome';

alter table public.event_settings
  add constraint event_settings_screen_mode_check
  check (screen_mode in ('welcome', 'activity'));

-- Preserve a question or map already being projected during an upgrade.
update public.event_settings settings
set screen_mode = 'activity'
where exists (
  select 1 from public.live_sessions session
  where session.event_id = settings.event_id
    and session.state in ('preparing', 'open', 'locked', 'revealed', 'leaderboard')
);
