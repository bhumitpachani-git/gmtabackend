const express = require('express');
const { scrapeGoogleMaps } = require('../mapsScraper');
const { createJob, updateJob, getJob } = require('../jobStore');

const router = express.Router();

router.post('/leads/find', (req, res) => {
  const { query, location, maxResults } = req.body;

  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'Provide a "query" string (e.g. "restaurants")' });
  }
  if (!location || typeof location !== 'string') {
    return res.status(400).json({ error: 'Provide a "location" string (e.g. "Mumbai")' });
  }

  const resultLimit = Math.min(Math.max(Number(maxResults) || 20, 1), 40);
  const jobId = createJob();

  res.status(202).json({ jobId, status: 'processing' });

  scrapeGoogleMaps(query, location, { maxResults: resultLimit })
    .then((leads) => {
      updateJob(jobId, { status: 'done', result: { query, location, leads } });
    })
    .catch((err) => {
      updateJob(jobId, { status: 'error', error: err.message });
    });
});

router.get('/leads/:jobId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

module.exports = router;
