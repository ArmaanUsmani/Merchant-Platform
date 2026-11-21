import { CheckType, config, now } from './config.js';
import { checkApplication, clean, compareNames, DocInput, Form, Issue, maskValue } from './documents.js';
import { HttpError } from './errors.js';
import { Application, AppDoc } from './models.js';
import { SCENARIOS } from './providers.js';
import { readUploads } from './reading.js';
import { decrypt, encrypt, fingerprint } from './security.js';
import { addAudit, changeState } from './states.js';
import { CHECK_NAME, restartCheck, rid, startChecks } from './workflow.js';

// ---------------------------------------------------------------------------
// What happens when a merchant submits, a reviewer decides, or bank details change.
// ---------------------------------------------------------------------------

/** The application as a form again. This is the only place the sensitive numbers are decrypted. */
export function formOf(app: AppDoc): Form {
  const secret = decrypt<{ pan: string; gstin: string; accountNumber: string }>(app.secret);
  return {
    businessName: app.business.name, legalName: app.business.legalName, businessType: app.business.type,
    email: app.business.email, phone: app.business.phone,
    pan: secret.pan, gstin: secret.gstin,
    bank: { accountNumber: secret.accountNumber, ifsc: app.bank.ifsc, holderName: app.bank.holderName },
  };
}

/** The documents the merchant sent. They contain the real numbers, so they are kept encrypted. */
const docsOf = (app: AppDoc): DocInput[] => (app.rawDocs ? decrypt<DocInput[]>(app.rawDocs) : []);

const businessOf = (f: Form) => ({ name: f.businessName, legalName: f.legalName, type: f.businessType, email: f.email, phone: clean(f.phone) });

/** Stores the PAN, GSTIN and account number three ways: encrypted, as a fingerprint for duplicate checks, and masked for display. */
export function protect(f: Form) {
  const pan = clean(f.pan), gstin = clean(f.gstin), account = clean(f.bank.accountNumber);
  return {
    secret: encrypt({ pan, gstin, accountNumber: account }),
    ids: { pan: fingerprint(pan), gstin: fingerprint(gstin), account: fingerprint(account) },
    masked: { pan: maskValue(pan), gstin: maskValue(gstin), account: maskValue(account) },
    bank: { ifsc: clean(f.bank.ifsc), holderName: (f.bank.holderName ?? '').trim() },
  };
}

/**
 * Looks for other (not rejected) applications that are probably the same business:
 *   exact:  same PAN, GSTIN or bank account
 *   fuzzy:  a similar owner name AND the same phone or email (a shared phone alone is common in families, so it is not enough)
 */
async function findDuplicates(app: AppDoc) {
  const others: any[] = await Application.find({
    _id: { $ne: app._id }, state: { $ne: 'REJECTED' },
    $or: [{ 'ids.pan': app.ids.pan }, { 'ids.gstin': app.ids.gstin }, { 'ids.account': app.ids.account }, { 'business.phone': app.business.phone }, { 'business.email': app.business.email }],
  }).lean();

  const found = [];
  for (const o of others) {
    const same: string[] = [];
    if (o.ids?.pan === app.ids.pan) same.push('same PAN');
    if (o.ids?.gstin === app.ids.gstin) same.push('same GSTIN');
    if (o.ids?.account === app.ids.account) same.push('same bank account');
    const samePhone = o.business.phone === app.business.phone;
    const sameEmail = (o.business.email ?? '').toLowerCase() === (app.business.email ?? '').toLowerCase();
    if ((samePhone || sameEmail) && compareNames(o.business.legalName, app.business.legalName) !== 'different') {
      same.push('similar owner name');
      if (samePhone) same.push('same phone number');
      if (sameEmail) same.push('same email');
    }
    if (same.length) found.push({ appId: o._id, name: o.business.name, state: o.state, same });
  }
  return found;
}

/** Reads the documents, checks them against the form, looks for duplicates, and decides what happens next. */
async function runIntake(id: string) {
  const app: any = await Application.findById(id).lean();
  const { issues, documents } = checkApplication(formOf(app), docsOf(app));

  const duplicates = await findDuplicates(app);
  const sameIdentity = duplicates.some((d) => d.same.includes('same PAN') || d.same.includes('same GSTIN'));   // clearly the same legal entity
  for (const d of duplicates) {
    issues.push({ kind: 'review', message: `This looks like a duplicate of ${d.appId} ("${d.name}"): ${d.same.join(', ')}.` });
  }
  await Application.updateOne({ _id: id }, { $set: { issues, documents, duplicates } });

  const missing = issues.filter((i) => i.kind === 'missing');
  if (missing.length) {
    const msg = `We need ${missing.length} thing${missing.length > 1 ? 's' : ''} from the merchant before we can continue.`;
    if (app.state === 'NEEDS_INFO') await addAudit(id, `The merchant sent corrections, but ${missing.length} problem${missing.length > 1 ? 's' : ''} remain.`, 'Merchant');
    else await changeState(id, 'NEEDS_INFO', msg, 'System', {}, app.state);
  } else if (sameIdentity) {
    await changeState(id, 'IN_REVIEW', 'Another application has the same PAN or GSTIN, so no checks were run. A person must decide.', 'System', {}, app.state);
  } else {
    await changeState(id, 'VERIFYING', 'The documents look good. Starting the PAN, GST, bank and risk checks.', 'System', {}, app.state);
    await startChecks(id);
  }
}

