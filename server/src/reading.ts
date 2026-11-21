import sharp from 'sharp';
import { config } from './config.js';
import { DocInput } from './documents.js';
import { HttpError } from './errors.js';

// ---------------------------------------------------------------------------
// Turning an uploaded file into something we can check.
//   .json / .txt    the fields or the text, as they are
//   .pdf            the text inside the PDF (a scanned PDF has none, so it is treated as a photo)
//   .png / .jpg     a photo: we measure how sharp it is and flag it if it is too blurry
// ---------------------------------------------------------------------------

/**
 * How sharp an image is. We run an "edge detector" over the picture (the Laplacian) and measure how
 * much its result varies. A sharp picture has strong edges, so the number is high. A blurry one is
 * smooth, so the number is low. The picture is shrunk to a fixed width first, so size does not matter.
 */
export async function sharpness(image: Buffer): Promise<number> {
  const { data, info } = await sharp(image).greyscale().resize({ width: 800 }).raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height;
  let sum = 0, sumSquares = 0, count = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const edge = 4 * data[i] - data[i - 1] - data[i + 1] - data[i - w] - data[i + w];
      sum += edge; sumSquares += edge * edge; count++;
    }
  }
  const mean = sum / count;
  return sumSquares / count - mean * mean;
}

export const readUploads = (docs: DocInput[]) => Promise.all(docs.map(readUpload));

async function readUpload(doc: DocInput): Promise<DocInput> {
  if (!doc.file) return doc;
  const { name, data } = doc.file;
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length > config.maxUploadBytes) throw new HttpError(422, `${name} is too large. The limit is 5 MB.`);
  const lower = name.toLowerCase();
  const base = { type: doc.type, fileName: name };

  if (lower.endsWith('.json')) {
    try {
      const { file, ...rest } = JSON.parse(bytes.toString('utf8'));
      return { ...rest, ...base };
    } catch { throw new HttpError(422, `${name} is not valid JSON.`); }
  }
  if (lower.endsWith('.txt')) return { ...base, text: bytes.toString('utf8') };

  if (lower.endsWith('.pdf')) {
    let text = '';
    try {
      const { getDocumentProxy, extractText } = await import('unpdf');
      text = (await extractText(await getDocumentProxy(new Uint8Array(bytes)), { mergePages: true })).text;
    } catch { throw new HttpError(422, `${name} could not be opened as a PDF.`); }
    return text.trim().length >= 20 ? { ...base, text } : { ...base, photo: true };   // no text inside = a scan
  }

  if (/\.(png|jpe?g)$/.test(lower)) {
    let score: number;
    try { score = await sharpness(bytes); } catch { throw new HttpError(422, `${name} could not be opened as an image.`); }
    return { ...base, photo: true, sharpness: Math.round(score), blurry: score < config.blurThreshold };
  }
  throw new HttpError(422, `${name}: this file type is not supported. Please upload a PDF, PNG, JPG, TXT or JSON file.`);
}
