import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Application } from '../src/models.js';
import { goodDocs } from '../src/examples.js';
import { Application as AppModel } from '../src/models.js';
import { makeImage, makePdf } from '../src/samples.js';
import {
  advanceClock, audit, auditCount, callback, check, config, deliver, fileDoc, getApp, resetTests, server, settle, startTests, stopTests,
  submit, sweep, view, waitingCallbacks,
} from './helpers.js';

beforeAll(startTests);
afterAll(stopTests);
beforeEach(resetTests);

describe('the normal journey', () => {
  it('goes from submission through four async checks to a merchant ID', async () => {
    const { id } = await submit();
    expect((await getApp(id)).state).toBe('VERIFYING');
    expect(waitingCallbacks).toHaveLength(4);                // the providers have said "received"; answers come later

    await deliver((b) => b.type !== 'RISK');
    expect((await getApp(id)).state).toBe('VERIFYING');      // one answer still missing: do not approve yet
    await deliver();
    expect((await getApp(id)).state).toBe('APPROVED');
    await settle();                                           // the periodic job creates the merchant ID

    const app = await getApp(id);
    expect(app.state).toBe('ONBOARDED');
    expect(app.merchant.id).toMatch(/^MID\d{9}$/);
    expect(app.audit.map((e: any) => e.to).filter(Boolean)).toEqual(['VERIFYING', 'APPROVED', 'ONBOARDED']);
  });

  it('only the configured checks decide the outcome', async () => {
    config.requiredChecks = ['PAN', 'GST'];
    const { id } = await submit();
    expect((await getApp(id)).checks).toHaveLength(2);
    await settle();
    expect((await getApp(id)).state).toBe('ONBOARDED');
  });

  it('never shows full PAN, GSTIN or account numbers', async () => {
    const { id, form } = await submit();
    await settle();
    const json = JSON.stringify(await view(id)) + JSON.stringify((await server().get('/api/applications')).body);
    for (const secret of [form.pan, form.gstin, form.bank.accountNumber]) expect(json).not.toContain(secret);
  });
});

describe('PAN passes but GST fails', () => {
  it('sends the case to a person, who can approve it with a written reason', async () => {
    const { id } = await submit('good', 'gst_fails');
    await settle();
    expect((await getApp(id)).state).toBe('IN_REVIEW');
    expect((await check(id, 'PAN')).status).toBe('PASSED');
    expect((await check(id, 'GST')).status).toBe('FAILED');
    expect((await view(id)).reviewReasons[0].text).toMatch(/GST registration/);
    expect((await getApp(id)).merchant.id).toBeUndefined();   // no merchant ID while unresolved

    const bad = await server().post(`/api/applications/${id}/review`).send({ action: 'approve', reviewer: 'Asha', note: 'ok' });
    expect(bad.status).toBe(422);                              // a real reason is required

    await server().post(`/api/applications/${id}/review`).send({ action: 'approve', reviewer: 'Asha', note: 'Trade name differs from legal name; checked the certificate' });
    await settle();
    expect((await getApp(id)).state).toBe('ONBOARDED');
    expect((await view(id)).checks.find((c: any) => c.type === 'GST')).toMatchObject({ status: 'WAIVED', waivedBy: 'Asha' });
  });

  it('a person can reject; and PAN or bank failures can never be overridden', async () => {
    const { id } = await submit('good', 'gst_fails');
    await settle();
    await Application.updateOne({ _id: id, 'checks.type': 'PAN' }, { $set: { 'checks.$.status': 'FAILED', 'checks.$.reason': 'Name does not match' } });
    const res = await server().post(`/api/applications/${id}/review`).send({ action: 'approve', reviewer: 'Asha', note: 'looks fine to me' });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/can never be overridden/);
    expect((await view(id)).review.canApprove).toBe(false);

    await server().post(`/api/applications/${id}/review`).send({ action: 'reject', reviewer: 'Asha', note: 'PAN does not match the business' });
    expect((await getApp(id)).state).toBe('REJECTED');
    const again = await server().post(`/api/applications/${id}/review`).send({ action: 'approve', reviewer: 'Asha', note: 'changed my mind' });
    expect(again.status).toBe(409);                            // a rejected application is closed
  });

  it('a reviewer can run a failed check again', async () => {
    const { id } = await submit('good', 'gst_fails');
    await settle();
    await Application.updateOne({ _id: id }, { $set: { scenario: 'normal' } });
    await server().post(`/api/applications/${id}/review`).send({ action: 'retry_check', checkType: 'GST', reviewer: 'Asha', note: 'The provider data was stale' });
    await settle();
    expect((await getApp(id)).state).toBe('ONBOARDED');
  });

  it('a reviewer can ask the merchant for more information', async () => {
    const { id } = await submit('good', 'gst_fails');
    await settle();
    await server().post(`/api/applications/${id}/review`).send({ action: 'ask_merchant', items: ['Upload the latest GST certificate'], reviewer: 'Asha', note: 'Need a current certificate' });
    const v = await view(id);
    expect(v.state).toBe('NEEDS_INFO');
    expect(v.toFix).toEqual(['Upload the latest GST certificate']);
  });

  it('high risk score also goes to a person', async () => {
    const { id } = await submit('good', 'high_risk');
    await settle();
    expect((await getApp(id)).state).toBe('IN_REVIEW');
    expect((await view(id)).reviewReasons[0].text).toMatch(/Risk screening/);
  });
});

