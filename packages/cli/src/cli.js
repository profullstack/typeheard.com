/**
 * typeheard: transcribe a recording from the terminal.
 *
 *   typeheard <file> [--format txt|md|srt|vtt|json] [--language en] [--preview] [--out file]
 *   typeheard login [key]       save an API key (make one at /account/keys)
 *   typeheard list              your transcripts
 *   typeheard get <id> [--format md]
 *   typeheard me                minutes left
 *   typeheard redeem <code>     add a credit code's minutes to your account
 *   typeheard invites [new [note]]  your invites, or make a new invite link
 *   typeheard webhooks          your webhook endpoints; webhook add|test|rotate|rm|log
 *   typeheard tui               the same, as a screen
 *
 * TYPEHEARD_API_KEY and TYPEHEARD_URL override the saved config.
 */
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import {
  addWebhook,
  createInvite,
  FORMATS,
  get,
  invites,
  list,
  me,
  redeem,
  removeWebhook,
  resolveAuth,
  rotateWebhook,
  saveConfig,
  testWebhook,
  text,
  transcribe,
  webhookLog,
  webhooks,
} from './client.js';

const HELP = `typeheard: drop a recording, get what was said.

  typeheard <file> [--format txt|md|srt|vtt|json] [--language auto|en|es|...] [--preview] [--out FILE]
  typeheard login [KEY]        save an API key (make one at https://typeheard.com/account/keys)
  typeheard list               your transcripts
  typeheard get ID [--format md]
  typeheard me                 minutes left on your account
  typeheard redeem CODE        add a credit code's minutes to your account
  typeheard invites            invites left and sent, and your ?ref= link
  typeheard invites new [NOTE] make a single-use invite link (you both get minutes)
  typeheard webhooks           your webhook endpoints and the events typeheard sends
  typeheard webhook add URL [EVENTS...]  POST transcript.completed/failed to URL (prints the secret)
  typeheard webhook test|rotate|rm ID    send a test, replace the secret, or remove it
  typeheard webhook log [ID]   recent deliveries
  typeheard tui                your transcripts and uploads, in the terminal
  typeheard --version

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
    else if (arg === '-v') flags.version = true;
    else positional.push(arg);
  }
  return { positional, flags };
}

const clock = (sec) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;
const say = (line) => process.stderr.write(`${line}\n`);

export async function main(argv = process.argv.slice(2)) {
  const { positional, flags } = parse(argv);
  const [cmd, ...rest] = positional;
  if (flags.version || cmd === 'version') {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    console.log(`typeheard ${pkg.version}`);
    return 0;
  }
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
    case 'redeem': {
      if (!rest[0]) throw new Error('typeheard redeem <code>');
      const out = await redeem(auth, rest.join(' '));
      console.log(`Added ${out.added_minutes} minutes. You have ${out.minutes}.`);
      return 0;
    }
    case 'invites': {
      if (rest[0] === 'new' || rest[0] === 'create') {
        const made = await createInvite(auth, rest.slice(1).join(' '));
        console.log(made.url);
        say(`Works once, for 30 days. ${made.quota.left} invite(s) left. Shown once.`);
        return 0;
      }
      const s = await invites(auth);
      console.log(`${s.quota.left} of ${s.quota.total} invites left; ${s.joined} joined.`);
      for (const i of s.invites) {
        console.log(
          `  ${i.used ? 'joined ' : i.revoked ? 'revoked' : 'waiting'}  ${i.created_at.slice(0, 10)}  ${i.note}`,
        );
      }
      console.log(`Your link: ${s.affiliate_url}`);
      return 0;
    }
    case 'webhooks': {
      const r = await webhooks(auth);
      for (const w of r.endpoints) {
        console.log(
          `${w.id}  ${w.url}  ${w.events.join(',')}${w.enabled ? '' : `  OFF (${w.disabled_reason ?? 'disabled'})`}`,
        );
      }
      if (!r.endpoints.length) say('No webhooks yet: typeheard webhook add <url>');
      say(`events: ${r.event_types.join(', ')}`);
      return 0;
    }
    case 'webhook': {
      const [sub, arg, ...more] = rest;
      const need = (v, what) => {
        if (!v) throw new Error(`typeheard webhook ${sub} <${what}>`);
        return v;
      };
      if (sub === 'add') {
        const r = await addWebhook(auth, need(arg, 'url'), more);
        console.log(`${r.endpoint.id} -> ${r.endpoint.url}  ${r.endpoint.events.join(',')}`);
        console.log(`signing secret: ${r.secret}`);
      } else if (sub === 'test') {
        const r = await testWebhook(auth, need(arg, 'id'));
        console.log(r.ok ? `delivered (HTTP ${r.status})` : `failed: ${r.error}`);
        return r.ok ? 0 : 1;
      } else if (sub === 'rotate') {
        const r = await rotateWebhook(auth, need(arg, 'id'));
        console.log(`new signing secret: ${r.secret}`);
      } else if (sub === 'rm' || sub === 'remove' || sub === 'delete') {
        await removeWebhook(auth, need(arg, 'id'));
        say('removed');
      } else if (sub === 'log') {
        const r = await webhookLog(auth, arg);
        for (const d of r.deliveries) {
          console.log(
            `${d.created_at.slice(0, 19)}  ${d.event_type.padEnd(22)} ${d.status.padEnd(9)} x${d.attempts} ${d.last_status ?? ''} ${d.last_error ?? ''}`.trimEnd(),
          );
        }
        if (!r.deliveries.length) say('no deliveries yet');
      } else throw new Error('typeheard webhook add|test|rotate|rm|log');
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
