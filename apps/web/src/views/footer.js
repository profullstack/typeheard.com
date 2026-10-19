/**
 * The site footer is the shared Profullstack footer (@profullstack/footer:
 * links, the << Profullstack >> webring and one copyright line, from the
 * template published on jsDelivr @latest, laid out as one wrapping row), then
 * the pit.world network footer, fetched server-side from pit.world/snippets.
 * Both render on the server: the ring verifier reads HTML and runs no script.
 *
 * The page templates are synchronous, so a middleware calls refreshFooter()
 * before the handlers run and the pages read the last fetched string. Only the
 * very first fetch is awaited (3 s timeout); after that a copy older than an
 * hour refreshes in the background and a failed fetch keeps the stale copy.
 * With no copy at all the network footer is simply left out.
 */
import { footerHtml, footerHtmlSync } from '@profullstack/footer';

const PFS_OPTIONS = {
  site: 'https://typeheard.com/',
  links: [
    { label: 'Pricing', href: '/pricing' },
    { label: 'API', href: '/docs' },
    { label: 'llms.txt', href: '/llms.txt' },
    { label: 'Source', href: 'https://github.com/profullstack/typeheard.com' },
  ],
  tagline: 'MIT licensed. Audio is deleted once transcribed',
};

let pfs = footerHtmlSync(PFS_OPTIONS);

const PIT_FOOTER_URL = 'https://pit.world/snippets/footer.html?site=typeheard.com';
const TTL_MS = 60 * 60 * 1000;

let pit = '';
let fetchedAt = 0;
let inflight = null;
let first = true;

function fetchPit() {
  inflight ??= fetch(PIT_FOOTER_URL, { signal: AbortSignal.timeout(3000) })
    .then(async (res) => {
      if (!res.ok) throw new Error(`pit footer ${res.status}`);
      const text = await res.text();
      if (!text.includes('data-pit-footer')) throw new Error('pit footer: unexpected body');
      pit = text;
      fetchedAt = Date.now();
    })
    .catch(() => {})
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export async function refreshFooter() {
  try {
    // Cached by the package, so this only fetches when its copy is stale.
    pfs = await footerHtml(PFS_OPTIONS);
  } catch {
    // Keep the last good footer.
  }
  if (Date.now() - fetchedAt < TTL_MS) return;
  const p = fetchPit();
  if (first) {
    first = false;
    await p;
  }
}

export const siteFooter = () => `${pfs}
${pit}`;
