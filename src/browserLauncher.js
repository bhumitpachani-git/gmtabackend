// Puppeteer needs a portable Chromium binary in any cloud deployment — the regular
// `puppeteer` package's own download-and-cache mechanism has now failed identically on two
// different platforms (confirmed via real deployment errors: "Could not find Chrome" on
// both Vercel and Render), so we don't trust it in production anywhere, not just on one
// specific platform. Locally, keep using the full `puppeteer` package (already working,
// and @sparticuz/chromium's binary is Linux-only — it cannot run on a Windows dev machine,
// so this branch can only be verified after an actual deploy, not locally).
const isCloudDeployment = Boolean(
  process.env.VERCEL ||
    process.env.AWS_LAMBDA_FUNCTION_NAME ||
    process.env.RENDER ||
    process.env.NODE_ENV === 'production'
);

async function launchBrowser() {
  if (isCloudDeployment) {
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
