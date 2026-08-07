const express = require('express');
const { crawlSite } = require('../scraper');
const { analyzeBusiness } = require('../sarvam');
const { generateCustomerSegments } = require('../customerSegments');
const { createJob, updateJob, getJob } = require('../jobStore');

const router = express.Router();

router.post('/analyze', (req, res) => {
  const { url, maxPages } = req.body;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Provide a "url" string in the request body' });
  }

  const pageLimit = Math.min(Math.max(Number(maxPages) || 12, 1), 25);
  const jobId = createJob();

  // Respond immediately — the crawl+AI step runs in the background so this
  // request never stays open long enough to hit a client/proxy timeout.
  res.status(202).json({ jobId, status: 'processing' });

  runAnalysis(jobId, url, pageLimit).catch((err) => {
    updateJob(jobId, { status: 'error', error: err.message });
  });
});

async function runAnalysis(jobId, url, pageLimit) {
  try {
    const pages = await crawlSite(url, { maxPages: pageLimit });

    if (!pages.length) {
      updateJob(jobId, { status: 'error', error: 'Could not read any pages from this site' });
      return;
    }

    const combinedText = pages
      .map((p) => `=== PAGE: ${p.url} ===\n${p.text}`)
      .join('\n\n');

    const details = await analyzeBusiness(combinedText);
    const customerSegments = await generateCustomerSegments(details);

    updateJob(jobId, {
      status: 'done',
      result: { url, pagesCrawled: pages.map((p) => p.url), details, customerSegments },
    });
  } catch (err) {
    updateJob(jobId, { status: 'error', error: err.message });
  }
}

router.get('/analyze/:jobId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

module.exports = router;