describe('the same callback arrives several times', () => {
  it('counts only the first copy', async () => {
    const { id } = await submit('good', 'repeated_callbacks');
    expect(waitingCallbacks).toHaveLength(12);                 // 4 answers x 3 copies
    const results = await deliver();
    expect(results.filter((r) => r === 'accepted')).toHaveLength(4);
    expect(results.filter((r) => r === 'duplicate')).toHaveLength(8);
    await settle();
    expect((await getApp(id)).state).toBe('ONBOARDED');
    expect(await auditCount(id, /Ignored a repeated/)).toBe(8);
  });

  it('is safe when the copies arrive at the very same moment', async () => {
    const { id } = await submit();
    const pan = waitingCallbacks.find((w) => w.type === 'PAN')!;
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => callback('PAN', pan.body).then((r) => r.body.result)));
    expect(results.filter((r) => r === 'accepted')).toHaveLength(1);
    expect(results.filter((r) => r === 'duplicate')).toHaveLength(4);
    expect((await check(id, 'PAN')).status).toBe('PASSED');
  });
});

describe('a callback arrives after the request timed out', () => {
  it('uses the late answer, then ignores the retry\'s answer', async () => {
    const { id } = await submit('good', 'late_answer');
    const firstBank = waitingCallbacks.find((w) => w.type === 'BANK')!.body;
    await deliver((b) => b.type !== 'BANK');
    expect((await check(id, 'BANK')).status).toBe('PENDING');

    advanceClock(config.checkTimeoutMs + 1);                   // the provider stayed silent too long
    await sweep();
    expect((await check(id, 'BANK')).status).toBe('RETRYING');
    advanceClock(config.retryDelayMs + 1);
    await sweep();
    expect((await check(id, 'BANK')).sends).toBe(2);           // second attempt is on its way

    expect(await deliver((b) => b.requestId === firstBank.requestId)).toEqual(['late']);
    expect((await check(id, 'BANK')).status).toBe('PASSED');
    expect((await getApp(id)).state).toBe('APPROVED');         // the late answer unblocked the application

    expect(await deliver()).toEqual(['already-answered']);     // the retry's answer is no longer needed
    await settle();
    expect((await getApp(id)).state).toBe('ONBOARDED');
  });

  it('after all tries it asks a person, and still accepts a very late answer', async () => {
    const { id } = await submit();
    const risk = waitingCallbacks.find((w) => w.type === 'RISK')!.body;
    await deliver((b) => b.type !== 'RISK');
    for (let i = 0; i < config.maxSends; i++) {
      advanceClock(config.checkTimeoutMs + 1); await sweep();  // time out
      advanceClock(config.retryDelayMs * 3); await sweep();    // send again
      waitingCallbacks.length = 0;                             // the provider never answers
    }
    expect((await getApp(id)).state).toBe('IN_REVIEW');
    expect((await check(id, 'RISK')).status).toBe('NO_RESPONSE');
    const late = await callback('RISK', risk);
    expect(late.body.result).toBe('late');
    expect((await check(id, 'RISK')).status).toBe('PASSED');
  });
});

