import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { goodDocs, newMerchant } from '../src/examples.js';
import { Application } from '../src/models.js';
import { getApp, resetTests, server, startTests, stopTests, view } from './helpers.js';

beforeAll(startTests);
afterAll(stopTests);
beforeEach(resetTests);

/** An application saved by the first version of this project: the numbers are stored in plain text. */
async function saveOldRecord(id = 'APP-OLD001') {
  const m = newMerchant();
  await Application.collection.insertOne({
    _id: id as any, state: 'ONBOARDED', scenario: 'normal', createdAt: 1000, stateChangedAt: 2000,
    business: { name: m.businessName, legalName: m.legalName, type: m.businessType, email: m.email, phone: m.phone },
    pan: m.pan, gstin: m.gstin, bank: { accountNumber: m.bank.accountNumber, ifsc: m.bank.ifsc, holderName: m.bank.holderName },
    rawDocs: goodDocs(m), documents: [], issues: [], duplicates: [], staleRequestIds: [],
    checks: [{ type: 'PAN', status: 'PASSED', requestIds: ['req_1'], sends: 1 }],
    merchant: { attempts: 1, id: 'MID123456789' }, payoutsOnHold: false,
    audit: [{ at: 1000, actor: 'Merchant', message: 'Application received with 3 documents.' }],
  } as any);
  return m;
}

describe('applications saved by an older version', () => {
  it('are upgraded in place: they open, are masked, and no longer hold plain-text numbers', async () => {
    const { migrateOldRecords } = await import('../src/migrate.js');
    const m = await saveOldRecord();
    expect(await migrateOldRecords()).toBe(1);

    const v = await view('APP-OLD001');
    expect(v.label).toBe('Active merchant');
    expect(v.merchantId).toBe('MID123456789');               // nothing about the case was lost
    expect(v.pan).toBe('*'.repeat(6) + m.pan.slice(-4));
    expect(v.audit).toHaveLength(1);

    const stored = JSON.stringify(await Application.collection.findOne({ _id: 'APP-OLD001' as any }));
    for (const secret of [m.pan, m.gstin, m.bank.accountNumber]) expect(stored).not.toContain(secret);
    expect((await getApp('APP-OLD001')).secret).toBeTypeOf('string');
  });

  it('upgrading is safe to repeat, and an upgraded record still works in the workflow', async () => {
    const { migrateOldRecords } = await import('../src/migrate.js');
    const m = await saveOldRecord();
    await migrateOldRecords();
    expect(await migrateOldRecords()).toBe(0);                // nothing left to upgrade

    // The upgraded record takes part in duplicate detection like any other.
    const again = await server().post('/api/applications').send({ form: m, documents: goodDocs(m), scenario: 'normal' });
    expect((await view(again.body.id)).duplicates[0]).toMatchObject({ appId: 'APP-OLD001' });
  });
});
