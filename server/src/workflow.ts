import crypto from 'node:crypto';
import { CheckType, config, now } from './config.js';
import { Application, AppDoc, ProcessedEvent } from './models.js';
import { Callback, createMerchantId, sendToProvider } from './providers.js';
import { decrypt } from './security.js';
import { addAudit, changeState } from './states.js';

// ---------------------------------------------------------------------------
// The workflow engine: send checks, handle the answers, decide, create the merchant ID.
// ---------------------------------------------------------------------------

export const CHECK_NAME: Record<CheckType, string> = {
  PAN: 'PAN (tax ID)', GST: 'GST registration', BANK: 'Bank account', RISK: 'Risk screening',
};
const CHECKING = ['VERIFYING', 'BANK_RECHECK'];           // states in which checks are running
const STILL_WAITING = ['PENDING', 'RETRYING'];
const ANSWERED = ['PASSED', 'FAILED', 'NEEDS_REVIEW'];

export const rid = (n = 8) => crypto.randomBytes(n).toString('hex');

// What we send to a provider. The providers need the real numbers, so this is where they are decrypted.
function dataFor(app: AppDoc, type: CheckType): Record<string, string> {
  const secret = decrypt<{ pan: string; gstin: string; accountNumber: string }>(app.secret);
  if (type === 'PAN') return { pan: secret.pan, name: app.business.legalName };
  if (type === 'GST') return { gstin: secret.gstin, legalName: app.business.legalName };
  if (type === 'BANK') return { accountNumber: secret.accountNumber, ifsc: app.bank.ifsc, holderName: app.bank.holderName };
  return { pan: secret.pan, businessName: app.business.name };
}

/** Changes one check inside the application's "checks" list. Optionally only if it is in the expected status. */
export async function setCheck(
  id: string, type: CheckType, set: Record<string, unknown>,
  opts: { onlyIf?: string[]; requestId?: string; addRequestId?: string } = {},
): Promise<boolean> {
  const match: any = { type };
  if (opts.onlyIf) match.status = { $in: opts.onlyIf };
  if (opts.requestId) match.requestIds = opts.requestId;
  const update: any = { $set: Object.fromEntries(Object.entries(set).map(([k, v]) => [`checks.$.${k}`, v])) };
  if (opts.addRequestId) update.$push = { 'checks.$.requestIds': opts.addRequestId };
  const result = await Application.updateOne({ _id: id, checks: { $elemMatch: match } }, update);
  return result.modifiedCount === 1;
}

const freshCheck = (type: CheckType) => ({ type, status: 'RETRYING', requestIds: [] as string[], sends: 0, nextSendAt: now() });

/** Starts all required checks. */
export async function startChecks(id: string) {
  await Application.updateOne({ _id: id }, { $set: { checks: config.requiredChecks.map(freshCheck) } });
  for (const type of config.requiredChecks) await sendCheck(id, type);
}

/** Starts one check again from zero (after a bank change, or when a reviewer asks for a retry). */
export async function restartCheck(id: string, type: CheckType) {
  const app: any = await Application.findById(id).lean();
  const old = app.checks.find((c: any) => c.type === type);
  const stale = old?.requestIds ?? [];
  await Application.updateOne({ _id: id }, { $push: { staleRequestIds: { $each: stale } } });
  const exists = !!old;
  if (exists) await Application.updateOne({ _id: id, 'checks.type': type }, { $set: { 'checks.$': freshCheck(type) } });
  else await Application.updateOne({ _id: id }, { $push: { checks: freshCheck(type) } });
  await sendCheck(id, type);
}

export async function sendCheck(id: string, type: CheckType) {
  const app: any = await Application.findById(id).lean();
  const check = app.checks.find((c: any) => c.type === type);
  const requestId = 'req_' + rid(6);
  const sends = check.sends + 1;
  // Claim the check first. If something else already did, we do nothing.
  const claimed = await setCheck(id, type, { status: 'PENDING', sends, dueAt: now() + config.checkTimeoutMs, nextSendAt: null }, { onlyIf: ['RETRYING'], addRequestId: requestId });
  if (!claimed) return;
  await addAudit(id, `Sent the ${CHECK_NAME[type]} request to the provider (attempt ${sends} of ${config.maxSends}).`);
  try {
    await sendToProvider(type, { requestId, appId: id, attempt: sends, scenario: app.scenario, data: dataFor(app, type) });
  } catch {
    if (sends < config.maxSends) {
      await setCheck(id, type, { status: 'RETRYING', nextSendAt: now() + config.retryDelayMs * sends }, { onlyIf: ['PENDING'] });
      await addAudit(id, `The ${CHECK_NAME[type]} provider could not be reached. Trying again shortly.`);
    } else {
      await setCheck(id, type, { status: 'UNAVAILABLE', reason: 'The provider could not be reached after 3 tries.' }, { onlyIf: ['PENDING'] });
      await addAudit(id, `The ${CHECK_NAME[type]} provider could not be reached after ${config.maxSends} tries. Giving up on this check.`);
      await evaluate(id);
    }
  }
}

