# Business Intelligence & Lead-Finding API

Backend service built on a crawl-and-AI-extract engine (Sarvam-105B), with three capabilities:

1. **`POST /grow` — fully automated, one input, one response.** Give it a business's own URL and nothing else. It analyzes the site, figures out who their customers are, and finds real leads two ways depending on the customer type: **local** customers (restaurants, clinics, shops) via Google Maps, and **online** customers (SaaS startups, agencies, e-commerce brands — anyone without a physical storefront) via company search + finding a named decision-maker at each one. Every lead is enriched with phone, email, and a personalized outreach email. **Best when you just want the end result and don't need a UI showing progress through each stage.**
2. **`POST /pipeline/*` — the same work, broken into 6 explicit steps.** Search company → explore competitors → define campaigns → find potential customers → find decision-makers → write emails. Each step is its own endpoint, tied together by a `sessionId`, so a frontend can show results after each stage and let the user review/pick before continuing — matching a step-by-step wizard UI. **Best when you're building a UI around this**, since `/grow` only gives you one result at the very end.
3. **`POST /analyze`** — crawl any website (a competitor's, or your own) and extract structured business details, without running the lead search. Useful for competitor research, or if you want to inspect/override the AI's suggested customer segments before searching.
4. **`POST /leads/find`** — manually search Google Maps with your own search term + location, without the business-analysis step. Useful if you already know exactly who you're targeting.

`/analyze`, `/leads/find`, and the individual pieces behind each `/pipeline/*` step are the manual building blocks `/grow` chains together automatically in one call — kept available/exposed for cases where you want more control, more visibility, or a step-by-step UI.

## Base URL

```
http://localhost:3000
```

(Update this once deployed — dev only for now, not yet behind auth.)

## Authentication

**None currently.** This API has no API-key/auth layer yet — it's open on the network it's running on. Do not expose this port publicly without adding auth first.

## CORS

Enabled for all origins (dev mode) — safe to call directly from a browser-based frontend during development.

---

## ⚠️ This is an async, submit-then-poll API — not a single request/response call

Crawling a site takes time (typically 10–30s, hard-capped at 90s). Instead of holding one HTTP request open that whole time — which times out unpredictably depending on browser/proxy/hosting limits — the flow is:

1. `POST /grow`, `POST /analyze`, or `POST /leads/find` → returns **instantly** with a `jobId`
2. `GET /grow/:jobId`, `GET /analyze/:jobId`, or `GET /leads/:jobId` → poll this every ~3-5 seconds until `status` is `"done"` or `"error"`

`/grow` does the most work (site crawl + AI analysis + Maps search + per-lead phone/email/website enrichment), so it takes noticeably longer than the other two — expect **2-5 minutes** depending on how many segments/leads you ask for, not the 10-30s typical of `/analyze` alone. Still fully async/poll-based for the same reason: no single request should stay open that long.

**Do not treat the `POST` endpoints as returning the result.** They never will — they only return a job handle.

---

## Endpoints

### `GET /health`

Simple liveness check.

**Response — `200 OK`**
```json
{ "ok": true }
```

---

### `POST /grow` ⭐ recommended — the fully automated pipeline

One input: the business's own website URL. Everything else happens automatically:

1. Crawls the site and extracts business details (same as `/analyze`)
2. AI proposes customer segments (same as `/analyze`'s `customerSegments`)
3. **Automatically derives a target location** from the extracted `headquarters`/`officeLocations` — no location input from the caller
4. For each segment, the AI already decided how to search for it (see `type` below) — runs a Google Maps search for **local** segments, or a company + decision-maker search for **online** segments
5. **Enriches every lead** with phone number, email, and a personalized outreach email

#### `local` vs `online` segments — two different lead-finding methods

Not every customer type is findable the same way. `generateCustomerSegments` tags each proposed segment with a `type`:

- **`"local"`** — a physical, in-person business type (restaurants, dental clinics, gyms). Found via Google Maps, same as `/leads/find`. Needs a target location.
- **`"online"`** — a company type with no relevant physical storefront (SaaS startups, agencies, e-commerce brands). Google Maps wouldn't have these at all, so instead: search for real companies matching the segment (via web search, crawling a relevant listing/article if needed), then for each company, crawl its About/Team page to find a named decision-maker (founder/CEO/executive), then guess that **person's** email (`firstname.lastname@domain`) rather than a generic company inbox. No location needed.

**Why this matters**: a business whose customers are other companies (an IT agency, a SaaS tool, anything B2B-online) would get useless or empty results from a Maps-only search — Maps simply doesn't index that kind of company. The `online` path exists specifically for that case.

**⚠️ Scraping/reliability note**: both paths query systems (Google Maps, Google/DuckDuckGo search results, individual company websites) directly rather than through a paid third-party API, which carries real ToS and reliability caveats — expect some individual lookups to fail. A failed enrichment just leaves that one lead's `phone`/`email` as `null`; it doesn't fail the whole job. The `online` path does meaningfully more per-lead work (company search → team-page crawl → person email guess) than `local`, so it's slower per lead.

**Location caveat**: a `"local"`-type segment needs a target location, auto-derived from the site's own headquarters/office info. If the site doesn't state one anywhere (common for purely online/global businesses), that specific segment is skipped with a note in its result — it does **not** fail the whole job, since other segments (especially `"online"` ones, which don't need a location at all) may still succeed.

#### Request

```
POST /grow
Content-Type: application/json
```

| Field                | Type   | Required | Default | Notes                                                                 |
|----------------------|--------|----------|---------|--------------------------------------------------------------------------|
| `url`                | string | yes      | —       | The business's own website (not a competitor's)                          |
| `maxSegments`         | number | no       | `1`     | How many of the AI's suggested customer segments to actually search. Clamped `1`-`4`. Each added segment roughly multiplies total run time. |
| `maxLeadsPerSegment`  | number | no       | `5`     | How many leads to find (and enrich) per segment. Clamped `1`-`20`. Each added lead adds ~10-15s (Maps lookup + website visit for email).     |

**Example request body**
```json
{
  "url": "https://your-own-business.com",
  "maxSegments": 2,
  "maxLeadsPerSegment": 8
}
```

#### Response — `202 Accepted`
```json
{
  "jobId": "2c89e5d4-7468-4a3e-987e-40d5fc156f34",
  "status": "processing"
}
```

#### Error responses

| Status | Body                                                       | When it happens          |
|--------|--------------------------------------------------------------|---------------------------|
| `400`  | `{ "error": "Provide a \"url\" string in the request body" }` | Missing/invalid `url`     |

---

### `GET /grow/:jobId`

Poll this with the `jobId` from `POST /grow`.

#### Response — `200 OK` (still running)
```json
{ "status": "processing", "stage": "finding_leads", "location": "Boston, United States" }
```
`stage` is one of `"analyzing_business"` or `"finding_leads"` — useful for showing the user a more specific progress message than a generic spinner.

#### Response — `200 OK` (finished)
```json
{
  "status": "done",
  "createdAt": 1785759227714,
  "result": {
    "url": "https://pos.toasttab.com",
    "business": { "companyName": "Toast", "whatTheyDo": "...", "headquarters": { "country": "United States", "state": "MA", "city": "Boston" } },
    "location": "Boston, United States",
    "segments": [
      {
        "searchQuery": "restaurants",
        "reason": "Toast's all-in-one platform for POS, online ordering, and marketing directly targets restaurants of all types.",
        "type": "local",
        "leads": [
          {
            "name": "Example Restaurant",
            "rating": "4.5",
            "category": "Restaurant",
            "address": "123 Main St, Boston, MA",
            "website": "https://exampleresturant.com",
            "phone": "(617) 555-0100",
            "email": "info@exampleresturant.com",
            "emailSource": "website",
            "outreachEmail": {
              "subject": "Streamline Example Restaurant's ordering & payments",
              "body": "Hi Example Restaurant team,\n\nI came across your restaurant in Boston and wanted to reach out..."
            }
          }
        ]
      },
      {
        "searchQuery": "web development agencies",
        "reason": "Agencies building client products need reliable backend/cloud infrastructure partners.",
        "type": "online",
        "leads": [
          {
            "name": "Example Agency",
            "website": "https://exampleagency.com",
            "personName": "Priya Sharma",
            "personTitle": "Founder & CEO",
            "personLinkedIn": "https://www.linkedin.com/in/priyasharma",
            "phone": null,
            "email": "priya.sharma@exampleagency.com",
            "emailSource": "pattern-verified",
            "outreachEmail": {
              "subject": "Scaling Example Agency's client delivery",
              "body": "Hi Priya, I came across Example Agency and wanted to reach out..."
            }
          },
          {
            "name": "Another Agency Co",
            "website": "https://anotheragency.com",
            "personName": null,
            "personTitle": null,
            "personLinkedIn": null,
            "phone": null,
            "email": "info@anotheragency.com",
            "emailSource": "website",
            "outreachEmail": {
              "subject": "Backend & cloud infrastructure for Another Agency Co",
              "body": "Hi Another Agency Co team, I came across your work and wanted to reach out..."
            }
          }
        ]
      }
    ]
  }
}
```

#### Response — `200 OK` (a `local` segment skipped, no location found)

The job still completes — only that one segment is affected:
```json
{
  "searchQuery": "dental clinics",
  "reason": "...",
  "type": "local",
  "leads": [],
  "error": "Skipped — no headquarters/office location found on this website to search Google Maps against."
}
```
If this is the *only* segment and it gets skipped, `result.segments` comes back with one empty/errored entry — the job status is still `"done"`, not `"error"`, since business analysis and segment generation both succeeded. If you need that segment's leads anyway, fall back to the manual pipeline: `POST /leads/find` with a location you provide yourself.

#### `result` field reference

| Field                       | Type                                                          | Description                                                    |
|-----------------------------|------------------------------------------------------------------|-------------------------------------------------------------------|
| `business`                   | same shape as `/analyze`'s `details`                              | The analyzed business's own profile                                |
| `location`                   | `string \| null`                                                  | Location auto-derived from the business's HQ/office data — only used by `local` segments |
| `segments[].searchQuery`     | `string`                                                          | The customer type searched for                                     |
| `segments[].reason`          | `string`                                                          | Why the AI picked this segment                                     |
| `segments[].type`            | `"local" \| "online"`                                             | Which lead-finding method was used — see above                     |
| `segments[].error`           | `string` (only present if the segment was skipped)                 | Present when a `local` segment had no location to search against   |
| `segments[].leads[]`         | array — shape differs by `type`, see below                        | |

**`local` leads** (via Maps): `name`, `rating`, `category`, `address`, `website`, `phone`, `email`, `emailSource`, `outreachEmail` — same shape as `/leads/find`, plus enrichment fields.

**`online` leads** (via company + decision-maker search): `name` (company), `website`, `personName` (`string \| null` — the decision-maker found, if any), `personTitle` (`string \| null`), `personLinkedIn` (`string \| null` — their public profile URL, only set when the person was found via LinkedIn search rather than the website-crawl fallback), `phone`, `email`, `emailSource`, `outreachEmail`. No `rating`/`category`/`address` — those are Maps-specific fields that don't apply here.

**`personName` is `null` more often than not, by design.** The extraction is deliberately strict: it only accepts a person if the text clearly states they're on *that* company's own leadership team, with a real title (CEO, Founder, CTO, etc.) — vague labels like "Contact Person" are rejected outright. This exists because testing surfaced a real failure mode: a company's page can mention a completely unrelated person (a partner, a case-study subject, someone at a different company entirely) and a looser extractor will misattribute that person — and their real email — to the wrong company. When `personName` is `null`, email-finding falls back to generic company patterns (`info@`, `contact@`) instead of guessing a name.

**Every crawled email is domain-checked before being trusted.** If a page mentions an email that isn't actually `@` that company's own domain, it's discarded rather than attributed to them — this is what stops the wrong-company mix-up above from happening via the email side too.

Note: `mapsUrl` is deliberately **not** included anywhere — the product is meant to hand you a ready-to-send email directly, not send you to click through to Google Maps for each business.

`phone`/`email`/`website` on any individual lead can still be `null` if every fallback failed or the business simply doesn't publish it anywhere reachable — this is expected on some fraction of leads, not a bug.

#### `emailSource` — how much to trust the email

Finding an email goes through several attempts, in order, each only tried if the previous one came up empty. The system is tuned to **maximize coverage** — always hand back something to attempt sending to when there's any domain to work with at all — over maximum precision, so read `emailSource` as a confidence label, not a pass/fail signal:

1. **`"website"`** — found directly on the lead's own site (a `mailto:` link or a plain email in the page text, homepage or contact/about page). Highest confidence — this is a real, published address.
2. **`"pattern-verified"`** — no email was published anywhere findable, so the system guessed a likely address and confirmed it via a direct SMTP handshake with the domain's actual mail server (a real `RCPT TO` check — this is the same technique commercial email-finder tools use, done here with our own code, no third-party API). For `local` leads (no known person) it tries generic addresses (`info@`, `contact@`, `hello@`, `sales@`, `support@`, `admin@`, `office@`, `enquiries@`, `team@`); for `online` leads with a `personName`, it tries name-based patterns instead (`firstname.lastname@`, `flastname@`, `firstname@`, etc.), falling back to the generic list if none of those verify. Either way, the mail server explicitly accepted this exact address.
3. **`"pattern-guess"`** — the mail server didn't give a clean accept on any candidate — either it's catch-all (accepts *any* address, so RCPT TO can't distinguish real from fake) or every check came back ambiguous (timeout/greylisting). The single best guess is returned anyway rather than nothing, but treat it as unverified — it may or may not be checked by anyone.
4. **`null`** email with `emailSource: null` — the one case with genuinely nothing to offer: no website found anywhere (Maps listing had none, and guessing `businessname.com` from the name didn't resolve to a real reachable site either), or the domain has no mail server at all (MX lookup failed — there's no mailbox format to even guess against).

**Practical guidance for the frontend**: show a confidence indicator based on `emailSource` — e.g. a checkmark for `"website"`/`"pattern-verified"`, a caution icon for `"pattern-guess"`. Sending to a `"pattern-guess"` address has a real chance of bouncing.

**Local leads with no website listed on Maps** also get one more attempt before falling back to the generic patterns above: the system guesses `businessname.com` from the lead's name and verifies it actually loads before trusting it (Maps doesn't always show a website field even when the business has one).

#### `outreachEmail` — personalized cold email per lead

For every lead where an `email` was found, the AI writes a **separate, personalized** outreach email — referencing that specific lead's business name/category, and pitching the sender's own product using only facts already extracted in `business` (no invented claims). `outreachEmail` is `null` when `email` is `null` (nowhere to send it), when that email-writing call failed outright, or when the generation came back too short to be a usable draft (a real failure mode seen in testing: a valid-JSON response with a body of just "Hi [Business] team," — four words, clearly cut off — now rejected rather than handed back). A failure here only drops that one lead's email draft, it does not fail the whole job.

**This is AI-generated content — review before sending.** Treat it as a strong first draft per lead, not something to blast out unreviewed. Nothing in this pipeline sends email on your behalf; `outreachEmail` is text only, for you (or your own separate sending step) to use.

Same in-memory job caveat as the other endpoints: jobs are lost on server restart, no expiry yet.

---

### `POST /analyze`

Starts a crawl + AI analysis job in the background and returns immediately.

#### Request

```
POST /analyze
Content-Type: application/json
```

| Field      | Type   | Required | Default | Notes                                                 |
|------------|--------|----------|---------|--------------------------------------------------------|
| `url`      | string | yes      | —       | Full URL including `https://`                          |
| `maxPages` | number | no       | `12`    | How many pages to crawl. Clamped between `1` and `25`. |

**Example request body**
```json
{
  "url": "https://explee.com",
  "maxPages": 10
}
```

#### Response — `202 Accepted`

```json
{
  "jobId": "7c396583-9993-4cf2-874e-4157132d61e1",
  "status": "processing"
}
```

#### Error responses

| Status | Body                                                       | When it happens          |
|--------|--------------------------------------------------------------|---------------------------|
| `400`  | `{ "error": "Provide a \"url\" string in the request body" }` | Missing/invalid `url`     |

---

### `GET /analyze/:jobId`

Poll this with the `jobId` from `POST /analyze` to check progress and get the result.

#### Response — `200 OK` (still running)
```json
{
  "status": "processing",
  "createdAt": 1785757388024
}
```

#### Response — `200 OK` (finished)
```json
{
  "status": "done",
  "createdAt": 1785757388024,
  "result": {
    "url": "https://explee.com",
    "pagesCrawled": [
      "https://explee.com/",
      "https://explee.com/pricing"
    ],
    "details": {
      "companyName": "Explee",
      "whatTheyDo": "AI agents that research the market, find high-intent prospects, write personalized emails, and book demos.",
      "targetAudience": "Businesses looking for automated outbound sales and lead generation.",
      "keyFeatures": [
        "AI-powered market research and ICP sharpening",
        "Automated prospect finding",
        "Personalized email generation"
      ],
      "pricingPlans": [
        {
          "name": "AI Search - Starter",
          "price": "$49/month",
          "billingPeriod": "Monthly",
          "included": ["5,000 credits", "10,000 companies/mo"]
        }
      ],
      "priceRange": "$0 - $490/month",
      "positioning": "Automated outbound sales platform handling the entire pipeline from research to booking meetings.",
      "notableClaims": ["Built on own GPU cluster covering 536M people"],
      "headquarters": { "country": "United Kingdom", "state": "England", "city": "London" },
      "officeLocations": [{ "country": "United Kingdom", "city": "London" }],
      "contactInfo": { "email": null, "phone": null },
      "foundedYear": null,
      "teamSize": null,
      "socialLinks": null
    },
    "customerSegments": [
      {
        "searchQuery": "restaurants",
        "reason": "Toast's all-in-one platform for POS, online ordering, and marketing directly targets restaurants of all types."
      },
      {
        "searchQuery": "retailers",
        "reason": "Toast provides a connected platform for retailers, including payment processing and inventory management tools."
      }
    ]
  }
}
```

`customerSegments` is only meaningful when you analyze **your own** business (not a competitor) — it's the AI's suggestion for what type of local businesses to search for as leads on Google Maps. Feed one segment's `searchQuery` straight into `POST /leads/find` (see below). Usually 2-4 segments; can be an empty array if the AI couldn't confidently infer any from the site content.

#### Response — `200 OK` (failed)
```json
{
  "status": "error",
  "createdAt": 1785757388024,
  "error": "Could not read any pages from this site"
}
```

Other `error` messages you may see here: `"Sarvam returned an empty response (finish_reason: length)"` or `"Sarvam response was not valid JSON: ..."` — both mean the AI extraction step itself failed (as opposed to the crawl succeeding but yielding nothing). These surface as a clean job error rather than a silently broken/empty `details` object, so treat any `status: "error"` the same way in the UI regardless of which of these messages it is.

#### Error responses

| Status | Body                            | When it happens                          |
|--------|----------------------------------|--------------------------------------------|
| `404`  | `{ "error": "Job not found" }`  | Unknown/expired `jobId`                     |

**Note:** jobs are stored in memory — they're lost if the server restarts, and there's no expiry/cleanup yet. Don't rely on a `jobId` staying valid indefinitely.

#### `result.details` field reference

Any field the AI couldn't find on the site comes back as `null` (or an empty array for list fields) — **this is expected, not an error.** Not every company publishes every field.

| Field             | Type                                                         | Description                                  |
|-------------------|----------------------------------------------------------------|-----------------------------------------------|
| `companyName`     | `string \| null`                                               | Extracted company name                        |
| `whatTheyDo`      | `string \| null`                                               | One-line description of the product/service   |
| `targetAudience`  | `string \| null`                                               | Who the product is aimed at                    |
| `keyFeatures`     | `string[]`                                                      | List of headline features                      |
| `pricingPlans`    | `{ name, price, billingPeriod, included: string[] }[]`         | All pricing tiers found                        |
| `priceRange`      | `string \| null`                                               | Human-readable overall price range              |
| `positioning`     | `string \| null`                                               | How the company positions itself vs market      |
| `notableClaims`   | `string[]`                                                      | Marketing claims/stats (e.g. "536M people")     |
| `headquarters`    | `{ country, state, city } \| null`                             | HQ location if findable on the site             |
| `officeLocations` | `{ country, city }[]`                                           | Additional office locations                     |
| `contactInfo`     | `{ email: string\|null, phone: string\|null }`                  | Public contact details                          |
| `foundedYear`     | `string \| null`                                               | Year founded, if stated                          |
| `teamSize`        | `string \| null`                                               | Team/employee count, if stated                    |
| `socialLinks`     | `string[] \| null`                                              | Social media links found                          |

---

### `POST /leads/find`

Starts a Google Maps search job in the background and returns immediately. Finds real businesses matching a search term in a given location — use this to turn a `customerSegments` suggestion (or any search term) into actual leads.

**⚠️ Scraping risk note**: this queries Google Maps directly, which is against Google's ToS. Kept as low-risk as reasonably possible (no clicking into individual listings, capped result count, hard time budget), but expect occasional failures if Google shows a CAPTCHA/consent wall, and don't run this at high volume from one IP.

#### Request

```
POST /leads/find
Content-Type: application/json
```

| Field        | Type   | Required | Default | Notes                                                    |
|--------------|--------|----------|---------|------------------------------------------------------------|
| `query`      | string | yes      | —       | Type of business to search for, e.g. `"restaurants"`        |
| `location`   | string | yes      | —       | City/region to search in, e.g. `"Mumbai"`                   |
| `maxResults` | number | no       | `20`    | How many leads to return. Clamped between `1` and `40`.     |

**Example request body**
```json
{
  "query": "restaurants",
  "location": "Mumbai",
  "maxResults": 15
}
```

#### Response — `202 Accepted`
```json
{
  "jobId": "0c84db26-61df-4e67-86d9-dbe7d7bebf8c",
  "status": "processing"
}
```

#### Error responses

| Status | Body                                                              | When it happens              |
|--------|----------------------------------------------------------------------|--------------------------------|
| `400`  | `{ "error": "Provide a \"query\" string (e.g. \"restaurants\")" }`   | Missing/invalid `query`        |
| `400`  | `{ "error": "Provide a \"location\" string (e.g. \"Mumbai\")" }`     | Missing/invalid `location`     |

---

### `GET /leads/:jobId`

Poll this with the `jobId` from `POST /leads/find`. Same status shape as `GET /analyze/:jobId`.

#### Response — `200 OK` (finished)
```json
{
  "status": "done",
  "createdAt": 1785759272359,
  "result": {
    "query": "restaurants",
    "location": "Mumbai",
    "leads": [
      {
        "name": "Pali Bhavan",
        "rating": "4.4",
        "category": "Restaurant",
        "address": "Cambata Building, 42, Maharshi Karve Rd, opposite Oval Maidan",
        "website": null
      }
    ]
  }
}
```

#### `result.leads[]` field reference

| Field      | Type             | Description                                                         |
|------------|-------------------|-----------------------------------------------------------------------|
| `name`     | `string \| null`  | Business name                                                        |
| `rating`   | `string \| null`  | Google rating (e.g. `"4.4"`), null if unrated                        |
| `category` | `string \| null`  | Business category as shown on Maps (e.g. `"Restaurant"`)             |
| `address`  | `string \| null`  | Address text, null if Maps only shows hours/status instead           |
| `website`  | `string \| null`  | Website, only populated if visible directly in the results list      |

No `mapsUrl` field — this product hands you contact info directly, it doesn't send anyone to click through to Google Maps.

**Note**: this is fast/list-view scraping only — no phone numbers, and `website`/`address` will be `null` for listings where Maps doesn't show that info in the results list itself (would require opening each listing individually, which this endpoint intentionally does not do, to stay fast and lower-risk).

Same in-memory job caveat as `/analyze`: jobs are lost on server restart, no expiry yet.

---

## The step-wise pipeline (`/pipeline/*`)

Same underlying work as `/grow`, but split into 6 explicit steps so a wizard-style frontend can show results after each one and let the user review/pick before continuing. All state is held server-side in a **session**, keyed by `sessionId` — each step reads what an earlier step produced and writes its own result back onto the session.

**Every step follows this shape**: `POST` the step → get `{ jobId }` (or `{ sessionId, jobId }` for step 1) immediately → poll `GET /pipeline/jobs/:jobId` until `status` is `"done"` or `"error"`, same async pattern as `/analyze`/`/grow`/`/leads/find`. `GET /pipeline/:sessionId` at any time returns the full accumulated session state (company, competitors, campaigns, customers, decisionMakers, emails — whichever steps have run so far).

**Steps must run in order** — each one requires the previous step's output to exist on the session, and returns `409 Conflict` with a message telling you which step to run first if it's missing.

### Step 1 — `POST /pipeline/start`

```json
{ "url": "https://your-own-business.com" }
```
→ `202` `{ "sessionId": "...", "jobId": "..." }`. Job result: `{ "company": { ...same shape as /analyze's details... } }`, also stored on the session.

### Step 2 — `POST /pipeline/:sessionId/competitors`

No body needed. Searches for real competitors based on what the business actually does (not its name — a name-only search is unreliable for smaller/lesser-known companies, confirmed during testing: searching by company name alone surfaced completely unrelated businesses).

→ `202` `{ "jobId": "..." }`. Job result: `{ "competitors": [{ "name", "website", "description" }] }`. `description` is a real search-result snippet when available, `null` otherwise — never fabricated.

### Step 3 — `POST /pipeline/:sessionId/campaigns`

No body needed. Same engine as `/grow`'s `customerSegments`, with two extra fields for a richer campaign-card UI:

→ `202` `{ "jobId": "..." }`. Job result:
```json
{
  "campaigns": [
    {
      "searchQuery": "FinTech startups",
      "reason": "...",
      "type": "online",
      "pain": "FinTech startups need secure, scalable infrastructure without enterprise-grade dev resources.",
      "criteria": ["High-volume transaction processing", "Bank-grade security requirements", "Rapid time-to-market"]
    }
  ]
}
```

### Step 4 — `POST /pipeline/:sessionId/customers`

```json
{ "campaignIndexes": [0, 2], "maxPerCampaign": 8 }
```
Both fields optional — omit `campaignIndexes` to run every campaign from step 3; `maxPerCampaign` defaults to 8, clamped 1-20. Routes each campaign through Maps (`type: "local"`) or company search (`type: "online"`) automatically, same as `/grow`.

→ `202` `{ "jobId": "..." }`. Job result: `{ "customers": [...], "location": "..." }` — each customer tagged with `campaignIndex` so you know which campaign it came from. **Calling this again replaces the whole `customers` list** — pass all the campaign indexes you want in one call rather than calling it multiple times expecting it to accumulate.

No "Size"/"Monthly Traffic" fields (unlike the reference UI this mirrors) — that data comes from paid third-party services (SimilarWeb-style traffic estimates); left out entirely rather than faked.

### Step 5 — `POST /pipeline/:sessionId/decision-makers`

```json
{ "customerIndexes": [0, 1, 3] }
```
Optional — omit to run every customer from step 4. For each customer, tries two sources in order:

1. **LinkedIn, via public search-result snippets** (primary) — searches for `linkedin.com/in <company> founder CEO CTO executive director` and parses real people's public profile titles (e.g. `"Patrick Collison - Stripe CEO | LinkedIn"`). This never visits linkedin.com itself, requires no login, and doesn't scrape LinkedIn's pages directly — it only reads what's already publicly indexed by the search engine. Deliberately **not** doing direct LinkedIn scraping — that carries real ToS/ban risk and LinkedIn has sued scrapers before.
2. **Crawling the company's own About/Team page** (fallback, only tried if LinkedIn found nothing) — extracts named leadership from the page text.

→ `202` `{ "jobId": "..." }`. Job result: `{ "decisionMakers": [{ "customerIndex", "company", "website", "personName", "personTitle", "personLinkedIn" }] }`. `personLinkedIn` is the profile URL when sourced from LinkedIn, `null` when sourced from the website fallback.

**This meaningfully improved hit rate on large/prominent companies, confirmed during testing**: the website-crawl-only approach found **zero** named leadership for Stripe, ever, across every test — its About page has no simple leadership listing. The LinkedIn-search approach found Stripe's actual CEO and President by name and title in the same test. Smaller companies with a real, simple "Leadership" page (commercetools, in earlier testing) still work well via the website-crawl fallback.

**Important reliability caveat, also confirmed during testing**: DuckDuckGo's results for the *exact same query* are not fully consistent across repeated calls in quick succession — likely soft rate-limiting under automated querying. Three identical Stripe searches in a row returned three different result sets (sometimes both Collison brothers, sometimes only one, sometimes with an irrelevant same-named company mixed in). This is not a bug to "fix" so much as an inherent characteristic of scraping public search results — expect variance run-to-run, not a guaranteed identical result for the same input every time. A basic relevance filter is applied to reduce (not eliminate) false matches — e.g. a search for "Stripe" can surface someone at "Stripe Partners", a completely different company; the filter catches company names followed by another capitalized word forming a longer distinct name, but isn't foolproof.

### Step 6 — `POST /pipeline/:sessionId/emails`

```json
{ "personIndexes": [0, 1] }
```
Optional — omit to run every decision-maker from step 5. For each person, finds their email (name-based pattern + SMTP verification, same technique as `/grow`'s `online` leads) and writes a personalized outreach email addressed to them by name/title.

→ `202` `{ "jobId": "..." }`. Job result: `{ "emails": [{ "personIndex", "company", "personName", "personTitle", "personLinkedIn", "email", "emailSource", "phone", "outreachEmail" }] }`. Same `emailSource` confidence levels as `/grow` (`"website"` / `"pattern-verified"` / `"pattern-guess"` / `null`). If step 5 came back empty, this step correctly returns `{ "emails": [] }` rather than erroring.

### `GET /pipeline/:sessionId` and `GET /pipeline/jobs/:jobId`

- `GET /pipeline/:sessionId` — full current session state, whatever steps have run so far. `404` if the session doesn't exist (or the server restarted — in-memory, same caveat as everywhere else in this API).
- `GET /pipeline/jobs/:jobId` — generic job poll, shared across all 6 steps. Same `{status, result}` / `{status, error}` shape as every other job in this API.

---

## Frontend integration example

### Recommended: one-call `/grow` pipeline

```javascript
async function startGrow(url, { maxSegments = 1, maxLeadsPerSegment = 5 } = {}) {
  const res = await fetch('http://localhost:3000/grow', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, maxSegments, maxLeadsPerSegment }),
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || `Request failed with status ${res.status}`);
  }

  const { jobId } = await res.json();
  return jobId;
}

async function pollGrow(jobId, { intervalMs = 3000, maxAttempts = 120 } = {}) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await fetch(`http://localhost:3000/grow/${jobId}`);
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || `Request failed with status ${res.status}`);
    }

    const job = await res.json();
    if (job.status === 'done') return job.result;
    if (job.status === 'error') {
      // job.partialResult may still have `details`/`customerSegments` even on failure —
      // worth showing the user what was found before falling back to the manual pipeline.
      const err = new Error(job.error);
      err.partialResult = job.partialResult;
      throw err;
    }
    // job.stage (e.g. "analyzing_business" / "finding_leads") is available here for progress UI

    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw new Error('This is taking too long — gave up polling');
}

