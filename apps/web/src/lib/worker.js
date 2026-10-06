/**
 * The queue runner.
 *
 * Jobs live in the `transcripts` table, so this is a loop that claims the oldest
 * queued row, transcribes the file it points at, and writes the words back. It
 * wakes on a nudge from the upload route and on a slow timer, so a job queued by
 * another instance, or left behind by a restart, is still picked up.
 *
 * A failure refunds what the job was charged. Minutes are spent at upload, before
 * the work, because that is the only ordering that stops two uploads spending the
 * same last minutes; the cost of that ordering is that a failure must give them back.
 */
import { unlink } from 'node:fs/promises';
import { config } from '@typeheard/config';
import * as q from '@typeheard/db/queries';
import { transcribeFile } from '@typeheard/transcribe';

let running = 0;
let stopped = false;
let timer = null;

async function work(row) {
  try {
    const result = await transcribeFile({
      path: row.upload_path,
      maxSeconds: row.tier === 'preview' ? config.pricing.previewSeconds : 0,
      language: row.language,
      durationSec: row.duration_sec,
      ...(config.whisper.model ? { model: config.whisper.model } : {}),
    });
    await q.finishTranscript({
      id: row.id,
      segments: result.segments,
      transcribedSec: result.transcribedSec,
      ms: result.ms,
    });
    console.log(
      `[worker] ${row.id} done: ${Math.round(result.transcribedSec)}s of audio in ${result.ms}ms`,
    );
  } catch (err) {
    const message = String(err?.message ?? err);
    console.error(`[worker] ${row.id} failed: ${message}`);
    await q.failTranscript({ id: row.id, error: message.split('\n')[0] }).catch(() => {});
    if (row.user_id && row.minutes_charged > 0) {
      await q
        .refundCredits({
          userId: row.user_id,
          credits: row.minutes_charged,
          reason: 'transcription failed',
        })
        .catch((refundErr) =>
          // Loud: the customer paid for work that did not happen and the repair failed too.
          console.error(
            `[worker] REFUND FAILED for ${row.user_id}: ${refundErr?.message ?? refundErr}`,
          ),
        );
    }
  } finally {
    if (row.upload_path) await unlink(row.upload_path).catch(() => {});
  }
}

/** Start as many jobs as there is room for. Safe to call as often as you like. */
export async function pump() {
  if (stopped) return;
  while (running < config.whisper.concurrency) {
    const row = await q.claimNextTranscript().catch((err) => {
      console.error(`[worker] claim failed: ${err?.message ?? err}`);
      return null;
    });
    if (!row) return;
    running += 1;
    work(row).finally(() => {
      running -= 1;
      pump();
    });
  }
}

export async function startWorker() {
  const stale = await q.requeueStale();
  if (stale) console.log(`[worker] requeued ${stale} job(s) left running by the last container`);
  timer = setInterval(pump, 15_000);
  await pump();
}

export function stopWorker() {
  stopped = true;
  if (timer) clearInterval(timer);
}

export const busy = () => running;
