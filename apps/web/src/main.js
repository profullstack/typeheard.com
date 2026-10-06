import { mkdir, unlink } from 'node:fs/promises';
import { assertCoinpayMerchantKey, config } from '@typeheard/config';
import { close as closeDb, healthcheck, sql } from '@typeheard/db';
import { migrate } from '@typeheard/db/migrate';
import * as q from '@typeheard/db/queries';
import { configurePayments } from '@typeheard/payments';
import { app } from './app.js';
import { startWorker, stopWorker } from './lib/worker.js';

/*
 * Hand the payments package its database handle and settings.
 *
 * It imports nothing from this brand -- that is what lets the same file live in every
 * sibling unchanged -- so it has to be given `sql` and the CoinPay block once, here,
 * before anything can take money. The coinpay object is passed WHOLE rather than
 * unpacked: its keys are getters that read the environment on every access, and
 * snapshotting them is the bug their comment in config warns about.
 */
configurePayments({ sql, coinpay: config.coinpay, siteUrl: config.siteUrl });

// Fail at boot rather than at checkout if the CoinPay credential is the wrong family.
assertCoinpayMerchantKey();

/**
 * Turn an infrastructure failure into a sentence someone can act on.
 *
 * A container that cannot reach Postgres dies with ERR_POSTGRES_CONNECTION_CLOSED and
 * a stack trace inside Bun's driver, which is indistinguishable from a bug in this app
 * when the actual cause is a variable nobody set on the service.
 */
async function preflight(what, fn) {
  try {
    return await fn();
  } catch (err) {
    let host = 'unparseable';
    try {
      // Host only -- a connection string carries the password.
      host = new URL(config.databaseUrl).host;
    } catch {}
    console.error(
      `[boot] cannot reach ${what} at ${host}: ${err?.message ?? err}\n` +
        "[boot] check DATABASE_URL in this deployment's app.env.",
    );
    throw err;
  }
}

// Migrations apply themselves; an advisory lock inside makes that safe when more than
// one container boots at the same moment.
await preflight('postgres', () => migrate());
if (!(await healthcheck())) throw new Error('database healthcheck failed at boot');

// Uploads wait here for their turn and are deleted the moment the words are out.
await mkdir(config.dataDir, { recursive: true });

/*
 * Delete transcripts that have passed their date.
 *
 * The read path already refuses an expired id, so this is about not keeping other
 * people's interviews rather than about correctness. Idempotent and indexed, so
 * every instance running it is harmless.
 */
async function purge() {
  try {
    const rows = await q.purgeExpiredTranscripts();
    for (const row of rows) if (row.upload_path) await unlink(row.upload_path).catch(() => {});
    if (rows.length) console.log(`[purge] removed ${rows.length} expired transcript(s)`);
  } catch (err) {
    // Never fatal: failing to tidy up must not take the site down.
    console.warn(`[purge] failed: ${err?.message ?? err}`);
  }
}
await purge();
const purgeTimer = setInterval(purge, config.retention.purgeIntervalMinutes * 60_000);

// Jobs queued before a restart are picked up again here.
await startWorker();

// The port comes from the environment; the dev2 compose file maps it behind nginx.
const server = Bun.serve({
  port: config.port,
  fetch: app.fetch,
  idleTimeout: 255,
  maxRequestBodySize: config.uploads.maxBytes + 1024 * 1024,
});
console.log(
  `[web] listening on :${server.port}, ${config.whisper.concurrency} transcription(s) at a time`,
);
console.log(
  `[web] site ${config.siteUrl} · payments ${config.coinpay.enabled ? 'on' : 'off'} · x402 ${config.x402.enabled ? 'on' : 'off'}`,
);

async function shutdown(signal) {
  console.log(`[main] ${signal}, draining`);
  clearInterval(purgeTimer);
  await Promise.allSettled([server.stop(true)]);
  stopWorker();
  await closeDb();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
