import { DocInput, Form } from './documents.js';

// Made-up merchants for trying the system out. The numbers look real (right pattern) but belong to nobody.
const pick = <T,>(list: T[]): T => list[Math.floor(Math.random() * list.length)];
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'.split('');
const letters = (n: number) => Array.from({ length: n }, () => pick(LETTERS)).join('');
const digits = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');

const FIRST = ['Priya', 'Arjun', 'Sunita', 'Vikram', 'Kavita', 'Manoj', 'Deepa', 'Imran', 'Neha', 'Rohit', 'Anita', 'Suresh'];
const LAST = ['Nair', 'Mehta', 'Rao', 'Singh', 'Joshi', 'Gupta', 'Iyer', 'Qureshi', 'Patel', 'Menon', 'Desai', 'Reddy'];
const SHOP = ['Fashion Hub', 'Electronics', 'Organic Foods', 'Auto Spares', 'Home Decor', 'Book Depot', 'Sweets', 'Textiles', 'Pharmacy'];

export function newMerchant(): Form {
  const first = pick(FIRST), last = pick(LAST);
  const pan = letters(3) + 'P' + last[0].toUpperCase() + digits(4) + letters(1);   // 4th letter P = an individual
  return {
    businessName: `${last} ${pick(SHOP)}`,
    legalName: `${first} ${last}`,
    businessType: 'PROPRIETORSHIP',
    email: `${first.toLowerCase()}${digits(3)}@${last.toLowerCase()}.example`,
    phone: '9' + digits(9),
    pan,
    gstin: '27' + pan + '1Z5',
    bank: { accountNumber: '5' + digits(11), ifsc: 'HDFC0001234', holderName: `${first} ${last}` },
  };
}

/** Documents that agree perfectly with the form. */
export function goodDocs(f: Form): DocInput[] {
  return [
    { type: 'PAN_CARD', fileName: 'pan_card.json', fields: { pan: f.pan, name: f.legalName } },
    { type: 'GST_CERTIFICATE', fileName: 'gst_certificate.json', fields: { gstin: f.gstin, legalName: f.legalName } },
    { type: 'BANK_PROOF', fileName: 'bank_proof.json', fields: { accountNumber: f.bank.accountNumber, ifsc: f.bank.ifsc, holderName: f.bank.holderName } },
  ];
}

export function buildExamples() {
  const make = (id: string, label: string, description: string, change?: (docs: DocInput[], f: Form) => DocInput[]) => {
    const form = newMerchant();
    const docs = goodDocs(form);
    return { id, label, description, form, documents: change ? change(docs, form) : docs };
  };
  return [
    make('good', 'A complete, correct application', 'Everything matches. Good for showing the normal flow.'),
    make('mismatch', 'A document that does not match the form', 'The PAN on the PAN card is different from the PAN in the form.',
      (docs) => docs.map((d) => (d.type === 'PAN_CARD' ? { ...d, fields: { ...d.fields!, pan: 'ZZZZZ9999Z' } } : d))),
    make('blurry', 'A blurry document', 'The PAN card photo is too blurry to read.',
      (docs) => docs.map((d) => (d.type === 'PAN_CARD' ? { ...d, blurry: true } : d))),
    make('missing', 'A missing document', 'The bank proof was not uploaded.', (docs) => docs.filter((d) => d.type !== 'BANK_PROOF')),
    make('unsure', 'A document read with low confidence', 'The PAN was read with only 72% confidence, so a person must double-check it.',
      (docs) => docs.map((d) => (d.type === 'PAN_CARD' ? { ...d, confidence: { pan: 0.72 } } : d))),
  ];
}
