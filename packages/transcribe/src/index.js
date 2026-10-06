/**
 * Recording in, words out.
 *
 * The heavy lifting is @profullstack/media2markdown-core, which already runs
 * whisper.cpp in production for media2markdown.com: `probe` for the duration and
 * `transcribe` for timestamped segments. What lives here is the part a
 * transcription product needs and a lecture-to-Markdown pipeline does not:
 *
 *   - its own ffmpeg step, so a free preview can stop at the first N seconds
 *     instead of transcribing an hour and throwing most of it away;
 *   - the formats people actually paste somewhere: plain text, SRT and VTT
 *     subtitles, timestamped Markdown and JSON.
 *
 * Nothing here calls a hosted model. whisper.cpp on our own box is the product's
 * whole cost structure, and the reason a minute can be sold for a fraction of
 * what Otter charges.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findTool, probe, transcribe as whisper } from '@profullstack/media2markdown-core';

export class TranscribeError extends Error {
  constructor(message, status = 422) {
    super(message);
    this.status = status;
  }
}

/** Run a binary, collecting stderr so a failure can say why. */
function run(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (chunk) => {
      err = (err + chunk).slice(-4000);
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${bin} exited ${code}: ${err.trim().split('\n').slice(-3).join(' ')}`)),
    );
  });
}

/**
 * 16 kHz mono PCM, optionally only the first `maxSeconds` of it.
 *
 * `-t` is the cheap way to cap a preview: ffmpeg stops reading the input there,
 * so an hour-long upload costs a few seconds of decoding rather than an hour.
 */
export async function toWav(input, outDir, { maxSeconds = 0 } = {}) {
  const ffmpeg = (await findTool('ffmpeg')) ?? 'ffmpeg';
  const out = join(outDir, 'audio.wav');
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', input];
  if (maxSeconds > 0) args.push('-t', String(maxSeconds));
  args.push('-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', out);
  await run(ffmpeg, args);
  return out;
}

/** How long a recording is, in seconds. Throws a 422 for something with no audio. */
export async function durationOf(input) {
  let info;
  try {
    info = await probe(input);
  } catch (err) {
    throw new TranscribeError(
      `that does not look like audio or video (${String(err?.message ?? err).slice(0, 120)})`,
    );
  }
  if (!info.hasAudio) throw new TranscribeError('that file has no audio track');
  if (!Number.isFinite(info.durationSec) || info.durationSec <= 0) {
    throw new TranscribeError('could not read how long that recording is');
  }
  return info.durationSec;
}

/**
 * Transcribe a file on disk.
 *
 * @param {{ path: string, maxSeconds?: number, language?: string, model?: string, durationSec?: number }} args
 *   `maxSeconds` > 0 stops after that much audio (the free preview).
 *   `language` is an ISO code, or "auto" to let whisper detect it.
 *   `durationSec` skips a second probe when the caller already has it.
 */
export async function transcribeFile({
  path,
  maxSeconds = 0,
  language = 'auto',
  model,
  durationSec,
} = {}) {
  const started = Date.now();
  const total = durationSec ?? (await durationOf(path));
  const work = await mkdtemp(join(tmpdir(), 'typeheard-'));
  try {
    const wav = await toWav(path, work, { maxSeconds });
    const segments = await whisper(wav, {
      ...(model ? { model } : {}),
      language: language || 'auto',
    });
    return {
      segments: cleanSegments(segments),
      durationSec: total,
      transcribedSec: maxSeconds > 0 ? Math.min(total, maxSeconds) : total,
      ms: Date.now() - started,
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * Drop what whisper emits that is not speech.
 *
 * Silence comes back as "[BLANK_AUDIO]", music as "(music)" or "♪", and the odd
 * empty segment; none of that belongs in a transcript somebody is going to quote.
 */
export function cleanSegments(segments) {
  return (segments ?? [])
    .map((seg) => ({
      start: Number(seg.start) || 0,
      end: Number(seg.end) || 0,
      text: String(seg.text ?? '')
        .replace(/\s+/g, ' ')
        .trim(),
    }))
    .filter((seg) => seg.text && !/^(\[[^\]]*\]|\([^)]*\)|[♪\s]+)$/.test(seg.text));
}

// ------------------------------------------------------------------ formats

const pad = (n, w = 2) => String(Math.floor(n)).padStart(w, '0');

/** 00:01:02,345 for SRT, or 00:01:02.345 for VTT. */
export function stamp(seconds, sep = ',') {
  const totalMs = Math.round(Math.max(0, seconds) * 1000);
  const whole = Math.floor(totalMs / 1000);
  return `${pad(whole / 3600)}:${pad((whole % 3600) / 60)}:${pad(whole % 60)}${sep}${pad(totalMs % 1000, 3)}`;
}

/** 01:02 or 1:02:03, for reading rather than for players. */
export function clock(seconds) {
  const s = Math.floor(Math.max(0, seconds));
  const h = Math.floor(s / 3600);
  return h ? `${h}:${pad((s % 3600) / 60)}:${pad(s % 60)}` : `${pad(s / 60)}:${pad(s % 60)}`;
}

/**
 * Paragraphs, not one line per segment.
 *
 * whisper cuts every few seconds, which is right for subtitles and unreadable as
 * prose. A pause of `gap` seconds, or a paragraph past `max` characters, starts a
 * new one.
 */
export function paragraphs(segments, { gap = 2, max = 600 } = {}) {
  const out = [];
  let cur = null;
  for (const seg of segments) {
    if (!cur || seg.start - cur.end > gap || cur.text.length > max) {
      cur = { start: seg.start, end: seg.end, text: seg.text };
      out.push(cur);
    } else {
      cur.end = seg.end;
      cur.text = `${cur.text} ${seg.text}`;
    }
  }
  return out;
}

export const FORMATS = {
  txt: { type: 'text/plain; charset=utf-8', ext: 'txt' },
  md: { type: 'text/markdown; charset=utf-8', ext: 'md' },
  srt: { type: 'application/x-subrip; charset=utf-8', ext: 'srt' },
  vtt: { type: 'text/vtt; charset=utf-8', ext: 'vtt' },
  json: { type: 'application/json; charset=utf-8', ext: 'json' },
};

/**
 * Render a transcript in one of FORMATS.
 *
 * @param {string} format
 * @param {{ segments: object[], title?: string, durationSec?: number, transcribedSec?: number }} t
 */
export function render(format, t) {
  const segments = t.segments ?? [];
  const partial = t.transcribedSec && t.durationSec && t.transcribedSec < t.durationSec - 1;
  switch (format) {
    case 'txt':
      return `${paragraphs(segments)
        .map((p) => p.text)
        .join('\n\n')}\n`;
    case 'md': {
      const head = t.title ? `# ${t.title}\n\n` : '';
      const note = partial
        ? `> Preview: the first ${clock(t.transcribedSec)} of ${clock(t.durationSec)}.\n\n`
        : '';
      return `${head}${note}${paragraphs(segments)
        .map((p) => `**[${clock(p.start)}]** ${p.text}`)
        .join('\n\n')}\n`;
    }
    case 'srt':
      return segments
        .map((s, i) => `${i + 1}\n${stamp(s.start)} --> ${stamp(s.end)}\n${s.text}\n`)
        .join('\n');
    case 'vtt':
      return `WEBVTT\n\n${segments
        .map((s) => `${stamp(s.start, '.')} --> ${stamp(s.end, '.')}\n${s.text}\n`)
        .join('\n')}`;
    case 'json':
      return `${JSON.stringify(
        {
          title: t.title ?? null,
          durationSec: t.durationSec ?? null,
          transcribedSec: t.transcribedSec ?? null,
          segments,
        },
        null,
        2,
      )}\n`;
    default:
      throw new TranscribeError(
        `unknown format ${format}; one of ${Object.keys(FORMATS).join(', ')}`,
        400,
      );
  }
}

/** Billable minutes for a duration: whole minutes, rounded up, never zero. */
export const billableMinutes = (seconds) => Math.max(1, Math.ceil(seconds / 60));