/**
 * A provider calls us with an answer. Possible outcomes:
 *   accepted        first answer for the check
 *   late            the answer arrived after we had already timed out; still valid, so we use it
 *   duplicate       we already handled this exact callback
 *   already-answered another answer for this check was used before
 *   old-answer      the answer is for details that have since changed (e.g. old bank account)
 *   unknown         we never sent that request
 */
export async function handleCallback(body: Callback): Promise<string> {
  if (!body?.eventId || !body?.requestId || !body?.type || !body?.status) throw new Error('eventId, requestId, type and status are required');

  // Every callback has a unique id. If we cannot save it, we have seen it before.
  try { await ProcessedEvent.create({ _id: body.eventId, at: now() }); }
  catch (e: any) {
    if (e.code !== 11000) throw e;
    const app: any = await Application.findOne({ 'checks.requestIds': body.requestId }).lean();
    if (app) await addAudit(app._id, `Ignored a repeated ${CHECK_NAME[body.type as CheckType]} answer (we already had it).`);
    return 'duplicate';
  }

  const app: any = await Application.findOne({ 'checks.requestIds': body.requestId }).lean();
  if (!app) {
    const old: any = await Application.findOne({ staleRequestIds: body.requestId }).lean();
    if (old) await addAudit(old._id, `Ignored an old ${CHECK_NAME[body.type as CheckType]} answer: the details were changed after the request was sent.`);
    return old ? 'old-answer' : 'unknown';
  }
  const check = app.checks.find((c: any) => c.requestIds.includes(body.requestId));
  const type = check.type as CheckType;
  if (ANSWERED.includes(check.status)) {
    await addAudit(app._id, `Ignored an extra ${CHECK_NAME[type]} answer: this check already has its result.`);
    return 'already-answered';
  }

  // Late = we are no longer waiting for this particular request (we timed out and retried, or gave up).
  const late = check.status !== 'PENDING' || check.requestIds[check.requestIds.length - 1] !== body.requestId;
  const saved = await setCheck(app._id, type,
    { status: body.status, reason: body.reason ?? null, answeredAt: now(), dueAt: null },
    { onlyIf: ['PENDING', 'RETRYING', 'NO_RESPONSE', 'UNAVAILABLE'], requestId: body.requestId });
  if (!saved) return 'already-answered';

  const word = { PASSED: 'passed', FAILED: 'failed', NEEDS_REVIEW: 'needs a person to look at it' }[body.status];
  await addAudit(app._id, late
    ? `The ${CHECK_NAME[type]} answer arrived after the timeout, but it is still valid: ${word}.`
    : `${CHECK_NAME[type]} check ${word}${body.reason ? ' (' + body.reason + ')' : ''}.`, `${CHECK_NAME[type]} provider`);
  await evaluate(app._id);
  return late ? 'late' : 'accepted';
}

/** What is still wrong with this application? (failed checks and things a person must double-check) */
export function problemsOf(app: AppDoc): { text: string; canOverride: boolean }[] {
  const list: { text: string; canOverride: boolean }[] = [];
  for (const c of app.checks) {
    if (c.status === 'PASSED' || c.overridden || STILL_WAITING.includes(c.status)) continue;
    const what = c.reason ?? { FAILED: 'The check failed.', NEEDS_REVIEW: 'It needs a person to look at it.', NO_RESPONSE: 'The provider did not answer in time.', UNAVAILABLE: 'The provider could not be reached.' }[c.status as string];
    list.push({ text: `${CHECK_NAME[c.type as CheckType]}: ${what}`, canOverride: !config.cannotOverride.includes(c.type) });
  }
  for (const i of app.issues) if (i.kind === 'review') list.push({ text: i.message, canOverride: true });
  return list;
}

/**
 * Decides what happens next. Called after every answer.
 * Waits until all checks have an outcome. If everything is clean: approve. Otherwise: send to a person.
 * The system never rejects by itself, only a person can reject.
 */
