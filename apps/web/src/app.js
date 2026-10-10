import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { throttle } from '@profullstack/throttle/hono';
import { createGateway } from '@profullstack/x402-gateway';
import * as auth from '@typeheard/auth';
import { config } from '@typeheard/config';
import * as q from '@typeheard/db/queries';
import { sendLoginLink, sendTopupReceipt } from '@typeheard/notify';
import * as pay from '@typeheard/payments';
import {
  billableMinutes,
  durationOf,
  FORMATS,
  render,
  TranscribeError,
} from '@typeheard/transcribe';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { OPEN_PATHS, UNMETERED_PATHS } from './lib/open-paths.js';
import { decideTier } from './lib/tier.js';
import { pump } from './lib/worker.js';
import {
  Account,
  Docs,
  Gone,
  History,
  Keys,
  Landing,
  NotFound,
  Pricing,
  Sent,
  SignIn,
  TranscriptPage,
} from './views/pages.js';

export const app = new Hono();

/* ------------------------------------------------------------------ callers -- */

/**
 * Who is asking: a browser session, an API key, or nobody.
 *
 * Nobody is a first-class answer. An anonymous caller gets a real transcript of the
 * first minutes without an account, which is the entire top of the funnel.
 */
async function caller(c) {
  const bearer = c.req.header('authorization');
  if (bearer) {
    const user = await auth.userFromApiKey(bearer);
    if (user) return { user, apiKeyId: user.api_key_id, via: 'api-key' };
  }
  const user = await auth.userFromRequest(getCookie(c, config.session.cookie));
  return user
    ? { user, apiKeyId: null, via: 'session' }
    : { user: null, apiKeyId: null, via: null };
}

/* -------------------------------------------------------------------- x402 -- */

/**
 * The agent door. Built only when configured: a gateway with no payee would offer
 * an empty address, and an agent that paid it would send USDC nowhere.
 */
const gateway = config.x402.enabled
  ? createGateway({
      siteUrl: config.siteUrl,
      siteName: 'typeheard',
      coinpay: { apiKey: config.x402.scopedKey, baseUrl: config.coinpay.baseUrl },
      payTo: config.x402.payTo,
      priceCents: config.x402.priceCents,
      currency: config.x402.currency,
      passMinutes: config.x402.passMinutes,
      // See lib/open-paths.js: '/' is a prefix that matches every path.
      openPaths: OPEN_PATHS,
    })
  : null;

/**
 * Meter requests, and sell a pass to whoever goes over. A signed-in person is
 * exempt: their minutes are the meter, and charging twice sells the same work twice.
 */
app.use(
  '*',
  throttle({
    gateway,
    limit: config.throttle.limit,
    windowSeconds: config.throttle.windowSeconds,
    openPaths: UNMETERED_PATHS,
    // API keys are not exempt: the prefix is public, so exempting on its shape would
    // let anyone skip the limit by sending a made-up key. A minute is plenty of polls.
    exempt: (request) => Boolean(request.headers.get('cookie')?.includes(config.session.cookie)),
  }),
);

/* ------------------------------------------------------------------- pages -- */

const html = (c, body, status = 200) => c.html(body, status);

app.get('/healthz', (c) => c.text('ok'));

/**
 * The logo, favicons and manifest, straight off disk. A short allowlist rather than a
 * static middleware: there are a dozen files, and nothing else in public/ should be
 * reachable by guessing a name.
 */
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const ASSET_TYPES = {
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};
const asset = (path) => async (c) => {
  const file = Bun.file(join(PUBLIC_DIR, path));
  if (!(await file.exists())) return c.notFound();
  c.header('content-type', ASSET_TYPES[extname(path)] ?? 'application/octet-stream');
  c.header('cache-control', 'public, max-age=86400');
  return c.body(await file.arrayBuffer());
};
for (const name of ['favicon.ico', 'favicon.svg', 'logo.svg', 'manifest.webmanifest']) {
  app.get(`/${name}`, asset(name));
}
app.get('/icons/:name', (c) => {
  const name = c.req.param('name');
  return /^[a-z0-9-]+\.png$/i.test(name) ? asset(`icons/${name}`)(c) : c.notFound();
});

