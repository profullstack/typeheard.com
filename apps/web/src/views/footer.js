/**
 * The site's own footer row plus the pit.world network footer, fetched
 * server-side from pit.world/snippets.
 *
 * The page templates are synchronous, so a middleware calls refreshFooter()
 * before the handlers run and the pages read the last fetched string. Only the
 * very first fetch is awaited (3 s timeout); after that a copy older than an
 * hour refreshes in the background and a failed fetch keeps the stale copy.
 * With no copy at all the network footer is simply left out.
 */
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
  if (Date.now() - fetchedAt < TTL_MS) return;
  const p = fetchPit();
  if (first) {
    first = false;
    await p;
  }
}

export const siteFooter = () => `<footer class="wrap foot">
  <span>&copy; ${new Date().getFullYear()} Profullstack, Inc. &middot; MIT &middot; audio is deleted once transcribed</span>
  <a href="/pricing">Pricing</a>
  <a href="/docs">API</a>
  <a href="/llms.txt">llms.txt</a>
  <a href="https://github.com/profullstack/typeheard.com">Source</a>
</footer>
${pit}`;
