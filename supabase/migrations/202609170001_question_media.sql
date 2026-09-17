-- Additive only. Apply before importing reviewed photo questions.
-- Legacy image_url/alt_text questions continue to work without this metadata.
alter table public.quiz_questions
  add column if not exists media jsonb,
  add column if not exists image_fallback text;

alter table public.decode_state_rounds
  add column if not exists clue_media jsonb;

comment on column public.quiz_questions.media is
  'Private source metadata: src, alt, timing (question/reveal), title, caption, author, license, licenseUrl, source. Publish only through the state sanitizer.';

