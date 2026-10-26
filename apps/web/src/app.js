import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createProfileStore,
  mountProfileRoutes,
  saveSignupProfile,
  validateProfile,
} from '@profullstack/profile';
import { throttle } from '@profullstack/throttle/hono';
import { createGateway } from '@profullstack/x402-gateway';
import { x402Gateway } from '@profullstack/x402-gateway/hono';
import * as auth from '@typeheard/auth';
import { config } from '@typeheard/config';
import { sql } from '@typeheard/db';
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
import { getCookie, setCookie } from 'hono/cookie';
import {
  acceptInvite,
  attributeRef,
  canonicalInvite,
  cleanRef,
  createInvite,
  INVITE_COOKIE,
  inviteBonusMinutes,
  inviteSummary,
  originFor,
  REF_COOKIE,
  redeemCode,
} from './lib/credits.js';
import { OPEN_PATHS, UNMETERED_PATHS } from './lib/open-paths.js';
import { decideTier } from './lib/tier.js';
import { pump } from './lib/worker.js';
import { refreshFooter } from './views/footer.js';
import {
  Account,
  Docs,
  Gone,
  History,
  Invites,
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
 * The crawl door: the fleet's day pass ($1 a day over x402, or any coin / PayPal through
 * CoinPay's hosted checkout on /crawl) for AI training crawlers, headless browsers and
 * SEO scrapers. People, verified Googlebot/Bingbot and the AI chat/search fetchers pass
 * through untouched; a signed-in session is never charged.
 *
 * Separate from the transcription gateway above, which prices agent minutes for the throttle.
 */
export const crawlGateway =
  config.x402.scopedKey && config.x402.payTo
    ? createGateway({
        siteUrl: config.siteUrl,
        siteName: 'typeheard',
        coinpay: { apiKey: config.x402.scopedKey, baseUrl: config.coinpay.baseUrl },
        payTo: config.x402.payTo,
        // Its own pass secret: a crawl pass reads pages, it does not buy transcription.
        secret: `${config.x402.scopedKey}:crawl`,
        contact: 'mailto:anthony@profullstack.com',
        openPaths: [...OPEN_PATHS, ...UNMETERED_PATHS],
        exempt: (request) =>
          Boolean(request.headers.get('cookie')?.includes(config.session.cookie)),
      })
    : null;
if (crawlGateway) app.use('*', x402Gateway(crawlGateway));

/** A transcription pass this site minted (or a Power Key), not merely a header naming one. */
export async function hasAgentPass(request) {
  const token = gateway?.passFrom(request);
  return Boolean(token && (await gateway.verifyPass(token).catch(() => false)));
}

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

// The pit.world network footer refreshes at most hourly; only the first fetch is
// awaited, so the synchronous page templates always have the last good copy.
app.use('*', async (c, next) => {
  if (c.req.method === 'GET') await refreshFooter();
  await next();
});

const html = (c, body, status = 200) => c.html(body, status);

/** 30 days, the life of an invite: long enough to read the mail and come back. */
const CODE_COOKIE_SECONDS = 30 * 86_400;
const codeCookie = (c, name, value) =>
  setCookie(c, name, value, {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    secure: config.isProd,
    maxAge: CODE_COOKIE_SECONDS,
  });

/*
 * ?ref=<affiliate code> on any page: first touch wins, so a cookie already set is kept.
 * The cookie is @profullstack/referrals' `referral_code`, so one sign-up can never be
 * counted under two names. It is read when the emailed link is requested and recorded
 * only if that link creates the account.
 */
app.use('*', async (c, next) => {
  if (c.req.method === 'GET') {
    const ref = cleanRef(c.req.query('ref'));
    if (ref && !getCookie(c, REF_COOKIE)) codeCookie(c, REF_COOKIE, ref);
  }
  await next();
});

const origin = (c) => originFor(config.siteUrl, c.req.url);

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
  '.sh': 'text/x-shellscript; charset=utf-8',
};
const asset = (path) => async (c) => {
  const file = Bun.file(join(PUBLIC_DIR, path));
  if (!(await file.exists())) return c.notFound();
  c.header('content-type', ASSET_TYPES[extname(path)] ?? 'application/octet-stream');
  c.header('cache-control', 'public, max-age=86400');
  return c.body(await file.arrayBuffer());
};
// install.sh is the CLI installer: curl -fsSL https://typeheard.com/install.sh | sh
for (const name of [
  'favicon.ico',
  'favicon.svg',
  'logo.svg',
  'manifest.webmanifest',
  'install.sh',
]) {
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
  const [balance, ledger, passkeys, contact] = await Promise.all([
    q.creditBalance(user.id),
    q.creditHistory(user.id),
    q.listPasskeys(user.id),
    profiles.get(user.id),
  ]);
  return html(
    c,
    Account({
      user,
      balance,
      ledger,
      passkeys,
      config,
      contact: contact ?? { email: user.email },
      contactError: c.req.query('contact_error') ?? null,
      contactSaved: c.req.query('contact') === 'saved',
      redeemError: c.req.query('redeem_error') ?? null,
      redeemed: Number(c.req.query('redeemed')) || 0,
      invited: Number(c.req.query('invited')) || 0,
    }),
  );
});

