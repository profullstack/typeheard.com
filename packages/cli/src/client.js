/**
 * The typeheard API, as a function call.
 *
 * Shared by the CLI, the TUI and the MCP server so all three upload, wait and
 * read the same way. Plain fetch, no dependencies: it runs anywhere Node 20+ or
 * Bun does.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export const FORMATS = ['txt', 'md', 'srt', 'vtt', 'json'];

const CONFIG_FILE = join(
  process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
  'typeheard',
  'config.json',
);

export async function loadConfig() {
  try {
    return JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

export async function saveConfig(patch) {
  const next = { ...(await loadConfig()), ...patch };
  await mkdir(dirname(CONFIG_FILE), { recursive: true });
  await writeFile(CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return CONFIG_FILE;
}

/** The server and key: flags and environment first, then the saved config. */
export async function resolveAuth({ server, key } = {}) {
  const saved = await loadConfig();
  return {
    server: (
      server ||
      process.env.TYPEHEARD_URL ||
      saved.server ||
      'https://typeheard.com'
    ).replace(/\/+$/, ''),
    key: key || process.env.TYPEHEARD_API_KEY || saved.key || '',
  };
}

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error ? `${body.error} (HTTP ${status})` : `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

async function call(auth, path, init = {}) {
  const res = await fetch(`${auth.server}${path}`, {
    ...init,
    headers: {
      ...(auth.key ? { authorization: `Bearer ${auth.key}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const type = res.headers.get('content-type') ?? '';
  const body = type.includes('json') ? await res.json().catch(() => ({})) : await res.text();
  if (!res.ok)
    throw new ApiError(res.status, typeof body === 'string' ? { error: body.slice(0, 200) } : body);
  return body;
}

/**
 * Upload a file. Returns the job: `{ id, status, status_url, url, tier, ... }`.
 * @param {{ path: string, language?: string, tier?: 'auto'|'preview'|'full', title?: string }} args
 */
export async function upload(auth, { path, language = 'auto', tier = 'auto', title }) {
  const bytes = await readFile(path);
  const form = new FormData();
  form.append('file', new Blob([bytes]), basename(path));
  form.append('language', language);
  form.append('tier', tier);
  if (title) form.append('title', title);
  return call(auth, '/api/v1/transcripts', { method: 'POST', body: form });
}

export const get = (auth, id) => call(auth, `/api/v1/transcripts/${encodeURIComponent(id)}`);
export const list = (auth) => call(auth, '/api/v1/transcripts');
export const me = (auth) => call(auth, '/api/v1/me');

export async function text(auth, id, format = 'txt') {
  if (!FORMATS.includes(format)) throw new Error(`format is one of ${FORMATS.join(', ')}`);
  return call(auth, `/api/v1/transcripts/${encodeURIComponent(id)}/${format}`);
}

/** Poll until done or failed. `onStatus` sees every poll. */
export async function wait(auth, id, { every = 3000, timeoutMs = 6 * 3600_000, onStatus } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const job = await get(auth, id);
    onStatus?.(job);
    if (job.status === 'done') return job;
    if (job.status === 'failed')
      throw new Error(`transcription failed: ${job.error ?? 'unknown error'}`);
    if (Date.now() > until)
      throw new Error(
        `still ${job.status} after ${Math.round(timeoutMs / 60000)} minutes; see ${job.url}`,
      );
    await new Promise((resolve) => setTimeout(resolve, every));
  }
}

/** Upload, wait, and return the transcript in one format. */
export async function transcribe(auth, { path, language, tier, title, format = 'txt', onStatus }) {
  const job = await upload(auth, { path, language, tier, title });
  onStatus?.(job);
  const done = await wait(auth, job.id, { onStatus });
  return { job: done, output: await text(auth, job.id, format) };
}
