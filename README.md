# typeheard

Drop a recording, get what was said.

typeheard transcribes the audio and video people already have (interviews,
lectures, podcasts, voice memos) with [whisper.cpp](https://github.com/ggml-org/whisper.cpp)
on our own hardware, and bills by the minute of audio instead of by the month.

- **Free:** the first 3 minutes of any file, no account.
- **Whole files:** one credit per audio minute. $5 buys 300 minutes, and minutes never expire.
- **Agents:** x402 per call, no account and no key.
- **Formats:** plain text, timestamped Markdown, SRT, VTT, JSON.
- **Surfaces:** web, HTTP API, CLI, TUI and an MCP server.

Built because people keep asking Reddit for "an Otter.ai alternative for files
I already have" and "transcription software for my thesis interviews".

## Use it

```bash
npx -y @profullstack/typeheard interview.m4a                  # prints the text
npx -y @profullstack/typeheard talk.mp4 --format srt --out talk.srt
npx -y @profullstack/typeheard login                          # API key for whole files
npx -y @profullstack/typeheard tui
```

```bash
curl -F file=@interview.m4a -H "Authorization: Bearer $TYPEHEARD_API_KEY" https://typeheard.com/api/v1/transcripts
curl https://typeheard.com/api/v1/transcripts/<id>/txt        # also md, srt, vtt, json
```

MCP: `npx -y @profullstack/typeheard-mcp` with `TYPEHEARD_API_KEY` set. Its tools are
`transcribe_file`, `get_transcript` and `list_transcripts`.

## How it is built

| | |
| --- | --- |
| `apps/web` | Bun + Hono: pages, API, magic-link + passkey auth, CoinPay top-ups, x402 |
| `packages/transcribe` | ffmpeg + whisper.cpp via `@profullstack/media2markdown-core`; the formats |
| `packages/db` | Postgres. `transcripts` is also the job queue (`for update skip locked`) |
| `packages/cli` | `@profullstack/typeheard`: CLI, hqtui TUI, and the API client |
| `packages/mcp` | `@profullstack/typeheard-mcp`: stdio MCP server |
| `packages/auth`, `payments`, `notify`, `config` | shared with bg0ne.com |

A job is a row. The upload is written to `DATA_DIR`, the row is queued, and a worker
claims it, transcribes it and stores the segments. The upload is deleted as soon as the
words are out. Jobs survive a restart. A failure refunds the minutes it was charged.

## Run it yourself

```bash
docker compose up        # Postgres + the app on :3000, payments off, everything free
```

Or `bun install && DATABASE_URL=... bun run dev`, with `ffmpeg` and `whisper-cli` plus a
ggml model where media2markdown-core looks (`$XDG_DATA_HOME/media2markdown/`).

| Variable | |
| --- | --- |
| `DATABASE_URL` | required |
| `SITE_URL` | public origin; the passkey rpID comes from it |
| `WHISPER_MODEL` | path to a ggml model; the image bakes `ggml-base.bin` (multilingual) |
| `CONCURRENCY` | transcriptions at once (default 1) |
| `PREVIEW_SECONDS` | free preview length (default 180) |
| `RESEND_API_KEY`, `MAIL_FROM` | sign-in mail |
| `COINPAY_API_KEY`, `COINPAY_BUSINESS_ID`, `COINPAY_WEBHOOK_SECRET` | top-ups |
| `X402_ENABLED`, `X402_PAY_TO`, `COINPAY_X402_KEY` | per-call payment for agents |

Secrets live in the logicsrc vault (`typeheardcom--prod`), not in a `.env`.

## Test

```bash
DATABASE_URL=postgres://... bun test
```

MIT.
