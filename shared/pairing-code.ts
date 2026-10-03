/** 128 bits in base32: 26 characters. */
export const CODE_RE = /^[a-z2-7]{26}$/;

/** A typed or pasted code: case, spaces and dashes don't matter. */
export function normalizePairingCode(code: string): string {
  return code.toLowerCase().replace(/[\s-]/g, '');
}
