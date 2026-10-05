import { parse } from 'yaml';

/** Hermes also accepts a YAML sequence stored inside a scalar string. */
export function commandAllowlist(value: unknown): string[] | undefined {
  if (typeof value === 'string') {
    try { value = parse(value, { version: '1.1', maxAliasCount: 0 }); }
    catch { return undefined; }
  }
  return Array.isArray(value) && value.every(entry => typeof entry === 'string') ? value : undefined;
}
