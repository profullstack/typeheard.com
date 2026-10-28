/**
 * typeheard over MCP: newline-delimited JSON-RPC 2.0 on stdio.
 *
 * Small enough to implement directly, which keeps this package free of any
 * runtime dependency beyond the typeheard client. Auth is TYPEHEARD_API_KEY;
 * without one an assistant still gets the free preview of each file.
 */

import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import {
  addWebhook,
  createInvite,
  FORMATS,
  get,
  invites,
  list,
  redeem,
  removeWebhook,
  resolveAuth,
  rotateWebhook,
  testWebhook,
  text,
  transcribe,
  webhookLog,
  webhooks,
} from '@profullstack/typeheard/client';

const PROTOCOL_VERSION = '2025-06-18';

const ID_SCHEMA = {
  type: 'object',
  properties: { id: { type: 'string' } },
  required: ['id'],
  additionalProperties: false,
};

const TOOLS = [
  {
    name: 'transcribe_file',
    description:
      'Transcribe a local audio or video file (mp3, m4a, wav, mp4, mov, webm...) with whisper.cpp on typeheard.com and return the text. ' +
      'Waits until it is done. Without TYPEHEARD_API_KEY only the first few minutes are transcribed (the free preview).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the recording.' },
        format: {
          type: 'string',
          enum: FORMATS,
          description: 'txt (default), md with timestamps, srt, vtt or json.',
        },
        language: { type: 'string', description: 'ISO code like en or es, or auto (default).' },
        title: { type: 'string' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_transcript',
    description: 'Status of one transcript, and its text once it is done.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, format: { type: 'string', enum: FORMATS } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_transcripts',
    description: "The account's transcripts, newest first. Needs TYPEHEARD_API_KEY.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'redeem_code',
    description:
      'Redeem a typeheard credit code (TH-XXXX-...) for transcription minutes on the account. Needs TYPEHEARD_API_KEY.',
    inputSchema: {
      type: 'object',
      properties: { code: { type: 'string' } },
      required: ['code'],
      additionalProperties: false,
    },
  },
  {
    name: 'invites',
    description:
      "The account's invites: how many are left, which were used, and its open ?ref= link. Needs TYPEHEARD_API_KEY.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'create_invite',
    description:
      'Make a single-use invite link to typeheard (each account has a few). Whoever makes an account through it and the inviter both get bonus minutes. Needs TYPEHEARD_API_KEY.',
    inputSchema: {
      type: 'object',
      properties: {
        note: { type: 'string', description: 'Who it is for; only the inviter sees it.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_webhooks',
    description:
      "The account's webhook endpoints, and the events typeheard sends (transcript.completed, transcript.failed). Needs TYPEHEARD_API_KEY.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'create_webhook',
    description:
      'Have typeheard POST transcript.completed / transcript.failed to a URL (https) as signed CloudEvents (Standard Webhooks) with the id, status and download links, not the text. Returns the signing secret. Needs TYPEHEARD_API_KEY.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'https URL to POST to.' },
        events: {
          type: 'array',
          items: { type: 'string' },
          description: 'Patterns like "transcript.*" or "transcript.completed"; omit for all.',
        },
        description: { type: 'string' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'test_webhook',
    description: 'Send a webhook.test event to one endpoint now and say how it went.',
    inputSchema: ID_SCHEMA,
  },
  {
    name: 'rotate_webhook',
    description: "Replace an endpoint's signing secret; the old one stops working at once.",
    inputSchema: ID_SCHEMA,
  },
  {
    name: 'delete_webhook',
    description: 'Remove a webhook endpoint.',
    inputSchema: ID_SCHEMA,
  },
  {
    name: 'webhook_deliveries',
    description: 'Recent webhook deliveries, for one endpoint (id) or all of them.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      additionalProperties: false,
    },
  },
];

const textResult = (value, isError = false) => ({
  content: [
    { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
  ],
  ...(isError ? { isError: true } : {}),
});

async function callTool(name, args) {
  const auth = await resolveAuth();
  switch (name) {
    case 'transcribe_file': {
      const { job, output } = await transcribe(auth, {
        path: resolve(String(args.path)),
        format: args.format ?? 'txt',
        language: args.language ?? 'auto',
        title: args.title,
      });
      const partial = job.transcribed_sec < job.duration_sec - 1;
      return textResult(
        `${partial ? `[free preview: first ${Math.round(job.transcribed_sec / 60)} of ${Math.ceil(job.duration_sec / 60)} minutes; set TYPEHEARD_API_KEY for whole files]\n` : ''}` +
          `[${job.url}]\n\n${output}`,
      );
    }
    case 'get_transcript': {
      const job = await get(auth, String(args.id));
      if (job.status !== 'done')
        return textResult({ id: job.id, status: job.status, error: job.error, url: job.url });
      return textResult(await text(auth, job.id, args.format ?? 'txt'));
    }
    case 'list_transcripts':
      return textResult(
        (await list(auth)).transcripts.map(({ text: _t, downloads: _d, ...rest }) => rest),
      );
    case 'redeem_code':
      return textResult(await redeem(auth, String(args.code ?? '')));
    case 'invites':
      return textResult(await invites(auth));
    case 'create_invite':
      return textResult(await createInvite(auth, args.note));
    case 'list_webhooks':
      return textResult(await webhooks(auth));
    case 'create_webhook':
      return textResult(
        await addWebhook(
          auth,
          String(args.url ?? ''),
          Array.isArray(args.events) ? args.events.map(String) : [],
          String(args.description ?? ''),
        ),
      );
    case 'test_webhook':
      return textResult(await testWebhook(auth, String(args.id ?? '')));
    case 'rotate_webhook':
      return textResult(await rotateWebhook(auth, String(args.id ?? '')));
    case 'delete_webhook':
      return textResult(await removeWebhook(auth, String(args.id ?? '')));
    case 'webhook_deliveries':
      return textResult(await webhookLog(auth, args.id ? String(args.id) : undefined));
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

async function handle(req) {
  switch (req.method) {
    case 'initialize':
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'typeheard', version: '0.2.0' },
      };
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call':
      try {
        return await callTool(req.params?.name, req.params?.arguments ?? {});
      } catch (err) {
        return textResult(String(err?.message ?? err), true);
      }
    case 'ping':
      return {};
    default:
      throw Object.assign(new Error(`method not found: ${req.method}`), { code: -32601 });
  }
}

export function serve(input = process.stdin, output = process.stdout) {
  const rl = createInterface({ input });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      output.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })}\n`,
      );
      return;
    }
    if (req.id === undefined) return; // a notification
    try {
      const result = await handle(req);
      output.write(`${JSON.stringify({ jsonrpc: '2.0', id: req.id, result })}\n`);
    } catch (err) {
      output.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: err.code ?? -32603, message: String(err.message) } })}\n`,
      );
    }
  });
  return rl;
}

export { handle, TOOLS };