// Usage — the whole pipeline in one call:
const jobId = await startGrow('https://your-own-business.com', { maxSegments: 2, maxLeadsPerSegment: 8 });
const { business, location, segments } = await pollGrow(jobId);

for (const segment of segments) {
  for (const lead of segment.leads) {
    console.log(lead.name, lead.email, lead.outreachEmail?.subject);
    // lead.outreachEmail is a ready-to-review { subject, body } draft, or null if no email was found
  }
}
```

**UX recommendation**: this takes 2-5 minutes, noticeably longer than the other endpoints — show `job.stage` ("Analyzing your business..." / "Finding your customers...") rather than a generic spinner, and set expectations up front (e.g. "This usually takes a few minutes").

### Manual pipeline (more control, more steps)

Use this instead of `/grow` if you want to show the user the suggested segments and let them pick one, override the location, or just analyze a competitor without running a lead search at all.

```javascript
async function startAnalysis(url, maxPages = 12) {
  const res = await fetch('http://localhost:3000/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, maxPages }),
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || `Request failed with status ${res.status}`);
  }

  const { jobId } = await res.json();
  return jobId;
}

async function pollAnalysis(jobId, { intervalMs = 2000, maxAttempts = 60 } = {}) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await fetch(`http://localhost:3000/analyze/${jobId}`);
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || `Request failed with status ${res.status}`);
    }

    const job = await res.json();
    if (job.status === 'done') return job.result;
    if (job.status === 'error') throw new Error(job.error);

    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw new Error('Analysis is taking too long — gave up polling');
}

