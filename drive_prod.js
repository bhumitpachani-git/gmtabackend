const puppeteer = require("puppeteer");
const path = require("path");

const consoleErrors = [];

async function shot(page, name) {
  await page.screenshot({ path: path.join(process.cwd(), "shots", name + ".png") });
  console.log("SHOT:", name);
}

async function clickButtonStartingWith(page, prefix) {
  const clicked = await page.evaluate((prefix) => {
    const btn = Array.from(document.querySelectorAll("button")).find((b) =>
      b.textContent.trim().startsWith(prefix)
    );
    if (btn) { btn.click(); return true; }
    return false;
  }, prefix);
  if (!clicked) throw new Error(`No button starting with "${prefix}" found`);
}

async function waitForAnyText(page, texts, timeout = 120000) {
  await page.waitForFunction(
    (texts) => texts.some((t) => document.body.innerText.includes(t)),
    { timeout }, texts
  );
}

(async () => {
  const browser = await puppeteer.launch({ headless: "new" });
  const page = await browser.newPage();
  page.setDefaultTimeout(120000);
  page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
  page.on("pageerror", (err) => consoleErrors.push("PAGEERROR: " + err.message));

  console.log("Loading production frontend...");
  await page.goto("https://gmtafrontend.vercel.app", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("input");
  await shot(page, "prod-01-landing");

  await page.type("input", "aavrti.com");
  await page.click("button[type=submit]");

  console.log("Waiting for step 1 (real backend job)...");
  await waitForAnyText(page, ["Continue to competitors"]);
  await shot(page, "prod-02-step1");

  await clickButtonStartingWith(page, "Continue to competitors");
  console.log("Waiting for step 2...");
  await waitForAnyText(page, ["Continue to campaigns"]);
  await shot(page, "prod-03-step2");

  console.log("CONSOLE ERRORS:", JSON.stringify(consoleErrors));
  await browser.close();
})().catch((e) => { console.error("FAILED:", e.message); console.log("ERRORS:", JSON.stringify(consoleErrors)); process.exit(1); });