describe('providers that fail', () => {
  it('retries when the provider is briefly down', async () => {
    const { id } = await submit('good', 'provider_down');
    expect((await check(id, 'GST')).status).toBe('RETRYING');
    await settle();
    expect((await getApp(id)).state).toBe('ONBOARDED');
    expect((await check(id, 'GST')).sends).toBe(3);
    expect(await auditCount(id, /could not be reached/)).toBe(2);
  });

  it('asks a person when the provider stays down', async () => {
    const { id } = await submit('good', 'provider_dead');
    await settle();
    expect((await getApp(id)).state).toBe('IN_REVIEW');
    expect((await check(id, 'GST')).status).toBe('UNAVAILABLE');
  });
});

describe('approval works but the merchant ID cannot be created', () => {
  it('retries, then succeeds, with exactly one merchant ID', async () => {
    const { id } = await submit('good', 'merchant_id_retry');
    await settle();
    const app = await getApp(id);
    expect(app.state).toBe('ONBOARDED');
    expect(await auditCount(id, /Creating the merchant ID failed/)).toBe(2);
    expect(app.merchant.id).toMatch(/^MID/);
  });

  it('keeps the approval, hands the problem to operations, and allows a retry', async () => {
    const { id } = await submit('good', 'merchant_id_fails');
    await settle();
    expect((await getApp(id)).state).toBe('MERCHANT_ID_FAILED');
    expect((await view(id)).nextStep).toMatch(/Retry/);
    await server().post(`/api/applications/${id}/retry-merchant-id`).send({ by: 'Priya' });
    await settle();
    expect((await getApp(id)).state).toBe('ONBOARDED');
  });

  it('without the demo shortcut a retry fails again, honestly', async () => {
    config.demoAutoHeal = false;
    const { id } = await submit('good', 'merchant_id_fails');
    await settle();
    await server().post(`/api/applications/${id}/retry-merchant-id`).send({ by: 'Priya' });
    await settle();
    expect((await getApp(id)).state).toBe('MERCHANT_ID_FAILED');
  });
});

