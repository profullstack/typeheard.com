/**
 * One place that reads the environment, so no other module ever touches process.env.
 *
 * Everything required is read once at import and throws here, at boot, rather than at
 * the moment a customer presses pay. Secrets live in the logicsrc vault and reach the
 * container through the box's app.env; there is deliberately no .env loading in this file.
 */

/** @param {string} name @param {string} [fallback] */
function req(name, fallback) {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Missing required env var ${name}`);
  return v;
}

/** @param {string} name @param {string} [fallback] */
const opt = (name, fallback = '') => process.env[name] ?? fallback;

/** @param {string} name @param {number} fallback */
const num = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`env ${name} must be a number, got ${raw}`);
  return n;
};

/** @param {string} name @param {boolean} fallback */
const bool = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
};

export const config = {
  env: opt('NODE_ENV', 'development'),
  isProd: opt('NODE_ENV', 'development') === 'production',

  /** Railway injects PORT. Never hardcode it -- a fixed port makes every request 404
   *  behind the edge proxy while the container still reports healthy. */
  port: num('PORT', 3000),

  /** Public origin. The passkey rpID is derived from this, so changing it invalidates
   *  every credential already registered. */
  siteUrl: opt('SITE_URL', 'http://localhost:3000').replace(/\/$/, ''),

  /** No fallback, deliberately: a service deployed without DATABASE_URL otherwise
   *  dials localhost and dies with a Postgres driver error that names nothing. */
  databaseUrl: req('DATABASE_URL'),

  session: {
    cookie: opt('SESSION_COOKIE', 'typeheard_session'),
    ttlDays: num('SESSION_TTL_DAYS', 30),
  },

  mail: {
    get enabled() {
      return Boolean(process.env.RESEND_API_KEY);
    },
    get resendKey() {
      return process.env.RESEND_API_KEY ?? '';
    },
    from: opt('MAIL_FROM', 'typeheard <noreply@typeheard.com>'),
  },

  /**
   * The ear: whisper.cpp on this box, through @profullstack/media2markdown-core.
   *
   * One transcription at a time per core is the most whisper.cpp wants, and two
   * at once on a shared box just makes both slow; CONCURRENCY is how many jobs
   * the queue runs in parallel, not how many threads each gets.
   */
  whisper: {
    /** Absolute path to a ggml model. Empty lets media2markdown-core pick the one it finds. */
    model: opt('WHISPER_MODEL', ''),
    concurrency: num('CONCURRENCY', 1),
  },

  /** Where uploads wait for their turn. Deleted as soon as the words are out. */
  dataDir: opt('DATA_DIR', '/tmp/typeheard'),

  /** What an upload may be. Big enough for a long interview in video, not a film archive. */
  uploads: {
    maxBytes: num('MAX_UPLOAD_BYTES', 1024 * 1024 * 1024),
    maxMinutes: num('MAX_MINUTES', 240),
  },

  /**
   * What a minute costs, and what you get without paying.
   *
   * The free tier is capped by LENGTH rather than by a count: the first three
   * minutes of anything, as often as you like. That answers "is it any good on my
   * recording" without a signup wall, and still leaves the rest of the hour worth
   * paying for. One credit is one minute of audio, rounded up per file.
   */
  pricing: {
    /**
     * A private instance: every file in full, for anyone, with no account.
     * Explicit rather than inferred from "payments are off", because the public
     * site runs without CoinPay for a while too and must not become free then.
     */
    freeForAll: bool('FREE_FOR_ALL', false),
    previewSeconds: num('PREVIEW_SECONDS', 180),
    /** Top-up bundles, cents -> minutes. Credits never expire; that is the pitch against monthly plans. */
    topups: [
      { cents: 500, credits: 300 },
      { cents: 2000, credits: 1500 },
      { cents: 5000, credits: 4500 },
    ],
  },

  /**
   * CoinPay.
   *
   * These are GETTERS on purpose. The payments package is copied verbatim between
   * brands and reads this object on every access; snapshotting the values at import
   * made the effective key depend on which module imported config first, which turned
   * the webhook signature tests into a coin flip decided by the rest of the suite.
   */
  coinpay: {
    get enabled() {
      return Boolean(process.env.COINPAY_API_KEY && process.env.COINPAY_BUSINESS_ID);
    },
    get baseUrl() {
      return (process.env.COINPAY_API_URL ?? 'https://coinpayportal.com').replace(/\/$/, '');
    },
    get apiKey() {
      return process.env.COINPAY_API_KEY ?? '';
    },
    get businessId() {
      return process.env.COINPAY_BUSINESS_ID ?? '';
    },
    get webhookSecret() {
      return process.env.COINPAY_WEBHOOK_SECRET ?? '';
    },
    /**
     * Chains a buyer may settle on.
     *
     * These are not arbitrary. CoinPay resolves the payee from the BUSINESS's own
     * wallets, so naming a chain the business has no wallet for is refused at
     * checkout with "No <X> wallet configured for this business" -- a 400 that only
     * appears at the moment somebody presses pay. BASE was the default here and is
     * exactly that mistake: it is a real chain, the key was valid, and the button
     * simply failed.
     *
     * Verified against this business's imported wallets on 2026-09-24. Re-check with
     * `coinpay business list` + GET /api/businesses/:id/wallets before adding one.
     */
    chains: opt('COINPAY_CHAINS', 'USDC_POL,USDC_SOL,USDC_ETH,SOL,POL,ETH,BTC')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),

    /**
     * What the buyer gets if they express no preference.
     *
     * A stablecoin on a cheap chain: the smallest top-up is five dollars, and a
     * default whose network fee costs a meaningful slice of that is not a default.
     */
    get defaultChain() {
      const chosen = opt('COINPAY_CHAIN', 'USDC_POL').toUpperCase();
      return this.chains.includes(chosen) ? chosen : this.chains[0];
    },
  },

  /**
   * Agent-native metering. A bot pays per call and never makes an account.
   *
   * This is the thing remove.bg structurally cannot offer: no signup, no key, no
   * card, just a paid request. It is also the reason the free tier can stay generous,
   * because the callers that would abuse it are the ones with a way to pay.
   */
  x402: {
    /**
     * A SCOPED CoinPay key (Businesses -> API Keys), NOT the merchant key above.
     *
     * CoinPay's x402 verify and settle routes resolve the merchant from
     * `business_api_keys` only; the cp_live_ key that checkout uses is refused there
     * with "Invalid or inactive API key". Same shape, different table -- and the
     * failure is invisible until the moment an agent actually pays.
     */
    get scopedKey() {
      return process.env.COINPAY_X402_KEY ?? '';
    },
    /**
     * The EVM address the USDC lands in.
     *
     * The one payee the business cannot resolve for itself: x402 verify holds the
     * proof against whatever address the offer named and never looks the merchant's
     * wallets up. So unlike a checkout, this one genuinely is configuration.
     */
    get payTo() {
      return process.env.X402_PAY_TO ?? '';
    },
    get enabled() {
      return bool('X402_ENABLED', false) && Boolean(this.payTo && this.scopedKey);
    },
    /** What one full transcription (up to x402.maxMinutes of audio) costs an agent, in cents. */
    priceCents: num('X402_PRICE_CENTS', 50),
    maxMinutes: num('X402_MAX_MINUTES', 60),
    currency: opt('X402_CURRENCY', 'USD'),
    /** A pass, for an agent doing a batch rather than a single image. */
    passMinutes: num('X402_PASS_MINUTES', 60),
  },

  /**
   * How long a transcript is kept.
   *
   * The id is the only thing protecting somebody's interview, so an anonymous
   * preview goes after a week. An account's transcripts stay until it deletes
   * them or this many days pass, whichever comes first.
   */
  retention: {
    anonDays: num('ANON_TTL_DAYS', 7),
    accountDays: num('ACCOUNT_TTL_DAYS', 365),
    purgeIntervalMinutes: num('PURGE_MINUTES', 60),
  },

  /** The free allowance of requests before a caller is asked to pay. */
  throttle: {
    limit: num('THROTTLE_LIMIT', 60),
    windowSeconds: num('THROTTLE_WINDOW_SECONDS', 60),
  },
};

/**
 * Fail at boot rather than at checkout if the CoinPay credential is the wrong family.
 *
 * `cp_live_` and `cp_test_` take money. A bare `cp_` or `cps_` is a scoped read key and
 * will be refused by /api/payments/create with an authorization error that reads like a
 * misconfigured header rather than the wrong key entirely.
 */
export function assertCoinpayMerchantKey() {
  if (!config.coinpay.enabled) return;
  const key = config.coinpay.apiKey;
  if (!/^cp_(live|test)_/.test(key)) {
    throw new Error(
      'COINPAY_API_KEY is not a merchant key: payments need cp_live_ or cp_test_, ' +
        `got ${key.slice(0, 8)}… (a cp_/cps_ scoped key cannot create a payment)`,
    );
  }
}
