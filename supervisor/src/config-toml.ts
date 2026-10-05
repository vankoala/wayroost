import { ConfigError } from './config-paths.js';

/** Parse without evaluation; only the root approval fields leave this reader. */
export function readConfigToml(source: string): Record<string, string> {
  let at = 0;
  const root: Record<string, unknown> = Object.create(null);
  let table = root;
  const declared = new Set<object>();
  const explicit = new WeakSet<object>();
  const sealed = new WeakSet<object>();
  const tableArrays = new WeakSet<object>();
  const fail = (): never => { throw new ConfigError('parse_failed'); };
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]|\r(?!\n)/.test(source)) fail();
  const space = (lines = false): void => {
    while (at < source.length) {
      if (source[at] === ' ' || source[at] === '\t' || lines && /[\r\n]/.test(source[at]!)) at++;
      else if (source[at] === '#') { while (at < source.length && source[at] !== '\n') at++; if (!lines) break; }
      else break;
    }
  };
  const string = (multiline = true): string => {
    const quote = source[at++]!;
    const triple = multiline && source.slice(at, at + 2) === quote.repeat(2);
    if (triple) { at += 2; if (source.slice(at, at + 2) === '\r\n') at += 2; else if (source[at] === '\n') at++; }
    let result = '';
    while (at < source.length) {
      if (source[at] === quote) {
        if (!triple) { at++; return result; }
        if (source.slice(at, at + 3) === quote.repeat(3)) {
          at += 3;
          for (let count = 0; count < 2 && source[at] === quote; count++) { result += quote; at++; }
          return result;
        }
      }
      const char = source[at++]!;
      if ((!triple && /[\r\n]/.test(char)) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(char)) fail();
      if (char !== '\\' || quote === "'") { result += char; continue; }
      if (triple && /[ \t\r\n]/.test(source[at] ?? '')) {
        const begin = at;
        while (/[ \t\r\n]/.test(source[at] ?? '')) at++;
        if (!source.slice(begin, at).includes('\n')) fail();
        continue;
      }
      const escaped = source[at++]!;
      const escapes: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
      if (Object.hasOwn(escapes, escaped)) { result += escapes[escaped]; continue; }
      if (escaped !== 'u' && escaped !== 'U') fail();
      const length = escaped === 'u' ? 4 : 8;
      const hex = source.slice(at, at + length);
      if (hex.length !== length || !/^[a-fA-F0-9]+$/.test(hex)) fail();
      at += length;
      const point = Number.parseInt(hex, 16);
      if (point > 0x10ffff || point >= 0xd800 && point <= 0xdfff) fail();
      result += String.fromCodePoint(point);
    }
    return fail();
  };
  const keys = (): string[] => {
    const result: string[] = [];
    while (true) {
      space();
      if (source[at] === '"' || source[at] === "'") result.push(string(false));
      else {
        const key = /^[A-Za-z0-9_-]+/.exec(source.slice(at))?.[0];
        if (!key) fail();
        result.push(key!); at += key!.length;
      }
      space();
      if (source[at] !== '.') return result;
      at++;
    }
  };
  const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
  const descend = (base: Record<string, unknown>, path: string[], dotted = false): Record<string, unknown> => {
    for (const key of path) {
      if (!Object.hasOwn(base, key)) base[key] = Object.create(null);
      let next = base[key];
      if (Array.isArray(next)) {
        if (dotted || !tableArrays.has(next)) fail();
        next = next.at(-1);
      }
      if (!object(next) || sealed.has(next) || dotted && explicit.has(next)) fail();
      if (dotted) declared.add(next as object);
      base = next as Record<string, unknown>;
    }
    return base;
  };
  const put = (base: Record<string, unknown>, path: string[], value: unknown): void => {
    const parent = descend(base, path.slice(0, -1), true);
    const key = path.at(-1)!;
    if (Object.hasOwn(parent, key)) fail();
    parent[key] = value;
  };
  const value = (depth = 0): unknown => {
    if (depth > 64) fail();
    space();
    if (source[at] === '"' || source[at] === "'") return string();
    if (source[at] === '[') {
      at++; const result: unknown[] = []; space(true);
      while (source[at] !== ']') {
        result.push(value(depth + 1)); space(true);
        if (source[at] === ']') break;
        if (source[at++] !== ',') fail();
        space(true);
      }
      at++; return result;
    }
    if (source[at] === '{') {
      at++; const result: Record<string, unknown> = Object.create(null); space();
      while (source[at] !== '}') {
        const path = keys();
        if (source[at++] !== '=') fail();
        put(result, path, value(depth + 1)); space();
        if (source[at] === '}') break;
        if (source[at++] !== ',') fail();
        space(); if (source[at] === '}') fail();
      }
      at++; sealed.add(result); return result;
    }
    let token = /^[^\s,\]}#]+/.exec(source.slice(at))?.[0];
    if (!token) return fail();
    at += token.length;
    if (/^\d{4}-\d{2}-\d{2}$/.test(token) && source[at] === ' ') {
      const time = /^ \d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})?/.exec(source.slice(at))?.[0];
      if (time) { token += time; at += time.length; }
    }
    if (token === 'true' || token === 'false') return token === 'true';
    const digit = '[0-9](?:_?[0-9])*';
    if (new RegExp(`^[+-]?(?:0|[1-9](?:_?[0-9])*)(?:\\.${digit})?(?:[eE][+-]?${digit})?$`).test(token)
      || /^0x[0-9a-fA-F](?:_?[0-9a-fA-F])*$/.test(token) || /^0o[0-7](?:_?[0-7])*$/.test(token)
      || /^0b[01](?:_?[01])*$/.test(token) || /^[+-]?(?:inf|nan)$/.test(token)) return Number(token.replaceAll('_', ''));
    const date = /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})?))?$/.exec(token);
    const time = date?.[4] ?? (/^\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(token) ? token : undefined);
    if (date) {
      const year = Number(date[1]); const month = Number(date[2]); const day = Number(date[3]);
      const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      if (month < 1 || month > 12 || day < 1 || day > days[month - 1]!) fail();
    }
    if (time) {
      const parts = /^(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))?$/.exec(time);
      if (!parts || Number(parts[1]) > 23 || Number(parts[2]) > 59 || Number(parts[3]) > 60 || Number(parts[4] ?? 0) > 23 || Number(parts[5] ?? 0) > 59) fail();
    }
    if (date || time) { const result = { datetime: token }; sealed.add(result); return result; }
    return fail();
  };
  while (at < source.length) {
    space(true); if (at === source.length) break;
    if (source[at] === '[') {
      at++; const array = source[at] === '['; if (array) at++;
      const path = keys();
      if (source[at++] !== ']' || array && source[at++] !== ']') fail();
      if (array) {
        const parent = descend(root, path.slice(0, -1)); const key = path.at(-1)!;
        if (!Object.hasOwn(parent, key)) { parent[key] = []; tableArrays.add(parent[key] as object); }
        if (!Array.isArray(parent[key]) || !tableArrays.has(parent[key] as object)) fail();
        table = Object.create(null) as Record<string, unknown>;
        explicit.add(table);
        (parent[key] as unknown[]).push(table);
      } else {
        const parent = descend(root, path.slice(0, -1)); const key = path.at(-1)!;
        if (!Object.hasOwn(parent, key)) parent[key] = Object.create(null);
        if (!object(parent[key]) || sealed.has(parent[key] as object)) fail();
        table = parent[key] as Record<string, unknown>;
        if (declared.has(table)) fail();
        declared.add(table); explicit.add(table);
      }
    } else {
      const path = keys();
      if (source[at++] !== '=') fail();
      put(table, path, value());
    }
    space();
    if (at < source.length && source[at] !== '\r' && source[at] !== '\n') fail();
    if (source[at] === '\r') { at++; if (source[at] !== '\n') fail(); }
    if (source[at] === '\n') at++;
  }
  const result: Record<string, string> = Object.create(null);
  for (const key of ['approval_policy', 'sandbox_mode']) {
    if (!Object.hasOwn(root, key)) continue;
    if (typeof root[key] !== 'string') fail();
    result[key] = root[key] as string;
  }
  return result;
}
