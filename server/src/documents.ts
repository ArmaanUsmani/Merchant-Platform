import { config } from './config.js';

// ---------------------------------------------------------------------------
// Reading documents and checking them against the form.
//
// Documents arrive as "structured payloads": the fields an OCR tool would have read,
// each with a confidence score. We also accept a plain text file ("PAN: ABCDE1234F").
// A real system would run OCR on scans; here that step is simulated (see README).
// ---------------------------------------------------------------------------

export type DocType = 'PAN_CARD' | 'GST_CERTIFICATE' | 'BANK_PROOF';

export interface DocInput {
  type: DocType;
  fileName?: string;
  blurry?: boolean;                       // the image quality check says: too blurry to read
  fields?: Record<string, string>;        // field name -> value
  confidence?: Record<string, number>;    // field name -> 0..1 (default 0.95)
  text?: string;                          // alternative: free text with "Label: value" lines
  file?: { name: string; data: string };  // an uploaded file (base64). reading.ts turns it into text or a sharpness score
  photo?: boolean;                        // an image or scan: we can measure it, but cannot read text from it
  sharpness?: number;                     // for photos: how sharp the image is (higher is sharper)
}

export interface Form {
  businessName: string;
  legalName: string;
  businessType: string;
  email: string;
  phone: string;
  pan: string;
  gstin: string;
  bank: { accountNumber: string; ifsc: string; holderName: string };
}

export interface Issue {
  kind: 'missing' | 'review';   // missing: merchant must fix it.  review: a person must double-check it.
  message: string;
  doc?: DocType;                // which document the problem is about, if any
}

export const DOC_NAME: Record<DocType, string> = {
  PAN_CARD: 'PAN card',
  GST_CERTIFICATE: 'GST certificate',
  BANK_PROOF: 'bank proof (cancelled cheque or statement)',
};

// Which fields we expect on each document, and how to read them from plain text.
const EXPECTED: Record<DocType, { field: string; label: RegExp }[]> = {
  PAN_CARD: [{ field: 'pan', label: /permanent account number|pan/i }, { field: 'name', label: /name/i }],
  GST_CERTIFICATE: [{ field: 'gstin', label: /gstin/i }, { field: 'legalName', label: /legal name(?: of business)?/i }],
  BANK_PROOF: [
    { field: 'accountNumber', label: /account (?:number|no\.?)/i },
    { field: 'ifsc', label: /ifsc/i },
    { field: 'holderName', label: /account holder(?: name)?/i },
  ],
};
const SECRET_FIELDS = ['pan', 'gstin', 'accountNumber'];
const FIELD_LABEL: Record<string, string> = { pan: 'PAN', gstin: 'GSTIN', accountNumber: 'account number', ifsc: 'IFSC code', name: 'name', legalName: 'name', holderName: 'account holder name' };

const PAN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;

export const clean = (s: string) => (s ?? '').replace(/\s+/g, '').toUpperCase();
export const maskValue = (v: string) => (v.length > 4 ? '*'.repeat(v.length - 4) + v.slice(-4) : '****');

function readText(type: DocType, text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { field, label } of EXPECTED[type]) {
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(new RegExp(`^\\s*(?:${label.source})\\s*[:\\-]\\s*(.+?)\\s*$`, 'i'));
      if (m) { out[field] = m[1]; break; }
    }
  }
  return out;
}

// Names are compared loosely: ignore case, punctuation, word order and "Pvt Ltd".
function nameWords(s: string): string[] {
  const skip = new Set(['PVT', 'PRIVATE', 'LTD', 'LIMITED', 'LLP', 'MS', 'THE']);
  return s.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter((w) => w && !skip.has(w)).sort();
}
export function compareNames(a: string, b: string): 'same' | 'close' | 'different' {
  const x = nameWords(a), y = nameWords(b);
  if (!x.length || !y.length) return 'different';
  if (x.join(' ') === y.join(' ')) return 'same';
  const [small, big] = x.length <= y.length ? [x, y] : [y, x];
  return small.every((w) => big.includes(w)) ? 'close' : 'different';   // "Rahul Sharma" vs "Rahul Kumar Sharma"
}

export interface ReadField {
  name: string;
  value: string;                       // masked if it is sensitive
  confidence: number;
  status: 'OK' | 'LOW_CONFIDENCE' | 'MISMATCH' | 'UNREADABLE';
}
export interface ReadDoc {
  type: DocType;
  fileName: string;
  blurry: boolean;
  photo: boolean;
  sharpness?: number;
  fields: ReadField[];
}

