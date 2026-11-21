// All the rules an operations team would want to tweak live in this one file.

export type CheckType = 'PAN' | 'GST' | 'BANK' | 'RISK';

const port = Number(process.env.PORT ?? 4000);

export const config = {
  port,
  // Leave empty to use a throw-away MongoDB that starts automatically (see db.ts).
  mongoUri: process.env.MONGO_URI ?? '',

  // A merchant ID is only created when ALL of these checks have passed.
  requiredChecks: ['PAN', 'GST', 'BANK', 'RISK'] as CheckType[],
  // A reviewer can waive a failed GST or risk check (with a written reason),
  // but never the PAN (identity) or the bank account (where the money goes).
  cannotOverride: ['PAN', 'BANK'] as CheckType[],

  // How long we wait for a provider's answer, how often we try, and how long we wait between tries.
  checkTimeoutMs: Number(process.env.CHECK_TIMEOUT_MS ?? 10_000),
  maxSends: 3,
  retryDelayMs: 1_500,

  merchantMaxAttempts: 3,
  merchantRetryDelayMs: 2_000,

  // Confidence of a value read from a document: below "low" we ask for a better document,
  // between "low" and "good" a person has to double-check it.
  lowConfidence: 0.6,
  goodConfidence: 0.85,

  // Photos and scans: a sharpness score below this means "too blurry to read". Uploads can be at most this big.
  blurThreshold: 60,
  maxUploadBytes: 5 * 1024 * 1024,

  // true: the fake providers call us back by themselves after a delay (normal running).
  // false: callbacks wait in a list until a test delivers them.
  autoCallbacks: true,
  callbackBase: `http://127.0.0.1:${port}`,

  // Demo only: when someone clicks "retry" on a simulated outage, treat the outage as fixed.
  demoAutoHeal: process.env.DEMO_AUTOHEAL !== 'false',
};

// A clock we can move forward in tests, so "10 seconds passed" doesn't need a 10 second wait.
let offset = 0;
export const now = () => Date.now() + offset;
export const advanceClock = (ms: number) => { offset += ms; };
export const resetClock = () => { offset = 0; };
