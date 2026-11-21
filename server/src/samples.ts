import sharp from 'sharp';

// Makes small sample files, so the upload feature can be tried (and tested) without hunting for real documents.

/** A one-page PDF with the given lines of text. */
export function makePdf(lines: string[]): Buffer {
  const escape = (s: string) => s.replace(/[\\()]/g, '\\$&');
  const page = ['BT', '/F1 14 Tf', '50 780 Td', '20 TL', ...lines.map((l) => `(${escape(l)}) Tj T*`), 'ET'].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(page)} >>\nstream\n${page}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}

/** A picture of some text. `blur` makes it blurry (0 = perfectly sharp). */
export async function makeImage(lines: string[], blur = 0): Promise<Buffer> {
  const text = lines.map((l, i) => `<text x="40" y="${90 + i * 90}" font-size="48" font-family="Arial" fill="#000">${l.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="${160 + lines.length * 90}"><rect width="100%" height="100%" fill="#fff"/>${text}</svg>`;
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  return blur ? sharp(png).blur(blur).png().toBuffer() : png;
}
