const express = require('express');
const { quickCompanySearch } = require('../companySearch');

const router = express.Router();

// Synchronous, not job-based like everything else in this API — this is meant for live
// "search as you type" (a few seconds, not minutes), so a single request/response is the
// right shape here, not submit-then-poll.
router.post('/company-search', async (req, res) => {
  const { query } = req.body;
  if (!query || typeof query !== 'string' || query.trim().length < 2) {
    return res.status(400).json({ error: 'Provide a "query" string of at least 2 characters' });
  }

  try {
    const companies = await quickCompanySearch(query.trim(), { maxResults: 3 });
    res.json({ companies });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