describe('the merchant changes bank details', () => {
  const newBank = { accountNumber: '987654321012', ifsc: 'ICIC0004321', holderName: '' };
  const proof = (b: typeof newBank) => ({ type: 'BANK_PROOF', fields: { accountNumber: b.accountNumber, ifsc: b.ifsc, holderName: b.holderName } });

  it('after go-live: payouts pause, only the bank is re-checked, payouts resume', async () => {
    const { id, form } = await submit();
    await settle();
    const merchantId = (await getApp(id)).merchant.id;
    const bank = { ...newBank, holderName: form.bank.holderName };

    await server().post(`/api/applications/${id}/bank`).send({ bank, proof: proof(bank) });
    expect((await getApp(id)).state).toBe('BANK_RECHECK');
    expect((await view(id)).payoutsOnHold).toBe(true);
    expect((await check(id, 'PAN')).status).toBe('PASSED');    // nothing else is re-run
    await settle();
    const app = await getApp(id);
    expect(app.state).toBe('ONBOARDED');
    expect(app.payoutsOnHold).toBe(false);
    expect(app.merchant.id).toBe(merchantId);                  // same merchant, no second ID
  });

  it('without proof a person must confirm, and payouts stay paused until then', async () => {
    const { id, form } = await submit();
    await settle();
    await server().post(`/api/applications/${id}/bank`).send({ bank: { ...newBank, holderName: form.bank.holderName } });
    await settle();
    expect((await getApp(id)).state).toBe('IN_REVIEW');
    expect((await getApp(id)).payoutsOnHold).toBe(true);
    expect((await view(id)).reviewReasons.map((r: any) => r.text).join()).toMatch(/without proof/);
    await server().post(`/api/applications/${id}/review`).send({ action: 'approve', reviewer: 'Ravi', note: 'Called the merchant, account confirmed' });
    expect((await getApp(id)).state).toBe('ONBOARDED');
    expect((await getApp(id)).payoutsOnHold).toBe(false);
  });

  it('during verification: the answer for the old account is ignored', async () => {
    const { id, form } = await submit();
    const bank = { ...newBank, holderName: form.bank.holderName };
    const oldBank = waitingCallbacks.find((w) => w.type === 'BANK')!.body;
    await server().post(`/api/applications/${id}/bank`).send({ bank, proof: proof(bank) });
    // The old answers arrive now (the new BANK request has its own answer, which we hold back for a moment).
    const results = await deliver((b) => b.type !== 'BANK' || b.requestId === oldBank.requestId);
    expect(results).toContain('old-answer');
    expect((await getApp(id)).state).toBe('VERIFYING');        // must not approve on the old account
    await settle();
    expect((await getApp(id)).state).toBe('ONBOARDED');
    expect(await auditCount(id, /old Bank account answer/)).toBe(1);
  });

  it('rejects a proof that does not match, and an invalid IFSC', async () => {
    const { id, form } = await submit();
    await settle();
    const bank = { ...newBank, holderName: form.bank.holderName };
    const wrong = await server().post(`/api/applications/${id}/bank`).send({ bank, proof: proof({ ...bank, accountNumber: '111122223333' }) });
    expect(wrong.status).toBe(422);
    const badIfsc = await server().post(`/api/applications/${id}/bank`).send({ bank: { ...bank, ifsc: 'BAD' } });
    expect(badIfsc.status).toBe(422);
    expect((await getApp(id)).state).toBe('ONBOARDED');
  });
});

describe('documents', () => {
  it('a document that disagrees with the form stops the case, without calling any provider', async () => {
    const { id, form } = await submit('mismatch');
    const v = await view(id);
    expect(v.state).toBe('NEEDS_INFO');
    expect(v.toFix[0]).toMatch(/PAN on the PAN card does not match the PAN in the application/);
    expect(JSON.stringify(v.toFix)).not.toContain(form.pan);   // numbers are masked in messages
    expect((await getApp(id)).checks).toHaveLength(0);
    expect(waitingCallbacks).toHaveLength(0);

    await server().post(`/api/demo/merchant-fix/${id}`).send({});
    await settle();
    expect((await getApp(id)).state).toBe('ONBOARDED');
  });

  it('a blurry document, a missing document and a typo are all explained', async () => {
    expect((await view((await submit('blurry')).id)).toFix[0]).toMatch(/too blurry/);
    expect((await view((await submit('missing')).id)).toFix[0]).toMatch(/upload the bank proof/);
    const typo = await submit('good', 'normal', (ex) => { ex.form.bank.ifsc = 'NOPE'; });
    expect((await view(typo.id)).toFix.join()).toMatch(/IFSC/);
  });

  it('a value read with medium confidence goes ahead but needs a person before approval', async () => {
    const { id } = await submit('unsure');
    expect((await getApp(id)).state).toBe('VERIFYING');
    await settle();
    expect((await getApp(id)).state).toBe('IN_REVIEW');
    expect((await view(id)).reviewReasons[0].text).toMatch(/72% confidence/);
  });

  it('a GSTIN that belongs to a different PAN is caught', async () => {
    const { id } = await submit('good', 'normal', (ex) => { ex.form.gstin = '27ABCDE1234F1Z5'; });
    expect((await view(id)).toFix.join()).toMatch(/does not belong to this PAN/);
  });

  it('plain text documents are read too', async () => {
    const { id } = await submit('good', 'normal', (ex) => {
      const f = ex.form;
      ex.documents = [
        { type: 'PAN_CARD', fileName: 'pan.txt', text: `PAN CARD\nPermanent Account Number: ${f.pan}\nName: ${f.legalName}` },
        { type: 'GST_CERTIFICATE', fileName: 'gst.txt', text: `GSTIN: ${f.gstin}\nLegal Name of Business: ${f.legalName}` },
        { type: 'BANK_PROOF', fileName: 'bank.txt', text: `Account Number: ${f.bank.accountNumber}\nIFSC: ${f.bank.ifsc}\nAccount Holder Name: ${f.bank.holderName}` },
      ];
    });
    expect((await getApp(id)).state).toBe('VERIFYING');
    const pan = (await view(id)).documents.find((d: any) => d.type === 'PAN_CARD');
    expect(pan.fields.map((f: any) => f.status)).toEqual(['OK', 'OK']);
  });
});

