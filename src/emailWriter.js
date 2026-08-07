const { parseJsonResponse } = require('./jsonUtil');

const SYSTEM_PROMPT = `You are a professional B2B sales copywriter. Write a short, personalized cold outreach email from a sender business to a lead, pitching the sender's product/service to the lead as a potential customer.
Respond with ONLY valid JSON, no markdown fences, matching this exact shape:
{ "subject": string, "body": string }
Rules:
- If "lead.personName" is given, address the email to that person by first name and reference their title/role naturally — write it as if reaching out to that specific decision-maker, not the company in the abstract.
- If "lead.personName" is not given, address the email to the business itself (by name/category), as if researched individually.
- Reference what the sender's business actually does, using only the facts given — do not invent features, claims, or pricing not present in the input.
- Professional, concise tone. Body under 150 words.
- End with one clear, low-friction call to action (e.g. a quick call or demo).
- Write it as a ready-to-send email — no placeholder brackets like "[Name]" or "[Company]".`;

async function writeOutreachEmail(senderDetails, lead) {
  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey) throw new Error('SARVAM_API_KEY is not set');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  const input = {
    sender: {
      companyName: senderDetails.companyName,
      whatTheyDo: senderDetails.whatTheyDo,
      keyFeatures: senderDetails.keyFeatures,
      positioning: senderDetails.positioning,
    },
    lead: {
      name: lead.name,
      category: lead.category,
      address: lead.address,
      personName: lead.personName || null,
      personTitle: lead.personTitle || null,
    },
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
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify(input) },
        ],
        temperature: 0.6,
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
    // A short/truncated generation can still be valid JSON (seen in testing: a body of just
    // "Hi Tasty Burger team," — four words, clearly cut off) — reject those as a failed draft
    // rather than handing back something unusable.
    if (!parsed.subject || !parsed.body || parsed.body.trim().length < 80) return null;
    return { subject: parsed.subject, body: parsed.body };
  } catch {
    return null;
  }
}

module.exports = { writeOutreachEmail };
