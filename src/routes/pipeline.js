const express = require('express');
const puppeteer = require('puppeteer');
const { crawlSite } = require('../scraper');
const { analyzeBusiness } = require('../sarvam');
const { generateCustomerSegments } = require('../customerSegments');
const { findCompetitors } = require('../competitorFinder');
const { scrapeGoogleMaps } = require('../mapsScraper');
const { searchCompanies, guessAndVerifyDomain } = require('../companySearch');
const { findDecisionMakers } = require('../decisionMakers');
const { findContactInfoForPerson } = require('../emailFinder');
const { writeOutreachEmail } = require('../emailWriter');
const { deriveLocation } = require('../locationUtil');
const { createJob, updateJob, getJob } = require('../jobStore');
const { createSession, getSession, updateSession } = require('../sessionStore');

const router = express.Router();

// Every step follows the same shape: validate the session has what this step needs,
// respond 202 with a jobId immediately, run the real work in the background, and store
// the result on the session so the next step can build on it.
function startJob(work) {
  const jobId = createJob();
  work()
    .then((result) => updateJob(jobId, { status: 'done', result }))
    .catch((err) => updateJob(jobId, { status: 'error', error: err.message }));
  return jobId;
}

router.get('/pipeline/jobs/:jobId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

router.get('/pipeline/:sessionId', (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(session);
});

// Step 1 — resolve the business's own site into a structured profile.
router.post('/pipeline/start', (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Provide a "url" string in the request body' });
  }

  const sessionId = createSession();
  const jobId = startJob(async () => {
    const pages = await crawlSite(url, { maxPages: 12 });
    if (!pages.length) throw new Error('Could not read any pages from this site');

    const combinedText = pages.map((p) => `=== PAGE: ${p.url} ===\n${p.text}`).join('\n\n');
    const details = await analyzeBusiness(combinedText);

    updateSession(sessionId, { url, company: details });
    return { company: details };
  });

  res.status(202).json({ sessionId, jobId });
});

// Step 2 — explore competitors.
router.post('/pipeline/:sessionId/competitors', (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (!session.company) return res.status(409).json({ error: 'Run POST /pipeline/start first' });

  const jobId = startJob(async () => {
    const competitors = await findCompetitors(session.company);
    updateSession(req.params.sessionId, { competitors });
    return { competitors };
  });

  res.status(202).json({ jobId });
});

// Step 3 — define campaigns (customer segments with pain point + qualifying criteria).
router.post('/pipeline/:sessionId/campaigns', (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (!session.company) return res.status(409).json({ error: 'Run POST /pipeline/start first' });

  const jobId = startJob(async () => {
    const campaigns = await generateCustomerSegments(session.company);
    updateSession(req.params.sessionId, { campaigns });
    return { campaigns };
  });

  res.status(202).json({ jobId });
});

// Step 4 — find potential customers for the chosen campaign(s).
router.post('/pipeline/:sessionId/customers', (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (!session.campaigns) return res.status(409).json({ error: 'Run POST /pipeline/:sessionId/campaigns first' });

  const { campaignIndexes, maxPerCampaign } = req.body;
  const indexes =
    Array.isArray(campaignIndexes) && campaignIndexes.length
      ? campaignIndexes
      : session.campaigns.map((_, i) => i);
  const limit = Math.min(Math.max(Number(maxPerCampaign) || 8, 1), 20);

  const jobId = startJob(async () => {
    const location = deriveLocation(session.company);
    const customers = [];

    for (const idx of indexes) {
      const campaign = session.campaigns[idx];
      if (!campaign) continue;

      // One campaign's search failing (timeout, blocked request, etc.) must not lose
      // results already collected from other campaigns in this same batch.
      try {
        if (campaign.type === 'local') {
          if (!location) {
            customers.push({ campaignIndex: idx, type: 'local', error: 'No location available for this campaign' });
            continue;
          }
          const leads = await scrapeGoogleMaps(campaign.searchQuery, location, { maxResults: limit });
          for (const lead of leads) {
            // Maps doesn't always show a website even when one exists — guess-and-verify
            // from the name so a missing Maps field doesn't block email-finding downstream.
            const website = lead.website || (lead.name ? await guessAndVerifyDomain(lead.name) : null);
            customers.push({ campaignIndex: idx, type: 'local', ...lead, website });
          }
        } else {
          const companies = await searchCompanies(campaign.searchQuery, { maxResults: limit });
          companies.forEach((company) => customers.push({ campaignIndex: idx, type: 'online', ...company }));
        }
      } catch (err) {
        customers.push({ campaignIndex: idx, type: campaign.type, error: err.message });
      }
    }

    updateSession(req.params.sessionId, { customers, location });
    return { customers, location };
  });

  res.status(202).json({ jobId });
});

