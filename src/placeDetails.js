const FEED_SELECTOR = 'div[role="feed"]';

// Navigating directly to a place's raw Maps URL (as harvested from search-result hrefs)
// does not reliably load the detail panel outside of an active browsing session — Google
// only populates it fully after an in-app click. So instead we run a fresh, independent
// search for "<name> <location>" and click the top result — slower per lookup, but each
// call is self-contained and doesn't depend on fragile SPA back/forward navigation state.
async function getPlaceDetails(browser, name, location, { timeoutMs = 20000 } = {}) {
  const page = await browser.newPage();
  try {
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (['image', 'font', 'media'].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    const searchTerm = `${name} ${location}`;
    await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(searchTerm)}`, {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs,
    });
    await new Promise((r) => setTimeout(r, 2000));

    const feed = await page.$(FEED_SELECTOR);
    if (feed) {
      const firstLink = await page.$(`${FEED_SELECTOR} a[href*="/maps/place/"]`);
      if (firstLink) {
        await firstLink.click();
        await new Promise((r) => setTimeout(r, 2500));
      }
    } else {
      // Google sometimes jumps straight to a single matching place with no result list.
      await new Promise((r) => setTimeout(r, 1500));
    }

    return await page.evaluate(() => {
      const get = (id) => {
        const el = document.querySelector(`[data-item-id="${id}"]`);
        return el ? (el.textContent || '').trim() : null;
      };
      const phoneEl = document.querySelector('[data-item-id^="phone:tel:"]');
      const websiteEl = document.querySelector('[data-item-id="authority"]');

      return {
        address: get('address'),
        phone: phoneEl ? (phoneEl.textContent || '').trim() : null,
        website: websiteEl ? websiteEl.getAttribute('href') : null,
      };
    });
  } catch {
    return { address: null, phone: null, website: null };
  } finally {
    await page.close().catch(() => {});
  }
}

module.exports = { getPlaceDetails };
