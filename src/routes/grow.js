const express = require('express');
const puppeteer = require('puppeteer');
const { crawlSite } = require('../scraper');
const { analyzeBusiness } = require('../sarvam');
const { generateCustomerSegments } = require('../customerSegments');
const { scrapeGoogleMaps } = require('../mapsScraper');
const { getPlaceDetails } = require('../placeDetails');
const { searchCompanies, guessAndVerifyDomain } = require('../companySearch');
const { findDecisionMakers } = require('../decisionMakers');
const { findContactInfo, findContactInfoForPerson } = require('../emailFinder');
const { writeOutreachEmail } = require('../emailWriter');
const { deriveLocation } = require('../locationUtil');
const { createJob, updateJob, getJob } = require('../jobStore');

const router = express.Router();

router.post('/grow', (req, res) => {
  const { url, maxSegments, maxLeadsPerSegment } = req.body;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Provide a "url" string in the request body' });
  }

  const segmentLimit = Math.min(Math.max(Number(maxSegments) || 1, 1), 4);
  const leadLimit = Math.min(Math.max(Number(maxLeadsPerSegment) || 5, 1), 20);
  const jobId = createJob();

  // One input (the business's own URL), everything else — category/segment choice,
  // target location, lead search, and contact enrichment — runs automatically.
  res.status(202).json({ jobId, status: 'processing' });

  runGrow(jobId, url, segmentLimit, leadLimit).catch((err) => {
    updateJob(jobId, { status: 'error', error: err.message });
  });
});

// "local" segments (restaurants, clinics, etc.) — findable on Google Maps.
async function processLocalSegment(segment, location, leadLimit, browser, details) {
  // Contact-less leads get dropped below, so search for more than requested up front —
  // otherwise a business with several dead-end leads would silently return fewer results
  // than asked for instead of backfilling with more candidates.
  const rawLeads = await scrapeGoogleMaps(segment.searchQuery, location, { maxResults: leadLimit * 2 });
  const enrichedLeads = [];

  for (const lead of rawLeads) {
    if (!lead.name) continue; // nothing to enrich, and it'll be dropped by the contact filter anyway

    // One lead's lookup timing out/erroring must not discard every other lead already
    // found in this same segment (confirmed as a real failure mode in testing: a single
    // aborted request was taking down the entire /grow job, not just that one lead).
    try {
      const placeDetails = await getPlaceDetails(browser, lead.name, location);
      // Maps doesn't always show a website even when one exists (it depends on whether the
      // business filled out that field in their profile) — guess-and-verify from the name
      // before giving up, so a missing Maps field doesn't mean a missing email entirely.
      const website = placeDetails.website || lead.website || (await guessAndVerifyDomain(lead.name));

      const contact = website
        ? await findContactInfo(browser, website)
        : { email: null, phone: null, emailSource: null };
      const phone = placeDetails.phone || contact.phone;

      const outreachEmail = contact.email
        ? await writeOutreachEmail(details, {
            name: lead.name,
            category: lead.category,
            address: placeDetails.address || lead.address,
          })
        : null;

      enrichedLeads.push({
        ...lead,
        address: placeDetails.address || lead.address,
        phone,
        website,
        email: contact.email,
        emailSource: contact.emailSource,
        outreachEmail,
      });
    } catch {
      // Dropped by the contact filter below anyway (no phone/email) — just move on.
      continue;
    }
  }

  // The whole point of this pipeline is delivering a number to call or an email to send —
  // a lead with neither is not a usable result, so it's dropped rather than returned as
  // filler with a wall of nulls.
  const contactableLeads = enrichedLeads.filter((l) => l.phone || l.email).slice(0, leadLimit);

  return { searchQuery: segment.searchQuery, reason: segment.reason, type: 'local', leads: contactableLeads };
}

// "online" segments (SaaS startups, agencies, etc.) — not on Maps, so: search for real
// companies, find a named decision-maker on their site, and email-guess by their name.
async function processOnlineSegment(segment, leadLimit, browser, details) {
  // Same over-search-then-filter reasoning as the local path — contact-less leads get
  // dropped below, so ask for more candidates up front to still land near leadLimit.
  const companies = await searchCompanies(segment.searchQuery, { maxResults: leadLimit * 2 });
  const enrichedLeads = [];

  for (const company of companies) {
    // Same per-item isolation as the local path — one company's lookup failing must not
    // discard every other company already enriched in this batch.
    try {
      const people = await findDecisionMakers(company.name, company.website).catch(() => []);
      const person = people[0] || null;

      let contact;
      if (person) {
        const [firstName, ...rest] = person.name.split(' ');
        contact = await findContactInfoForPerson(browser, company.website, firstName, rest.join(' '));
      } else {
        contact = await findContactInfo(browser, company.website);
      }

      const outreachEmail = contact.email
        ? await writeOutreachEmail(details, {
            name: company.name,
            category: segment.searchQuery,
            personName: person?.name || null,
            personTitle: person?.title || null,
          })
        : null;

      enrichedLeads.push({
        name: company.name,
        website: company.website,
        personName: person?.name || null,
        personTitle: person?.title || null,
        personLinkedIn: person?.linkedinUrl || null,
        phone: contact.phone,
        email: contact.email,
        emailSource: contact.emailSource,
        outreachEmail,
      });
    } catch {
      continue;
    }
  }

  const contactableLeads = enrichedLeads.filter((l) => l.phone || l.email).slice(0, leadLimit);

  return { searchQuery: segment.searchQuery, reason: segment.reason, type: 'online', leads: contactableLeads };
}

async function runGrow(jobId, url, segmentLimit, leadLimit) {
  updateJob(jobId, { status: 'processing', stage: 'analyzing_business' });

  const pages = await crawlSite(url, { maxPages: 12 });
  if (!pages.length) {
    updateJob(jobId, { status: 'error', error: 'Could not read any pages from this site' });
    return;
  }

  const combinedText = pages.map((p) => `=== PAGE: ${p.url} ===\n${p.text}`).join('\n\n');
  const details = await analyzeBusiness(combinedText);
  const segments = await generateCustomerSegments(details);
  const location = deriveLocation(details);

  updateJob(jobId, { status: 'processing', stage: 'finding_leads', location });

  const chosenSegments = segments.slice(0, segmentLimit);
  const browser = await puppeteer.launch({ headless: 'new' });
  const segmentResults = [];

  try {
    for (const segment of chosenSegments) {
      // A whole segment failing outright (e.g. the underlying search itself aborting,
      // not just one lead within it) must not discard results already collected from
      // other segments in this same job.
      try {
        if (segment.type === 'online') {
          segmentResults.push(await processOnlineSegment(segment, leadLimit, browser, details));
        } else if (location) {
          segmentResults.push(await processLocalSegment(segment, location, leadLimit, browser, details));
        } else {
          // "local"-type segment but no HQ/office address to search Maps against — skip just
          // this segment rather than failing the whole job (other segments may still work).
          segmentResults.push({
            searchQuery: segment.searchQuery,
            reason: segment.reason,
            type: 'local',
            leads: [],
            error: 'Skipped — no headquarters/office location found on this website to search Google Maps against.',
          });
        }
      } catch (err) {
        segmentResults.push({
          searchQuery: segment.searchQuery,
          reason: segment.reason,
          type: segment.type,
          leads: [],
          error: err.message,
        });
      }
    }
  } finally {
    await browser.close();
  }

  updateJob(jobId, {
    status: 'done',
    result: { url, business: details, location, segments: segmentResults },
  });
}

router.get('/grow/:jobId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

module.exports = router;
