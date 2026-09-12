-- NIAC Live additive production schema. Apply after the legacy schema.sql.
create extension if not exists pgcrypto;

create table if not exists public.events (
  id uuid primary key default gen_random_uuid(), slug text unique not null,
  name text not null, theme text not null, starts_at timestamptz, ends_at timestamptz,
  created_at timestamptz not null default now()
);
create table if not exists public.event_settings (
  event_id uuid primary key references public.events(id) on delete cascade,
  active_activity text not null default 'lens' check(active_activity in ('lens','passport','decode')),
  lens_submissions_per_participant integer not null default 2 check(lens_submissions_per_participant between 1 and 10),
  rehearsal_mode boolean not null default false, updated_at timestamptz not null default now()
);
create table if not exists public.participants (
  id uuid primary key default gen_random_uuid(), event_id uuid not null references public.events(id),
  alias text not null check(char_length(alias) between 2 and 30), token_hash text unique not null,
  recovery_code_hash text unique not null, registered_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(), is_rehearsal boolean not null default false
);
create table if not exists public.participant_recovery_codes (
  participant_id uuid primary key references public.participants(id) on delete cascade,
  code_hash text unique not null, used_at timestamptz, created_at timestamptz not null default now()
);
create table if not exists public.lens_submissions (
  id uuid primary key default gen_random_uuid(), event_id uuid not null references public.events(id),
  participant_id uuid references public.participants(id), phrase text not null check(char_length(phrase) between 1 and 72),
  normalized_phrase text not null, status text not null default 'approved' check(status in ('pending','approved','rejected','hidden')),
  moderator_note text, reviewed_by uuid, reviewed_at timestamptz, created_at timestamptz not null default now()
);
create table if not exists public.quiz_games (
  id uuid primary key default gen_random_uuid(), event_id uuid not null references public.events(id),
  activity text not null check(activity in ('passport','decode')), title text not null, is_active boolean not null default true
);
create table if not exists public.quiz_rounds (
  id uuid primary key default gen_random_uuid(), game_id uuid not null references public.quiz_games(id) on delete cascade,
  day integer not null check(day in (1,2)), title text not null, display_order integer not null,
  status text not null default 'draft' check(status in ('draft','reviewed','published','complete')),
  unique(game_id, display_order)
);
create table if not exists public.quiz_questions (
  id uuid primary key default gen_random_uuid(), round_id uuid not null references public.quiz_rounds(id) on delete cascade,
  category text not null, difficulty text not null default 'medium', question text not null,
  correct_option smallint not null check(correct_option between 0 and 3), duration_seconds integer not null default 20 check(duration_seconds between 5 and 120),
  explanation text not null, image_url text, alt_text text, source text not null,
  review_status text not null default 'requires_fact_check' check(review_status in ('requires_fact_check','reviewed','approved')),
  display_order integer not null, is_void boolean not null default false, updated_at timestamptz not null default now(),
  unique(round_id, display_order)
);
create table if not exists public.question_options (
  id uuid primary key default gen_random_uuid(), question_id uuid not null references public.quiz_questions(id) on delete cascade,
  option_index smallint not null check(option_index between 0 and 3), label text not null,
  unique(question_id, option_index)
);
create table if not exists public.decode_state_rounds (
  round_id uuid primary key references public.quiz_rounds(id) on delete cascade,
  state_name text not null, zone text not null, clues jsonb not null check(jsonb_array_length(clues)=3),
  reveal_fact text not null, state_geo_id text not null, source text not null,
  review_status text not null default 'requires_fact_check', current_clue smallint not null default 1 check(current_clue between 1 and 3)
);
create table if not exists public.live_sessions (
  id uuid primary key default gen_random_uuid(), event_id uuid not null references public.events(id),
  game_id uuid references public.quiz_games(id), state text not null default 'lobby',
  resume_state text, current_round_id uuid references public.quiz_rounds(id),
  current_question_id uuid references public.quiz_questions(id), current_clue smallint not null default 1,
  opened_at timestamptz, deadline_at timestamptz, version bigint not null default 1,
  updated_at timestamptz not null default now()
);
alter table public.live_sessions drop constraint if exists live_sessions_state_check;
alter table public.live_sessions add constraint live_sessions_state_check check(state in ('lobby','preparing','open','locked','revealed','leaderboard','round_complete','paused','ended'));
create table if not exists public.live_question_state (
  session_id uuid primary key references public.live_sessions(id) on delete cascade,
  question_id uuid references public.quiz_questions(id), response_count integer not null default 0,
  locked_at timestamptz, revealed_at timestamptz
);
create table if not exists public.participant_answers (
  id uuid primary key default gen_random_uuid(), participant_id uuid not null references public.participants(id),
  session_id uuid not null references public.live_sessions(id), question_id uuid not null references public.quiz_questions(id),
  option_index smallint not null check(option_index between 0 and 3), clue_number smallint,
  is_correct boolean not null, points integer not null default 0, response_ms integer not null,
  idempotency_key uuid not null, submitted_at timestamptz not null default clock_timestamp(),
  unique(participant_id, question_id), unique(participant_id, idempotency_key)
);
create table if not exists public.score_totals (
  participant_id uuid not null references public.participants(id) on delete cascade,
  activity text not null check(activity in ('passport','decode')), day integer not null check(day in (0,1,2)),
  points integer not null default 0, correct_answers integer not null default 0,
  correct_response_ms bigint not null default 0, primary key(participant_id,activity,day)
);
create table if not exists public.passport_stamps (
  participant_id uuid not null references public.participants(id) on delete cascade,
  category text not null, earned_at timestamptz not null default now(), primary key(participant_id,category)
);
create table if not exists public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade, display_name text not null,
  role text not null default 'operator' check(role in ('operator','content_editor','super_admin'))
);
create table if not exists public.admin_audit_logs (
  id bigint generated always as identity primary key, event_id uuid references public.events(id),
  admin_user_id uuid references auth.users(id), action text not null, entity_type text not null,
  entity_id text, before_data jsonb, after_data jsonb, created_at timestamptz not null default now()
);