export async function submitApplication(input: { form: Form; documents?: DocInput[]; scenario?: string }): Promise<string> {
  const { form } = input;
  const scenario = input.scenario ?? 'normal';
  if (!SCENARIOS.some((s) => s.id === scenario)) throw new HttpError(422, `Unknown scenario "${scenario}".`);
  if (!form?.bank || !form.legalName?.trim() || !form.businessName?.trim()) throw new HttpError(422, 'Please fill in the business name, the owner\'s name and the bank details.');

  const documents = await readUploads(input.documents ?? []);
  const id = 'APP-' + rid(3).toUpperCase();
  const t = now();
  await Application.create({
    _id: id, state: 'SUBMITTED', createdAt: t, stateChangedAt: t, scenario,
    business: businessOf(form), ...protect(form), rawDocs: encrypt(documents),
    audit: [{ at: t, actor: 'Merchant', message: `Application received with ${documents.length} document${documents.length === 1 ? '' : 's'}.` }],
  });
  await runIntake(id);
  return id;
}

/** The merchant answers a "we need more information" request. */
export async function resubmit(id: string, input: { form?: Partial<Form>; documents?: DocInput[] }) {
  const app: any = await Application.findById(id).lean();
  if (!app) throw new HttpError(404, 'Application not found.');
  if (app.state !== 'NEEDS_INFO') throw new HttpError(409, 'This application is not waiting for information from the merchant.');

  const given = (o: object = {}) => Object.fromEntries(Object.entries(o).filter(([, v]) => v)) as any;   // ignore empty fields
  const current = formOf(app);
  const merged: Form = { ...current, ...given(input.form), bank: { ...current.bank, ...given(input.form?.bank) } };

  const newDocs = await readUploads(input.documents ?? []);
  const rawDocs = [...docsOf(app).filter((d) => !newDocs.some((n) => n.type === d.type)), ...newDocs];
  await Application.updateOne({ _id: id }, { $set: { business: businessOf(merged), ...protect(merged), rawDocs: encrypt(rawDocs) } });
  await addAudit(id, newDocs.length ? `The merchant sent ${newDocs.length} corrected document${newDocs.length > 1 ? 's' : ''}.` : 'The merchant sent corrections.', 'Merchant');
  await runIntake(id);
}

/**
 * The merchant changes bank details. Whatever we verified before was about the OLD account,
 * so the bank check starts again. A live merchant keeps accepting payments but payouts pause.
 */
export async function changeBank(id: string, input: { bank: { accountNumber: string; ifsc: string; holderName: string }; proof?: DocInput }) {
  const app: any = await Application.findById(id).lean();
  if (!app) throw new HttpError(404, 'Application not found.');
  if (['REJECTED', 'SUBMITTED'].includes(app.state)) throw new HttpError(409, `Bank details cannot be changed while the application is ${app.state.toLowerCase()}.`);

  const form: Form = { ...formOf(app), bank: { accountNumber: input.bank.accountNumber ?? '', ifsc: input.bank.ifsc ?? '', holderName: input.bank.holderName ?? '' } };
  const [proof] = await readUploads(input.proof ? [input.proof] : []);
  const others = docsOf(app).filter((d) => d.type !== 'BANK_PROOF');
  const check = checkApplication(form, proof ? [proof, ...others] : docsOf(app));
  const problems = check.issues.filter((i: Issue) => i.kind === 'missing' && (!i.doc || (proof && i.doc === 'BANK_PROOF')) && /bank|IFSC|account/i.test(i.message));
  if (problems.length) throw new HttpError(422, problems.map((p: Issue) => p.message).join(' '));

  const oldReview = app.issues.filter((i: any) => i.kind === 'review' && !i.bankChange);
  const issues = proof
    ? check.issues.filter((i: Issue) => i.kind === 'review')
    : [...oldReview, { kind: 'review', bankChange: true, message: 'The bank account was changed without proof (cancelled cheque or statement). A person must confirm it is genuine.' }];
  const rawDocs = proof ? [...others, proof] : docsOf(app);
  const stored = protect(form);
  await Application.updateOne({ _id: id }, { $set: { ...stored, issues, rawDocs: encrypt(rawDocs), ...(proof && { documents: check.documents }) } });
  await addAudit(id, `Bank account changed from ${app.masked.account} to ${stored.masked.account} (${proof ? 'with proof' : 'without proof'}).`, 'Merchant');

  if (app.state === 'ONBOARDED') {
    await changeState(id, 'BANK_RECHECK', 'Bank details changed after go-live. Payments keep working, payouts are paused until the new account is verified.', 'System', { payoutsOnHold: true }, 'ONBOARDED');
  } else if (['APPROVED', 'IN_REVIEW', 'MERCHANT_ID_FAILED'].includes(app.state)) {
    await changeState(id, 'VERIFYING', 'Bank details changed, so the bank check starts again.', 'System', {}, app.state);
  }
  const after: any = await Application.findById(id).lean();
  if (['VERIFYING', 'BANK_RECHECK'].includes(after.state)) await restartCheck(id, 'BANK');
}

