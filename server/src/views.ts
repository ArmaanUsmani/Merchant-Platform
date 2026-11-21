import { config, now } from './config.js';
import { AppDoc, Application } from './models.js';
import { State } from './states.js';
import { CHECK_NAME, problemsOf } from './workflow.js';

// ---------------------------------------------------------------------------
// What the screens show. The words are written here, in plain English,
// so the web page does not have to translate codes into sentences.
// ---------------------------------------------------------------------------

type Tone = 'good' | 'warn' | 'bad' | 'info' | 'neutral';

export const STATE_INFO: Record<State, { label: string; tone: Tone; next: string; group: string }> = {
  SUBMITTED: { label: 'Received', tone: 'neutral', group: 'progress', next: 'The documents are being read.' },
  NEEDS_INFO: { label: 'Waiting for the merchant', tone: 'warn', group: 'merchant', next: 'The merchant has to fix the items listed below and send them again. Nothing to do for the operations team.' },
  VERIFYING: { label: 'Being verified', tone: 'info', group: 'progress', next: 'The checks are running. Answers arrive on their own, usually within a few seconds. Nothing to do.' },
  IN_REVIEW: { label: 'Needs a review', tone: 'warn', group: 'attention', next: 'A person has to decide. Read the reasons below, then approve, reject or ask the merchant for more.' },
  APPROVED: { label: 'Approved', tone: 'good', group: 'progress', next: 'All checks passed. The merchant ID is being created.' },
  ONBOARDED: { label: 'Active merchant', tone: 'good', group: 'done', next: 'Done. The merchant can accept payments.' },
  MERCHANT_ID_FAILED: { label: 'Merchant ID failed', tone: 'bad', group: 'attention', next: 'The application is approved, but the merchant ID could not be created. Press "Retry" below.' },
  BANK_RECHECK: { label: 'Bank change being checked', tone: 'info', group: 'progress', next: 'Payments still work. Payouts are paused until the new bank account is verified.' },
  REJECTED: { label: 'Rejected', tone: 'bad', group: 'done', next: 'Closed. A reviewer rejected this application.' },
};

const CHECK_STATUS: Record<string, { text: string; tone: Tone }> = {
  PENDING: { text: 'Waiting for the answer', tone: 'info' },
  RETRYING: { text: 'Trying again', tone: 'warn' },
  PASSED: { text: 'Passed', tone: 'good' },
  FAILED: { text: 'Failed', tone: 'bad' },
  NEEDS_REVIEW: { text: 'Needs a person to look', tone: 'warn' },
  NO_RESPONSE: { text: 'No answer', tone: 'bad' },
  UNAVAILABLE: { text: 'Provider unavailable', tone: 'bad' },
  WAIVED: { text: 'Waived by a reviewer', tone: 'good' },
};

function checkRows(app: AppDoc) {
  return app.checks.map((c: any) => {
    const status = c.overridden ? 'WAIVED' : c.status;
    const s = CHECK_STATUS[status];
    return {
      type: c.type, name: CHECK_NAME[c.type as keyof typeof CHECK_NAME], status, text: s.text, tone: s.tone,
      tries: c.sends, reason: c.reason ?? null, waivedBy: c.overridden?.by ?? null, waivedWhy: c.overridden?.note ?? null,
    };
  });
}

/** One application, ready to show. Sensitive numbers are masked here, so they can never leak out of the API. */
export function toView(app: AppDoc) {
  const info = STATE_INFO[app.state as State];
  const checks = app.checks.map((c: any) => c);
  const stillRunning = checks.filter((c: any) => ['PENDING', 'RETRYING'].includes(c.status)).map((c: any) => CHECK_NAME[c.type as keyof typeof CHECK_NAME]);
  const blockers = checks.filter((c: any) => !['PASSED'].includes(c.status) && !c.overridden && config.cannotOverride.includes(c.type) && !['PENDING', 'RETRYING'].includes(c.status));
  const canApprove = app.state === 'IN_REVIEW' && !stillRunning.length && !blockers.length;
  return {
    id: app._id,
    state: app.state,
    label: info.label, tone: info.tone, nextStep: info.next,
    business: { name: app.business.name, legalName: app.business.legalName, type: app.business.type, email: app.business.email, phone: app.business.phone },
    pan: app.masked.pan, gstin: app.masked.gstin,
    bank: { account: app.masked.account, ifsc: app.bank.ifsc, holderName: app.bank.holderName },
    scenario: app.scenario,
    toFix: app.issues.filter((i: any) => i.kind === 'missing').map((i: any) => i.message),
    reviewReasons: problemsOf(app),
    checks: checkRows(app),
    documents: app.documents,
    duplicates: app.duplicates,
    merchantId: app.merchant?.id ?? null,
    payoutsOnHold: app.payoutsOnHold,
    audit: app.audit,
    createdAt: app.createdAt,
    inStateMs: now() - app.stateChangedAt,
    review: app.state === 'IN_REVIEW' ? {
      canApprove,
      approveBlockedBecause: blockers.length
        ? `${blockers.map((c: any) => CHECK_NAME[c.type as keyof typeof CHECK_NAME]).join(' and ')} failed. A person can never override that check.`
        : stillRunning.length ? `These checks are still running: ${stillRunning.join(', ')}.` : null,
      checksToRetry: config.requiredChecks.map((t) => ({ type: t, name: CHECK_NAME[t] })),
    } : null,
  };
}

export async function listApplications(group?: string) {
  const rows: any[] = await Application.find().sort({ createdAt: -1 }).limit(200).lean();
  return rows
    .filter((a) => !group || group === 'all' || STATE_INFO[a.state as State].group === group)
    .map((a) => {
      const info = STATE_INFO[a.state as State];
      return {
        id: a._id, name: a.business.name, legalName: a.business.legalName, state: a.state, label: info.label, tone: info.tone,
        group: info.group, merchantId: a.merchant?.id ?? null, inStateMs: now() - a.stateChangedAt, createdAt: a.createdAt,
        checks: checkRows(a).map((c: any) => ({ name: c.name, text: c.text, tone: c.tone })),
        toFix: a.issues.filter((i: any) => i.kind === 'missing').length,
        duplicates: a.duplicates.length,
      };
    });
}

export async function counts() {
  const rows: any[] = await Application.find({}, { state: 1 }).lean();
  const groups: Record<string, number> = { all: rows.length, attention: 0, merchant: 0, progress: 0, done: 0 };
  for (const r of rows) groups[STATE_INFO[r.state as State].group]++;
  return groups;
}