app.get('/', async (c) => {
  const { user } = await caller(c);
  const balance = user ? await q.creditBalance(user.id) : null;
  return html(c, Landing({ config, user, balance }));
});
app.get('/pricing', (c) => html(c, Pricing({ config })));
app.get('/docs', (c) => html(c, Docs({ config })));
app.get('/signin', (c) => html(c, SignIn({ config })));
app.get('/signup', (c) => html(c, SignIn({ config, signup: true })));

app.get('/account', async (c) => {
  const { user } = await caller(c);
  if (!user) return c.redirect('/signin');
  const [balance, ledger, passkeys] = await Promise.all([
    q.creditBalance(user.id),
    q.creditHistory(user.id),
    q.listPasskeys(user.id),
  ]);
  return html(c, Account({ user, balance, ledger, passkeys, config }));
});

app.get('/account/history', async (c) => {
  const { user } = await caller(c);
  if (!user) return c.redirect('/signin');
  const rows = await q.transcriptHistory(user.id);
  return html(c, History({ user, rows, config }));
});

app.get('/account/keys', async (c) => {
  const { user } = await caller(c);
  if (!user) return c.redirect('/signin');
  const keys = await q.listApiKeys(user.id);
  return html(c, Keys({ user, keys, config }));
});

/* -------------------------------------------------------------------- auth -- */

app.post('/auth/link', async (c) => {
  const form = await c.req.parseBody();
  const email = String(form.email ?? '').trim();
  /*
   * Answer identically whatever happens next. A different response for a known
   * address turns this form into "does this person have an account here".
   */
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    try {
      const url = await auth.createLoginLink(email);
      if (config.mail.enabled) await sendLoginLink({ email, url });
      else console.log(`[auth] mail disabled; link for ${email}: ${url}`);
    } catch (err) {
      console.error(`[auth] could not send link: ${err?.message ?? err}`);
    }
  }
  return html(c, Sent({ email, config }));
});

app.get('/auth/magic', async (c) => {
  const token = c.req.query('t');
  const session = token
    ? await auth.consumeLoginLink(token, { userAgent: c.req.header('user-agent') })
    : null;
  if (!session)
    return html(c, SignIn({ config, error: 'That link has expired or was already used.' }), 400);
  c.header('set-cookie', auth.sessionCookie(session.sessionId));
  return c.redirect('/account');
});

app.post('/auth/signout', async (c) => {
  const sid = getCookie(c, config.session.cookie);
  if (sid) await q.endSession(sid);
  c.header('set-cookie', auth.sessionCookie('', { clear: true }));
  return c.redirect('/');
});

/**
 * Passkeys.
 *
 * The challenge is kept server-side for five minutes under a random id that the
 * browser carries in a short-lived cookie. A challenge the browser held itself
 * could be chosen by the browser, which is the one thing a challenge must not be.
 */
const challenges = new Map();
const CHALLENGE_COOKIE = 'th_challenge';
const keepChallenge = (c, challenge) => {
  const id = randomUUID();
  challenges.set(id, { challenge, at: Date.now() });
  for (const [key, value] of challenges)
    if (Date.now() - value.at > 300_000) challenges.delete(key);
  c.header(
    'set-cookie',
    `${CHALLENGE_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=300${config.isProd ? '; Secure' : ''}`,
  );
};
const takeChallenge = (c) => {
  const id = getCookie(c, CHALLENGE_COOKIE);
  const entry = id ? challenges.get(id) : null;
  if (id) challenges.delete(id);
  return entry && Date.now() - entry.at <= 300_000 ? entry.challenge : null;
};

app.post('/auth/passkey/register/options', async (c) => {
  const { user, via } = await caller(c);
  if (!user || via !== 'session')
    return c.json({ error: 'sign in with the emailed link first' }, 401);
  const options = await auth.passkeyRegistrationOptions(user);
  keepChallenge(c, options.challenge);
  return c.json(options);
});

