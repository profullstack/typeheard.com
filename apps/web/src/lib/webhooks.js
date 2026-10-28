/**
 * Customer webhooks: an account adds a URL and typeheard POSTs to it when one of its
 * transcripts is finished or has failed, so nobody has to poll `status_url`.
 *
 * Endpoints, signing secrets, the outbox and the delivery log are @profullstack/webhooks
 * (Standard Webhooks signatures, CloudEvents bodies, retries for about three days), kept
 * in this app's Postgres in the tables migration 0004 makes.
 *
 * The payload carries ids, status and links, never the words: a transcript can be an
 * hour of somebody's interview, and the receiver fetches it from `status_url` or one of
 * the `downloads` with the same capability the id already is.
 */

import { postgresStore, Webhooks } from '@profullstack/webhooks';
import { config } from '@typeheard/config';
import { sql } from '@typeheard/db';

/** What typeheard tells webhooks about. */
export const WEBHOOK_EVENTS = ['transcript.completed', 'transcript.failed'];

const FORMATS = ['txt', 'md', 'srt', 'vtt', 'json'];

/**
 * pg's `query(text, params) -> { rows }` over Bun.SQL, which is not a pg pool.
 *
 * `sql.unsafe(text, params)` takes the same `$1` placeholders and resolves to the rows
 * as an array, so the adapter only has to wrap them. The package sends numbers (unix
 * milliseconds), strings and null; Bun.SQL hands BIGINT back as a string, which the
 * store already reads with Number().
 */
export function pgAdapter(db) {
  return {
    async query(text, params = []) {
      const rows = await db.unsafe(text, params);
      return { rows: [...rows] };
    },
  };
}

/** A hub on this app's database. Tests pass `fetchImpl` and `guard`. */
export function makeHooks({ db = sql, ...options } = {}) {
  return new Webhooks({
    store: postgresStore(pgAdapter(db)),
    source: config.siteUrl,
    eventTypes: WEBHOOK_EVENTS,
    log: (m) => console.log(`[webhooks] ${m}`),
    ...options,
  });
}

/** The one hub for this process. `start()` is called once, in main.js. */
export const hooks = makeHooks();

/** Links to a transcript, never its text. */
export function transcriptLinks(id) {
  const base = `${config.siteUrl}/api/v1/transcripts/${id}`;
  return { url: `${config.siteUrl}/t/${id}`, status_url: base, base };
}

/**
 * The `data` of a transcript event. `row` is the claimed job (transcripts.*), `done` is
 * what the worker learned.
 */
export function transcriptEventData(row, done) {
  const { url, status_url, base } = transcriptLinks(row.id);
  const common = {
    id: row.id,
    status: done.status,
    tier: row.tier,
    title: row.title ?? null,
    filename: row.filename ?? null,
    language: done.language ?? row.language ?? null,
    duration_sec: row.duration_sec == null ? null : Number(row.duration_sec),
    minutes_charged: Number(row.minutes_charged ?? 0),
    created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
    finished_at: new Date(done.finishedAt ?? Date.now()).toISOString(),
    url,
    status_url,
  };
  if (done.status === 'done') {
    return {
      ...common,
      transcribed_sec: done.transcribedSec ?? null,
      downloads: Object.fromEntries(FORMATS.map((f) => [f, `${base}/${f}`])),
    };
  }
  return { ...common, error: done.error ?? null, minutes_refunded: done.refunded ?? 0 };
}

/**
 * Tell the account that submitted the job. Anonymous previews have nobody to tell.
 * Never throws: a webhook must not cost anybody their transcript.
 */
export async function notifyTranscript(row, done, hub = hooks) {
  if (!row?.user_id) return null;
  const type = done.status === 'done' ? 'transcript.completed' : 'transcript.failed';
  try {
    return await hub.emit(String(row.user_id), type, transcriptEventData(row, done), {
      subject: `transcript:${row.id}`,
    });
  } catch (err) {
    console.error(`[webhooks] ${type} for ${row.id} not queued: ${err?.message ?? err}`);
    return null;
  }
}
