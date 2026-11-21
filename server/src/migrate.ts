import { protect } from './applications.js';
import { Application } from './models.js';
import { encrypt } from './security.js';

/**
 * The first version of this project stored the PAN, GSTIN and account number as plain text.
 * Later versions store them encrypted (see security.ts). This upgrades any record still in the old
 * shape, in place, so nothing is lost and nothing stays in plain text. Safe to run again.
 * Returns how many records it upgraded.
 */
export async function migrateOldRecords(): Promise<number> {
  const old: any[] = await Application.collection.find({ secret: { $exists: false } }).toArray();
  for (const app of old) {
    const form: any = {
      businessName: app.business?.name, legalName: app.business?.legalName, businessType: app.business?.type,
      email: app.business?.email, phone: app.business?.phone,
      pan: app.pan ?? '', gstin: app.gstin ?? '', bank: { accountNumber: app.bank?.accountNumber ?? '', ifsc: app.bank?.ifsc ?? '', holderName: app.bank?.holderName ?? '' },
    };
    const docs = Array.isArray(app.rawDocs) ? app.rawDocs : [];
    // The plain-text fields live outside the current schema, so this uses the database directly.
    await Application.collection.updateOne(
      { _id: app._id },
      { $set: { ...protect(form), rawDocs: encrypt(docs) }, $unset: { pan: '', gstin: '' } },
    );
  }
  return old.length;
}
