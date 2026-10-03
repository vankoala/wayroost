/** The server's approval id grammar (IdParam in server/src/app.ts): dotted question ids such as `req-1.q0` included. */
export const APPROVAL_ID = /^[A-Za-z0-9][\w.:@+-]{0,199}$/;
export type ApprovalProtocol = 'wayroost' | 'wayroost-dev';
/** `nonce` is the single-use token of the toast that raised the activation; without a valid one nothing is answered. */
export interface ApprovalActivation { id: string; action: 'allow-once' | 'open'; nonce?: string }
export function parseActivation(value: string, protocol: ApprovalProtocol = 'wayroost'): ApprovalActivation | null {
  if (!value.startsWith(`${protocol}://`)) return null;
  const match = /^wayroost(?:-dev)?:\/\/approval\/([A-Za-z0-9][\w.:@+-]{0,199})\/(allow-once|open)(?:\/([A-Za-z0-9_-]{22}))?$/.exec(value);
  if (!match) return null;
  return { id: match[1]!, action: match[2] as ApprovalActivation['action'], ...(match[3] ? { nonce: match[3] } : {}) };
}
export function activationFromArgv(argv: string[], protocol: ApprovalProtocol = 'wayroost'): ApprovalActivation | null {
  for (const arg of argv) { const activation = parseActivation(arg, protocol); if (activation) return activation; }
  return null;
}
export function navigationKind(value: string, origin: string): 'internal' | 'external' | 'refuse' {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return 'refuse';
    return url.origin === origin ? 'internal' : 'external';
  } catch { return 'refuse'; }
}
