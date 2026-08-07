const { parseJsonResponse } = require('./jsonUtil');

const SYSTEM_PROMPT = `Extract a list of real, distinct company/business names mentioned in this article or listing text. Respond with ONLY valid JSON, no markdown fences: { "companies": string[] }
Rules:
- Only include actual company names the text is describing as businesses — not generic terms, not the publishing site's own name, not job-board/navigation text (e.g. "View Profile", "Log In").
- Do not invent companies not present in the text.
- Return at most 15, most-clearly-a-real-company first.`;

async function extractCompanyNames(text) {
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
        max_tokens: 800,
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
    return Array.isArray(parsed.companies) ? parsed.companies : [];
  } catch {
    return [];
  }
}

module.exports = { extractCompanyNames };
