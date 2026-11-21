// Creates files you can upload to try the system:   npm run samples
import fs from 'node:fs';
import path from 'node:path';
import { makeImage, makePdf } from '../src/samples.js';

const out = path.resolve(process.cwd(), '../samples');
fs.mkdirSync(out, { recursive: true });

// One made-up merchant. Type these details into the form, then upload the files.
const m = { name: 'Rahul Sharma', shop: 'Sharma General Store', pan: 'ABCPS1234E', gstin: '27ABCPS1234E1Z5', account: '551234567890', ifsc: 'HDFC0001234', phone: '9876543210', email: 'rahul@sharmastore.example' };
const panLines = (pan: string) => ['PAN CARD', `Permanent Account Number: ${pan}`, `Name: ${m.name}`];
const write = (name: string, data: Buffer | string) => fs.writeFileSync(path.join(out, name), data);

write('pan_card.pdf', makePdf(panLines(m.pan)));
write('gst_certificate.pdf', makePdf(['GST REGISTRATION CERTIFICATE', `GSTIN: ${m.gstin}`, `Legal Name of Business: ${m.name}`]));
write('bank_proof.pdf', makePdf(['CANCELLED CHEQUE', `Account Number: ${m.account}`, `IFSC: ${m.ifsc}`, `Account Holder Name: ${m.name}`]));
write('pan_card_WRONG_PAN.pdf', makePdf(panLines('ZZZZZ9999Z')));
write('pan_card_photo_clear.png', await makeImage(panLines(m.pan), 0));
write('pan_card_photo_BLURRY.png', await makeImage(panLines(m.pan), 9));

write('merchant_details.txt', `Details to type into the form (they match the sample files)

Shop or business name : ${m.shop}
Owner's full name     : ${m.name}
Type of business      : proprietorship
Phone                 : ${m.phone}
Email                 : ${m.email}
PAN                   : ${m.pan}
GSTIN                 : ${m.gstin}
Bank account number   : ${m.account}
IFSC code             : ${m.ifsc}
Name on bank account  : ${m.name}

What to try
  pan_card.pdf + gst_certificate.pdf + bank_proof.pdf   everything matches, so the checks start
  pan_card_WRONG_PAN.pdf                                 the PAN is different from the form, so the merchant is asked to fix it
  pan_card_photo_BLURRY.png                              too blurry to read, so the merchant is asked for a clearer one
  pan_card_photo_clear.png                               a clear photo; it is accepted but a person must read it
`);
console.log(`Sample files written to ${out}`);
