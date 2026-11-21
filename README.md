# Merchant Onboarding

A small web app that onboards merchants for a payments company. A merchant applies with a form and three documents. The system reads the documents, runs PAN, GST, bank and risk checks with (simulated) outside services, handles their delayed answers, sends problem cases to a human reviewer, and creates a merchant ID only when every required check has passed. Every step is written to a timeline.

Built with MongoDB, Express, React and Node, all in TypeScript.

## Run it

You need Node 20 or newer.

```bash
npm install
npm start
```

Then open http://localhost:4000.

- **Database:** if you don't set `MONGO_URI`, a private MongoDB is downloaded once (about 70 MB) and started for you; its data is kept in the `.data` folder. To use your own database (Atlas, Docker, local), run `MONGO_URI=mongodb://... npm start`.
- **Tests:** `npm test` (42 tests, real MongoDB, no mocks of our own code).
- **Sample files to upload:** `npm run samples` writes PDFs and photos into the `samples` folder, with a `merchant_details.txt` that matches them.
- **Type check:** `npm run typecheck`.
- **Development with auto-reload:** `npm run dev` (page on http://localhost:5173).

## Try it in two minutes

1. Open **New application**. The form is empty. For a quick start use *"For the demo: fill in an example..."* at the top right of step 1. Or type the details from `samples/merchant_details.txt` and add the sample files yourself in step 2 (choose the document type, then pick the file).
2. Press **Submit application**. On the application page watch the four checks go from "Waiting for the answer" to "Passed", then the merchant ID appears. The **Timeline** at the bottom shows every step in plain words.
3. Submit again with *"GST check fails (PAN passes)"* chosen in step 3. The case lands in **Needs a review**. Try *Approve* with no reason (it is refused), then with a reason.
4. Try the files in the `samples` folder: `pan_card_WRONG_PAN.pdf` (contradicts the form), `pan_card_photo_BLURRY.png` (too blurry) and `pan_card_photo_clear.png` (a clear photo, which a person must read). Then try the other situations in step 3.

## How it works

```
Merchant applies ──► read documents, compare with the form
                        │
        problems? ──────┼──► NEEDS_INFO  (the merchant fixes it and sends it again)
        same PAN/GSTIN as another application? ──► IN_REVIEW
                        │ all good
                        ▼
                    VERIFYING   PAN, GST, bank, risk requests go out.
                        │       Each provider answers later by calling us back.
         all four back, all passed ──► APPROVED ──► ONBOARDED   (merchant ID created)
         anything failed or unsure ──► IN_REVIEW  (a person approves, rejects, retries a check or asks the merchant)
```

Nine states, defined in one table in [`server/src/states.ts`](server/src/states.ts). Only the moves in that table are possible. The other states are `MERCHANT_ID_FAILED` (approved, but creating the ID kept failing), `BANK_RECHECK` (bank details changed after go-live; payouts paused) and `REJECTED`.

Every application is a single MongoDB document that holds its form, documents, checks, duplicates and timeline. One function, `sweep()`, runs every second and does whatever is due: it retries checks that got no answer in time and retries merchant-ID creation. Because the "due" times are stored in the database, it keeps working after a restart.

## What the brief asks for, and where it is

| Requirement | Where |
|---|---|
| Accept an application and documents or structured payloads | `POST /api/applications` ([`applications.ts`](server/src/applications.ts)). Documents can be PDF, PNG/JPG, text or JSON files, or structured fields. |
| Extract fields, show confidence or validation status | [`reading.ts`](server/src/reading.ts) reads the text inside PDFs and measures how sharp a photo is. [`documents.ts`](server/src/documents.ts) compares fields with the form. Each field shows its confidence and "matches the form / double-check / does not match". |
| At least two simulated verification services | PAN, GST, bank and risk in [`providers.ts`](server/src/providers.ts) |
| Explicit states and transition rules | [`states.ts`](server/src/states.ts) |
| Asynchronous callbacks | `POST /api/callbacks/:type`, handled in [`workflow.ts`](server/src/workflow.ts) |
| Operator view of status, missing information, exceptions | The web app: list, "What happens next", "What the merchant needs to fix", "Why a person has to look at this" |
| Approve and create a merchant ID only when configured checks pass | `requiredChecks` in [`config.ts`](server/src/config.ts), decision in `evaluate()` |
| Duplicate detection and entity matching | Same PAN, GSTIN or bank account as another application that is not rejected, or a similar owner name together with the same phone or email. Rejected applications are ignored. |
| Human review queue | "Needs a review" status and the *Needs my attention* filter |
| Retries, dead letter, audit history | Check retries, merchant-ID retries, `MERCHANT_ID_FAILED` for the dead letter, and the timeline |
| Operational metrics | "How is the process doing?" on the Applications page |

Not built: reading text out of photos and scanned PDFs (that needs OCR). A clear photo is accepted but a person has to read it; a blurry one is sent back. Nothing here needs production infrastructure. See the limitations below.

## The failure scenarios

Pick the situation in step 4 of **New application**. Each one also has an automated test in [`server/tests/flow.test.ts`](server/tests/flow.test.ts).

| Scenario | What the system does |
|---|---|
| PAN passes, GST fails | PAN stays passed. The case goes to a reviewer with the exact reason. They can approve (the GST check is shown as "waived by Asha", with their reason) or reject. |
| The same callback arrives several times | Every callback has a unique id that is saved the first time. Copies are recognised and ignored, even when they arrive at the same instant. |
| A callback arrives after the request timed out | We timed out and sent the request again. If the first answer shows up late, it is still valid and is used. The retry's answer is then ignored because the check already has its result. |
| The merchant changes bank details | Only the bank check starts again. An answer about the old account is ignored. For a live merchant, payouts pause (payments keep working) until the new account is verified. A change without proof also needs a person to confirm. |
| Approval works, merchant ID creation fails | Approval is saved first. The ID is retried 3 times, then the application moves to "Merchant ID failed" for operations to retry. A merchant can never get two IDs. |
| A document is blurry or contradicts the form | The merchant is told exactly what to fix, in plain words. No checks are started, so no provider is called for a bad application. |

Also covered: a provider that is down for a moment (retries work) or for good (a person is asked), a high risk score, and low-confidence document values.

## Handling sensitive data

- **Masked everywhere you can see:** PAN, GSTIN and account numbers show only their last 4 characters in every API response, on every screen and in the timeline. A test checks the full numbers never appear.
- **Encrypted in the database:** the numbers (and the uploaded documents, which contain them) are stored encrypted with AES-256-GCM. A test searches the raw database record and checks the plain numbers are not in it.
- **Duplicates without decrypting:** for duplicate checks we store a one-way, keyed fingerprint of each number, so nothing has to be decrypted to compare.
- **Signed callbacks:** every provider callback carries a signature made with a secret only the provider and we know. A missing or wrong signature is refused (HTTP 401) and changes nothing.
- **Only the providers see real values** (they need them). They are decrypted at the moment a check is sent, and nowhere else.
- **People:** only someone who gives a name and a written reason can approve, reject or override. PAN and bank failures can never be overridden by anyone.
- The keys in the code are demo defaults. Real use sets `ENCRYPTION_KEY`, `HASH_KEY` and `CALLBACK_SECRET` from a secrets manager.

## Assumptions, simulated parts and limits

- **Simulated:** the PAN, GST, bank and risk providers, and the merchant-ID system. The providers answer by calling a URL on our server, like real ones do.
- **Real:** reading the text inside PDFs and measuring photo sharpness. Structured fields and text files are accepted too.
- **Not done:**
  - **No OCR.** The system cannot read text out of photos or scanned PDFs. A clear photo is accepted but a person has to read it, so it is never approved on its own.
  - No login or roles. The reviewer just types a name.
  - Name matching is simple (ignores case, word order and "Pvt Ltd"). It does not understand nicknames or spelling variants.
  - `npm audit` reports issues only in development tools (the test runner and the dev server), none in the packages the app runs on. They were left alone rather than forcing major upgrades late in the project.
  - The page refreshes every few seconds instead of using live updates.
  - Retries run in one server process. That is fine for a demo; for more load the "what is due" query could be shared by several workers.
  - If you ran an older version of this project, delete the `.data` folder once: its saved applications use an older format.
- The demo shortcut "retry also fixes the simulated outage" can be turned off with `DEMO_AUTOHEAL=false`.
- MongoDB's own check wants some free disk space; the app lowers it for the built-in database so it can start on a nearly full laptop.

## Folder guide

```
server/src
  config.ts        the rules (required checks, timeouts, retries, thresholds)
  security.ts      encryption, fingerprints, callback signatures
  states.ts        the states and the allowed moves
  reading.ts       turn an uploaded file into text, or measure a photo's sharpness
  documents.ts     compare what was read with the form, confidence
  providers.ts     the simulated PAN / GST / bank / risk services and merchant-ID system
  workflow.ts      sending checks, handling callbacks, deciding, retries
  applications.ts  submit, fix, change bank details, reviewer decisions
  views.ts         the plain-English labels the screens show
  metrics.ts       the numbers
  app.ts           the web routes
server/tests       the scenario tests
server/scripts     makeSamples.ts: creates the sample files in samples/
client/src         three screens: applications, new application, application detail
```
