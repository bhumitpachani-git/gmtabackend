const net = require('net');
const dns = require('dns').promises;

// Same generic-mailbox patterns real email-finder tools try first, checked via a raw
// SMTP RCPT TO handshake against the domain's own mail server — no third-party API.
const GENERIC_PREFIXES = ['info', 'contact', 'hello', 'sales', 'support', 'admin', 'office', 'enquiries', 'team'];
const HELO_DOMAIN = 'lead-verify.local';

function waitForResponse(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      socket.removeListener('data', onData);
      reject(new Error('SMTP response timeout'));
    }, timeoutMs);

    function onData(chunk) {
      buffer += chunk.toString();
      const lines = buffer.split('\r\n').filter(Boolean);
      const last = lines[lines.length - 1];
      // A final response line has a space after the code; "250-" (with a dash) means more lines follow.
      if (last && /^\d{3} /.test(last)) {
        clearTimeout(timer);
        socket.removeListener('data', onData);
        resolve({ code: parseInt(last.slice(0, 3), 10), text: buffer });
      }
    }
    socket.on('data', onData);
  });
}

function probeAddress(mxHost, address, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: mxHost, port: 25 });
    socket.setTimeout(timeoutMs);
    let done = false;

    const finish = (value) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(value);
    };

    socket.on('timeout', () => finish(null));
    socket.on('error', () => finish(null));

    socket.on('connect', async () => {
      try {
        await waitForResponse(socket, timeoutMs); // 220 greeting
        socket.write(`EHLO ${HELO_DOMAIN}\r\n`);
        await waitForResponse(socket, timeoutMs);
        socket.write(`MAIL FROM:<verify@${HELO_DOMAIN}>\r\n`);
        await waitForResponse(socket, timeoutMs);
        socket.write(`RCPT TO:<${address}>\r\n`);
        const rcpt = await waitForResponse(socket, timeoutMs);
        finish(rcpt.code === 250);
      } catch {
        finish(null);
      }
    });
  });
}

async function resolveMxHost(domain) {
  try {
    const records = await dns.resolveMx(domain);
    records.sort((a, b) => a.priority - b.priority);
    return records[0]?.exchange || null;
  } catch {
    return null;
  }
}

// Shared core: given a domain and an ordered list of candidate addresses to try, detects
// catch-all servers first (so we don't trust a false-positive RCPT TO), then probes each
// candidate in order. Returns { email, verified } or null.
//
// `null` is reserved for the one case where we truly have nothing to offer: no mail server
// exists for this domain at all (MX lookup failed). Every other outcome — a definitive
// reject on every candidate, or an inconclusive/timed-out probe — still returns the single
// best-guess address rather than giving up, just marked verified:false. The goal here is
// maximum coverage (always hand back *something* to attempt sending to) with an honest
// confidence label, not maximum precision.
async function probeCandidates(domain, candidates, fallbackEmail, timeoutMs) {
  const mxHost = await resolveMxHost(domain);
  if (!mxHost) return null; // no mail server for this domain — genuinely nothing to guess

  const probeAddr = `probe-${Math.floor(Math.random() * 1e9)}-nonexistent@${domain}`;
  const catchAllAccepted = await probeAddress(mxHost, probeAddr, timeoutMs);

  if (catchAllAccepted === true) {
    return { email: fallbackEmail, verified: false };
  }

  for (const candidate of candidates) {
    const accepted = await probeAddress(mxHost, candidate, timeoutMs);
    if (accepted === true) {
      return { email: candidate, verified: true };
    }
  }

  // Connected to a real mail server but never got a definitive accept on any candidate
  // (rejects, or timeouts/greylisting) — still return the best guess, unverified, instead
  // of nothing.
  return { email: candidates[0] || fallbackEmail, verified: false };
}

// Returns { email, verified } — verified:true means the mail server explicitly accepted
// that exact address. verified:false means the domain is catch-all (accepts everything,
// so RCPT TO can't distinguish a real mailbox from a fake one) and this is just the most
// likely generic address, not a confirmed one.
async function findGenericEmail(domain, { timeoutMs = 8000 } = {}) {
  const candidates = GENERIC_PREFIXES.map((prefix) => `${prefix}@${domain}`);
  return probeCandidates(domain, candidates, `info@${domain}`, timeoutMs);
}

// Same idea, but targeted at a specific named person — tries the common name-based
// mailbox patterns companies actually use, most-likely-first.
async function findPersonEmail(domain, firstName, lastName, { timeoutMs = 8000 } = {}) {
  const f = firstName.toLowerCase().replace(/[^a-z]/g, '');
  const l = (lastName || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!f) return null;

  const candidates = l
    ? [
        `${f}.${l}@${domain}`,
        `${f}${l}@${domain}`,
        `${f[0]}${l}@${domain}`,
        `${f}@${domain}`,
        `${l}@${domain}`,
      ]
    : [`${f}@${domain}`];

  return probeCandidates(domain, candidates, `${f}@${domain}`, timeoutMs);
}

module.exports = { findGenericEmail, findPersonEmail };
