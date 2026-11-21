export const DOC_TYPES = [
  { type: 'PAN_CARD', name: 'PAN card' },
  { type: 'GST_CERTIFICATE', name: 'GST certificate' },
  { type: 'BANK_PROOF', name: 'Bank proof (cancelled cheque or statement)' },
];
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** Reads a chosen file so it can be sent to the server. */
export function readFile(file: File): Promise<{ name: string; data: string }> {
  return new Promise((resolve, reject) => {
    if (file.size > MAX_FILE_BYTES) return reject(new Error(`${file.name} is too large. The limit is 5 MB.`));
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, data: String(reader.result).split(',')[1] ?? '' });   // drop the "data:...;base64," part
    reader.onerror = () => reject(new Error(`${file.name} could not be read.`));
    reader.readAsDataURL(file);
  });
}