/* ------------------------------------------------- credit codes + invites -- */

/** "Have a code?" on the account page: a plain form, so it works without script. */
app.post('/account/redeem', async (c) => {
  const { user, via } = await caller(c);
  if (!user || via !== 'session') return c.redirect('/signin');
  const form = await c.req.parseBody();
  const r = await redeemCode(user.id, String(form.code ?? ''));
  return c.redirect(
    r.ok
      ? `/account?redeemed=${r.minutes}#code`
      : `/account?redeem_error=${encodeURIComponent(r.message)}#code`,
  );
});

/** The same for the CLI, the MCP server and anything holding an API key. */
app.post('/api/v1/credits/redeem', async (c) => {
  const { user } = await caller(c);
  if (!user) return c.json({ error: 'sign in or send an API key' }, 401);
  const type = c.req.header('content-type') ?? '';
  const body = type.includes('json')
    ? await c.req.json().catch(() => ({}))
    : await c.req.parseBody().catch(() => ({}));
  const r = await redeemCode(user.id, String(body?.code ?? ''));
  if (!r.ok)
    return c.json({ error: r.message, reason: r.reason }, r.reason === 'invalid' ? 404 : 409);
  return c.json({ ok: true, added_minutes: r.minutes, minutes: r.balance });
});

app.get('/invites', async (c) => {
  const { user, via } = await caller(c);
  if (!user || via !== 'session') return c.redirect('/signin');
  return html(c, Invites({ user, config, summary: await inviteSummary(user.id, origin(c)) }));
});

app.post('/invites', async (c) => {
  const { user, via } = await caller(c);
  if (!user || via !== 'session') return c.redirect('/signin');
  const form = await c.req.parseBody();
  const made = await createInvite(user.id, form.note, origin(c));
  const summary = await inviteSummary(user.id, origin(c));
  return html(
    c,
    Invites({
      user,
      config,
      summary,
      created: made.ok ? made : null,
      error: made.ok ? null : 'You have used all your invites.',
    }),
    made.ok ? 200 : 409,
  );
});

app.get('/api/v1/invites', async (c) => {
  const { user } = await caller(c);
  if (!user) return c.json({ error: 'sign in or send an API key' }, 401);
  return c.json(await inviteSummary(user.id, origin(c)));
});

app.post('/api/v1/invites', async (c) => {
  const { user } = await caller(c);
  if (!user) return c.json({ error: 'sign in or send an API key' }, 401);
  const body = await c.req.json().catch(() => ({}));
  const made = await createInvite(user.id, body?.note, origin(c));
  if (!made.ok) return c.json({ error: 'no invites left', reason: made.reason }, 409);
  return c.json(
    { code: made.code, url: made.url, invite: made.invite, quota: made.quota, shown_once: true },
    201,
  );
});

/**
 * An invite link. Visiting it spends nothing: the code waits in a cookie (and rides the
 * emailed link) until an account is actually made. Never metered or sold (open-paths.js),
 * so a link preview or a friend on a shared IP never meets a 402.
 */
app.get('/i/:code', async (c) => {
  const code = canonicalInvite(c.req.param('code'));
  const { user } = await caller(c);
  c.header('x-robots-tag', 'noindex, nofollow');
  if (!code) {
    return html(
      c,
      SignIn({
        config,
        signup: true,
        error: 'That invite link is not valid. You can still sign up.',
      }),
      404,
    );
  }
  if (user) return c.redirect('/invites');
  codeCookie(c, INVITE_COOKIE, code);
  return html(c, SignIn({ config, signup: true, invite: code, bonus: inviteBonusMinutes() }));
});

/*
 * The shared Profullstack profile (@profullstack/profile): email, names, company
 * domain, job title and LinkedIn, in user_profiles. GET/PUT/PATCH /api/v1/me/profile
 * are the package's own handlers; the account form below is the same validation for
 * a page without script.
 */
