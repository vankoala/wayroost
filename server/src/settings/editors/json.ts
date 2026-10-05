import { applyValues, nestedValue, SettingsWriteError, type FormatEditor, type SettingOperation, type SettingValue } from './types.js';

interface Entry { key?: string; start: number; keyEnd?: number; node: JsonNode }
interface JsonNode { start: number; end: number; kind: 'object' | 'array' | 'scalar'; entries: Entry[] }

function parse(source: string): SettingValue {
  try {
    const value = JSON.parse(source.startsWith('\uFEFF') ? source.slice(1) : source) as SettingValue;
    tree(source);
    return value;
  }
  catch { throw new SettingsWriteError('parse_failed', 'Settings file is not valid JSON.'); }
}

/** Offsets let edits leave unrelated whitespace, key order and number spellings untouched. */
function tree(source: string): JsonNode {
  let offset = 0;
  const whitespace = () => { while (/\s/.test(source[offset] ?? '') && offset < source.length) offset++; };
  const stringEnd = () => {
    offset++;
    while (offset < source.length) {
      if (source[offset++] === '\\') offset++;
      else if (source[offset - 1] === '"') break;
    }
  };
  function node(): JsonNode {
    whitespace();
    const start = offset;
    const character = source[offset];
    if (character !== '{' && character !== '[') {
      if (character === '"') stringEnd();
      else while (offset < source.length && !/[\s,}\]]/.test(source[offset]!)) offset++;
      return { start, end: offset, kind: 'scalar', entries: [] };
    }
    const kind = character === '{' ? 'object' : 'array';
    const close = kind === 'object' ? '}' : ']';
    const entries: Entry[] = [];
    const keys = new Set<string>();
    offset++;
    whitespace();
    while (source[offset] !== close) {
      const entryStart = offset;
      let key: string | undefined;
      let keyEnd: number | undefined;
      if (kind === 'object') {
        stringEnd();
        keyEnd = offset;
        key = JSON.parse(source.slice(entryStart, offset)) as string;
        if (keys.has(key)) throw new Error();
        keys.add(key);
        whitespace();
        offset++;
      }
      entries.push({ key, keyEnd, start: entryStart, node: node() });
      whitespace();
      if (source[offset] === ',') { offset++; whitespace(); }
    }
    return { start, end: ++offset, kind, entries };
  }
  return node();
}

function editOne(source: string, operation: SettingOperation): string {
  const root = tree(source);
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const indentation = source.match(/\n([ \t]+)\S/)?.[1] ?? '';
  const prefixAt = (offset: number) => source.slice(source.lastIndexOf('\n', offset - 1) + 1, offset).match(/^[ \t]*/)?.[0] ?? '';
  const render = (value: SettingValue, prefix: string) => JSON.stringify(value, null, indentation)
    .replace(/\n/g, `${newline}${prefix}`);
  const replace = (start: number, end: number, text: string) => source.slice(0, start) + text + source.slice(end);
  if (operation.path.length === 0 && operation.type === 'set') return replace(root.start, root.end, render(operation.value, prefixAt(root.start)));
  let parent = root;
  for (let depth = 0; depth < operation.path.length; depth++) {
    const segment = operation.path[depth]!;
    const index = parent.kind === 'array' ? segment as number : parent.entries.findIndex(entry => entry.key === segment);
    const entry = parent.entries[index];
    if (entry && depth < operation.path.length - 1) { parent = entry.node; continue; }
    if (operation.type === 'delete') {
      if (!entry) return source;
      if (parent.entries.length === 1) return replace(parent.start + 1, entry.node.end, '');
      const next = parent.entries[index + 1];
      return next ? replace(entry.start, next.start, '') : replace(parent.entries[index - 1]!.node.end, entry.node.end, '');
    }
    const value = nestedValue(operation.path.slice(depth + 1), operation.value);
    if (entry) return replace(entry.node.start, entry.node.end, render(value, prefixAt(entry.start)));
    const first = parent.entries[0];
    const last = parent.entries.at(-1);
    const multiline = source.slice(parent.start, parent.end).includes('\n');
    const prefix = first ? prefixAt(first.start) : prefixAt(parent.start) + (indentation || '  ');
    const colon = first?.keyEnd === undefined ? (multiline || source.includes(': ') ? ': ' : ':')
      : source.slice(first.keyEnd, first.node.start);
    const text = (parent.kind === 'object' ? `${JSON.stringify(segment)}${colon}` : '') + render(value, prefix);
    if (last) {
      const gap = multiline ? `${newline}${prefix}` : first ? source.slice(parent.start + 1, first.start) : '';
      return replace(last.node.end, last.node.end, `,${gap}${text}`);
    }
    const gap = multiline ? `${newline}${prefix}` : source.slice(parent.start + 1, parent.end - 1);
    return replace(parent.start + 1, parent.start + 1, `${gap}${text}`);
  }
  return source;
}

export const jsonEditor: FormatEditor = {
  parse,
  edit(source, operations) {
    applyValues(parse(source), operations);
    for (const operation of operations) source = editOne(source, operation);
    return source;
  },
};
