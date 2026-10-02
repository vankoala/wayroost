// Office documents, archives and data files that can be attached besides
// images, PDFs and text. Agents can't read these inline: Paseo and Hermes save
// them and the agent gets a path, to open with its own tools. A file counts
// only when its bytes carry the format's signature AND its name has one of
// that format's extensions, so an executable renamed to .xlsx is still refused.
// The browser and the server both use this list.

interface DocumentFormat {
  /** Byte signatures, any of which marks the format, at `offset`. */
  signatures: readonly (readonly number[])[];
  offset?: number;
  /** Extension → MIME type. */
  types: Readonly<Record<string, string>>;
}

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

const FORMATS: readonly DocumentFormat[] = [
  {
    // ZIP: Office Open XML, OpenDocument, EPUB and plain .zip (the second is an empty archive).
    signatures: [
      [0x50, 0x4b, 0x03, 0x04],
      [0x50, 0x4b, 0x05, 0x06],
    ],
    types: {
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      ods: 'application/vnd.oasis.opendocument.spreadsheet',
      odt: 'application/vnd.oasis.opendocument.text',
      odp: 'application/vnd.oasis.opendocument.presentation',
      epub: 'application/epub+zip',
      zip: 'application/zip',
    },
  },
  {
    // OLE compound file: Office 97–2003 and Outlook messages.
    signatures: [[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]],
    types: {
      xls: 'application/vnd.ms-excel',
      doc: 'application/msword',
      ppt: 'application/vnd.ms-powerpoint',
      msg: 'application/vnd.ms-outlook',
    },
  },
  { signatures: [[0x1f, 0x8b]], types: { gz: 'application/gzip', tgz: 'application/gzip' } },
  { signatures: [ascii('ustar')], offset: 257, types: { tar: 'application/x-tar' } },
  { signatures: [[0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]], types: { '7z': 'application/x-7z-compressed' } },
  {
    signatures: [ascii('SQLite format 3\0')],
    types: { sqlite: 'application/vnd.sqlite3', sqlite3: 'application/vnd.sqlite3', db: 'application/vnd.sqlite3' },
  },
  { signatures: [ascii('PAR1')], types: { parquet: 'application/vnd.apache.parquet' } },
];

/** Extensions of the formats above, for a file picker's `accept`. */
export const DOCUMENT_EXTENSIONS: readonly string[] = FORMATS.flatMap((f) => Object.keys(f.types));

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** The MIME type when the bytes and the name agree on one of the formats above, else null. */
export function sniffDocument(bytes: Uint8Array, name: string): string | null {
  const ext = extensionOf(name);
  for (const format of FORMATS) {
    if (!Object.hasOwn(format.types, ext)) continue;
    const at = format.offset ?? 0;
    if (format.signatures.some((sig) => bytes.length >= at + sig.length && sig.every((b, i) => bytes[at + i] === b))) {
      return format.types[ext]!;
    }
  }
  return null;
}
