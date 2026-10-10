/**
 * Server-rendered HTML as template strings.
 *
 * No JSX and no client framework: the app is an upload form, a progress line and
 * a page of text. A build step for that is a cost with nothing on the other side.
 */

import { siteFooter } from './footer.js';

const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
  );

const mins = (seconds) => {
  const s = Math.round(Number(seconds) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
    : `${m}:${String(r).padStart(2, '0')}`;
};

const STYLE = `
:root{color-scheme:light dark;--bg:#fbfbf8;--fg:#17150f;--mut:#6d6a60;--line:#e6e3d8;--card:#fff;--accent:#e4572e;--accent-fg:#fff;--hi:#fff4c2}
@media(prefers-color-scheme:dark){:root{--bg:#100f0c;--fg:#f3f1ea;--mut:#a29f93;--line:#2a2822;--card:#18170f;--accent:#ff7a50;--accent-fg:#100f0c;--hi:#3a3110}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent)}
.wrap{max-width:860px;margin:0 auto;padding:0 20px}
header{border-bottom:1px solid var(--line)}
header .wrap{display:flex;align-items:center;flex-wrap:wrap;gap:6px 20px;min-height:64px;padding-top:10px;padding-bottom:10px}
@media(max-width:560px){header nav{margin-left:0;width:100%;gap:16px}}
.brand{font-weight:800;font-size:21px;text-decoration:none;color:var(--fg);letter-spacing:-.03em;display:flex;align-items:center;gap:9px}
.brand b{color:var(--accent);font-weight:inherit}
nav{margin-left:auto;display:flex;gap:18px;font-size:15px;flex-wrap:wrap}
nav a{text-decoration:none;color:var(--mut)}nav a:hover{color:var(--fg)}
h1{font-size:clamp(32px,5.5vw,50px);line-height:1.08;letter-spacing:-.035em;margin:48px 0 12px}
h2{font-size:22px;letter-spacing:-.02em;margin:40px 0 12px}
.lede{font-size:19px;color:var(--mut);margin:0 0 30px;max-width:62ch}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px}
.drop{display:block;border:2px dashed var(--line);border-radius:16px;padding:52px 20px;text-align:center;cursor:pointer;transition:.15s;background:var(--card)}
.drop:hover,.drop.over{border-color:var(--accent)}
.drop p{margin:6px 0;color:var(--mut)}
.drop strong{font-size:19px;color:var(--fg)}
.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:14px}
.btn{display:inline-block;background:var(--accent);color:var(--accent-fg);border:0;border-radius:9px;padding:11px 18px;font:inherit;font-weight:600;cursor:pointer;text-decoration:none}
.btn.ghost{background:transparent;color:var(--fg);border:1px solid var(--line)}
.btn.small{padding:7px 12px;font-size:14px}
.grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
table{width:100%;border-collapse:collapse;font-size:15px}
th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line)}
th{color:var(--mut);font-weight:500}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
pre{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;overflow-x:auto;font-size:13.5px;white-space:pre-wrap}
code{font-size:13.5px}
input[type=email],input[type=text]{font:inherit;padding:11px 12px;border:1px solid var(--line);border-radius:9px;background:var(--card);color:var(--fg);width:100%}
select{font:inherit;padding:10px 12px;border:1px solid var(--line);border-radius:9px;background:var(--card);color:var(--fg)}
.muted{color:var(--mut)}
.big{font-size:38px;font-weight:700;letter-spacing:-.02em}
.bar{height:6px;background:var(--line);border-radius:6px;overflow:hidden;margin-top:12px}
.bar i{display:block;height:100%;width:30%;background:var(--accent);border-radius:6px;animation:slide 1.4s ease-in-out infinite}
@keyframes slide{0%{margin-left:-30%}100%{margin-left:100%}}
.para{margin:0 0 16px;display:flex;gap:14px}
.para time{flex:0 0 58px;color:var(--mut);font-variant-numeric:tabular-nums;font-size:14px;padding-top:2px}
.note{background:var(--hi);border-radius:10px;padding:12px 14px;margin:0 0 20px}
.tabs{display:flex;gap:4px;border-bottom:1px solid var(--line);margin:24px 0}
.tab{padding:9px 14px;text-decoration:none;color:var(--mut);border-bottom:2px solid transparent;margin-bottom:-1px}
.tab:hover{color:var(--fg)}
.tab.on{color:var(--fg);border-bottom-color:var(--accent);font-weight:600}
.foot-note{margin-top:80px;color:var(--mut);font-size:14px}
.pfs-footer{color:var(--fg);margin-top:16px}
`;

function page({ title, description, body, canonical, config }) {
  const site = config?.siteUrl ?? 'https://typeheard.com';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${canonical ? `<link rel="canonical" href="${esc(canonical)}">` : ''}
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/icons/favicon-32.png" sizes="32x32" type="image/png">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon-180x180.png">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#fbfbf8" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#100f0c" media="(prefers-color-scheme: dark)">
<meta property="og:image" content="${esc(site)}/icons/icon-512x512.png">
<style>${STYLE}</style>
<script data-site="2d708fa7-d482-436e-964e-34629305d6db" src="https://crawlproof.com/stats.js" async></script>
</head>
<body>
<header><div class="wrap">
  <a class="brand" href="/"><img src="/favicon.svg" alt="" width="30" height="30"><span>type<b>heard</b></span></a>
  <nav>
    <a href="/pricing">Pricing</a>
    <a href="/docs">API</a>
    <a href="https://github.com/profullstack/typeheard.com">Source</a>
    <a href="/account">Account</a>
  </nav>
</div></header>
<main class="wrap">${body}</main>
<div class="wrap foot-note">
  <p>Transcribed by whisper.cpp on our own hardware. Your audio is deleted the moment
  the words are out; transcripts are yours to delete.</p>
</div>
${siteFooter()}
</body></html>`;
}

const LANGS = [
  ['auto', 'Detect language'],
  ['en', 'English'],
  ['es', 'Spanish'],
  ['fr', 'French'],
  ['de', 'German'],
  ['pt', 'Portuguese'],
  ['it', 'Italian'],
  ['nl', 'Dutch'],
  ['pl', 'Polish'],
  ['ru', 'Russian'],
  ['uk', 'Ukrainian'],
  ['tr', 'Turkish'],
  ['ar', 'Arabic'],
  ['hi', 'Hindi'],
  ['zh', 'Chinese'],
  ['ja', 'Japanese'],
  ['ko', 'Korean'],
];

/* ----------------------------------------------------------------- landing -- */

export function Landing({ config, user, balance }) {
  const free = Math.round(config.pricing.previewSeconds / 60);
  const cheapest = config.pricing.topups[0];
  const perHour = ((cheapest.cents / cheapest.credits) * 60) / 100;
  return page({
    config,
    title: 'typeheard: drop a recording, get the transcript',
    description: `Transcribe interviews, lectures, podcasts and voice memos you already have. The first ${free} minutes of any file are free; after that about $${perHour.toFixed(2)} an hour, no subscription.`,
    canonical: `${config.siteUrl}/`,
    body: `
<h1>Drop a recording.<br>Get what was said.</h1>
<p class="lede">Interviews, lectures, podcasts, voice memos: the files you already have.
The first ${free} minutes of anything are free, no account. The whole file is about
$${perHour.toFixed(2)} an hour, paid once, with no subscription and minutes that never expire.</p>

<label class="drop" id="drop" for="file">
  <strong>Drop audio or video here</strong>
  <p>mp3, m4a, wav, ogg, flac, mp4, mov, webm… up to ${Math.round(config.uploads.maxBytes / 1073741824)} GB and ${config.uploads.maxMinutes / 60} hours</p>
  <p class="muted">or click to choose a file</p>
</label>
<input id="file" type="file" accept="audio/*,video/*" hidden>
<div class="row">
  <select id="language" aria-label="Language">${LANGS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
  <span class="muted">${
    user
      ? `${balance.toLocaleString()} minutes on your account. Files are transcribed in full.`
      : `Not signed in: you get the first ${free} minutes. <a href="/signup">Sign up</a> to do whole files.`
  }</span>
</div>
<div id="status" class="card" style="display:none;margin-top:20px"></div>

<h2>What you get</h2>
<div class="grid">
  <div class="card"><strong>Plain text</strong><p class="muted">Paragraphs, ready to paste into a doc or quote in a thesis.</p></div>
  <div class="card"><strong>Timestamps</strong><p class="muted">Markdown with [mm:ss] on every paragraph, so a quote can be found again.</p></div>
  <div class="card"><strong>Subtitles</strong><p class="muted">SRT and VTT for YouTube, Premiere, Resolve or any player.</p></div>
  <div class="card"><strong>An API</strong><p class="muted">One POST. Keys for people, x402 per call for agents. <a href="/docs">Docs</a>.</p></div>
</div>

<h2>Why it is cheap</h2>
<p class="muted">The transcription runs on <a href="https://github.com/ggml-org/whisper.cpp">whisper.cpp</a>
on our own servers rather than a hosted AI API, so a minute costs us very little and you pay
for what you upload instead of a monthly plan sized for someone else.</p>

<script>
const drop=document.getElementById('drop'),input=document.getElementById('file'),status=document.getElementById('status');
['dragenter','dragover'].forEach(e=>drop.addEventListener(e,ev=>{ev.preventDefault();drop.classList.add('over')}));
['dragleave','drop'].forEach(e=>drop.addEventListener(e,ev=>{ev.preventDefault();drop.classList.remove('over')}));
drop.addEventListener('drop',ev=>{if(ev.dataTransfer.files[0])send(ev.dataTransfer.files[0])});
input.addEventListener('change',()=>{if(input.files[0])send(input.files[0])});
function show(h){status.style.display='block';status.innerHTML=h}
function send(file){
  const body=new FormData();body.append('file',file);body.append('language',document.getElementById('language').value);
  const xhr=new XMLHttpRequest();xhr.open('POST','/api/v1/transcripts');
  xhr.upload.onprogress=e=>{if(e.lengthComputable)show('Uploading '+file.name+'… '+Math.round(e.loaded/e.total*100)+'%<div class="bar"><i></i></div>')};
  xhr.onload=()=>{let j={};try{j=JSON.parse(xhr.responseText)}catch{}
    if(xhr.status===202&&j.url){location.href=j.url;return}
    show('<strong>That did not work.</strong> '+(j.error||('HTTP '+xhr.status))+(xhr.status===402?' <a href="/pricing">Top up</a>':''))};
  xhr.onerror=()=>show('Upload failed. Check your connection and try again.');
  show('Uploading '+file.name+'…<div class="bar"><i></i></div>');xhr.send(body);
}
</script>`,
  });
}

/* -------------------------------------------------------------- transcript -- */

export function TranscriptPage({ row, view, config, mine }) {
  const title = row.title || row.filename || 'Transcript';
  const partial =
    row.status === 'done' && row.transcribed_sec && row.transcribed_sec < row.duration_sec - 1;
  const segments = row.segments ?? [];
  // Paragraphs on a pause, the same rule as the txt download, so the page and the file agree.
  const paras = [];
  for (const s of segments) {
    const last = paras[paras.length - 1];
    if (!last || s.start - last.end > 2 || last.text.length > 600)
      paras.push({ start: s.start, end: s.end, text: s.text });
    else {
      last.end = s.end;
      last.text += ` ${s.text}`;
    }
  }
  const downloads = Object.keys(view.downloads ?? {})
    .map(
      (f) =>
        `<a class="btn ghost small" href="/api/v1/transcripts/${row.id}/${f}?download">${f.toUpperCase()}</a>`,
    )
    .join(' ');

  let body;
  if (row.status === 'done') {
    body = `
${
  partial
    ? `<p class="note">This is the free preview: the first ${mins(row.transcribed_sec)} of ${mins(row.duration_sec)}.
<a href="/signup">Sign up</a> and <a href="/pricing">add minutes</a> to transcribe the whole file
(${Math.ceil(row.duration_sec / 60)} minutes).</p>`
    : ''
}
<div class="row" style="margin:0 0 24px"><button class="btn small" id="copy">Copy text</button> ${downloads}</div>
<article id="text">${
      paras.length
        ? paras
            .map(
              (p) => `<p class="para"><time>${mins(p.start)}</time><span>${esc(p.text)}</span></p>`,
            )
            .join('')
        : '<p class="muted">No speech was found in this recording.</p>'
    }</article>
<script>
document.getElementById('copy').addEventListener('click',async e=>{
  await navigator.clipboard.writeText([...document.querySelectorAll('#text .para span')].map(s=>s.textContent).join('\\n\\n'));
  e.target.textContent='Copied';setTimeout(()=>e.target.textContent='Copy text',1500)});
</script>`;
  } else if (row.status === 'failed') {
    body = `<div class="card"><strong>That one failed.</strong> <span class="muted">${esc(row.error ?? '')}</span>
<p class="muted">Any minutes it used were put back on your account.</p><p><a class="btn" href="/">Try another file</a></p></div>`;
  } else {
    body = `<div class="card" id="wait"><strong>${row.status === 'running' ? 'Listening…' : 'In the queue…'}</strong>
<p class="muted" id="waitmsg">${view.queue_position ? `${view.queue_position} ahead of you. ` : ''}A ${mins(row.tier === 'preview' ? Math.min(row.duration_sec, config.pricing.previewSeconds) : row.duration_sec)} recording usually takes a fraction of that. This page refreshes itself; you can also bookmark it and come back.</p>
<div class="bar"><i></i></div></div>
<script>
setInterval(async()=>{const r=await fetch('/api/v1/transcripts/${row.id}');const j=await r.json().catch(()=>({}));
if(j.status==='done'||j.status==='failed')location.reload();
else if(j.queue_position!==undefined)document.getElementById('waitmsg').firstChild.textContent=j.queue_position+' ahead of you. '},3000);
</script>`;
  }

  return page({
    config,
    title: `${title} - typeheard`,
    description: 'A transcript on typeheard.',
    body: `
<h1 style="font-size:clamp(26px,4vw,36px)">${esc(title)}</h1>
<p class="muted">${mins(row.duration_sec)} recording · ${esc(row.language === 'auto' ? 'language detected' : row.language)} ·
kept until ${new Date(row.expires_at).toISOString().slice(0, 10)}${mine ? ` · <a href="#" id="del">delete</a>` : ''}</p>
${body}
${
  mine
    ? `<script>document.getElementById('del').addEventListener('click',async e=>{e.preventDefault();
if(!confirm('Delete this transcript for good?'))return;await fetch('/api/v1/transcripts/${row.id}',{method:'DELETE'});location.href='/account/history'});</script>`
    : ''
}`,
  });
}

/* ----------------------------------------------------------------- pricing -- */

export function Pricing({ config }) {
  const rows = config.pricing.topups
    .map(
      (t) => `<tr>
        <td><strong>$${(t.cents / 100).toFixed(2)}</strong></td>
        <td>${t.credits.toLocaleString()} minutes <span class="muted">(${(t.credits / 60).toFixed(0)} hours)</span></td>
        <td class="muted">$${((t.cents / t.credits) * 0.6).toFixed(2)} an hour</td>
        <td><button class="btn" data-cents="${t.cents}">Buy</button></td>
      </tr>`,
    )
    .join('');
  const LABELS = {
    USDC_POL: 'USDC on Polygon',
    USDC_SOL: 'USDC on Solana',
    USDC_ETH: 'USDC on Ethereum',
    SOL: 'Solana',
    POL: 'Polygon',
    ETH: 'Ethereum',
    BTC: 'Bitcoin',
  };
  const options = config.coinpay.chains
    .map(
      (ch) =>
        `<option value="${ch}"${ch === config.coinpay.defaultChain ? ' selected' : ''}>${esc(LABELS[ch] ?? ch)}</option>`,
    )
    .join('');
  const free = Math.round(config.pricing.previewSeconds / 60);

  return page({
    config,
    title: 'Pricing - typeheard',
    description: 'Pay by the minute of audio. No subscription, minutes never expire.',
    canonical: `${config.siteUrl}/pricing`,
    body: `
<h1>Pay for the minutes you upload</h1>
<p class="lede">One minute of credit transcribes one minute of audio, rounded up per file.
No subscription, nothing to cancel, and minutes never expire. The first ${free} minutes of
any file stay free whether you have credit or not.</p>

<div class="card">
<p style="margin:0 0 14px"><label for="chain" class="muted">Pay with</label><br>
<select id="chain" style="margin-top:6px">${options}</select></p>
<table>
<tr><th>Top up</th><th>Minutes</th><th>Works out at</th><th></th></tr>
${rows}
</table>
<p id="buyerr" class="muted" style="margin:14px 0 0"></p>
</div>

<h2>Compared with a monthly plan</h2>
<p class="muted">Subscription transcription tools charge every month whether you have
twelve thesis interviews or none. Here a five-dollar top-up is five hours of audio and it is
still there next semester.</p>

<h2>Agents</h2>
<p class="muted">An agent needs none of the above. <code>POST /api/v1/transcripts</code> answers
<code>402</code> with an x402 offer, $${(config.x402.priceCents / 100).toFixed(2)} for a file up to
${config.x402.maxMinutes} minutes, settled in USDC with no account. See the <a href="/docs">API docs</a>.</p>

<script>
const err=document.getElementById('buyerr');
document.querySelectorAll('button[data-cents]').forEach(b=>b.addEventListener('click',async()=>{
  const was=b.textContent;b.disabled=true;b.textContent='Starting…';err.textContent='';
  try{const body=new FormData();body.append('cents',b.dataset.cents);body.append('chain',document.getElementById('chain').value);
    const res=await fetch('/api/topup',{method:'POST',body});
    if(res.status===401){location.href='/signin';return}
    const j=await res.json().catch(()=>({}));
    if(j.checkout_url){location.href=j.checkout_url;return}
    err.textContent=(j.error||'could not start checkout')+(j.detail?' - '+j.detail:'');
  }catch(e){err.textContent='could not start checkout: '+e.message}
  finally{b.disabled=false;b.textContent=was}
}));
</script>`,
  });
}

/* -------------------------------------------------------------------- docs -- */

export function Docs({ config }) {
  const base = config.siteUrl;
  return page({
    config,
    title: 'API - typeheard',
    description:
      'Transcribe audio and video over HTTP, from the command line, or from an AI agent over MCP.',
    canonical: `${base}/docs`,
    body: `
<h1>API</h1>
<p class="lede">One upload, one id, five formats. Keys for people, x402 for agents,
and the same thing from a terminal or an MCP client.</p>

<h2>Upload</h2>
<pre>curl -F file=@interview.m4a -F language=auto \\
  -H "Authorization: Bearer $TYPEHEARD_API_KEY" \\
  ${base}/api/v1/transcripts</pre>
<p class="muted">Answers <code>202</code> with <code>{ id, status, status_url, url }</code>.
Without a key you get the first ${Math.round(config.pricing.previewSeconds / 60)} minutes free.
<code>tier=full</code> refuses with <code>402</code> rather than quietly giving you a preview;
<code>tier=preview</code> never spends.</p>

<h2>Wait, then read</h2>
<pre>curl ${base}/api/v1/transcripts/ID          # status: queued, running, done, failed
curl ${base}/api/v1/transcripts/ID/txt      # also md, srt, vtt, json</pre>

<h2>Command line</h2>
<pre>npx -y @profullstack/typeheard interview.m4a            # prints the text
npx -y @profullstack/typeheard talk.mp4 --format srt > talk.srt
npx -y @profullstack/typeheard login                    # saves an API key
npx -y @profullstack/typeheard tui                      # your transcripts, in the terminal</pre>

<h2>MCP</h2>
<pre>{ "mcpServers": { "typeheard": { "command": "npx", "args": ["-y", "@profullstack/typeheard-mcp"],
  "env": { "TYPEHEARD_API_KEY": "th_…" } } } }</pre>
<p class="muted">Tools: <code>transcribe_file</code>, <code>get_transcript</code>, <code>list_transcripts</code>.</p>

<h2>Agents without an account</h2>
<p class="muted">Send the upload with no key. A metered caller over the free allowance gets
<code>402</code> with an x402 offer; pay it and repeat the request with the payment header.
One payment covers a file up to ${config.x402.maxMinutes} minutes.</p>

<h2>Keys</h2>
<p class="muted">Make one at <a href="/account/keys">Account &rarr; API keys</a>. It is shown once.</p>`,
  });
}

/* ----------------------------------------------------------------- account -- */

function AccountNav(active) {
  const tabs = [
    ['/account', 'Minutes'],
    ['/account/history', 'Transcripts'],
    ['/account/keys', 'API keys'],
  ];
  return `<nav class="tabs">${tabs
    .map(
      ([href, label]) =>
        `<a href="${href}" class="${href === active ? 'tab on' : 'tab'}">${label}</a>`,
    )
    .join('')}</nav>`;
}

const PASSKEY_JS = `<script src="https://unpkg.com/@simplewebauthn/browser@13/dist/bundle/index.umd.min.js"></script>`;

export function Account({ user, balance, ledger, passkeys, config }) {
  const rows = ledger
    .map(
      (h) => `<tr><td>${h.delta > 0 ? '+' : ''}${h.delta}</td><td>${esc(h.reason)}</td>
         <td class="muted">${new Date(h.created_at).toISOString().slice(0, 16).replace('T', ' ')}</td></tr>`,
    )
    .join('');
  return page({
    config,
    title: 'Account - typeheard',
    description: 'Your minutes, transcripts and keys.',
    body: `
<h1>Account</h1>
<p class="lede">${esc(user.email)}</p>
${AccountNav('/account')}
<div class="card">
  <div class="muted">Minutes</div>
  <div class="big">${balance.toLocaleString()}</div>
  <p class="muted" style="margin:4px 0 0">One minute transcribes one minute of audio. They do not expire.</p>
  <p style="margin:14px 0 0"><a class="btn" href="/pricing">Top up</a> <a class="btn ghost" href="/">Transcribe a file</a></p>
</div>

<h2>Passkeys</h2>
<div class="card">
  <p class="muted" style="margin:0 0 12px">${passkeys.length ? `${passkeys.length} passkey${passkeys.length === 1 ? '' : 's'} on this account.` : 'None yet. A passkey signs you in with your fingerprint or face instead of an emailed link.'}</p>
  <button class="btn small" id="addkey">Add a passkey</button> <span id="keymsg" class="muted"></span>
</div>

<h2>History</h2>
<div class="card">
${ledger.length ? `<table><tr><th>Change</th><th>Reason</th><th>When</th></tr>${rows}</table>` : '<p class="muted" style="margin:0">Nothing yet.</p>'}
</div>
<form method="post" action="/auth/signout" style="margin-top:32px"><button class="btn ghost">Sign out</button></form>
${PASSKEY_JS}
<script>
document.getElementById('addkey').addEventListener('click',async()=>{const msg=document.getElementById('keymsg');
  try{const opts=await (await fetch('/auth/passkey/register/options',{method:'POST'})).json();
    const att=await SimpleWebAuthnBrowser.startRegistration({optionsJSON:opts});
    const r=await fetch('/auth/passkey/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(att)});
    const j=await r.json();msg.textContent=j.ok?'Added. Next time, sign in with it.':(j.error||'could not add it');
  }catch(e){msg.textContent=e.message}});
</script>`,
  });
}

export function History({ user, rows, config }) {
  const list = rows
    .map(
      (r) => `<tr>
        <td><a href="/t/${r.id}">${esc(r.title || r.filename || 'Transcript')}</a></td>
        <td class="muted">${mins(r.duration_sec)}${r.tier === 'preview' ? ' (preview)' : ''}</td>
        <td class="muted">${esc(r.status)}</td>
        <td class="muted">${new Date(r.created_at).toISOString().slice(0, 16).replace('T', ' ')}</td></tr>`,
    )
    .join('');
  return page({
    config,
    title: 'Transcripts - typeheard',
    description: 'Every transcript on this account.',
    body: `
<h1>Transcripts</h1>
<p class="lede">${esc(user.email)}</p>
${AccountNav('/account/history')}
${rows.length ? `<div class="card"><table><tr><th>File</th><th>Length</th><th>Status</th><th>When</th></tr>${list}</table></div>` : '<div class="card"><p class="muted" style="margin:0">Nothing yet. <a href="/">Transcribe a file</a>.</p></div>'}`,
  });
}

export function Keys({ user, keys, config }) {
  const keyRows = keys
    .map(
      (
        k,
      ) => `<tr><td><code>${esc(k.prefix)}&hellip;</code></td><td class="muted">${esc(k.name)}</td>
         <td class="muted">${k.last_used_at ? new Date(k.last_used_at).toISOString().slice(0, 10) : 'never used'}</td></tr>`,
    )
    .join('');
  return page({
    config,
    title: 'API keys - typeheard',
    description: 'Keys for the CLI, the MCP server and your own code.',
    body: `
<h1>API keys</h1>
<p class="lede">${esc(user.email)}</p>
${AccountNav('/account/keys')}
<div class="card">
${keys.length ? `<table><tr><th>Key</th><th>Name</th><th>Last used</th></tr>${keyRows}</table>` : '<p class="muted" style="margin:0 0 12px">No keys yet.</p>'}
<p style="margin:14px 0 0"><button class="btn" id="mk">Make a key</button></p>
<pre id="out" style="display:none"></pre>
</div>
<script>
document.getElementById('mk').addEventListener('click',async()=>{const r=await fetch('/account/keys',{method:'POST'});const j=await r.json();
const o=document.getElementById('out');o.style.display='block';o.textContent=j.key?j.key+'\\n\\nShown once. Put it in TYPEHEARD_API_KEY.':(j.error||'failed')});
</script>`,
  });
}

/* -------------------------------------------------------------------- auth -- */

export function SignIn({ config, error, signup = false }) {
  return page({
    config,
    title: `${signup ? 'Sign up' : 'Sign in'} - typeheard`,
    description: 'Sign in with an emailed link or a passkey. No passwords.',
    body: `
<h1>${signup ? 'Make an account' : 'Sign in'}</h1>
<p class="lede">${signup ? 'Put in your email and we will send a link. Clicking it makes the account; there is no password to choose.' : 'We will email you a link. If you added a passkey, use that instead.'}</p>
${error ? `<p class="note">${esc(error)}</p>` : ''}
<form class="card" method="post" action="/auth/link" style="max-width:460px">
  <label for="email" class="muted">Email</label>
  <input id="email" name="email" type="email" autocomplete="email webauthn" required style="margin:6px 0 14px">
  <button class="btn">Email me a link</button>
</form>
<p style="margin-top:18px"><button class="btn ghost" id="pk">Sign in with a passkey</button> <span id="pkmsg" class="muted"></span></p>
<p class="muted">${signup ? 'Already have one? <a href="/signin">Sign in</a>.' : 'New here? The same link makes an account: <a href="/signup">sign up</a>.'}</p>
${PASSKEY_JS}
<script>
document.getElementById('pk').addEventListener('click',async()=>{const msg=document.getElementById('pkmsg');
  try{const opts=await (await fetch('/auth/passkey/options',{method:'POST'})).json();
    const as=await SimpleWebAuthnBrowser.startAuthentication({optionsJSON:opts});
    const r=await fetch('/auth/passkey',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(as)});
    const j=await r.json();if(j.ok){location.href=j.next||'/account';return}msg.textContent=j.error||'that did not work';
  }catch(e){msg.textContent=e.message}});
</script>`,
  });
}

export function Sent({ email, config }) {
  return page({
    config,
    title: 'Check your email - typeheard',
    description: 'A sign-in link is on its way.',
    body: `<h1>Check your email</h1>
<p class="lede">If ${esc(email) || 'that address'} can receive mail, a sign-in link is on its way.
It works once and expires in twenty minutes.</p>`,
  });
}

export function Gone({ config }) {
  return page({
    config,
    title: 'Gone - typeheard',
    description: 'This transcript has expired or was deleted.',
    body: `<h1>That transcript is gone</h1>
<p class="lede">It expired or was deleted. Free previews are kept for ${config.retention.anonDays} days.</p>
<p><a class="btn" href="/">Transcribe a file</a></p>`,
  });
}

export function NotFound({ config } = {}) {
  return page({
    config,
    title: 'Not found - typeheard',
    description: 'Nothing here.',
    body: `<h1>Nothing here</h1><p class="lede"><a href="/">Back to the start</a>.</p>`,
  });
}