describe('duplicate applications', () => {
  it('the same PAN or GSTIN goes to a person without calling any provider', async () => {
    const first = await submit();
    await settle();
    const second = await submit('good', 'normal', (ex) => { Object.assign(ex.form, first.form, { businessName: 'Second shop' }); ex.documents = first.documents; });
    const app = await getApp(second.id);
    expect(app.state).toBe('IN_REVIEW');
    expect(app.duplicates[0]).toMatchObject({ appId: first.id });
    expect(app.checks).toHaveLength(0);
  });

  it('the same bank account only is flagged, and still gets verified', async () => {
    const first = await submit();
    await settle();
    const second = await submit('good', 'normal', (ex) => { ex.form.bank.accountNumber = first.form.bank.accountNumber; ex.documents[2].fields.accountNumber = first.form.bank.accountNumber; });
    expect((await getApp(second.id)).state).toBe('VERIFYING');
    await settle();
    expect((await getApp(second.id)).state).toBe('IN_REVIEW');
    expect((await view(second.id)).reviewReasons[0].text).toMatch(/duplicate of/);
  });

  it('a rejected application does not block a new one', async () => {
    const first = await submit('good', 'gst_fails');
    await settle();
    await server().post(`/api/applications/${first.id}/review`).send({ action: 'reject', reviewer: 'Asha', note: 'Wrong GSTIN, please reapply' });
    const again = await submit('good', 'normal', (ex) => { Object.assign(ex.form, first.form); ex.documents = first.documents; });
    expect((await getApp(again.id)).duplicates).toEqual([]);
    expect((await getApp(again.id)).state).toBe('VERIFYING');
  });
});

describe('rules and numbers', () => {
  it('refuses moves that are not allowed', async () => {
    const { id } = await submit('mismatch');                   // waiting for the merchant
    const res = await server().post(`/api/applications/${id}/review`).send({ action: 'approve', reviewer: 'Asha', note: 'approve it anyway' });
    expect(res.status).toBe(409);
    const { changeState } = await import('../src/states.js');
    await expect(changeState(id, 'ONBOARDED', 'skip everything')).rejects.toThrow(/cannot go from/);
  });

  it('rejects a callback it cannot understand', async () => {
    expect((await callback('PAN', { nope: true })).status).toBe(400);
    const unknown = await callback('PAN', { eventId: 'e1', requestId: 'req_x', status: 'PASSED' });
    expect(unknown.body.result).toBe('unknown');
  });

  it('shows how many cases needed a person and how long each stage takes', async () => {
    await submit(); await submit('good', 'gst_fails'); await submit('mismatch');
    advanceClock(4000);
    await settle();
    const m = (await server().get('/api/metrics')).body;
    expect(m.total).toBe(3);
    expect(m.exceptions).toBe(2);
    expect(m.automatic).toBe(1);
    expect(m.exceptionRate).toBeCloseTo(2 / 3);
    expect(m.timeInState.find((t: any) => t.state === 'VERIFYING').averageMs).toBeGreaterThanOrEqual(4000);
    expect(m.averageOnboardMs).toBeGreaterThan(0);
  });

  it('every example and scenario is available to the web page', async () => {
    expect((await server().get('/api/examples')).body).toHaveLength(5);
    expect((await server().get('/api/scenarios')).body.length).toBeGreaterThanOrEqual(9);
    const bad = await server().post('/api/applications').send({ form: (await submit()).form, scenario: 'nonsense' });
    expect(bad.status).toBe(422);
  });
});

