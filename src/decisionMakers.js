const { crawlSite } = require('./scraper');
const { findLinkedInProfiles } = require('./linkedinFinder');
const { parseJsonResponse } = require('./jsonUtil');

const SYSTEM_PROMPT = `Given text scraped from a company's own website (About/Team/Leadership pages), extract key decision-makers who WORK AT this company — founders, C-level executives, and senior leadership.
Respond with ONLY valid JSON, no markdown fences: { "people": [{ "name": string, "title": string }] }
Rules:
- Only include people with a specific, substantive leadership title (e.g. "Founder", "CEO", "CTO", "VP of Engineering") actually stated in the text. Reject vague/generic labels like "Contact Person", "Representative", or "Team Member" — those are not real titles.
- CRITICAL: only include people clearly identified as working AT this company itself. Pages often mention other people incidentally — partners, integration contacts, quoted customers, case-study subjects, testimonial authors, or people at OTHER companies. Do not include any of those, even if they have an impressive title, unless the text clearly states they are part of THIS company's own team.
- Do not invent people, titles, or names not present in the text.
- Return at most 3 people, founders/CEO first if present.
- If no named individuals clearly on this company's own leadership team are found, return an empty array — an empty result is correct and expected when the page doesn't describe this company's own team.`;

async function extractPeople(text) {
  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey) throw new Error('SARVAM_API_KEY is not set');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  let response;
  try {
    response = await fetch('https://api.sarvam.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'api-subscription-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'sarvam-105b',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: text.slice(0, 40000) },
        ],
        temperature: 0.2,
        max_tokens: 500,
        reasoning_effort: null,
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Sarvam API error ${response.status}: ${errBody}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content ?? '';

  try {
    const parsed = parseJsonResponse(content);
    return Array.isArray(parsed.people) ? parsed.people : [];
  } catch {
    return [];
  }
}

// One outreach contact per company, not a grab-bag of everyone on the leadership page —
// ranked by who actually makes buying decisions: CEO first, then CTO, then any other
// manager-level title, then other leadership (founder/president/head of.../owner).
const TITLE_PRIORITY = [
  /\bchief executive|\bceo\b/i,
  /\bchief technology|\bcto\b/i,
  /\bmanager\b/i,
  /\bfounder|\bpresident|\bhead of|\bmanaging director|\bowner\b/i,
];

function titleRank(title) {
  if (!title) return TITLE_PRIORITY.length;
  const rank = TITLE_PRIORITY.findIndex((pattern) => pattern.test(title));
  return rank === -1 ? TITLE_PRIORITY.length : rank;
}

// Primary: real people's public LinkedIn profiles via search snippets — far more reliable
// than crawling a company's own site, confirmed in testing (a company's "About" page
// crawl found zero named leadership for Stripe; a LinkedIn search immediately surfaced
// their actual CEO and President with correct titles). Fallback: crawlSite already
// prioritizes "about"/"team"/"company" pages (see PRIORITY_KEYWORDS in scraper.js), used
// for companies with a real, simple leadership page but weak LinkedIn presence in search.
async function findDecisionMakers(companyName, websiteUrl) {
  const fromLinkedIn = await findLinkedInProfiles(companyName).catch(() => []);

  // Only pay for the (slower, less reliable) website crawl when LinkedIn found nothing —
  // it's a genuine fallback, not a second pass that always runs regardless.
  const fromWebsite = fromLinkedIn.length
    ? []
    : await crawlSite(websiteUrl, { maxPages: 5 }).then((pages) =>
        pages.length ? extractPeople(pages.map((p) => `=== PAGE: ${p.url} ===\n${p.text}`).join('\n\n')) : []
      );

  const seen = new Set(fromLinkedIn.map((p) => p.name.toLowerCase()));
  const merged = [...fromLinkedIn];
  for (const person of fromWebsite) {
    if (seen.has(person.name.toLowerCase())) continue;
    seen.add(person.name.toLowerCase());
    merged.push(person);
  }

  if (!merged.length) return [];
  const best = merged.slice().sort((a, b) => titleRank(a.title) - titleRank(b.title))[0];
  return [best];
}

module.exports = { findDecisionMakers };
