-- Additive capacity, durable-ingress and snapshot-scoring structures.
alter table public.participants add column if not exists is_spectator boolean not null default false;
alter table public.event_settings add column if not exists roster_frozen boolean not null default false;

create table if not exists public.gateway_answers (
  id uuid primary key default gen_random_uuid(),
  participant_id uuid not null references public.participants(id) on delete cascade,
  session_id uuid not null references public.live_sessions(id) on delete cascade,
  question_id uuid not null references public.quiz_questions(id),
  option_index smallint not null check(option_index between 0 and 3),
  clue_number smallint,
  response_ms integer not null check(response_ms >= 0),
  idempotency_key uuid not null,
  received_at timestamptz not null default clock_timestamp(),
  unique(participant_id,question_id),
  unique(participant_id,idempotency_key)
);
create index if not exists gateway_answers_session_idx on public.gateway_answers(session_id,question_id);

create table if not exists public.leaderboard_snapshots (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.live_sessions(id) on delete cascade,
  activity text not null check(activity in ('passport','decode')),
  snapshot_version bigint not null,
  leaders jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default clock_timestamp(),
  unique(session_id,activity,snapshot_version)
);

create table if not exists public.participant_score_snapshots (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.live_sessions(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  snapshot_version bigint not null,
  rank integer,
  scores jsonb not null,
  stamps jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default clock_timestamp(),
  unique(session_id,participant_id,snapshot_version)
);
create index if not exists participant_score_snapshots_lookup on public.participant_score_snapshots(participant_id,snapshot_version desc);

alter table public.gateway_answers enable row level security;
alter table public.leaderboard_snapshots enable row level security;
alter table public.participant_score_snapshots enable row level security;
drop policy if exists "Allow public read leaderboard snapshots" on public.leaderboard_snapshots;
drop policy if exists "Allow public read participant score snapshots" on public.participant_score_snapshots;
revoke all on public.gateway_answers from anon,authenticated;
revoke all on public.leaderboard_snapshots from anon,authenticated;
revoke all on public.participant_score_snapshots from anon,authenticated;

create or replace function public.submit_raw_quiz_answer(
  p_token_hash text,p_session_id uuid,p_question_id uuid,p_option_index smallint,p_idempotency_key uuid
) returns jsonb language plpgsql security definer set search_path=public as $$
declare p participants; s live_sessions; existing gateway_answers; elapsed integer;
begin
  select * into p from participants where token_hash=p_token_hash;
  if p.id is null then raise exception 'unauthorized'; end if;
  if p.is_spectator then return jsonb_build_object('accepted',true,'duplicate',false,'spectator',true); end if;
  select * into existing from gateway_answers where participant_id=p.id and idempotency_key=p_idempotency_key;
  if existing.id is not null then return jsonb_build_object('accepted',true,'duplicate',true,'answerId',existing.id); end if;
  select * into s from live_sessions where id=p_session_id for share;
  if s.state <> 'open' or s.current_question_id <> p_question_id then raise exception 'question_not_open'; end if;
  if clock_timestamp() > s.deadline_at then raise exception 'answer_late'; end if;
  elapsed:=greatest(0,extract(epoch from (clock_timestamp()-s.opened_at))*1000);
  insert into gateway_answers(participant_id,session_id,question_id,option_index,clue_number,response_ms,idempotency_key)
  values(p.id,s.id,p_question_id,p_option_index,s.current_clue,elapsed,p_idempotency_key)
  returning * into existing;
  return jsonb_build_object('accepted',true,'duplicate',false,'answerId',existing.id);
exception when unique_violation then
  select * into existing from gateway_answers where participant_id=p.id and question_id=p_question_id;
  return jsonb_build_object('accepted',true,'duplicate',true,'answerId',existing.id);
end $$;
revoke all on function public.submit_raw_quiz_answer(text,uuid,uuid,smallint,uuid) from public,anon,authenticated;
grant execute on function public.submit_raw_quiz_answer(text,uuid,uuid,smallint,uuid) to service_role;

create or replace function public.count_quiz_answers(p_session_id uuid,p_question_id uuid)
returns bigint language sql stable security definer set search_path=public as $$
  select count(distinct participant_id) from (
    select participant_id from gateway_answers where session_id=p_session_id and question_id=p_question_id
    union all
    select participant_id from participant_answers where session_id=p_session_id and question_id=p_question_id
  ) answers;
$$;
revoke all on function public.count_quiz_answers(uuid,uuid) from public,anon,authenticated;
grant execute on function public.count_quiz_answers(uuid,uuid) to service_role;
