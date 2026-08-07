const { launchBrowser } = require('./browserLauncher');

const PRIORITY_KEYWORDS = [
  'pricing', 'plans', 'price',
  'about', 'company', 'team',
  'contact', 'location', 'office', 'offices',
  'product', 'features', 'solutions',
  'faq', 'customers', 'case-studies', 'clients',
];

const SKIP_EXTENSIONS = /\.(pdf|jpg|jpeg|png|gif|svg|zip|mp4|mp3|css|js|ico|woff2?|ttf)$/i;

function normalizeUrl(href) {
  try {
    const u = new URL(href);
    if (!/^https?:$/.test(u.protocol)) return null;
    u.hash = '';
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.slice(0, -1);
    }
    return u.toString();
  } catch {
    return null;
  }
}

function priorityScore(url) {
  const lower = url.toLowerCase();
  const idx = PRIORITY_KEYWORDS.findIndex((kw) => lower.includes(kw));
  return idx === -1 ? PRIORITY_KEYWORDS.length : idx;
}

async function extractPageData(page) {
  return page.evaluate(() => {
    document.querySelectorAll('script, style, noscript').forEach((el) => el.remove());
    const text = document.body.innerText.replace(/\n{3,}/g, '\n\n').trim();
    const links = Array.from(document.querySelectorAll('a[href]')).map((a) => a.href);
    return { text, links, title: document.title };
  });
}

async function crawlSite(
  startUrl,
  { maxPages = 12, delayMs = 300, pageTimeoutMs = 15000, maxDurationMs = 90000 } = {}
) {
  const origin = new URL(startUrl).origin;
  const browser = await launchBrowser();
  const pages = [];
  const visited = new Set();
  const queue = [normalizeUrl(startUrl)].filter(Boolean);
  const startedAt = Date.now();

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
    );
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      // Block heavy/irrelevant asset types so navigation settles fast — we only need text.
      if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    while (queue.length && pages.length < maxPages) {
      if (Date.now() - startedAt > maxDurationMs) break; // hard budget — always return something

      queue.sort((a, b) => priorityScore(a) - priorityScore(b));
      const url = queue.shift();
      if (!url || visited.has(url)) continue;
      visited.add(url);

      let text, links, title;
      try {
        // domcontentloaded, not networkidle2: chat widgets/analytics beacons never go
        // fully idle, which was silently eating the full timeout on every single page.
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: pageTimeoutMs });
        ({ text, links, title } = await extractPageData(page));
      } catch {
        continue;
      }

      if (text) pages.push({ url, title, text });

      for (const link of links) {
        const normalized = normalizeUrl(link);
        if (
          !normalized ||
          visited.has(normalized) ||
          queue.includes(normalized) ||
          !normalized.startsWith(origin) ||
          SKIP_EXTENSIONS.test(normalized)
        ) {
          continue;
        }
        queue.push(normalized);
      }

      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    }
  } finally {
    await browser.close();
  }

  return pages;
}

module.exports = { crawlSite };
