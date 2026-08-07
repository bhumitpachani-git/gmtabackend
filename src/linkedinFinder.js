const puppeteer = require('puppeteer');

// DuckDuckGo's HTML result links are redirect wrappers (duckduckgo.com/l/?uddg=<real-url>).
function resolveRealUrl(href) {
  try {
    const u = new URL(href);
    const real = u.searchParams.get('uddg');
    return real ? decodeURIComponent(real) : href;
  } catch {
    return href;
  }
}

// LinkedIn result titles look like "Patrick Collison - Stripe CEO | LinkedIn" or
// "John Collison - President at Stripe | LinkedIn" — split off the name and role.
function parseProfile(result, companyName) {
  const title = result.title.replace(/\s*\|\s*LinkedIn\s*$/i, '').trim();
  const parts = title.split(/\s+-\s+/);
  if (parts.length < 2) return null;

  const name = parts[0].trim();
  const roleText = parts.slice(1).join(' - ').trim();
  if (!name || !roleText) return null;

  // Relevance filter — the search can surface same-titled people at unrelated companies,
  // including ones whose name happens to start with the target company's name (confirmed
  // in testing: a "Stripe" search surfaced someone at "Stripe Partners", a different firm).
  // Require the company name as a whole word that ISN'T immediately followed by another
  // capitalized word forming a longer, different proper name.
  const haystack = `${roleText} ${result.snippet || ''}`;
  const escaped = companyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const relevanceRegex = new RegExp(`\\b${escaped}\\b(?!\\s+[A-Z][a-z])`, 'i');
  if (!relevanceRegex.test(haystack)) return null;

  return { name, title: roleText, linkedinUrl: result.href };
}

// Finds real people's public LinkedIn profiles via search-result snippets — never visits
// linkedin.com itself, no login, no scraping their pages directly (that carries real
// ToS/ban risk and LinkedIn has sued scrapers before). This only reads what DuckDuckGo has
// already indexed publicly. Note: querying with the `site:linkedin.com/in` operator
// specifically trips DuckDuckGo's bot-detection error page (confirmed in testing) — a plain
// keyword search without that operator works reliably instead.
async function findLinkedInProfiles(companyName, { maxResults = 3 } = {}) {
  const browser = await puppeteer.launch({ headless: 'new' });
  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
    );

    const query = `linkedin.com/in ${companyName} founder CEO CTO executive director`;
    await page.goto(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });

    const rawResults = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('.result'))
        .map((r) => {
          const titleEl = r.querySelector('.result__title a, a.result__a');
          const snippetEl = r.querySelector('.result__snippet');
          return {
            title: titleEl ? titleEl.textContent.trim() : null,
            href: titleEl ? titleEl.href : null,
            snippet: snippetEl ? snippetEl.textContent.trim() : null,
          };
        })
        .filter((r) => r.title && r.href);
    });

    const profiles = [];
    for (const raw of rawResults) {
      const href = resolveRealUrl(raw.href);
      if (!href.includes('linkedin.com/in/')) continue;

      const parsed = parseProfile({ ...raw, href }, companyName);
      if (parsed) profiles.push(parsed);
      if (profiles.length >= maxResults) break;
    }

    return profiles;
  } finally {
    await browser.close();
  }
}

module.exports = { findLinkedInProfiles };