export async function evaluate(id: string) {
  const app: any = await Application.findById(id).lean();
  if (!app || !CHECKING.includes(app.state)) return;
  if (app.checks.some((c: any) => STILL_WAITING.includes(c.status))) return;

  const problems = problemsOf(app);
  if (problems.length === 0) {
    if (app.state === 'BANK_RECHECK') {
      await changeState(id, 'ONBOARDED', 'The new bank account is verified. Payouts are switched back on.', 'System', { payoutsOnHold: false }, 'BANK_RECHECK');
      return;
    }
    await changeState(id, 'APPROVED', 'All required checks passed, so the application was approved automatically.', 'System', { 'merchant.attempts': 0, 'merchant.nextAttemptAt': now() }, 'VERIFYING');
  } else {
    await changeState(id, 'IN_REVIEW', `A person needs to review this: ${problems.map((p) => p.text).join(' ')}`, 'System', {}, app.state);
  }
}

/** Creates the merchant ID. If it fails we retry a few times, then hand it to the operations team. */
export async function createMerchant(id: string) {
  const t = now();
  // "Lease" the job for a minute so two workers can never do it at the same time.
  const leased = await Application.updateOne({ _id: id, state: 'APPROVED', 'merchant.nextAttemptAt': { $lte: t } }, { $set: { 'merchant.nextAttemptAt': t + 60_000 } });
  if (leased.modifiedCount !== 1) return;

  const app: any = await Application.findById(id).lean();
  const attempt = app.merchant.attempts + 1;
  try {
    const merchantId = createMerchantId(id, app.scenario, attempt);
    await changeState(id, 'ONBOARDED', `Merchant ID ${merchantId} created. Cards, UPI and net banking are switched on.`, 'System', { 'merchant.id': merchantId, 'merchant.attempts': attempt }, 'APPROVED');
  } catch (e: any) {
    if (attempt >= config.merchantMaxAttempts) {
      await changeState(id, 'MERCHANT_ID_FAILED', `Creating the merchant ID failed ${attempt} times (${e.message}). The approval is kept. The operations team needs to retry.`, 'System', { 'merchant.attempts': attempt, 'merchant.lastError': e.message }, 'APPROVED');
    } else {
      await Application.updateOne({ _id: id }, {
        $set: { 'merchant.attempts': attempt, 'merchant.nextAttemptAt': t + config.merchantRetryDelayMs * attempt, 'merchant.lastError': e.message },
        $push: { audit: { at: t, actor: 'System', message: `Creating the merchant ID failed (attempt ${attempt} of ${config.merchantMaxAttempts}): ${e.message}. Will try again.` } },
      });
    }
  }
}

/**
 * Runs once a second. Looks for work that is due and does it:
 *   1. checks that got no answer in time  -> try again, or give up after the last try
 *   2. checks waiting to be sent again    -> send them
 *   3. approved applications              -> create the merchant ID (or retry)
 * Because "when is it due" is saved in the database, this survives a restart.
 */
export async function sweep() {
  const t = now();

  const timedOut = await Application.find({ state: { $in: CHECKING }, checks: { $elemMatch: { status: 'PENDING', dueAt: { $lte: t } } } }).lean();
  for (const app of timedOut as any[]) {
    for (const c of app.checks.filter((c: any) => c.status === 'PENDING' && c.dueAt <= t)) {
      const name = CHECK_NAME[c.type as CheckType];
      if (c.sends < config.maxSends) {
        if (await setCheck(app._id, c.type, { status: 'RETRYING', nextSendAt: t + config.retryDelayMs, dueAt: null }, { onlyIf: ['PENDING'] })) {
          await addAudit(app._id, `No ${name} answer after ${config.checkTimeoutMs / 1000} seconds. Trying again.`);
        }
      } else if (await setCheck(app._id, c.type, { status: 'NO_RESPONSE', reason: `No answer after ${config.maxSends} tries.`, dueAt: null }, { onlyIf: ['PENDING'] })) {
        await addAudit(app._id, `No ${name} answer after ${config.maxSends} tries. Giving up on this check.`);
        await evaluate(app._id);
      }
    }
  }

  const toSend = await Application.find({ state: { $in: CHECKING }, checks: { $elemMatch: { status: 'RETRYING', nextSendAt: { $lte: t } } } }).lean();
  for (const app of toSend as any[]) {
    for (const c of app.checks.filter((c: any) => c.status === 'RETRYING' && c.nextSendAt <= t)) await sendCheck(app._id, c.type);
  }

  const toCreate = await Application.find({ state: 'APPROVED', 'merchant.nextAttemptAt': { $lte: t } }, { _id: 1 }).lean();
  for (const app of toCreate as any[]) await createMerchant(app._id);
}
