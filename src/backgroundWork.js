const { waitUntil } = require('@vercel/functions');

// Serverless platforms don't guarantee a fire-and-forget promise keeps running after the
// HTTP response is sent — confirmed via a real deployment test: a job that takes more than
// a few seconds never completed on Vercel, stuck at "processing" forever, because the
// function was frozen once the initial 202 response went out, before the actual
// scrape/AI work finished. waitUntil() tells the platform to keep the function alive until
// this promise settles. Safe to call outside Vercel too (confirmed: doesn't throw), so this
// one wrapper works unmodified for both local dev and production.
function runInBackground(promise) {
  waitUntil(promise);
  return promise;
}

module.exports = { runInBackground };