async function startLeadSearch(query, location, maxResults = 20) {
  const res = await fetch('http://localhost:3000/leads/find', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, location, maxResults }),1
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || `Request failed with status ${res.status}`);
  }

  const { jobId } = await res.json();
  return jobId;
}

async function pollLeads(jobId, { intervalMs = 2000, maxAttempts = 45 } = {}) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await fetch(`http://localhost:3000/leads/${jobId}`);
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || `Request failed with status ${res.status}`);
    }

    const job = await res.json();
    if (job.status === 'done') return job.result;
    if (job.status === 'error') throw new Error(job.error);

    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw new Error('Lead search is taking too long — gave up polling');
}

// Usage — full "find my customers" pipeline:
const jobId = await startAnalysis('https://your-own-business.com', 10);
const { details, customerSegments } = await pollAnalysis(jobId);

const chosenSegment = customerSegments[0]; // or let the user pick one in the UI
const leadJobId = await startLeadSearch(chosenSegment.searchQuery, 'Mumbai', 20);
const { leads } = await pollLeads(leadJobId);

console.log(leads);
```

**UX recommendation**: show a loading/progress indicator as soon as either `start*` call resolves with a `jobId` (e.g. "Analyzing website..." / "Searching for leads..."), and keep polling until `done` or `error`. Both steps typically finish in 10–30 seconds; the server enforces a hard cap so neither will run past ~90 seconds. For the segment step, let the user pick from `customerSegments` in the UI rather than always taking the first one — that's the whole point of returning multiple options.
