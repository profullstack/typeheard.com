/**
 * typeheard: transcribe a recording from the terminal.
 *
 *   typeheard <file> [--format txt|md|srt|vtt|json] [--language en] [--preview] [--out file]
 *   typeheard login [key]       save an API key (make one at /account/keys)
 *   typeheard list              your transcripts
 *   typeheard get <id> [--format md]
 *   typeheard me                minutes left
 *   typeheard tui               the same, as a screen
 *
 * TYPEHEARD_API_KEY and TYPEHEARD_URL override the saved config.
 */
import { writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { FORMATS, get, list, me, resolveAuth, saveConfig, text, transcribe } from './client.js';

const HELP = `typeheard: drop a recording, get what was said.

  typeheard <file> [--format txt|md|srt|vtt|json] [--language auto|en|es|...] [--preview] [--out FILE]
  typeheard login [KEY]        save an API key (make one at https://typeheard.com/account/keys)
  typeheard list               your transcripts
  typeheard get ID [--format md]
  typeheard me                 minutes left on your account
  typeheard tui                your transcripts and uploads, in the terminal

Without a key you get the first few minutes of any file free.
Environment: TYPEHEARD_API_KEY, TYPEHEARD_URL.`;

function parse(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const [name, inline] = arg.slice(2).split('=', 2);
      if (inline !== undefined) flags[name] = inline;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[name] = argv[++i];
      else flags[name] = true;
    } else if (arg === '-h') flags.help = true;
    else positional.push(arg);
  }
  return { positional, flags };
}

const clock = (sec) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;
const say = (line) => process.stderr.write(`${line}\n`);

export async function main(argv = process.argv.slice(2)) {
  const { positional, flags } = parse(argv);
  const [cmd, ...rest] = positional;
  if (!cmd || flags.help || cmd === 'help') {
    console.log(HELP);
    return 0;
  }
  const auth = await resolveAuth({ server: flags.server, key: flags.key });
  const format = String(flags.format ?? 'txt');
  if (!FORMATS.includes(format)) throw new Error(`--format is one of ${FORMATS.join(', ')}`);

  switch (cmd) {
    case 'login': {
      let key = rest[0];
      if (!key) {
        say(`Make a key at ${auth.server}/account/keys, then paste it here.`);
        const rl = createInterface({ input: process.stdin, output: process.stderr });
        key = (await rl.question('API key: ')).trim();
        rl.close();
      }
      if (!/^th_/.test(key))
        throw new Error('that does not look like a typeheard key (they start th_)');
      const file = await saveConfig({ key, server: auth.server });
      const who = await me({ ...auth, key });
      say(`Signed in as ${who.email}, ${who.minutes} minutes. Saved to ${file}.`);
      return 0;
    }
    case 'me': {
      const who = await me(auth);
      console.log(`${who.email}  ${who.minutes} minutes`);
      return 0;
    }
    case 'list':
    case 'ls': {
      const { transcripts } = await list(auth);
      for (const t of transcripts) {
        console.log(
          `${t.id}  ${t.status.padEnd(7)}  ${Math.round(t.duration_sec / 60)}m  ${t.title ?? t.filename ?? ''}`,
        );
      }
      return 0;
    }
    case 'get': {
      if (!rest[0]) throw new Error('typeheard get <id>');
      const job = await get(auth, rest[0]);
      if (job.status !== 'done') {
        say(`${job.status}${job.error ? `: ${job.error}` : ''}  ${job.url}`);
        return job.status === 'failed' ? 1 : 0;
      }
      return output(await text(auth, rest[0], format), flags.out);
    }
    case 'tui': {
      const { runTui } = await import('./tui.js');
      await runTui(auth);
      return 0;
    }
    default: {
      // Anything else is a file to transcribe.
      const path = cmd;
      let last = '';
      const { job, output: out } = await transcribe(auth, {
        path,
        language: String(flags.language ?? 'auto'),
        tier: flags.preview ? 'preview' : flags.full ? 'full' : 'auto',
        format,
        onStatus: (j) => {
          const line =
            j.status === 'queued' && j.queue_position
              ? `queued, ${j.queue_position} ahead`
              : j.status;
          if (line !== last) say(`${line}  ${j.url ?? ''}`);
          last = line;
        },
      });
      if (job.tier === 'preview' && job.transcribed_sec < job.duration_sec - 1) {
        say(
          `Preview: the first ${clock(job.transcribed_sec)} of ${clock(job.duration_sec)}. typeheard login to do whole files.`,
        );
      }
      return output(out, flags.out);
    }
  }
}

async function output(body, out) {
  if (typeof out === 'string') {
    await writeFile(out, body);
    say(`wrote ${out}`);
  } else process.stdout.write(body.endsWith('\n') ? body : `${body}\n`);
  return 0;
}
