const crypto = require('crypto');

// Holds accumulated state across a multi-step pipeline run (company -> competitors ->
// campaigns -> customers -> decision-makers -> emails). In-memory, same caveat as
// jobStore.js: lost on restart, no expiry yet.
const sessions = new Map();

function createSession() {
  const id = crypto.randomUUID();
  sessions.set(id, { createdAt: Date.now() });
  return id;
}

function getSession(id) {
  return sessions.get(id);
}

function updateSession(id, patch) {
  const current = sessions.get(id);
  if (current) sessions.set(id, { ...current, ...patch });
}

module.exports = { createSession, getSession, updateSession };
