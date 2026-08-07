const { searchCompanies } = require('./companySearch');
const { parseJsonResponse } = require('./jsonUtil');

const QUERY_SYSTEM_PROMPT = `Given structured details about a business, produce ONE short web-search query (5-10 words) that would surface this business's real, direct competitors — other companies offering a similar product/service to a similar audience.
Respond with ONLY valid JSON, no markdown fences: { "query": string }
Rules:
- Do NOT include the business's own name in the query — a name-only search is unreliable for smaller/lesser-known companies (it surfaces unrelated businesses with a similar-sounding name instead of real competitors).
- Base the query only on the given "whatTheyDo"/"keyFeatures"/"targetAudience" fields — describe the industry/service, not the brand.`;

async function generateCompetitorQuery(details) {
  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey) throw new Error('SARVAM_API_KEY is not set');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  const input = {
    whatTheyDo: details.whatTheyDo,
    keyFeatures: details.keyFeatures,
    targetAudience: details.targetAudience,
  };

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
          { role: 'system', content: QUERY_SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify(input) },
        ],
        temperature: 0.3,
        max_tokens: 200,
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
    return parsed.query || null;
  } catch {
    return null;
  }
}

// Same search+classify infrastructure as finding customers — grounded in what the
// business actually does, not its name (a name-only search is unreliable for
// smaller/lesser-known companies, confirmed during testing: searching "Aavrti competitors"
// surfaced unrelated chemical/energy companies with no connection to an IT agency).
async function findCompetitors(details, { maxResults = 12 } = {}) {
  const query = await generateCompetitorQuery(details);
  if (!query) return [];

  const results = await searchCompanies(query, { maxResults });
  return results.filter((c) => c.name.toLowerCase() !== (details.companyName || '').toLowerCase());
}

module.exports = { findCompetitors };