describe('protecting sensitive data', () => {
  it('refuses a callback that is not signed, or signed wrongly, and changes nothing', async () => {
    const { id } = await submit();
    const pan = waitingCallbacks.find((w) => w.type === 'PAN')!.body;
    expect((await callback('PAN', pan, null)).status).toBe(401);
    expect((await callback('PAN', pan, 'sha256=forged')).status).toBe(401);
    expect((await check(id, 'PAN')).status).toBe('PENDING');
    expect((await callback('PAN', pan)).body.result).toBe('accepted');   // the genuine one still works
  });

  it('never stores the PAN, GSTIN or account number in plain text', async () => {
    const { id, form } = await submit();
    await settle();
    const stored = JSON.stringify(await AppModel.collection.findOne({ _id: id as any }));
    for (const secret of [form.pan, form.gstin, form.bank.accountNumber]) expect(stored).not.toContain(secret);
    expect(stored).toContain(form.pan.slice(-4));    // only the masked ending is there
  });
});

describe('uploaded files', () => {
  const pdfDocs = (f: any, panOverride?: string) => [
    fileDoc('PAN_CARD', 'pan_card.pdf', makePdf(['PAN CARD', `Permanent Account Number: ${panOverride ?? f.pan}`, `Name: ${f.legalName}`])),
    fileDoc('GST_CERTIFICATE', 'gst.pdf', makePdf(['GST CERTIFICATE', `GSTIN: ${f.gstin}`, `Legal Name of Business: ${f.legalName}`])),
    fileDoc('BANK_PROOF', 'bank.pdf', makePdf(['CANCELLED CHEQUE', `Account Number: ${f.bank.accountNumber}`, `IFSC: ${f.bank.ifsc}`, `Account Holder Name: ${f.bank.holderName}`])),
  ];

  it('reads the text inside real PDF files and carries on', async () => {
    const { id } = await submit('good', 'normal', (ex) => { ex.documents = pdfDocs(ex.form); });
    expect((await getApp(id)).state).toBe('VERIFYING');
    const pan = (await view(id)).documents.find((d: any) => d.type === 'PAN_CARD');
    expect(pan.fields.map((f: any) => f.status)).toEqual(['OK', 'OK']);
    expect(pan.fileName).toBe('pan_card.pdf');
    await settle();
    expect((await getApp(id)).state).toBe('ONBOARDED');
  });

  it('notices when a PDF contradicts the form', async () => {
    const { id } = await submit('good', 'normal', (ex) => { ex.documents = pdfDocs(ex.form, 'ZZZZZ9999Z'); });
    expect((await view(id)).state).toBe('NEEDS_INFO');
    expect((await view(id)).toFix[0]).toMatch(/PAN on the PAN card does not match the PAN in the application/);
  });

  it('a blurry photo is sent back; a sharp photo needs a person to read it', async () => {
    const lines = ['PERMANENT ACCOUNT NUMBER', 'ABCPD1234E', 'RAHUL SHARMA'];
    const blurry = await makeImage(lines, 9);
    const clear = await makeImage(lines, 0);

    const a = await submit('good', 'normal', (ex) => { ex.documents[0] = fileDoc('PAN_CARD', 'pan_blurry.png', blurry); });
    const va = await view(a.id);
    expect(va.state).toBe('NEEDS_INFO');
    expect(va.toFix[0]).toMatch(/too blurry to read \(sharpness \d+, it needs at least 60\)/);
    expect((await getApp(a.id)).checks).toHaveLength(0);          // no provider is called for a bad document

    const b = await submit('good', 'normal', (ex) => { ex.documents[0] = fileDoc('PAN_CARD', 'pan_clear.png', clear); });
    const vb = await view(b.id);
    expect(vb.state).toBe('VERIFYING');
    expect(vb.documents.find((d: any) => d.type === 'PAN_CARD')).toMatchObject({ photo: true, blurry: false });
    expect(vb.documents.find((d: any) => d.type === 'PAN_CARD').sharpness).toBeGreaterThan(60);
    await settle();
    expect((await getApp(b.id)).state).toBe('IN_REVIEW');        // never approved without a person reading the photo
    expect((await view(b.id)).reviewReasons[0].text).toMatch(/cannot read text from pictures/);
  });

  it('the merchant can send a corrected file when something is wrong', async () => {
    const { id, form } = await submit('good', 'normal', (ex) => { ex.documents = pdfDocs(ex.form, 'ZZZZZ9999Z'); });
    expect((await getApp(id)).state).toBe('NEEDS_INFO');
    const fixed = await server().post(`/api/applications/${id}/fix`).send({
      documents: [fileDoc('PAN_CARD', 'pan_corrected.pdf', makePdf(['PAN CARD', `Permanent Account Number: ${form.pan}`, `Name: ${form.legalName}`]))],
    });
    expect(fixed.status).toBe(200);
    expect((await getApp(id)).state).toBe('VERIFYING');
    await settle();
    expect((await getApp(id)).state).toBe('ONBOARDED');
  });

  it('refuses files it cannot use, with a clear message', async () => {
    const bad = await submit('good', 'normal', (ex) => { ex.documents[0] = fileDoc('PAN_CARD', 'pan.exe', Buffer.from('MZ')); });
    expect(bad.res.status).toBe(422);
    expect(bad.res.body.error).toMatch(/not supported/);
    const broken = await submit('good', 'normal', (ex) => { ex.documents[0] = fileDoc('PAN_CARD', 'pan.pdf', Buffer.from('this is not a pdf')); });
    expect(broken.res.body.error).toMatch(/could not be opened as a PDF/);
    const notJson = await submit('good', 'normal', (ex) => { ex.documents[0] = fileDoc('PAN_CARD', 'pan.json', Buffer.from('{oops')); });
    expect(notJson.res.body.error).toMatch(/not valid JSON/);
  });
});

