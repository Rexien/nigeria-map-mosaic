-- ==========================================================
-- Nigeria Mosaic - Supabase Database Schema & Setup Script
-- ==========================================================
-- Run this complete script in your Supabase SQL Editor:
-- (Supabase Dashboard -> SQL Editor -> New Query -> Paste & Run)

-- 1. Create the responses table
create table if not exists public.responses (
  id uuid primary key default gen_random_uuid(),
  raw_word text not null check (
    char_length(raw_word) > 0
    and char_length(raw_word) <= 25
    and array_length(regexp_split_to_array(trim(raw_word), '\s+'), 1) <= 2
  ),
  word_lower text not null,
  stem text not null,
  is_hidden boolean default false not null,
  is_flagged boolean default false not null,
  created_at timestamptz default now() not null
);

-- Ensure constraint is up to date if table was created previously
alter table public.responses drop constraint if exists responses_raw_word_check;
alter table public.responses add constraint responses_raw_word_check check (
  char_length(raw_word) > 0
  and char_length(raw_word) <= 25
  and array_length(regexp_split_to_array(trim(raw_word), '\s+'), 1) <= 2
);

-- 2. Create high-performance indexes
create index if not exists idx_responses_active on public.responses (created_at desc) where is_hidden = false;
create index if not exists idx_responses_stem on public.responses (stem);
create index if not exists idx_responses_created_at on public.responses (created_at desc);

-- 3. Enable Realtime publication for the responses table
-- Note: If publication already exists, add table to it
do $$
begin
  if not exists (
    select 1 from pg_publication_tables 
    where pubname = 'supabase_realtime' and tablename = 'responses'
  ) then
    alter publication supabase_realtime add table public.responses;
  end if;
end $$;

-- 4. Enable Row Level Security (RLS)
alter table public.responses enable row level security;

-- Drop existing policies if any to prevent conflicts
drop policy if exists "Allow public read responses" on public.responses;
drop policy if exists "Allow public insert responses" on public.responses;
drop policy if exists "Allow public update moderation" on public.responses;

-- Policy A: Allow anyone to read all rows (needed for live display and live admin feed)
create policy "Allow public read responses"
  on public.responses for select
  using (true);

-- Policy B: Allow anyone to insert valid 1 or 2 words (<= 25 chars, max 2 words)
create policy "Allow public insert responses"
  on public.responses for insert
  with check (
    char_length(raw_word) > 0
    and char_length(raw_word) <= 25
    and array_length(regexp_split_to_array(trim(raw_word), '\s+'), 1) <= 2
  );

-- Policy C: Allow updating is_hidden moderation status
create policy "Allow public update moderation"
  on public.responses for update
  using (true)
  with check (true);

-- Optional: Seed demo words for testing (remove or comment out for production)
-- insert into public.responses (raw_word, word_lower, stem) values
--   ('Resilience', 'resilience', 'resilien'),
--   ('Resilient', 'resilient', 'resilien'),
--   ('Innovation', 'innovation', 'innovat'),
--   ('Progress', 'progress', 'progress'),
--   ('Unity', 'unity', 'uniti'),
--   ('Growth', 'growth', 'growth'),
--   ('Excellence', 'excellence', 'excel'),
--   ('Hope', 'hope', 'hope'),
--   ('Strength', 'strength', 'strength'),
--   ('Brilliance', 'brilliance', 'brillian');