app.post('/auth/passkey/register', async (c) => {
  const { user, via } = await caller(c);
  if (!user || via !== 'session') return c.json({ error: 'sign in first' }, 401);
  const expectedChallenge = takeChallenge(c);
  if (!expectedChallenge) return c.json({ error: 'that took too long; try again' }, 400);
  try {
    await auth.verifyPasskeyRegistration({ user, response: await c.req.json(), expectedChallenge });
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: String(err?.message ?? err).slice(0, 200) }, 400);
  }
});

app.post('/auth/passkey/options', async (c) => {
  const options = await auth.passkeyAuthenticationOptions();
  keepChallenge(c, options.challenge);
  return c.json(options);
});

app.post('/auth/passkey', async (c) => {
  const expectedChallenge = takeChallenge(c);
  if (!expectedChallenge) return c.json({ error: 'that took too long; try again' }, 400);
  try {
    const session = await auth.verifyPasskeyAuthentication({
      response: await c.req.json(),
      expectedChallenge,
      userAgent: c.req.header('user-agent'),
    });
    if (!session) return c.json({ error: 'that passkey is not recognised here' }, 401);
    c.header('set-cookie', auth.sessionCookie(session.sessionId));
    return c.json({ ok: true, next: '/account' });
  } catch (err) {
    return c.json({ error: String(err?.message ?? err).slice(0, 200) }, 400);
  }
});

app.post('/account/keys', async (c) => {
  const { user } = await caller(c);
  if (!user) return c.json({ error: 'sign in first' }, 401);
  const key = await auth.createApiKey({ userId: user.id, name: 'default' });
  // The plaintext exists in exactly one response, ever.
  return c.json({ key: key.plaintext, prefix: key.prefix, shown_once: true });
});

/* ------------------------------------------------------------- transcribing -- */

const LANGUAGE = /^(auto|[a-z]{2,3})$/;

/** The JSON a client polls. Words are only included once there are some. */
function transcriptView(row, { position } = {}) {
  const base = `${config.siteUrl}/api/v1/transcripts/${row.id}`;
  return {
    id: row.id,
    status: row.status,
    tier: row.tier,
    filename: row.filename,
    title: row.title,
    language: row.language,
    duration_sec: row.duration_sec,
    transcribed_sec: row.transcribed_sec,
    minutes_charged: row.minutes_charged,
    ...(position !== undefined ? { queue_position: position } : {}),
    error: row.error ?? undefined,
    created_at: row.created_at,
    finished_at: row.finished_at,
    expires_at: row.expires_at,
    url: `${config.siteUrl}/t/${row.id}`,
    status_url: base,
    ...(row.status === 'done'
      ? {
          text: render('txt', { segments: row.segments ?? [] }).trim(),
          downloads: Object.fromEntries(Object.keys(FORMATS).map((f) => [f, `${base}/${f}`])),
        }
      : {}),
  };
}

/**
 * The whole product.
 *
 *   an agent holding an x402 pass  -> the whole file, paid per call (up to an hour)
 *   an account with the minutes    -> the whole file, minutes spent atomically
 *   anyone at all                  -> the first few minutes, free
 *
 * Returns 202 with the job; the client polls `status_url` or opens `url`.
 */