// Step 5 — find named decision-makers at the chosen customer companies.
router.post('/pipeline/:sessionId/decision-makers', (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (!session.customers) return res.status(409).json({ error: 'Run POST /pipeline/:sessionId/customers first' });

  const { customerIndexes } = req.body;
  const indexes =
    Array.isArray(customerIndexes) && customerIndexes.length
      ? customerIndexes
      : session.customers.map((_, i) => i);

  const jobId = startJob(async () => {
    const decisionMakers = [];

    for (const idx of indexes) {
      const customer = session.customers[idx];
      if (!customer || !customer.website) continue;

      const people = await findDecisionMakers(customer.name, customer.website).catch(() => []);
      people.forEach((person) =>
        decisionMakers.push({
          customerIndex: idx,
          company: customer.name,
          website: customer.website,
          personName: person.name,
          personTitle: person.title,
          personLinkedIn: person.linkedinUrl || null,
        })
      );
    }

    updateSession(req.params.sessionId, { decisionMakers });
    return { decisionMakers };
  });

  res.status(202).json({ jobId });
});

// Step 6 — write a personalized email per decision-maker.
router.post('/pipeline/:sessionId/emails', (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (!session.decisionMakers) {
    return res.status(409).json({ error: 'Run POST /pipeline/:sessionId/decision-makers first' });
  }

  const { personIndexes } = req.body;
  const indexes =
    Array.isArray(personIndexes) && personIndexes.length
      ? personIndexes
      : session.decisionMakers.map((_, i) => i);

  const jobId = startJob(async () => {
    const browser = await puppeteer.launch({ headless: 'new' });
    const emails = [];

    try {
      for (const idx of indexes) {
        const person = session.decisionMakers[idx];
        if (!person || !person.personName) continue;

        // One person's lookup timing out/erroring must not discard the whole batch —
        // same isolation principle already used for step 5's per-company crawl.
        try {
          const [firstName, ...rest] = person.personName.split(' ');
          const contact = await findContactInfoForPerson(browser, person.website, firstName, rest.join(' '));

          const outreachEmail = contact.email
            ? await writeOutreachEmail(session.company, {
                name: person.company,
                personName: person.personName,
                personTitle: person.personTitle,
              })
            : null;

          emails.push({
            personIndex: idx,
            company: person.company,
            personName: person.personName,
            personTitle: person.personTitle,
            personLinkedIn: person.personLinkedIn || null,
            email: contact.email,
            emailSource: contact.emailSource,
            phone: contact.phone,
            outreachEmail,
          });
        } catch (err) {
          emails.push({
            personIndex: idx,
            company: person.company,
            personName: person.personName,
            personTitle: person.personTitle,
            personLinkedIn: person.personLinkedIn || null,
            email: null,
            emailSource: null,
            phone: null,
            outreachEmail: null,
            error: err.message,
          });
        }
      }
    } finally {
      await browser.close();
    }

    // A person with neither a phone nor an email is not a usable result — the whole point
    // of this step is delivering something to call or write to.
    const contactableEmails = emails.filter((e) => e.phone || e.email);

    updateSession(req.params.sessionId, { emails: contactableEmails });
    return { emails: contactableEmails };
  });

  res.status(202).json({ jobId });
});

module.exports = router;
