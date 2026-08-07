const { parseJsonResponse } = require('./jsonUtil');

const SYSTEM_PROMPT = `You are a competitive-analysis assistant. You will receive text scraped from multiple pages of a single company's website, each labeled with its source URL. Extract structured business details. Respond with ONLY valid JSON, no markdown fences, matching this exact shape:
{
  "companyName": string,
  "whatTheyDo": string,
  "targetAudience": string,
  "keyFeatures": string[],
  "pricingPlans": [{ "name": string, "price": string, "billingPeriod": string, "included": string[] }],
  "priceRange": string,
  "positioning": string,
  "notableClaims": string[],
  "headquarters": { "country": string, "state": string, "city": string },
  "officeLocations": [{ "country": string, "city": string }],
  "contactInfo": { "email": string, "phone": string },
  "foundedYear": string,
  "teamSize": string,
  "socialLinks": string[]
}
Use null (or an empty array/string as appropriate) for any field not found in the text. Do not invent facts that are not present in the provided text.`;

async function analyzeBusiness(text) {
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
          { role: 'user', content: text.slice(0, 100000) },
        ],
        temperature: 0.3,
        max_tokens: 3000,
        // Thinking mode is on by default and its hidden reasoning tokens count against
        // max_tokens — on long inputs that silently eats the whole budget and leaves
        // `content` empty. We want direct JSON extraction, not reasoning, so disable it.
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

  if (!content.trim()) {
    throw new Error(
      `Sarvam returned an empty response (finish_reason: ${data.choices?.[0]?.finish_reason ?? 'unknown'})`
    );
  }

  try {
    return parseJsonResponse(content);
  } catch {
    throw new Error(`Sarvam response was not valid JSON: ${content.slice(0, 300)}`);
  }
}

module.exports = { analyzeBusiness };
