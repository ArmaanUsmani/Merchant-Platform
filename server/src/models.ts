import mongoose, { Schema } from 'mongoose';

// One document per application. Everything about the case lives inside it:
// the form, the documents, the checks, the audit timeline. Easy to read, easy to explain.
const Mixed = Schema.Types.Mixed;

const applicationSchema = new Schema(
  {
    _id: String,
    state: { type: String, index: true },
    business: Mixed,                                  // name, legal name, type, email, phone
    secret: String,                                   // PAN, GSTIN and account number, encrypted
    ids: Mixed,                                       // one-way fingerprints of those numbers, for finding duplicates
    masked: Mixed,                                    // the same numbers showing only their last 4 characters
    bank: Mixed,                                      // ifsc and holderName (the account number is in `secret`)
    scenario: { type: String, default: 'normal' },    // tells the fake providers how to behave (demo only)
    rawDocs: String,                                  // the documents as they were sent in, encrypted (they contain the numbers)
    documents: { type: [Mixed], default: [] },        // what we read from them (sensitive values masked)
    issues: { type: [Mixed], default: [] },           // things to fix (kind: missing) or double-check (kind: review)
    checks: { type: [Mixed], default: [] },           // PAN / GST / BANK / RISK verification status
    duplicates: { type: [Mixed], default: [] },
    staleRequestIds: { type: [String], default: [] }, // provider requests whose answer no longer applies
    merchant: { type: Mixed, default: { attempts: 0 } },
    payoutsOnHold: { type: Boolean, default: false },
    decision: Mixed,                                  // last human decision
    audit: { type: [Mixed], default: [] },            // the timeline: who did what, when
    createdAt: Number,
    stateChangedAt: Number,
  },
  { versionKey: false, minimize: false },
);
applicationSchema.index({ 'checks.requestIds': 1 });
applicationSchema.index({ 'ids.pan': 1 });
applicationSchema.index({ 'ids.gstin': 1 });
applicationSchema.index({ 'ids.account': 1 });

export const Application = mongoose.model('Application', applicationSchema);

// Remembers which provider callbacks we already handled, so a repeated callback is ignored.
const eventSchema = new Schema({ _id: String, at: Number }, { versionKey: false });
export const ProcessedEvent = mongoose.model('ProcessedEvent', eventSchema);

export type AppDoc = Record<string, any> & { _id: string };
