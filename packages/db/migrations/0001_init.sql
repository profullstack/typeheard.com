-- Accounts. Magic link + passkey only: there is no password column on purpose,
-- so there is nothing to reset, rotate or leak.
create extension if not exists citext;

create table users (
  id           uuid primary key default gen_random_uuid(),
  email        citext not null unique,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz
);

-- Magic links. Only the hash is stored, so a database read cannot mint a session.
create table login_tokens (
  token_hash  bytea primary key,
  email       citext not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  consumed_at timestamptz
);
create index login_tokens_expires_idx on login_tokens (expires_at);

create table sessions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  user_agent text
);
create index sessions_user_idx on sessions (user_id);
create index sessions_expires_idx on sessions (expires_at);

create table passkeys (
  credential_id text primary key,
  user_id       uuid not null references users(id) on delete cascade,
  public_key    bytea not null,
  counter       bigint not null default 0,
  transports    text[] not null default '{}',
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);
create index passkeys_user_idx on passkeys (user_id);

-- ---------------------------------------------------------------------------
-- Money in.
-- ---------------------------------------------------------------------------

create table payments (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  provider     text not null,
  provider_ref text not null,
  amount_cents int not null,
  currency     text not null default 'USD',
  status       text not null,
  raw          jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  -- What makes a replayed webhook update one row instead of inserting a second.
  unique (provider, provider_ref)
);
create index payments_user_idx on payments (user_id);

-- ---------------------------------------------------------------------------
-- Credits, as an append-only ledger rather than a counter on the user row.
--
-- A single `balance` column is one UPDATE away from being wrong forever with no way
-- to find out when it went wrong. Every grant and every spend is a row here, the
-- balance is their sum, and the history is the audit trail -- which matters because
-- these are bought with money and people ask where they went.
-- ---------------------------------------------------------------------------

create table credit_ledger (
  id         bigserial primary key,
  user_id    uuid not null references users(id) on delete cascade,
  -- Positive for a top-up, negative for a spend. Never zero.
  delta      int not null check (delta <> 0),
  reason     text not null,
  payment_id uuid references payments(id) on delete set null,
  transcript_id uuid,
  created_at timestamptz not null default now()
);
create index credit_ledger_user_idx on credit_ledger (user_id, id desc);

-- One credit grant per payment, enforced by the database rather than by remembering.
-- A CoinPay webhook is retried until it is acknowledged, so "we already granted this"
-- has to be a constraint; a check-then-insert races itself and pays out twice.
create unique index credit_ledger_one_grant_per_payment
  on credit_ledger (payment_id) where payment_id is not null;

-- ---------------------------------------------------------------------------
-- Transcripts. One row is the job and its result: queued with the upload on disk,
-- running, then done with the segments (and the upload deleted) or failed.
-- The id is the capability that a share link carries, so it is a random uuid.
-- ---------------------------------------------------------------------------

create table transcripts (
  id              uuid primary key default gen_random_uuid(),
  -- Null for an anonymous preview and for an x402 caller, who never makes an account.
  user_id         uuid references users(id) on delete cascade,
  api_key_id      uuid,
  tier            text not null check (tier in ('preview', 'full')),
  status          text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  filename        text,
  title           text,
  language        text not null default 'auto',
  duration_sec    double precision not null,
  transcribed_sec double precision,
  -- What the account paid, so a dispute is answered with the number actually charged.
  minutes_charged int not null default 0,
  -- Present only while queued or running; cleared the moment the words are out.
  upload_path     text,
  bytes_in        bigint,
  segments        jsonb,
  error           text,
  work_ms         int,
  -- The paying address, when an agent paid per call instead of spending credits.
  payer           text,
  created_at      timestamptz not null default now(),
  started_at      timestamptz,
  finished_at     timestamptz,
  expires_at      timestamptz not null
);
create index transcripts_user_idx on transcripts (user_id, created_at desc);
create index transcripts_queue_idx on transcripts (created_at) where status in ('queued', 'running');
create index transcripts_expires_idx on transcripts (expires_at);

-- ---------------------------------------------------------------------------
-- Programmatic access for people (agents use x402 and need none of this).
-- ---------------------------------------------------------------------------

create table api_keys (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  name         text not null default 'default',
  -- Only the hash. The plaintext is shown once, at creation, and never again.
  key_hash     bytea not null unique,
  -- The visible prefix, so somebody can tell two keys apart in a list.
  prefix       text not null,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
create index api_keys_user_idx on api_keys (user_id);