app.post('/api/v1/transcripts', async (c) => {
  const body = await c.req.parseBody();
  const file = body.file;
  if (!file || typeof file === 'string')
    return c.json({ error: 'attach a recording as `file`' }, 400);
  if (file.size > config.uploads.maxBytes) {
    return c.json(
      { error: `that file is over ${Math.round(config.uploads.maxBytes / 1048576)} MB` },
      413,
    );
  }
  const language = String(body.language ?? 'auto').toLowerCase();
  if (!LANGUAGE.test(language))
    return c.json({ error: 'language is an ISO code like en, es, de, or auto' }, 400);
  const asked = ['preview', 'full'].includes(String(body.tier)) ? String(body.tier) : 'auto';
  const filename = String(file.name || 'recording').slice(0, 200);
  const title =
    String(body.title ?? '')
      .trim()
      .slice(0, 200) || filename.replace(/\.[^.]+$/, '');

  const uploadPath = join(
    config.dataDir,
    `${randomUUID()}${extname(filename).slice(0, 10) || '.bin'}`,
  );
  await Bun.write(uploadPath, file);

  let durationSec;
  try {
    durationSec = await durationOf(uploadPath);
  } catch (err) {
    await unlink(uploadPath).catch(() => {});
    return c.json({ error: err.message }, err instanceof TranscribeError ? err.status : 422);
  }
  const minutes = billableMinutes(durationSec);
  if (minutes > config.uploads.maxMinutes) {
    await unlink(uploadPath).catch(() => {});
    return c.json(
      { error: `recordings up to ${config.uploads.maxMinutes} minutes; this one is ${minutes}` },
      413,
    );
  }

  const { user, apiKeyId } = await caller(c);
  // A live x402 pass means this request is already paid for. The gateway put it there.
  const paidAgent = Boolean(c.req.header('x-crawl-pass') || c.req.header('x-payment'));
  const wholeFileFree = config.pricing.freeForAll || durationSec <= config.pricing.previewSeconds;

  let spend = null;
  if (asked !== 'preview' && !paidAgent && user && !wholeFileFree) {
    spend = await q.spendCredits({ userId: user.id, cost: minutes, reason: 'transcription' });
  }

  const { tier, refuse } = decideTier({
    asked,
    paidAgent,
    hasUser: Boolean(user),
    canSpend: Boolean(spend),
    minutes,
    previewSeconds: config.pricing.previewSeconds,
    agentMaxMinutes: config.x402.maxMinutes,
    freeForAll: config.pricing.freeForAll,
  });

  if (refuse) {
    await unlink(uploadPath).catch(() => {});
    if (spend)
      await q
        .refundCredits({ userId: user.id, credits: spend.spent, reason: 'refused' })
        .catch(() => {});
    return c.json(
      {
        error: refuse.reason,
        minutes,
        topup: `${config.siteUrl}/pricing`,
        docs: `${config.siteUrl}/docs`,
      },
      refuse.status,
    );
  }

  const days = user ? config.retention.accountDays : config.retention.anonDays;
  try {
    const row = await q.createTranscript({
      userId: user?.id ?? null,
      apiKeyId,
      tier,
      filename,
      title,
      language,
      durationSec,
      minutesCharged: spend ? spend.spent : 0,
      uploadPath,
      bytesIn: file.size ?? null,
      payer: paidAgent ? (c.req.header('x-payer') ?? 'x402') : null,
      expiresAt: new Date(Date.now() + days * 86_400_000),
    });
    pump();
    const full = {
      ...row,
      tier,
      filename,
      title,
      language,
      duration_sec: durationSec,
      minutes_charged: spend?.spent ?? 0,
    };
    if (spend) c.header('x-minutes-remaining', String(spend.remaining));
    return c.json(
      {
        ...transcriptView(full, { position: await q.queuePosition(row.id) }),
        ...(tier === 'preview'
          ? { preview_seconds: config.pricing.previewSeconds, full_minutes: minutes }
          : {}),
      },
      202,
    );
  } catch (err) {
    await unlink(uploadPath).catch(() => {});
    if (spend)
      await q
        .refundCredits({ userId: user.id, credits: spend.spent, reason: 'not queued' })
        .catch(() => {});
    console.error(`[upload] ${err?.message ?? err}`);
    return c.json({ error: 'could not queue that; nothing was charged' }, 500);
  }
});

app.get('/api/v1/transcripts', async (c) => {
  const { user } = await caller(c);
  if (!user) return c.json({ error: 'sign in or send an API key' }, 401);
  const rows = await q.transcriptHistory(user.id);
  return c.json({ transcripts: rows.map((row) => transcriptView(row)) });
});

