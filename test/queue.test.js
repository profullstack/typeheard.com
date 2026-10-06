import { beforeEach, expect, test } from 'bun:test';
import { sql } from '../packages/db/src/index.js';
import * as q from '../packages/db/src/queries.js';

/**
 * The job queue lives in `transcripts`. What has to hold: a job is claimed once,
 * however many workers ask; the words survive the round trip through jsonb; a job
 * left running by a dead container goes back in the queue; an expired transcript
 * reads as gone.
 */

beforeEach(async () => {
  await sql`truncate credit_ledger, transcripts, payments, sessions, api_keys, users restart identity cascade`;
});

const job = (extra = {}) =>
  q.createTranscript({
    tier: 'full',
    filename: 'a.mp3',
    title: 'a',
    durationSec: 42,
    uploadPath: '/tmp/none.mp3',
    expiresAt: new Date(Date.now() + 86_400_000),
    ...extra,
  });

test('a queued job is claimed exactly once, however many workers ask', async () => {
  const a = await job();
  const claims = await Promise.all(Array.from({ length: 8 }, () => q.claimNextTranscript()));
  const won = claims.filter(Boolean);
  expect(won).toHaveLength(1);
  expect(won[0].id).toBe(a.id);
  expect(won[0].status).toBe('running');
  expect(await q.claimNextTranscript()).toBeNull();
});

test('the oldest job goes first, and the queue position counts what is ahead', async () => {
  const first = await job();
  const second = await job();
  expect(await q.queuePosition(first.id)).toBe(0);
  expect(await q.queuePosition(second.id)).toBe(1);
  expect((await q.claimNextTranscript()).id).toBe(first.id);
});

test('segments survive the round trip, and the upload path is cleared once done', async () => {
  const a = await job();
  await q.claimNextTranscript();
  const segments = [{ start: 0, end: 2.5, text: 'And so, my fellow Americans, “ask not”' }];
  await q.finishTranscript({ id: a.id, segments, transcribedSec: 42, ms: 900 });
  const row = await q.getTranscript(a.id);
  expect(row.status).toBe('done');
  expect(row.segments).toEqual(segments);
  expect(row.upload_path).toBeNull();
  expect(row.work_ms).toBe(900);
});

test('a job left running by a dead container goes back in the queue', async () => {
  await job();
  await q.claimNextTranscript();
  expect(await q.requeueStale()).toBe(1);
  expect((await q.claimNextTranscript())?.status).toBe('running');
});

test('a failure records why and drops the upload path', async () => {
  const a = await job();
  await q.failTranscript({ id: a.id, error: 'ffmpeg exited 1' });
  const row = await q.getTranscript(a.id);
  expect(row.status).toBe('failed');
  expect(row.error).toBe('ffmpeg exited 1');
  expect(row.upload_path).toBeNull();
});

test('an expired transcript is gone, and the purge removes it', async () => {
  const a = await job({ expiresAt: new Date(Date.now() - 1000) });
  expect(await q.getTranscript(a.id)).toBeNull();
  expect(await q.getTranscript('not-a-uuid')).toBeNull();
  const purged = await q.purgeExpiredTranscripts();
  expect(purged.map((r) => r.id)).toEqual([a.id]);
});