describe('the same business applying again under different numbers', () => {
  it('a similar owner name with the same phone is flagged, verified, and then needs a person', async () => {
    const first = await submit();
    await settle();
    const [firstName, ...rest] = first.form.legalName.split(' ');
    const second = await submit('good', 'normal', (ex) => {
      ex.form.legalName = `${firstName} Kumar ${rest.join(' ')}`;     // "Priya Kumar Nair" is close to "Priya Nair"
      ex.form.bank.holderName = ex.form.legalName;
      ex.form.phone = first.form.phone;
      ex.documents = goodDocs(ex.form);
    });
    const app = await getApp(second.id);
    expect(app.state).toBe('VERIFYING');                              // not the same PAN or GSTIN, so no hard stop
    expect(app.duplicates[0]).toMatchObject({ appId: first.id });
    expect(app.duplicates[0].same).toEqual(['similar owner name', 'same phone number']);
    await settle();
    expect((await getApp(second.id)).state).toBe('IN_REVIEW');         // never approved on its own
    expect((await view(second.id)).reviewReasons[0].text).toMatch(/duplicate of .*similar owner name, same phone number/);
  });

  it('a shared phone number alone is not enough (families and shops share phones)', async () => {
    const first = await submit();
    await settle();
    const second = await submit('good', 'normal', (ex) => { ex.form.legalName = 'Zubin Qadir'; ex.form.bank.holderName = 'Zubin Qadir'; ex.form.phone = first.form.phone; ex.documents = goodDocs(ex.form); });
    expect((await getApp(second.id)).duplicates).toEqual([]);
    await settle();
    expect((await getApp(second.id)).state).toBe('ONBOARDED');
  });
});