app.get('/api/v1/transcripts/:id', async (c) => {
  const row = await q.getTranscript(c.req.param('id'));
  if (!row) return c.json({ error: 'no such transcript, or it has expired' }, 404);
  c.header('x-robots-tag', 'noindex, nofollow');
  const position = row.status === 'queued' ? await q.queuePosition(row.id) : undefined;
  return c.json(transcriptView(row, { position }));
});

app.get('/api/v1/transcripts/:id/:format', async (c) => {
  const format = c.req.param('format');
  if (!FORMATS[format])
    return c.json({ error: `format is one of ${Object.keys(FORMATS).join(', ')}` }, 400);
  const row = await q.getTranscript(c.req.param('id'));
  if (!row) return c.json({ error: 'no such transcript, or it has expired' }, 404);
  if (row.status !== 'done') return c.json({ error: `not ready: ${row.status}` }, 409);
  const name = (row.title || 'transcript').replace(/[^\w.-]+/g, '_').slice(0, 80);
  c.header('content-type', FORMATS[format].type);
  c.header('x-robots-tag', 'noindex, nofollow');
  if (c.req.query('download') !== undefined)
    c.header('content-disposition', `attachment; filename="${name}.${FORMATS[format].ext}"`);
  return c.body(
    render(format, {
      segments: row.segments ?? [],
      title: row.title,
      durationSec: row.duration_sec,
      transcribedSec: row.transcribed_sec,
    }),
  );
});

app.delete('/api/v1/transcripts/:id', async (c) => {
  const { user } = await caller(c);
  if (!user) return c.json({ error: 'sign in first' }, 401);
  const out = await q.deleteTranscript({ id: c.req.param('id'), userId: user.id });
  if (out.uploadPath) await unlink(out.uploadPath).catch(() => {});
  return c.json({ deleted: out.deleted });
});

app.get('/api/v1/me', async (c) => {
  const { user } = await caller(c);
  if (!user) return c.json({ error: 'sign in or send an API key' }, 401);
  return c.json({ email: user.email, minutes: await q.creditBalance(user.id) });
});

/** The transcript page. The id is the capability, so it is never indexed. */
app.get('/t/:id', async (c) => {
  const row = await q.getTranscript(c.req.param('id'));
  if (!row) return html(c, Gone({ config }), 404);
  c.header('x-robots-tag', 'noindex, nofollow');
  const { user } = await caller(c);
  return html(
    c,
    TranscriptPage({
      row,
      view: transcriptView(row),
      config,
      mine: Boolean(user && user.id === row.user_id),
    }),
  );
});

/* ------------------------------------------------------------------- money -- */

app.post('/api/topup', async (c) => {
  const { user } = await caller(c);
  if (!user) return c.json({ error: 'sign in first' }, 401);
  if (!pay.paymentsEnabled()) return c.json({ error: 'payments are not configured' }, 503);

  const body = await c.req.parseBody();
  const cents = Number(body.cents ?? 0);
  const bundle = config.pricing.topups.find((t) => t.cents === cents);
  // Only the published bundles: an arbitrary amount lets a caller name its own price.
  if (!bundle) return c.json({ error: 'pick one of the published bundles' }, 400);

  const chain = String(body.chain ?? config.coinpay.defaultChain).toUpperCase();
  if (!config.coinpay.chains.includes(chain)) {
    return c.json({ error: `unsupported chain ${chain}`, chains: config.coinpay.chains }, 400);
  }

  try {
    const { checkoutUrl, paymentRef } = await pay.createCheckout({
      user,
      amountCents: bundle.cents,
      description: `${bundle.credits} typeheard minutes`,
      metadata: { credits: String(bundle.credits) },
      blockchain: chain,
      successUrl: `${config.siteUrl}/account`,
      cancelUrl: `${config.siteUrl}/pricing`,
    });
    return c.json({ checkout_url: checkoutUrl, payment_ref: paymentRef });
  } catch (err) {
    const message = String(err?.message ?? err);
    console.error(`[topup] checkout failed for ${user.id} on ${chain}: ${message}`);
    return c.json({ error: 'could not start checkout', detail: message.slice(0, 200) }, 502);
  }
});