create index if not exists lens_public_idx on public.lens_submissions(event_id,created_at) where status='approved';
create index if not exists answers_score_idx on public.participant_answers(participant_id,submitted_at);
create index if not exists sessions_event_idx on public.live_sessions(event_id,updated_at desc);

alter table public.responses enable row level security;
drop policy if exists "Allow public read responses" on public.responses;
drop policy if exists "Allow public insert responses" on public.responses;
drop policy if exists "Allow public update moderation" on public.responses;

do $$ declare t text; begin
  foreach t in array array['events','event_settings','participants','participant_recovery_codes','lens_submissions','quiz_games','quiz_rounds','quiz_questions','question_options','decode_state_rounds','live_sessions','live_question_state','participant_answers','score_totals','passport_stamps','admin_users','admin_audit_logs'] loop
    execute format('alter table public.%I enable row level security',t);
  end loop;
end $$;

-- Browser access is intentionally restricted to safe projections. Writes use the server service role.
create or replace view public.approved_lens_submissions with (security_invoker=true) as
select id,event_id,phrase,normalized_phrase,created_at from public.lens_submissions where status='approved';
grant select on public.approved_lens_submissions to anon, authenticated;
create policy lens_public_read on public.lens_submissions for select to anon,authenticated using(status='approved');

create or replace function public.submit_quiz_answer(
  p_token_hash text,p_session_id uuid,p_question_id uuid,p_option_index smallint,p_idempotency_key uuid
) returns jsonb language plpgsql security definer set search_path=public as $$
declare p participants; s live_sessions; q quiz_questions; existing participant_answers; elapsed integer; awarded integer; clue smallint;
begin
  select * into p from participants where token_hash=p_token_hash;
  if p.id is null then raise exception 'unauthorized'; end if;
  select * into existing from participant_answers where participant_id=p.id and idempotency_key=p_idempotency_key;
  if existing.id is not null then return jsonb_build_object('accepted',true,'duplicate',true,'answerId',existing.id); end if;
  select * into s from live_sessions where id=p_session_id for update;
  if s.state <> 'open' or s.current_question_id <> p_question_id then raise exception 'question_not_open'; end if;
  if clock_timestamp() > s.deadline_at then raise exception 'answer_late'; end if;
  select * into q from quiz_questions where id=p_question_id;
  elapsed := greatest(0,extract(epoch from (clock_timestamp()-s.opened_at))*1000);
  clue := case when exists(select 1 from decode_state_rounds d where d.round_id=q.round_id) then s.current_clue else null end;
  awarded := case when q.is_void or p_option_index<>q.correct_option then 0 when clue is not null then 4-clue else 1000 end;
  insert into participant_answers(participant_id,session_id,question_id,option_index,clue_number,is_correct,points,response_ms,idempotency_key)
  values(p.id,s.id,q.id,p_option_index,clue,p_option_index=q.correct_option and not q.is_void,awarded,elapsed,p_idempotency_key)
  returning * into existing;
  update live_question_state set response_count=response_count+1 where session_id=s.id;
  insert into score_totals(participant_id,activity,day,points,correct_answers,correct_response_ms)
  select p.id,g.activity,r.day,awarded,case when awarded>0 then 1 else 0 end,case when awarded>0 then elapsed else 0 end
  from quiz_rounds r join quiz_games g on g.id=r.game_id where r.id=q.round_id
  on conflict(participant_id,activity,day) do update set points=score_totals.points+excluded.points,
    correct_answers=score_totals.correct_answers+excluded.correct_answers,
    correct_response_ms=score_totals.correct_response_ms+excluded.correct_response_ms;
  if awarded > 0 and clue is null then
    insert into passport_stamps(participant_id,category) values(p.id,q.category) on conflict do nothing;
  end if;
  return jsonb_build_object('accepted',true,'duplicate',false,'answerId',existing.id);