export interface ReviewInput {
  action: 'approve' | 'reject' | 'ask_merchant' | 'retry_check';
  reviewer: string;
  note: string;
  items?: string[];
  checkType?: CheckType;
}

/** A person decides on a case in review. Every decision needs a name and a written reason. */
export async function reviewApplication(id: string, input: ReviewInput) {
  const reviewer = (input.reviewer ?? '').trim();
  const note = (input.note ?? '').trim();
  if (!reviewer) throw new HttpError(422, 'Please enter your name.');
  if (note.length < 5) throw new HttpError(422, 'Please write a short reason for your decision (at least 5 characters).');

  const app: any = await Application.findById(id).lean();
  if (!app) throw new HttpError(404, 'Application not found.');
  if (app.state !== 'IN_REVIEW') throw new HttpError(409, 'This application is not waiting for a review.');
  const actor = `Reviewer ${reviewer}`;

  if (input.action === 'reject') {
    await changeState(id, 'REJECTED', `Rejected by ${reviewer}. Reason: ${note}`, actor, { decision: { by: reviewer, action: 'reject', note, at: now() } }, 'IN_REVIEW');
  } else if (input.action === 'ask_merchant') {
    const items = (input.items ?? []).map((s) => s.trim()).filter(Boolean);
    if (!items.length) throw new HttpError(422, 'Please say what the merchant needs to provide.');
    await changeState(id, 'NEEDS_INFO', `${reviewer} asked the merchant for more information: ${items.join('; ')}. Reason: ${note}`, actor,
      { issues: items.map((message) => ({ kind: 'missing', message })) }, 'IN_REVIEW');
  } else if (input.action === 'retry_check') {
    if (!input.checkType || !config.requiredChecks.includes(input.checkType)) throw new HttpError(422, 'Please choose which check to run again.');
    await changeState(id, 'VERIFYING', `${reviewer} asked to run the ${CHECK_NAME[input.checkType]} check again. Reason: ${note}`, actor, {}, 'IN_REVIEW');
    await restartCheck(id, input.checkType);
  } else if (input.action === 'approve') {
    const open = app.checks.filter((c: any) => c.status !== 'PASSED' && !c.overridden);
    if (open.some((c: any) => ['PENDING', 'RETRYING'].includes(c.status))) throw new HttpError(409, 'Some checks are still running. Please wait for them to finish.');
    const blockers = open.filter((c: any) => config.cannotOverride.includes(c.type));
    if (blockers.length) {
      throw new HttpError(422, `${blockers.map((c: any) => CHECK_NAME[c.type as CheckType]).join(' and ')} failed. That check can never be overridden by a person. Run it again, ask the merchant for more information, or reject.`);
    }
    for (const c of open) await Application.updateOne({ _id: id, 'checks.type': c.type }, { $set: { 'checks.$.overridden': { by: reviewer, note, at: now() } } });
    const waived = open.map((c: any) => CHECK_NAME[c.type as CheckType]);
    const text = `Approved by ${reviewer}${waived.length ? ` (waived: ${waived.join(', ')})` : ''}. Reason: ${note}`;
    const base = { decision: { by: reviewer, action: 'approve', note, at: now() }, issues: app.issues.filter((i: any) => i.kind !== 'review') };
    if (app.merchant?.id) await changeState(id, 'ONBOARDED', text, actor, { ...base, payoutsOnHold: false }, 'IN_REVIEW');
    else await changeState(id, 'APPROVED', text, actor, { ...base, 'merchant.attempts': 0, 'merchant.nextAttemptAt': now() }, 'IN_REVIEW');
  } else {
    throw new HttpError(422, 'Unknown action.');
  }
}

/** The operations team retries a merchant ID that kept failing. */
export async function retryMerchantId(id: string, by: string) {
  const app: any = await Application.findById(id).lean();
  if (!app) throw new HttpError(404, 'Application not found.');
  if (app.state !== 'MERCHANT_ID_FAILED') throw new HttpError(409, 'The merchant ID did not fail for this application.');
  const extra: Record<string, unknown> = { 'merchant.attempts': 0, 'merchant.nextAttemptAt': now() };
  if (config.demoAutoHeal && app.scenario === 'merchant_id_fails') {
    extra.scenario = 'normal';   // demo only: pretend the merchant platform has been fixed
    await addAudit(id, 'Demo only: the simulated merchant platform outage is treated as fixed.');
  }
  await changeState(id, 'APPROVED', `${by || 'Operations'} retried creating the merchant ID.`, `Ops ${by || ''}`.trim(), extra, 'MERCHANT_ID_FAILED');
}
