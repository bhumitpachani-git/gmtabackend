const { parseJsonResponse } = require('./jsonUtil');

const SYSTEM_PROMPT = `You are a go-to-market strategist. Given structured details about a business, define realistic outbound campaigns targeting customer segments this business could find as leads.
Respond with ONLY valid JSON, no markdown fences, matching this exact shape:
{
  "segments": [
    { "searchQuery": string, "reason": string, "type": "local" | "online", "pain": string, "criteria": string[] }
  ]
}
Rules:
- Propose 2 to 4 segments/campaigns.
- "type" is "local" if the segment is a TYPE OF PHYSICAL, IN-PERSON BUSINESS findable on Google Maps (e.g. restaurants, dental clinics, boutique hotels, gyms) — pick "local" only when the customer is genuinely a walk-in/physical-location type of business.
- "type" is "online" if the segment is a TYPE OF COMPANY that operates primarily online / has no relevant physical storefront (e.g. SaaS startups, e-commerce brands, marketing agencies, software companies) — this is the right choice whenever the customer would be found via their website/company presence, not a Maps listing.
- "searchQuery" must be a short search term for that segment (e.g. "restaurants", "SaaS startups", "e-commerce brands") — not the business's own name or industry jargon.
- "reason" is one sentence explaining why that segment is a fit, based only on the given business details.
- "pain" is one short sentence stating the specific problem this segment has that the sender's business solves — phrased as the customer's problem, not a sales pitch.
- "criteria" is an array of 2-4 short (3-6 word) qualifying signals that make a specific company/business a good fit for this campaign (e.g. "Video-first business model", "Small internal team").
- Do not invent facts about the business that are not present in the input.`;

async function generateCustomerSegments(details) {
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
          { role: 'user', content: JSON.stringify(details) },
        ],
        temperature: 0.4,
        max_tokens: 1000,
        reasoning_effort: null, // same fix as sarvam.js — avoid empty content from thinking-mode token burn
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
    return Array.isArray(parsed.segments) ? parsed.segments : [];
  } catch {
    return [];
  }
}

module.exports = { generateCustomerSegments };