exception when unique_violation then
  select * into existing from participant_answers where participant_id=p.id and question_id=p_question_id;
  return jsonb_build_object('accepted',true,'duplicate',true,'answerId',existing.id);
end $$;
revoke all on function public.submit_quiz_answer(text,uuid,uuid,smallint,uuid) from public,anon,authenticated;
grant execute on function public.submit_quiz_answer(text,uuid,uuid,smallint,uuid) to service_role;

create or replace function public.void_quiz_question(p_question_id uuid) returns void
language plpgsql security definer set search_path=public as $$
begin
  update quiz_questions set is_void=true,updated_at=now() where id=p_question_id;
  update participant_answers set points=0,is_correct=false where question_id=p_question_id;
  delete from score_totals;
  insert into score_totals(participant_id,activity,day,points,correct_answers,correct_response_ms)
  select a.participant_id,g.activity,r.day,sum(a.points),count(*) filter(where a.is_correct),
    coalesce(sum(a.response_ms) filter(where a.is_correct),0)
  from participant_answers a join quiz_questions q on q.id=a.question_id
  join quiz_rounds r on r.id=q.round_id join quiz_games g on g.id=r.game_id
  where not q.is_void group by a.participant_id,g.activity,r.day;
  delete from passport_stamps;
  insert into passport_stamps(participant_id,category)
  select distinct a.participant_id,q.category from participant_answers a
  join quiz_questions q on q.id=a.question_id join quiz_rounds r on r.id=q.round_id
  join quiz_games g on g.id=r.game_id where a.is_correct and not q.is_void and g.activity='passport';
end $$;
revoke all on function public.void_quiz_question(uuid) from public,anon,authenticated;
grant execute on function public.void_quiz_question(uuid) to service_role;

insert into public.events(slug,name,theme,starts_at,ends_at) values(
  'niac-2026','Nigeria Independence Anniversary Celebration 2026','Timeless Nigeria: Roots, Realities & Renewals',
  '2026-09-29 08:45:00+01','2026-09-30 14:00:00+01') on conflict(slug) do nothing;
insert into public.event_settings(event_id) select id from public.events where slug='niac-2026' on conflict do nothing;
insert into public.quiz_games(event_id,activity,title)
select id,'passport','Naija Passport Challenge' from public.events e where e.slug='niac-2026'
and not exists(select 1 from public.quiz_games g where g.event_id=e.id and g.activity='passport');
insert into public.quiz_games(event_id,activity,title)
select id,'decode','Decode the State' from public.events e where e.slug='niac-2026'
and not exists(select 1 from public.quiz_games g where g.event_id=e.id and g.activity='decode');
insert into public.live_sessions(event_id,game_id,state)
select e.id,g.id,'lobby' from public.events e join public.quiz_games g on g.event_id=e.id and g.activity='passport'
where e.slug='niac-2026' and not exists(select 1 from public.live_sessions s where s.event_id=e.id);

-- Preserve legacy public mosaic content as already-approved historical material.
insert into public.lens_submissions(event_id,phrase,normalized_phrase,status,created_at)
select e.id,r.raw_word,r.word_lower,case when r.is_hidden then 'hidden' else 'approved' end,r.created_at
from public.responses r cross join public.events e where e.slug='niac-2026'
and not exists(select 1 from public.lens_submissions l where l.participant_id is null and l.phrase=r.raw_word and l.created_at=r.created_at);

do $$ begin
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='lens_submissions') then
    alter publication supabase_realtime add table public.lens_submissions;
  end if;
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='live_sessions') then
    alter publication supabase_realtime add table public.live_sessions;
  end if;
end $$;
