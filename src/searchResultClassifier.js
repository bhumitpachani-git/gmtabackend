const { parseJsonResponse } = require('./jsonUtil');

const SYSTEM_PROMPT = `You are helping distinguish individual company homepages from media/listicle/directory pages in a set of web search results.
Respond with ONLY valid JSON, no markdown fences: { "companies": [{ "name": string, "website": string }], "articleCandidates": string[] }
Rules:
- "companies": results whose url IS a specific individual company's own website/homepage. Use a clean company name (not the raw page title) and copy the url exactly as given in the input.
- "articleCandidates": urls of results that are instead a media article, "top N" listicle, ranking, directory, or aggregator page ABOUT multiple companies (e.g. Forbes/TechCrunch/blog "X startups to watch" lists, Crunchbase/Tracxn directory pages, a list-making site's own homepage) — list just the url string, not a company object.
- A "top N" or "best X" article, or any page whose own business is publishing lists/rankings about other companies, is an articleCandidate — never a company, even if it superficially looks like a company site.
- Every result belongs to exactly one of the two lists.
- Do not invent companies or urls not present in the input.`;

async function classifySearchResults(results) {
  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey) throw new Error('SARVAM_API_KEY is not set');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  const input = results.map((r) => ({ title: r.title, url: r.href }));

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
          { role: 'user', content: JSON.stringify(input) },
        ],
        temperature: 0.1,
        max_tokens: 1200,
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
    return {
      companies: Array.isArray(parsed.companies) ? parsed.companies : [],
      articleCandidates: Array.isArray(parsed.articleCandidates) ? parsed.articleCandidates : [],
    };
  } catch {
    return { companies: [], articleCandidates: [] };
  }
}

module.exports = { classifySearchResults };