/** Checks the form on its own, then each document against the form. */
export function checkApplication(form: Form, docs: DocInput[]): { issues: Issue[]; documents: ReadDoc[] } {
  const issues: Issue[] = [];
  const missing = (message: string, doc?: DocType) => issues.push({ kind: 'missing', message, doc });
  const review = (message: string, doc?: DocType) => issues.push({ kind: 'review', message, doc });

  // 1. The form itself
  if (!PAN.test(clean(form.pan))) missing('The PAN is not valid. It should look like ABCDE1234F (5 letters, 4 digits, 1 letter).');
  if (!GSTIN.test(clean(form.gstin))) missing('The GSTIN is not valid. It should be 15 characters, for example 27ABCDE1234F1Z5.');
  else if (PAN.test(clean(form.pan)) && clean(form.gstin).slice(2, 12) !== clean(form.pan)) {
    missing('The GSTIN does not belong to this PAN. A GSTIN contains its holder\'s PAN in characters 3 to 12.');
  }
  if (!IFSC.test(clean(form.bank.ifsc))) missing('The IFSC code is not valid. It should look like HDFC0001234.');
  if (!/^[0-9]{9,18}$/.test(clean(form.bank.accountNumber))) missing('The bank account number should be 9 to 18 digits.');
  if (!/^[0-9]{10}$/.test(clean(form.phone))) missing('The phone number should be 10 digits.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email ?? '')) missing('The email address does not look right.');

  // 2. The documents
  const expectedValue = (type: DocType, field: string): string =>
    ({
      'PAN_CARD.pan': form.pan, 'PAN_CARD.name': form.legalName,
      'GST_CERTIFICATE.gstin': form.gstin, 'GST_CERTIFICATE.legalName': form.legalName,
      'BANK_PROOF.accountNumber': form.bank.accountNumber, 'BANK_PROOF.ifsc': form.bank.ifsc, 'BANK_PROOF.holderName': form.bank.holderName,
    } as Record<string, string>)[`${type}.${field}`];

  const documents: ReadDoc[] = [];
  for (const type of Object.keys(EXPECTED) as DocType[]) {
    const doc = docs.find((d) => d.type === type);
    if (!doc) { missing(`Please upload the ${DOC_NAME[type]}.`, type); continue; }

    const read = { ...(doc.text ? readText(type, doc.text) : {}), ...(doc.fields ?? {}) };
    const result: ReadDoc = { type, fileName: doc.fileName ?? type.toLowerCase(), blurry: !!doc.blurry, photo: !!doc.photo, sharpness: doc.sharpness, fields: [] };
    documents.push(result);

    if (doc.blurry) {
      const score = doc.sharpness != null ? ` (sharpness ${doc.sharpness}, it needs at least ${config.blurThreshold})` : '';
      missing(`The ${DOC_NAME[type]} is too blurry to read${score}. Please upload a clearer photo or scan.`, type);
      continue;
    }
    if (doc.photo) {
      // A clear photo or scan. Reading text out of pictures needs OCR, which this demo does not have.
      review(`The ${DOC_NAME[type]} is a photo or scan, and this system cannot read text from pictures yet. A person has to read it and confirm it matches the application.`, type);
      continue;
    }
    for (const { field } of EXPECTED[type]) {
      const value = read[field];
      const what = FIELD_LABEL[field] ?? field;
      const confidence = doc.confidence?.[field] ?? 0.95;
      const shown = (v: string) => (SECRET_FIELDS.includes(field) ? maskValue(clean(v)) : v);
      const push = (status: ReadField['status']) => result.fields.push({ name: field, value: value ? shown(value) : '', confidence, status });

      if (!value) { push('UNREADABLE'); missing(`We could not find the ${what} on the ${DOC_NAME[type]}.`, type); continue; }
      if (confidence < config.lowConfidence) { push('LOW_CONFIDENCE'); missing(`The ${what} on the ${DOC_NAME[type]} is hard to read (${Math.round(confidence * 100)}% sure). Please upload a clearer copy.`, type); continue; }

      const wanted = expectedValue(type, field);
      const isName = ['name', 'legalName', 'holderName'].includes(field);
      const verdict = isName ? compareNames(value, wanted) : clean(value) === clean(wanted) ? 'same' : 'different';
      if (verdict === 'different') {
        push('MISMATCH');
        // Numbers are not repeated here: only their last 4 characters would show, and two different numbers can end the same way.
        missing(SECRET_FIELDS.includes(field)
          ? `The ${what} on the ${DOC_NAME[type]} does not match the ${what} in the application. Please check both.`
          : `The ${what} on the ${DOC_NAME[type]} ("${value}") does not match the application ("${wanted}").`, type);
        continue;
      }
      if (verdict === 'close') review(`The name on the ${DOC_NAME[type]} ("${value}") is close to, but not exactly, the application name ("${wanted}").`, type);
      if (confidence < config.goodConfidence) { push('LOW_CONFIDENCE'); review(`The ${what} on the ${DOC_NAME[type]} was read with only ${Math.round(confidence * 100)}% confidence. Please double-check it.`, type); continue; }
      push('OK');
    }
  }

  // 3. The account should belong to the business owner
  if (compareNames(form.bank.holderName, form.legalName) === 'different') {
    review(`The bank account is in the name of "${form.bank.holderName}", not "${form.legalName}". Please confirm it is the merchant's own account.`);
  }
  return { issues, documents };
}
