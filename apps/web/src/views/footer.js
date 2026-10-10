/**
 * The shared Profullstack footer (@profullstack/footer): links, copyright and the
 * webring nav, from the template published on jsDelivr @latest.
 *
 * The page templates are synchronous, so a middleware awaits footerHtml() before
 * the handlers run (it caches the template for an hour) and the pages read the
 * last rendered string. Until the first render, the bundled template stands in.
 */
import { footerHtml, footerHtmlSync } from '@profullstack/footer';

const OPTIONS = {
  site: 'https://typeheard.com/',
  links: [{ label: 'llms.txt', href: '/llms.txt' }],
  tagline: 'Open source, MIT',
};

let current = footerHtmlSync(OPTIONS);

export const siteFooter = () => current;

export async function refreshFooter() {
  try {
    current = await footerHtml(OPTIONS);
  } catch {
    // Keep the last good footer.
  }
}
