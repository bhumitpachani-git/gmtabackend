// DuckDuckGo wraps organic result links as duckduckgo.com/l/?uddg=<real-url>, and sponsored
// ad results as duckduckgo.com/y.js?ad_domain=<domain>&... (a click-tracking redirect, not
// a real URL at all) — confirmed in testing: an ad result for a "stripe" search came back
// with the tracker link itself as the "website". Some ads are *double*-wrapped — an
// organic-looking /l/?uddg= redirect whose decoded target is itself another
// duckduckgo.com/y.js ad link — also confirmed in testing, which is why this unwraps in a
// loop instead of stopping after one layer. If it can't reach a real, non-duckduckgo.com
// URL within a few hops, there's nothing real to extract, so it returns null rather than a
// link that isn't the company's actual site.
function resolveRealUrl(href) {
  let current = href;

  for (let hop = 0; hop < 5; hop++) {
    let u;
    try {
      u = new URL(current);
    } catch {
      return current;
    }

    if (!u.hostname.includes('duckduckgo.com')) return current;

    const uddg = u.searchParams.get('uddg');
    if (uddg) {
      current = decodeURIComponent(uddg);
      continue; // decoded target might itself be another duckduckgo.com wrapper
    }

    const adDomain = u.searchParams.get('ad_domain');
    if (adDomain) return `https://${adDomain}`;

    return null; // some other duckduckgo.com URL we can't resolve to a real site
  }

  return null; // too many hops — treat as unresolvable rather than loop forever
}

module.exports = { resolveRealUrl };