/**
 * CoinPay calls this when money moves. The raw body is what the signature covers;
 * re-serialising parsed JSON changes key order and reads as a forgery.
 */
app.post('/webhooks/coinpay', async (c) => {
  const raw = await c.req.text();
  const ok = pay.verifyWebhook({
    rawBody: raw,
    signatureHeader: c.req.header('x-coinpay-signature') ?? c.req.header('coinpay-signature'),
  });
  if (!ok) return c.json({ error: 'bad signature' }, 401);

  const payload = JSON.parse(raw);
  let receipt = null;

  const result = await pay.settleWebhook(payload, {
    async grant(tx, { meta, payment }) {
      // How many minutes, decided from what WE charged, never from the payload.
      const bundle = config.pricing.topups.find((t) => t.cents === payment.amount_cents);
      const credits = bundle?.credits ?? Number(meta.credits ?? 0);
      if (!credits) return null;
      const granted = await q.grantCredits(tx, {
        userId: meta.user_id,
        credits,
        paymentId: payment.id,
        reason: 'topup',
      });
      if (granted.granted)
        receipt = { userId: meta.user_id, credits, amountCents: payment.amount_cents };
      return granted.granted || { alreadyGranted: true };
    },
  });

  if (receipt) {
    const { userId, ...details } = receipt;
    const email = await q.userEmail(userId);
    if (email && config.mail.enabled) {
      sendTopupReceipt({ email, ...details }).catch((err) =>
        console.error(`[mail] receipt not sent: ${err?.message ?? err}`),
      );
    }
  }
  // 2xx even when nothing was granted, or CoinPay retries forever.
  return c.json({ ok: true, ...result });
});

/* -------------------------------------------------------------- boilerplate -- */

app.get('/robots.txt', (c) =>
  c.text(
    [
      'User-agent: *',
      'Allow: /',
      'Disallow: /t/',
      'Disallow: /api/',
      '',
      `Sitemap: ${config.siteUrl}/sitemap.xml`,
      '',
    ].join('\n'),
  ),
);

app.get('/.well-known/openwebring.json', (c) =>
  c.json({
    openwebring: '0.1',
    site: { url: 'https://typeheard.com/', name: 'typeheard' },
    made_by: 'both',
    rings: [{ ring: 'https://rssamplifier.com/ring/profullstack', slug: 'typeheard-com' }],
  }),
);

app.get('/sitemap.xml', (c) => {
  const urls = ['/', '/pricing', '/docs', '/signup'];
  c.header('content-type', 'application/xml');
  return c.body(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
      .map((u) => `  <url><loc>${config.siteUrl}${u}</loc></url>`)
      .join('\n')}\n</urlset>\n`,
  );
});

/** For agents and LLMs: what this is and how to call it, in one fetch. */
app.get('/llms.txt', (c) =>
  c.text(`# typeheard

> Upload audio or video, get a transcript (txt, md, srt, vtt, json). whisper.cpp on our own hardware.

- POST ${config.siteUrl}/api/v1/transcripts  multipart: file, language (auto|en|es|...), tier (auto|preview|full), title
  -> 202 { id, status, status_url, url }
- GET  ${config.siteUrl}/api/v1/transcripts/{id}         poll until status is "done"
- GET  ${config.siteUrl}/api/v1/transcripts/{id}/{txt|md|srt|vtt|json}
- Free: the first ${Math.round(config.pricing.previewSeconds / 60)} minutes of any file, no key.
- Whole file: Authorization: Bearer <api key> (1 minute of credit per audio minute), or pay per call with x402.
- MCP: npx -y @profullstack/typeheard-mcp   CLI: npx -y @profullstack/typeheard <file>
- Docs: ${config.siteUrl}/docs
`),
);

app.notFound((c) => html(c, NotFound({ config }), 404));
