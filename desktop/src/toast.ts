import { APPROVAL_ID, type ApprovalProtocol } from './protocol.js';
/** Characters XML 1.0 can't carry (lone surrogates included); a toast with one is never shown. */
const XML_ILLEGAL = /[^\t\n\r\x20-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu;
/** Escapes a string for toast XML, replacing anything XML 1.0 forbids with U+FFFD. */
export function escapeXml(value: string): string {
  return value.replace(XML_ILLEGAL, '\uFFFD').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!);
}
/** Longest detail a toast line shows before clipping it (Open-only toasts). */
export const TOAST_DETAIL_MAX = 80;
const SENTENCE_MAX = 90;
/**
 * What a toast may show whole, in ems: one line of the toast body (about 330 px of 14 px text at 100 %
 * text size), with margin. Shown in a two-line text element, the spare line absorbs word wrap and larger
 * text sizes, so a detail within this budget is never cut or ellipsized.
 */
export const TOAST_DETAIL_EM = 20;
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu;
/** One line of at most `max` code points; never splits a surrogate pair. */
function clipLine(value: string, max: number): string {
  const points = [...value.replace(INVISIBLE, ' ').trim()];
  return points.length > max ? `${points.slice(0, max - 1).join('')}…` : points.join('');
}
/**
 * Upper bounds, in ems, for printable ASCII in the toast font (Segoe UI's real advances are smaller):
 * narrow punctuation and i/l, the widest letters and @ %, other capitals and math symbols, everything else.
 */
function emWidth(char: string): number {
  if (/[ .,:;'`!|il()[\]{}]/.test(char)) return 0.4;
  if (/[MWmw@%]/.test(char)) return 1.1;
  if (/[A-Z&#+<>=~^]/.test(char)) return 0.85;
  return 0.65;
}
/** Estimated width of printable ASCII text, in ems; anything else is never shown whole. */
export function detailEms(text: string): number {
  return [...text].reduce((sum, char) => sum + emWidth(char), 0);
}
/**
 * The detail line a toast shows, and whether it is the whole detail exactly. Whole needs a detail
 * worth reading (a missing or blank one leaves only the agent-written title), only printable ASCII
 * (no control, invisible, bidi or line-separator characters, and no wide glyphs whose width can't be
 * bounded) and an estimated width within one toast line, so nothing is wrapped away or cut.
 */
export function toastDetail(detail: string | undefined): { line?: string; whole: boolean } {
  if (!detail || !detail.trim()) return { whole: false };
  const whole = /^[\x20-\x7e]+$/.test(detail) && /[A-Za-z0-9]/.test(detail) && detailEms(detail) <= TOAST_DETAIL_EM;
  return { line: clipLine(detail, TOAST_DETAIL_MAX), whole };
}
/**
 * `nonce` comes from ToastTickets; only Windows and this process ever see it. "Allow once" appears only when
 * the caller allows it, which needs the whole detail on the toast (see toastCanAllow), so nothing is approved blind.
 */
export function toastXml(role: string, sentence: string, id: string, nonce: string, extra: { detail?: string; allowOnce: boolean; protocol?: ApprovalProtocol }): string {
  if (!APPROVAL_ID.test(id)) throw new Error('Invalid approval id');
  if (!/^[A-Za-z0-9_-]{22}$/.test(nonce)) throw new Error('Invalid toast nonce');
  const protocol = extra.protocol ?? 'wayroost';
  const open = escapeXml(`${protocol}://approval/${id}/open/${nonce}`);
  const allow = escapeXml(`${protocol}://approval/${id}/allow-once/${nonce}`);
  const detail = toastDetail(extra.detail).line;
  const texts = [clipLine(sentence, SENTENCE_MAX), ...(detail ? [detail] : [])].map((text) => `<text hint-maxLines="2">${escapeXml(text)}</text>`).join('');
  const actions = `${extra.allowOnce ? `<action content="Allow once" activationType="protocol" arguments="${allow}"/>` : ''}<action content="Open" activationType="protocol" arguments="${open}"/>`;
  return `<toast activationType="protocol" launch="${open}"><visual><binding template="ToastGeneric"><text>${escapeXml(role)}</text>${texts}</binding></visual><actions>${actions}</actions></toast>`;
}
