const { findGenericEmail, findPersonEmail } = require('./emailPatternFinder');

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
// Requires a separator (space/dash/dot/parens) between the first digit group and the rest —
// a bare run of digits (or a plain decimal number like "1.69232905") must NOT match this,
// only real phone-formatted text with actual grouping.
const PHONE_REGEX = /(\+\d{1,3}[\s.-]?)?(\(\d{2,4}\)[\s.-]?|\d{2,4}[\s.-])\d{3,4}[\s.-]?\d{3,4}\b/;

async function extractContactFromPage(page) {
  return page.evaluate(
    (emailSrc, phoneSrc) => {
      const emailRegex = new RegExp(emailSrc);
      const phoneRegex = new RegExp(phoneSrc);

      const mailtoLink = document.querySelector('a[href^="mailto:"]');
      const email = mailtoLink
        ? mailtoLink.getAttribute('href').replace('mailto:', '').split('?')[0].trim()
        : (document.body.innerText.match(emailRegex) || [])[0] || null;

      const telLink = document.querySelector('a[href^="tel:"]');
      const phone = telLink
        ? telLink.getAttribute('href').replace('tel:', '').trim()
        : (document.body.innerText.match(phoneRegex) || [])[0] || null;

      return { email, phone };
    },
    EMAIL_REGEX.source,
    PHONE_REGEX.source
  );
}

function getDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

// An email found on a company's page is only trustworthy as "their" contact if it's
// actually @ that company's own domain — pages often mention partners, case studies, or
// integration contacts whose email belongs to a completely different company (this is
// exactly what happened during testing: a partner's email got wrongly attributed as the
// target company's own decision-maker).
function emailMatchesDomain(email, domain) {
  if (!email || !domain) return false;
  const emailDomain = email.split('@')[1]?.toLowerCase();
  return emailDomain === domain || emailDomain?.endsWith(`.${domain}`);
}

async function crawlForContact(browser, websiteUrl, { timeoutMs = 12000 } = {}) {
  const domain = getDomain(websiteUrl);
  const page = await browser.newPage();
  try {
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (['image', 'font', 'media', 'stylesheet'].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.goto(websiteUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    let contact = await extractContactFromPage(page);
    if (contact.email && !emailMatchesDomain(contact.email, domain)) contact.email = null;
    if (contact.email) return contact;

    const nextHref = await page.evaluate(() => {
      const link = Array.from(document.querySelectorAll('a[href]')).find(
        (a) =>
          /contact|about/i.test(a.textContent || '') || /contact|about/i.test(a.getAttribute('href') || '')
      );
      return link ? link.href : null;
    });

    if (nextHref) {
      await page.goto(nextHref, { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => {});
      const secondPass = await extractContactFromPage(page);
      if (secondPass.email && !emailMatchesDomain(secondPass.email, domain)) secondPass.email = null;
      contact = { email: contact.email || secondPass.email, phone: contact.phone || secondPass.phone };
    }

    return contact;
  } catch {
    return { email: null, phone: null };
  } finally {
    await page.close().catch(() => {});
  }
}

// Primary: crawl the site itself (real email, high confidence). Fallback: guess common
// generic mailboxes (info@, contact@, etc.) and verify each via SMTP — our own technique,
// no third-party lookup service — for domains that publish nothing but don't reject checks.
async function findContactInfo(browser, websiteUrl) {
  const crawled = await crawlForContact(browser, websiteUrl);
  if (crawled.email) {
    return { email: crawled.email, phone: crawled.phone, emailSource: 'website' };
  }

  let domain;
  try {
    domain = new URL(websiteUrl).hostname.replace(/^www\./, '');
  } catch {
    return { email: null, phone: crawled.phone, emailSource: null };
  }

  const guessed = await findGenericEmail(domain);
  if (!guessed) {
    return { email: null, phone: crawled.phone, emailSource: null };
  }

  return {
    email: guessed.email,
    phone: crawled.phone,
    emailSource: guessed.verified ? 'pattern-verified' : 'pattern-guess',
  };
}

// Same idea as findContactInfo, but for when we have a specific decision-maker's name —
// falls back to name-based patterns (first.last@) instead of generic ones (info@), since
// that's far more likely to be the real mailbox format a company actually uses.
async function findContactInfoForPerson(browser, websiteUrl, firstName, lastName) {
  const crawled = await crawlForContact(browser, websiteUrl);
  if (crawled.email) {
    return { email: crawled.email, phone: crawled.phone, emailSource: 'website' };
  }

  let domain;
  try {
    domain = new URL(websiteUrl).hostname.replace(/^www\./, '');
  } catch {
    return { email: null, phone: crawled.phone, emailSource: null };
  }

  const personGuess = await findPersonEmail(domain, firstName, lastName);
  // Only truly unreachable if there's no mail server for this domain at all — everything
  // else already comes back with a best-guess fallback (see emailPatternFinder.js). Still,
  // fall back to a generic company address as one more attempt before giving up entirely.
  const guessed = personGuess || (await findGenericEmail(domain));
  if (!guessed) {
    return { email: null, phone: crawled.phone, emailSource: null };
  }

  return {
    email: guessed.email,
    phone: crawled.phone,
    emailSource: guessed.verified ? 'pattern-verified' : 'pattern-guess',
  };
}

module.exports = { findContactInfo, findContactInfoForPerson };
