-- Swarāvalamba cloud history — run this once in the Supabase SQL editor.
-- Everything is private to the signed-in user via row-level security.

-- One light row per session (fast to list).
create table if not exists public.sessions (
  id               uuid primary key,
  user_id          uuid not null default auth.uid() references auth.users (id) on delete cascade,
  started_at       timestamptz not null,
  exercise         text not null,
  raga             text,
  speed            int,
  mode             text,
  shruti           text,
  bpm              int,
  total_beats      int,
  headphones       boolean default false,
  summary          jsonb,
  video_path       text,
  video_mime       text,
  video_bytes      bigint,
  duration_ms      int,
  video_offset_ms  int,
  has_hands        boolean default false,
  created_at       timestamptz not null default now()
);
create index if not exists sessions_user_started_idx on public.sessions (user_id, started_at desc);

-- Heavy JSON (events timeline + hand frames), fetched only when a session is opened.
create table if not exists public.session_data (
  id        uuid primary key references public.sessions (id) on delete cascade,
  user_id   uuid not null default auth.uid() references auth.users (id) on delete cascade,
  timeline  jsonb not null,
  hands     jsonb
);

alter table public.sessions     enable row level security;
alter table public.session_data enable row level security;

drop policy if exists "own sessions" on public.sessions;
create policy "own sessions" on public.sessions
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own session data" on public.session_data;
create policy "own session data" on public.session_data
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Private bucket for videos: {user id}/{session id}.mp4|webm, max 50 MB each.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('recordings', 'recordings', false, 52428800, array['video/mp4', 'video/webm'])
on conflict (id) do update set file_size_limit = excluded.file_size_limit,
                               allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "recordings: read own"   on storage.objects;
drop policy if exists "recordings: upload own" on storage.objects;
drop policy if exists "recordings: delete own" on storage.objects;

create policy "recordings: read own" on storage.objects for select to authenticated
  using (bucket_id = 'recordings' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "recordings: upload own" on storage.objects for insert to authenticated
  with check (bucket_id = 'recordings' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "recordings: delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'recordings' and (storage.foldername(name))[1] = auth.uid()::text);
