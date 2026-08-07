const puppeteer = require('puppeteer');
const { crawlSite } = require('./scraper');
const { extractCompanyNames } = require('./companyExtractor');
const { classifySearchResults } = require('./searchResultClassifier');

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

async function ddgSearch(query) {
  const browser = await puppeteer.launch({ headless: 'new' });
  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
    );
    await page.goto(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });

    const results = await page.evaluate(() => {
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

    return results.map((r) => ({ ...r, href: resolveRealUrl(r.href) }));
  } finally {
    await browser.close();
  }
}

// Guesses "companyname.com" and confirms it actually loads before trusting it — never
// hands back a fabricated domain that wasn't verified to be reachable.
async function guessAndVerifyDomain(companyName) {
  const slug = companyName.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!slug) return null;

  const candidateUrl = `https://${slug}.com`;
  const pages = await crawlSite(candidateUrl, { maxPages: 1, pageTimeoutMs: 8000, maxDurationMs: 10000 });
  if (!pages.length) return null;

  return candidateUrl;
}

async function searchCompanies(query, { maxResults = 8 } = {}) {
  const results = await ddgSearch(query);
  if (!results.length) return [];

  // Search results for "best/top X" queries are overwhelmingly media listicles ABOUT
  // companies, not individual company sites — an AI classifier separates the two far more
  // reliably than a static domain blocklist (which missed forbes.com, failory.com, etc.
  // during testing — those got wrongly treated as companies themselves).
  const classified = await classifySearchResults(results);
  // Attach the original search snippet as a real, non-fabricated description where we
  // can match it back to a source result (listicle-extracted companies won't have one).
  const companies = classified.companies.map((c) => {
    const source = results.find((r) => r.href === c.website);
    return { ...c, description: source?.snippet || null };
  });

  // Different listicle sites render differently — some (interactive widgets, e.g. Forbes'
  // list pages) barely have any company names in the plain crawled HTML, others (plain
  // blog-style posts) have them all in text. Try a few candidates, not just the first, and
  // accumulate across them until we hit maxResults.
  for (const articleUrl of classified.articleCandidates.slice(0, 4)) {
    if (companies.length >= maxResults) break;

    const pages = await crawlSite(articleUrl, { maxPages: 1 });
    if (!pages.length) continue;

    const names = await extractCompanyNames(pages[0].text);
    for (const name of names) {
      if (companies.length >= maxResults) break;
      if (companies.some((c) => c.name.toLowerCase() === name.toLowerCase())) continue;
      const website = await guessAndVerifyDomain(name);
      if (website) companies.push({ name, website, description: null });
    }
  }

  return companies.slice(0, maxResults);
}

// Leaner variant for "search as you type" — a direct name/domain lookup, not a broad
// industry/segment search, so the slower listicle-crawl fallback (several more seconds,
// several more AI calls) isn't worth it here. Real search + real AI classification, just
// capped tighter for responsiveness. Still measured in seconds, not instant — a real web
// search, not a pre-built company database lookup.
async function quickCompanySearch(query, { maxResults = 3 } = {}) {
  const results = await ddgSearch(query);
  if (!results.length) return [];

  const classified = await classifySearchResults(results);
  return classified.companies
    .map((c) => {
      const source = results.find((r) => r.href === c.website);
      return { ...c, description: source?.snippet || null };
    })
    .slice(0, maxResults);
}

module.exports = { searchCompanies, guessAndVerifyDomain, quickCompanySearch };
