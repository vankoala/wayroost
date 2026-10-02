import { DOCUMENT_EXTENSIONS, sniffDocument } from '../../shared/documents';
import type { AttachmentRef } from '../../shared/protocol';

// Turning picked files into uploads. Photos straight off a phone camera are
// often 4–12 MB; they're downscaled here so sending stays quick on mobile data.

export const MAX_ATTACHMENTS = 4;
export const MAX_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_EDGE = 2048;
const RECOMPRESS_ABOVE = 1.5 * 1024 * 1024;

export const ACCEPT =
  'image/png,image/jpeg,image/gif,image/webp,image/heic,image/heif,application/pdf,text/*,' +
  '.md,.txt,.csv,.json,.log,.yaml,.yml,.toml,.ini,.py,.js,.ts,.tsx,.jsx,.sh,.html,.css,.xml,.sql,.go,.rs,.java,' +
  DOCUMENT_EXTENSIONS.map((ext) => `.${ext}`).join(',');

export interface PendingAttachment {
  id: string;
  name: string;
  mimeType: string;
  /** base64, no data: prefix */
  data: string;
  size: number;
  /** blob: URL for image thumbnails */
  previewUrl?: string;
}

let seq = 0;

function readAsBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(blob);
  });
}

async function downscale(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('could not encode image'))), 'image/jpeg', 0.85),
  );
}

const SIGNATURES = [
  [0x89, 0x50, 0x4e, 0x47], // PNG
  [0xff, 0xd8, 0xff], // JPEG
  [0x47, 0x49, 0x46, 0x38], // GIF
  [0x25, 0x50, 0x44, 0x46, 0x2d], // %PDF-
];

/**
 * What the server accepts, judged from the bytes as it does: an image or PDF
 * signature, an Office document, archive or data file whose bytes match its
 * name, else UTF-8 text.
 */
export function attachableBytes(bytes: Uint8Array, name = ''): boolean {
  if (SIGNATURES.some((sig) => sig.every((b, i) => bytes[i] === b))) return true;
  if (sniffDocument(bytes, name)) return true;
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return true;
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export async function prepareFile(file: File): Promise<PendingAttachment> {
  let blob: Blob = file;
  let name = file.name || 'file';
  let mimeType = file.type || 'application/octet-stream';

  if (file.size === 0) throw new Error(`${name} is empty.`);
  if (!mimeType.startsWith('image/') && file.size <= MAX_BYTES && !attachableBytes(new Uint8Array(await file.arrayBuffer()), name)) {
    throw new Error(`${name}: only photos, PDFs, text, Office files, archives and SQLite or Parquet data can be attached.`);
  }

  if (mimeType.startsWith('image/')) {
    const bitmap = await createImageBitmap(file).catch(() => null);
    const needsWork =
      !bitmap ||
      file.size > RECOMPRESS_ABOVE ||
      Math.max(bitmap.width, bitmap.height) > MAX_IMAGE_EDGE ||
      !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mimeType);
    bitmap?.close();
    if (needsWork && mimeType !== 'image/gif') {
      blob = await downscale(file);
      mimeType = 'image/jpeg';
      name = name.replace(/\.[^.]+$/, '') + '.jpg';
    }
  }

  if (blob.size > MAX_BYTES) throw new Error(`${name} is larger than 10 MB.`);
  return {
    id: `att-${++seq}`,
    name,
    mimeType,
    data: await readAsBase64(blob),
    size: blob.size,
    ...(mimeType.startsWith('image/') ? { previewUrl: URL.createObjectURL(blob) } : {}),
  };
}

export function releasePreview(attachment: PendingAttachment): void {
  if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** What the API expects. */
export function toUpload(list: PendingAttachment[]) {
  return list.map(({ name, mimeType, data }) => ({ name, mimeType, data }));
}

const TEXT_NAME = /\.(md|txt|csv|json|log|ya?ml|toml|ini|py|jsx?|tsx?|sh|html|css|xml|sql|go|rs|java)$/i;

/** Best guess at how the server will classify a file (it checks the bytes itself). */
export function attachmentKind(mimeType: string, name: string): AttachmentRef['kind'] {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType === 'application/pdf') return 'pdf';
  // Before the text test: Office types such as …spreadsheetml.sheet contain "xml".
  if (DOCUMENT_EXTENSIONS.includes(name.split('.').pop()?.toLowerCase() ?? '')) return 'file';
  if (mimeType.startsWith('text/') || /json|xml|yaml|javascript|typescript/.test(mimeType) || TEXT_NAME.test(name)) {
    return 'text';
  }
  return 'file';
}

/** How sent files appear on a message: name and kind only. */
export function attachmentRefs(list: PendingAttachment[]): AttachmentRef[] {
  return list.map((a) => ({ name: a.name, kind: attachmentKind(a.mimeType, a.name) }));
}
