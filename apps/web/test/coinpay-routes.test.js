import { beforeAll, expect, test } from 'bun:test';

/**
 * The Sign in with CoinPay routes, end to end inside the app (no CoinPay call is made:
 * every case here stops before the code exchange). Needs DATABASE_URL like the other
 * route tests.
 */

let app;
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const get = (path, headers = {}) =>
  app.request(path, { headers: { 'user-agent': UA, 'sec-fetch-mode': 'navigate', ...headers } });

beforeAll(async () => {
  process.env.COINPAY_OAUTH_CLIENT_ID = process.env.COINPAY_OAUTH_CLIENT_ID || 'cp_test';
  process.env.COINPAY_OAUTH_CLIENT_SECRET = process.env.COINPAY_OAUTH_CLIENT_SECRET || 'secret';
  ({ app } = await import('../src/app.js'));
});

test('start redirects to CoinPay with PKCE S256, state and nonce, and sets the pending cookie', async () => {
  const res = await get('/api/v1/coinpay/oauth/start');
  expect(res.status).toBe(302);
  const url = new URL(res.headers.get('location'));
  expect(url.origin + url.pathname).toBe('https://coinpayportal.com/api/oauth/authorize');
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  expect(url.searchParams.get('state')).toBeTruthy();
  expect(url.searchParams.get('nonce')).toBeTruthy();
  expect(res.headers.get('set-cookie')).toContain('th_cp_oauth=');
});

test('a forged state is rejected before any code exchange', async () => {
  const start = await get('/api/v1/coinpay/oauth/start');
  const cookie = start.headers.get('set-cookie').split(';')[0];
  const res = await get('/api/v1/coinpay/oauth/callback?code=x&state=forged', { cookie });
  expect(res.status).toBe(302);
  expect(res.headers.get('location')).toContain('/signin?coinpay_error=');
  expect(decodeURIComponent(res.headers.get('location'))).toContain('state mismatch');
});

test('a callback with no pending sign-in is rejected', async () => {
  const res = await get('/api/v1/coinpay/oauth/callback?code=x&state=y');
  expect(res.headers.get('location')).toContain('expired');
});

test('connecting needs a session', async () => {
  const res = await get('/api/v1/coinpay/oauth/start?mode=connect');
  expect(res.status).toBe(302);
  expect(res.headers.get('location')).toBe('/signin');
});
