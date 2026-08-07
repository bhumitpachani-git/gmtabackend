// Puppeteer needs a serverless-compatible Chromium binary in production — the regular
// `puppeteer` package's bundled Chrome doesn't exist in Vercel's runtime at all (confirmed
// via a real deployment error: "Could not find Chrome"). Locally, keep using the full
// `puppeteer` package (already working, and @sparticuz/chromium's binary is Linux-only —
// it cannot run on a Windows dev machine, so this branch can only be verified after an
// actual deploy, not locally).
const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);

async function launchBrowser() {
  if (isServerless) {
    const chromium = require('@sparticuz/chromium');
    const puppeteerCore = require('puppeteer-core');
    return puppeteerCore.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
    });
  }

  const puppeteer = require('puppeteer');
  return puppeteer.launch({ headless: 'new' });
}

module.exports = { launchBrowser };
