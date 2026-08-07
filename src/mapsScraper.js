const { launchBrowser } = require('./browserLauncher');

const FEED_SELECTOR = 'div[role="feed"]';

async function dismissConsentIfPresent(page) {
  try {
    const buttons = await page.$$('button');
    for (const btn of buttons) {
      const label = await page.evaluate((el) => el.textContent || '', btn);
      if (/accept all|i agree|reject all/i.test(label)) {
        await btn.click().catch(() => {});
        break;
      }
    }
  } catch {
    // Consent dialog not present or already dismissed — fine to continue.
  }
}

async function extractCards(page) {
  return page.evaluate((feedSelector) => {
    const feed = document.querySelector(feedSelector);
    if (!feed) return [];

    const cards = Array.from(feed.querySelectorAll('a[href*="/maps/place/"]'));
    return cards.map((anchor) => {
      const container = anchor.closest('div[role="article"]') || anchor.parentElement;
      const text = container ? container.innerText : anchor.textContent || '';
      return {
        name: anchor.getAttribute('aria-label') || null,
        mapsUrl: anchor.href,
        rawText: text.replace(/\n{2,}/g, '\n').trim(),
      };
    });
  }, FEED_SELECTOR);
}

function parseCard(card) {
  const lines = card.rawText.split('\n').map((l) => l.trim()).filter(Boolean);
  const ratingLine = lines.find((l) => /^\d\.\d$/.test(l));
  const rating = ratingLine || null;

  // Google renders category + address on one line like "Buffet restaurant ·  · 123 Some Rd".
  // Hours-status lines ("Open · Closes 11pm") also contain "·" so exclude those explicitly.
  const infoLine = lines.find((l) => l.includes('·') && !/^(open|closed)/i.test(l));
  const infoParts = infoLine
    ? infoLine.split('·').map((p) => p.trim()).filter(Boolean)
    : [];
  const category = infoParts[0] || null;
  const address =
    infoParts.length > 1 && infoParts[infoParts.length - 1] !== category
      ? infoParts[infoParts.length - 1]
      : null;

  const websiteLine = lines.find((l) => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(l));

  return {
    name: card.name,
    rating,
    category,
    address,
    website: websiteLine || null,
    mapsUrl: card.mapsUrl,
  };
}

function mergeUnique(existing, incoming, maxResults) {
  const seen = new Set(existing.map((r) => r.mapsUrl));
  for (const item of incoming) {
    if (existing.length >= maxResults) break;
    if (!item.mapsUrl || seen.has(item.mapsUrl)) continue;
    seen.add(item.mapsUrl);
    existing.push(parseCard(item));
  }
}

async function scrapeGoogleMaps(query, location, { maxResults = 20, maxDurationMs = 90000 } = {}) {
  const browser = await launchBrowser();
  const startedAt = Date.now();
  const results = [];

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
    );
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (['image', 'font', 'media'].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    const searchTerm = `${query} in ${location}`;
    await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(searchTerm)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });

    await dismissConsentIfPresent(page);
    await page.waitForSelector(FEED_SELECTOR, { timeout: 15000 }).catch(() => {});

    let stableRounds = 0;

    while (results.length < maxResults && stableRounds < 3) {
      if (Date.now() - startedAt > maxDurationMs) break;

      const before = results.length;
      const cards = await extractCards(page);
      mergeUnique(results, cards, maxResults);

      stableRounds = results.length === before ? stableRounds + 1 : 0;

      await page.evaluate((sel) => {
        const feed = document.querySelector(sel);
        if (feed) feed.scrollTop = feed.scrollHeight;
      }, FEED_SELECTOR);

      await new Promise((r) => setTimeout(r, 1200));
    }
  } finally {
    await browser.close();
  }

  // mapsUrl stays on the working objects for dedup during scrolling (mergeUnique) but the
  // product never needs users to click through to Maps — strip it from what we return.
  return results.slice(0, maxResults).map(({ mapsUrl, ...lead }) => lead);
}

module.exports = { scrapeGoogleMaps };
