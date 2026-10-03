/** The supervisor's single-token key format, shared by startup and the client. */
export function parseSupervisorKey(text: string): string | undefined {
  const key = text.trim();
  return /^[A-Za-z0-9+/=._~-]{16,256}$/.test(key) ? key : undefined;
}