const profiles = createProfileStore(sql);
mountProfileRoutes(app, {
  store: profiles,
  getUser: async (_req, c) => {
    const { user } = await caller(c);
    return user ? { id: user.id, email: user.email } : null;
  },
});

app.post('/account/contact', async (c) => {
  const { user } = await caller(c);
  if (!user) return c.redirect('/signin');
  const form = await c.req.parseBody();
  const check = validateProfile({ ...form, email: user.email });
  if (!check.ok) {
    const first = Object.values(check.errors)[0];
    return c.redirect(`/account?contact_error=${encodeURIComponent(first)}#contact`);
  }
  await profiles.save(user.id, check.profile);
  return c.redirect('/account?contact=saved#contact');
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

  /*
   * The signup page carries the shared profile fields; plain sign-in does not and is
   * never asked for them. They are checked before any link exists, and a refusal goes
   * back to the form with what was typed -- the same answer for a known or unknown
   * address.
   */
  let profile = null;
  if (form.mode === 'signup') {
    const check = validateProfile(form);
    if (!check.ok) {
      return html(c, SignIn({ config, signup: true, values: form, errors: check.errors }), 400);
    }
    profile = check.profile;
  }

  const email = String(form.email ?? '').trim();
  /*
   * Answer identically whatever happens next. A different response for a known
   * address turns this form into "does this person have an account here".
   */
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    try {
      const url = await auth.createLoginLink(email, {
        profile,
        inviteCode: canonicalInvite(form.invite) ?? canonicalInvite(getCookie(c, INVITE_COOKIE)),
        refCode: cleanRef(getCookie(c, REF_COOKIE)),
      });
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
  // The fields typed on the signup form, saved now that the account exists and the
  // link has proved the mailbox. A failure here must not cost anybody their sign-in:
  // the account page asks again.
  if (session.profile) {
    await saveSignupProfile(profiles, session.user.id, session.profile, {
      email: session.user.email,
    }).catch((err) => console.error(`[auth] signup profile save failed: ${err?.message ?? err}`));
  }
  /*
   * An invite or ?ref= code counts only when this link made the account: the address is
   * new and the click just proved it. Signing in to an existing account through an
   * invite spends nothing. A failure here must not cost anybody their sign-in.
   */
  let invited = 0;
  if (session.created && session.inviteCode) {
    const out = await acceptInvite(session.inviteCode, session.user).catch((err) => {
      console.error(`[invite] accept failed: ${err?.message ?? err}`);
      return null;
    });
    invited = out?.minutes ?? 0;
  }
  if (session.created && session.refCode) {
    await attributeRef(session.refCode, session.user.id).catch((err) =>
      console.error(`[ref] attribution failed: ${err?.message ?? err}`),
    );
  }
  c.header('set-cookie', auth.sessionCookie(session.sessionId));
  if (getCookie(c, INVITE_COOKIE)) setCookie(c, INVITE_COOKIE, '', { path: '/', maxAge: 0 });
  return c.redirect(invited ? `/account?invited=${invited}` : '/account');
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
  // A live x402 pass means this request is already paid for. Verified here, not just
  // seen: the throttle lets an under-limit request through whatever header it carries.
  const paidAgent = await hasAgentPass(c.req.raw);
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

  // No chain here: CoinPay's hosted checkout offers every coin the business holds a
  // wallet for, plus PayPal. A `chain` field from an old client is ignored.

  try {
    const { checkoutUrl, paymentRef } = await pay.createCheckout({
      user,
      email: user.email,
      accountId: String(user.id),
      amountCents: bundle.cents,
      description: `${bundle.credits} typeheard minutes`,
      metadata: { credits: String(bundle.credits) },
      successUrl: `${config.siteUrl}/account`,
      cancelUrl: `${config.siteUrl}/pricing`,
    });
    return c.json({ checkout_url: checkoutUrl, payment_ref: paymentRef });
  } catch (err) {
    const message = String(err?.message ?? err);
    console.error(`[topup] checkout failed for ${user.id}: ${message}`);
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
- CLI: curl -fsSL ${config.siteUrl}/install.sh | sh   then: typeheard <file>  (or npx -y @profullstack/typeheard <file>)
- Credit codes: POST ${config.siteUrl}/api/v1/credits/redeem {"code":"TH-..."} adds minutes to the account.
- Invites: GET/POST ${config.siteUrl}/api/v1/invites (3 single-use links per account; both sides get bonus minutes).
- MCP: npx -y @profullstack/typeheard-mcp
- Docs: ${config.siteUrl}/docs
`),
);

app.notFound((c) => html(c, NotFound({ config }), 404));
