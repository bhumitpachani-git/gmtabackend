const crypto = require('crypto');

// In-memory store — fine for a single-process dev/prototype. If this runs behind
// multiple server instances or restarts frequently, move this to Redis/DB.
const jobs = new Map();

function createJob() {
  const id = crypto.randomUUID();
  jobs.set(id, { status: 'processing', createdAt: Date.now() });
  return id;
}

function updateJob(id, patch) {
  const job = jobs.get(id);
  if (job) jobs.set(id, { ...job, ...patch });
}

function getJob(id) {
  return jobs.get(id);
}

module.exports = { createJob, updateJob, getJob };
