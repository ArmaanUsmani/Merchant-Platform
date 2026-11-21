import { Application } from './models.js';
import { now } from './config.js';

export const STATES = [
  'SUBMITTED',           // just received
  'NEEDS_INFO',          // the merchant must fix something
  'VERIFYING',           // PAN / GST / bank / risk checks are running
  'IN_REVIEW',           // a person has to decide
  'APPROVED',            // all checks passed, merchant ID being created
  'ONBOARDED',           // merchant ID exists
  'MERCHANT_ID_FAILED',  // approved, but creating the ID kept failing: needs ops
  'BANK_RECHECK',        // bank details changed after go-live: payouts paused
  'REJECTED',
] as const;
export type State = (typeof STATES)[number];

// The only moves that are allowed. Anything else is refused.
export const allowed: Record<State, State[]> = {
  SUBMITTED: ['NEEDS_INFO', 'VERIFYING', 'IN_REVIEW'],
  NEEDS_INFO: ['VERIFYING', 'IN_REVIEW', 'REJECTED'],
  VERIFYING: ['APPROVED', 'IN_REVIEW'],
  IN_REVIEW: ['VERIFYING', 'APPROVED', 'ONBOARDED', 'NEEDS_INFO', 'REJECTED'],
  APPROVED: ['ONBOARDED', 'MERCHANT_ID_FAILED', 'VERIFYING'],
  MERCHANT_ID_FAILED: ['APPROVED', 'VERIFYING'],
  ONBOARDED: ['BANK_RECHECK'],
  BANK_RECHECK: ['ONBOARDED', 'IN_REVIEW'],
  REJECTED: [],
};

export async function addAudit(id: string, message: string, actor = 'System') {
  await Application.updateOne({ _id: id }, { $push: { audit: { at: now(), actor, message } } });
}

/**
 * The only function that changes an application's state.
 * It checks the move is allowed, and it only updates if the state is still what we just read.
 * So if two things happen at the same moment (say two callbacks), only one of them wins.
 * Returns false when someone else got there first (pass expectFrom to say which state you are leaving).
 */
export async function changeState(
  id: string, to: State, message: string, actor = 'System', extra: Record<string, unknown> = {}, expectFrom?: State,
): Promise<boolean> {
  const app: any = await Application.findById(id).lean();
  if (!app) throw new Error(`Application ${id} not found`);
  if (expectFrom && app.state !== expectFrom) return false;   // someone else already moved it
  if (!allowed[app.state as State].includes(to)) throw new Error(`An application cannot go from ${app.state} to ${to}`);
  const t = now();
  const result = await Application.updateOne(
    { _id: id, state: app.state },
    { $set: { state: to, stateChangedAt: t, ...extra }, $push: { audit: { at: t, actor, message, from: app.state, to } } },
  );
  return result.modifiedCount === 1;
}
