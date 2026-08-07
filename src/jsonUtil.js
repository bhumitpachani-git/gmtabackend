// Sarvam's system prompts all say "no markdown fences", but it doesn't always follow that
// instruction (confirmed in testing: a response wrapped in ```json ... ``` caused a valid
// response to be rejected as "not valid JSON"). Strip fences before parsing so formatting
// the model didn't quite follow doesn't fail an otherwise-good response.
function parseJsonResponse(content) {
  const stripped = content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  return JSON.parse(stripped);
}

module.exports = { parseJsonResponse };
