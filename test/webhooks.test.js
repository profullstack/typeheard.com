import { beforeAll, beforeEach, expect, test } from 'bun:test';
import { verifySignature } from '@profullstack/webhooks';
import * as auth from '../packages/auth/src/index.js';
import { sql } from '../packages/db/src/index.js';
import * as q from '../packages/db/src/queries.js';

/**
 * Customer webhooks on @profullstack/webhooks, stored in this app's Postgres through a
 * pg-style adapter over Bun.SQL.
 *
 * What has to hold: the adapter speaks pg's `query(text, params) -> { rows }`; a
 * finished or failed transcript reaches the account that submitted it, signed so a
 * Standard Webhooks receiver verifies it, carrying links and never the words; an
 * anonymous job tells nobody; the API answers only with a key, scoped to its account.
 * No afterAll(close): the pool is shared by every test file in the process.
 */

let wh;
let app;

beforeAll(async () => {
  wh = await import('../apps/web/src/lib/webhooks.js');
  ({ app } = await import('../apps/web/src/app.js'));
});

beforeEach(async () => {
  await sql`truncate webhook_endpoints, webhook_deliveries`;
  await sql`truncate credit_ledger, transcripts, payments, sessions, api_keys, users restart identity cascade`;
});

/** A receiver that never leaves the process: records what it was sent. */
function receiver(status = 204) {
  const got = [];
  const fetchImpl = async (url, init) => {
    got.push({ url: String(url), headers: new Headers(init.headers), body: String(init.body) });
    return new Response(null, { status });
  };
  return { got, fetchImpl };
}

const hub = (fetchImpl) =>
  wh.makeHooks({
    fetchImpl,
    // A public address for any host, so no DNS is needed and the SSRF guard still runs.
    guard: { lookup: async () => ['93.184.216.34'] },
  });

test('the adapter is pg-shaped: query(text, params) resolves { rows } from sql.unsafe', async () => {
  const calls = [];
  const fake = {
    unsafe: async (text, params) => {
      calls.push([text, params]);
      return [{ a: 1 }];
    },
  };
  const out = await wh.pgAdapter(fake).query('select $1::int as a', [1]);
  expect(out).toEqual({ rows: [{ a: 1 }] });
  expect(calls).toEqual([['select $1::int as a', [1]]]);

  // And against the real Bun.SQL pool: placeholders, nulls, bigints and an empty result.
  const real = wh.pgAdapter(sql);
  const { rows } = await real.query('select $1::text as s, $2::bigint as n, $3::text as z', [
    'x',
    1_791_288_000_123,
    null,
  ]);
  expect(rows[0].s).toBe('x');
  expect(Number(rows[0].n)).toBe(1_791_288_000_123);
  expect(rows[0].z).toBeNull();
  expect((await real.query('select 1 where false')).rows).toEqual([]);
});

test('a finished transcript reaches its owner, signed, with links and not the text', async () => {
  const { got, fetchImpl } = receiver();
  const hooks = hub(fetchImpl);
  const user = await q.findOrCreateUser('hooks@example.com');
  const owner = String(user.id);
  const { endpoint, secret } = await hooks.createEndpoint(owner, {
    url: 'https://receiver.example/hooks',
    events: ['transcript.*'],
  });
  expect(endpoint.events).toEqual(['transcript.*']);
  expect(secret).toMatch(/^whsec_/);

  const row = {
    id: '11111111-2222-4333-8444-555555555555',
    user_id: user.id,
    tier: 'full',
    title: 'Interview',
    filename: 'interview.m4a',
    language: 'auto',
    duration_sec: 125.5,
    minutes_charged: 3,
    created_at: new Date('2026-10-28T10:00:00Z'),
    segments: [{ text: 'the secret words' }],
  };
  const queued = await wh.notifyTranscript(
    row,
    { status: 'done', transcribedSec: 125.5, language: 'en' },
    hooks,
  );
  expect(queued.queued).toBe(1);
  expect(await hooks.drain()).toBe(1);

  expect(got).toHaveLength(1);
  const [hit] = got;
  expect(hit.url).toBe('https://receiver.example/hooks');
  expect(verifySignature({ headers: hit.headers, body: hit.body, secret }).ok).toBe(true);
  expect(hit.headers.get('webhook-event')).toBe('transcript.completed');

  const event = JSON.parse(hit.body);
  expect(event.type).toBe('transcript.completed');
  expect(event.subject).toBe(`transcript:${row.id}`);
  expect(event.data.id).toBe(row.id);
  expect(event.data.status).toBe('done');
  expect(event.data.language).toBe('en');
  expect(event.data.status_url).toEndWith(`/api/v1/transcripts/${row.id}`);
  expect(event.data.downloads.srt).toEndWith(`/api/v1/transcripts/${row.id}/srt`);
  expect(hit.body).not.toContain('the secret words');
  expect(event.data.text).toBeUndefined();

  const [delivery] = await hooks.deliveries(owner);
  expect(delivery.status).toBe('delivered');
});

