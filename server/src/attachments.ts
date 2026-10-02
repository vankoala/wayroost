import { z } from 'zod';
import { sniffDocument } from '../../shared/documents.js';
import { UserFacingError } from './sources.js';

// Files sent from the phone. Everything is checked here, before any backend
// sees it: size, count, and that the bytes really are what the type claims.
// Besides images, PDFs and text, a short list of Office documents, archives and
// data files is allowed (shared/documents.ts); agents get those as a path.

export const MAX_ATTACHMENTS = 4;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** JSON body limit for routes that accept attachments (base64 adds ~33%). */
export const ATTACHMENT_BODY_LIMIT = Math.ceil((MAX_ATTACHMENTS * MAX_ATTACHMENT_BYTES * 4) / 3) + 256 * 1024;

export type AttachmentKind = 'image' | 'pdf' | 'text' | 'file';

export interface Attachment {
  name: string;
  mimeType: string;
  kind: AttachmentKind;
  bytes: Buffer;
}

export const AttachmentInput = z
  .object({
    name: z.string().min(1).max(200),
    mimeType: z.string().min(1).max(100),
    data: z.string().min(1).max(Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3) + 8),
  })
  .strict();
export type AttachmentInput = z.infer<typeof AttachmentInput>;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

const TEXT_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/x-log',
  'application/json',
  'application/x-yaml',
  'text/yaml',
  'text/html',
  'text/css',
  'text/javascript',
  'application/javascript',
  'application/typescript',
  'text/x-python',
  'text/x-shellscript',
  'application/xml',
  'text/xml',
]);

/** The image type the bytes really are (PNG, JPEG, GIF or WebP), or null. */
export function sniffImage(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

function isUtf8Text(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** A plain file name: no directories, control characters or leading dots. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').replace(/^\.+/, '').trim().slice(0, 120);
  return cleaned || 'file';
}

export function decodeAttachment(input: AttachmentInput): Attachment {
  const name = safeFileName(input.name);
  if (!BASE64.test(input.data)) throw new UserFacingError(`${name}: not valid file data.`, 400);
  const bytes = Buffer.from(input.data, 'base64');
  if (bytes.length === 0) throw new UserFacingError(`${name} is empty.`, 400);
  if (bytes.length > MAX_ATTACHMENT_BYTES) throw new UserFacingError(`${name} is larger than 10 MB.`, 413);

  const claimed = input.mimeType.toLowerCase().split(';')[0]!.trim();
  const image = sniffImage(bytes);
  if (image) return { name, mimeType: image, kind: 'image', bytes };
  if (claimed.startsWith('image/')) throw new UserFacingError(`${name}: only PNG, JPEG, GIF and WebP images are supported.`, 400);

  if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') return { name, mimeType: 'application/pdf', kind: 'pdf', bytes };
  if (claimed === 'application/pdf') throw new UserFacingError(`${name} is not a valid PDF.`, 400);

  const docType = sniffDocument(bytes, name);
  if (docType) return { name, mimeType: docType, kind: 'file', bytes };

  if (isUtf8Text(bytes)) {
    return { name, mimeType: TEXT_TYPES.has(claimed) ? claimed : 'text/plain', kind: 'text', bytes };
  }
  throw new UserFacingError(`${name}: only photos, PDFs, text, Office files, archives and SQLite or Parquet data can be attached.`, 400);
}

export function decodeAttachments(inputs: AttachmentInput[] | undefined): Attachment[] {
  if (!inputs?.length) return [];
  if (inputs.length > MAX_ATTACHMENTS) throw new UserFacingError(`Attach at most ${MAX_ATTACHMENTS} files.`, 400);
  return inputs.map(decodeAttachment);
}
