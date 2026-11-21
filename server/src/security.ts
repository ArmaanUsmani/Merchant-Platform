import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Protecting sensitive data.
//
//  encrypt / decrypt   PAN, GSTIN and account numbers are stored encrypted (AES-256-GCM).
//  fingerprint         a one-way keyed hash, used to spot duplicates without decrypting anything.
//  sign / verify       providers sign each callback, so we can tell it really came from them.
//
// The keys below are for running the demo. In real use they come from a secrets manager
// (environment variables here) and are never committed.
// ---------------------------------------------------------------------------

const encryptionKey = () => crypto.createHash('sha256').update(process.env.ENCRYPTION_KEY ?? 'dev-only-encryption-key').digest();
const hashKey = () => process.env.HASH_KEY ?? 'dev-only-hash-key';
const callbackSecret = () => process.env.CALLBACK_SECRET ?? 'dev-only-callback-secret';

export function encrypt(data: object): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');   // iv + tag + data
}

export function decrypt<T = any>(text: string): T {
  const raw = Buffer.from(text, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'));
}

export const fingerprint = (value: string) =>
  crypto.createHmac('sha256', hashKey()).update(value.replace(/\s+/g, '').toUpperCase()).digest('hex');

export const sign = (raw: string | Buffer) => 'sha256=' + crypto.createHmac('sha256', callbackSecret()).update(raw).digest('hex');

export function verify(raw: string | Buffer | undefined, signature: string | undefined): boolean {
  if (!raw || !signature) return false;
  const wanted = Buffer.from(sign(raw));
  const got = Buffer.from(signature);
  return wanted.length === got.length && crypto.timingSafeEqual(wanted, got);
}