test('a failed transcript says why and what was refunded; other events are filtered out', async () => {
  const { got, fetchImpl } = receiver();
  const hooks = hub(fetchImpl);
  const user = await q.findOrCreateUser('fails@example.com');
  const owner = String(user.id);
  await hooks.createEndpoint(owner, {
    url: 'https://receiver.example/failed',
    events: ['transcript.failed'],
  });
  const row = { id: '21111111-2222-4333-8444-555555555555', user_id: user.id, tier: 'full' };
  expect(
    (await wh.notifyTranscript(row, { status: 'done', transcribedSec: 1 }, hooks)).queued,
  ).toBe(0);
  await wh.notifyTranscript(
    { ...row, minutes_charged: 4 },
    { status: 'failed', error: 'no audio stream', refunded: 4 },
    hooks,
  );
  await hooks.drain();
  expect(got).toHaveLength(1);
  const event = JSON.parse(got[0].body);
  expect(event.type).toBe('transcript.failed');
  expect(event.data.error).toBe('no audio stream');
  expect(event.data.minutes_refunded).toBe(4);
  expect(event.data.downloads).toBeUndefined();
});

test('an anonymous job tells nobody, and a broken hub never throws into the worker', async () => {
  const { got, fetchImpl } = receiver();
  const hooks = hub(fetchImpl);
  expect(await wh.notifyTranscript({ id: 'x', user_id: null }, { status: 'done' }, hooks)).toBe(
    null,
  );
  const broken = {
    emit: async () => {
      throw new Error('db down');
    },
  };
  expect(await wh.notifyTranscript({ id: 'x', user_id: 'u' }, { status: 'done' }, broken)).toBe(
    null,
  );
  expect(got).toHaveLength(0);
});

test('two drains at once deliver a due event once (FOR UPDATE SKIP LOCKED through the adapter)', async () => {
  const { got, fetchImpl } = receiver();
  const hooks = hub(fetchImpl);
  const user = await q.findOrCreateUser('race@example.com');
  await hooks.createEndpoint(String(user.id), { url: 'https://receiver.example/race' });
  await wh.notifyTranscript(
    { id: '31111111-2222-4333-8444-555555555555', user_id: user.id, tier: 'full' },
    { status: 'done' },
    hooks,
  );
  // Separate hubs, as separate containers would be: one hub shares a drain in flight.
  const others = [hub(fetchImpl), hub(fetchImpl), hub(fetchImpl)];
  const sent = await Promise.all([hooks, ...others].map((h) => h.drain()));
  expect(sent.reduce((a, b) => a + b, 0)).toBe(1);
  expect(got).toHaveLength(1);
});

test('/api/v1/webhooks needs a key, and answers for that key only', async () => {
  const anon = await app.request('/api/v1/webhooks');
  expect(anon.status).toBe(401);
  const bogus = await app.request('/api/v1/webhooks', {
    headers: { authorization: 'Bearer th_not_a_real_key' },
  });
  expect(bogus.status).toBe(401);

  const user = await q.findOrCreateUser('api@example.com');
  const key = await auth.createApiKey({ userId: user.id, name: 'test' });
  const headers = { authorization: `Bearer ${key.plaintext}` };

  // Someone else's endpoint, made straight on the hub.
  const stranger = await q.findOrCreateUser('stranger@example.com');
  const theirs = await hub(receiver().fetchImpl).createEndpoint(String(stranger.id), {
    url: 'https://receiver.example/theirs',
  });

  const res = await app.request('/api/v1/webhooks', { headers });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.event_types).toEqual(['transcript.completed', 'transcript.failed']);
  expect(body.endpoints).toEqual([]);

  const peek = await app.request(`/api/v1/webhooks/${theirs.endpoint.id}`, { headers });
  expect(peek.status).toBe(404);
  const del = await app.request(`/api/v1/webhooks/${theirs.endpoint.id}`, {
    method: 'DELETE',
    headers,
  });
  expect(del.status).toBe(404);

  // A pattern that matches nothing typeheard sends is refused before any DNS lookup.
  const bad = await app.request('/api/v1/webhooks', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://receiver.example/x', events: ['room.joined'] }),
  });
  expect(bad.status).toBe(400);
});

test('the account page needs a session, and lists the events', async () => {
  const res = await app.request('/account/webhooks');
  expect(res.status).toBe(302);
  const user = await q.findOrCreateUser('page@example.com');
  const session = await q.startSession({ userId: user.id, ttlDays: 1 });
  const cookie = auth.sessionCookie(session).split(';')[0];
  const page = await app.request('/account/webhooks', { headers: { cookie } });
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain('transcript.completed');
  expect(html).toContain('action="/account/webhooks/add"');
});
