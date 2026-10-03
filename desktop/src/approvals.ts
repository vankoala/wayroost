import { randomBytes } from 'node:crypto';
import type { Approval, ApprovalOption, ConversationSummary } from '../../shared/protocol.js';
import { describeApproval } from '../../shared/approval-card.js';
import type { ApprovalActivation } from './protocol.js';
import { toastDetail } from './toast.js';
/** Approval ids are only unique within one backend conversation, so everything local is keyed by all three. */
export type ApprovalRef = Pick<Approval, 'source' | 'conversationId' | 'id'>;
export function approvalKey(approval: ApprovalRef): string { return `${approval.source}/${approval.conversationId}/${approval.id}`; }
/**
 * The page that shows this approval's card: its conversation, with `#approval-<id>` naming the card
 * the web app's approval dock shows first (web/src/approvalLink.ts).
 */
export function approvalUrl(origin: string, approval: ApprovalRef): string {
  return `${origin}/c/${approval.source}/${encodeURIComponent(approval.conversationId)}#approval-${encodeURIComponent(approval.id)}`;
}
/** The windows openApproval drives: load the main window, bring it forward, or bring forward whatever is in front now. */
export interface ApprovalView { load(url: string): Promise<unknown>; show(): void; reveal(): void }
/**
 * Opens an approval's card. The main window comes forward only once its page has loaded: a failed load
 * leaves what did-fail-load put in front (the rescue page while the server is down), so reveal() shows
 * that instead. Without an approval (answered meanwhile), the app comes forward as it is.
 */
export async function openApprovalView(origin: string, approval: ApprovalRef | undefined, view: ApprovalView): Promise<void> {
  if (!approval) { view.reveal(); return; }
  try { await view.load(approvalUrl(origin, approval)); } catch { view.reveal(); return; }
  view.show();
}
/**
 * Whether the rescue page comes forward when the server can't be reached. A sign-in start (`--hidden`)
 * stays in the tray until someone asks; a toast, a wayroost: link or a window already showing is asking.
 */
export function rescueInFront(state: { hiddenStart: boolean; asked: boolean; windowVisible: boolean }): boolean {
  return state.asked || !state.hiddenStart || state.windowVisible;
}
/** The one pending approval a bare activation id names; none when it is missing or ambiguous across conversations. */
export function approvalById(approvals: Iterable<Approval>, id: string): Approval | undefined {
  const matches = [...approvals].filter((approval) => approval.id === id);
  return matches.length === 1 ? matches[0] : undefined;
}
/**
 * The option that allows this one request and nothing more, or none when that can't be told without guessing.
 * Only Hermes' `once` qualifies: the Hermes normalizer builds it from a fixed table of Hermes choices.
 * Paseo options can't be told apart here: a provider action may use the ids `allow`/`deny` for something
 * broader (Claude's "Implement (then auto-accepts edits)"), exactly like Paseo's own fallback pair, so every
 * Paseo approval stays on the full card, like Session, Always and everything else.
 */
export function onceOption(approval: Approval): ApprovalOption | undefined {
  if (approval.kind !== 'permission' || approval.source !== 'hermes') return undefined;
  const once = approval.options.filter((option) => option.id === 'once' && option.kind === 'allow');
  return once.length === 1 ? once[0] : undefined;
}
/**
 * Whether a toast may offer "Allow once": a once-only option, the toast shows the whole detail, and the
 * card wouldn't call it High risk (a High request, or one Wayroost can't read whole, gets the full card).
 * The card's risk only ever takes "Allow once" away here; it never adds it.
 */
export function toastCanAllow(approval: Approval): boolean {
  return !!onceOption(approval) && !approval.detailTruncated && toastDetail(approval.detail).whole &&
    describeApproval(approval).risk.level !== 'High';
}
/**
 * What a toast, the tray and the confirmation say about an approval: the role that asks and the request in
 * the same words as its card (shared/approval-card.ts), from the conversation the last snapshot carried.
 */
export function approvalWords(approval: Approval, conversation?: ConversationSummary): { role: string; title: string; sentence: string } {
  const copy = describeApproval(approval, conversation);
  return { role: copy.role.name, title: copy.titleText, sentence: `${copy.role.name} is asking: ${copy.titleText}` };
}
export interface ToastTicket { key: string; id: string; createdAt: number }
/**
 * Single-use 128-bit tokens that bind a toast's activation URL to the exact approval it showed.
 * wayroost: links can be opened by any web page or local program (an agent through WSL interop
 * included), but toast arguments are seen only by Windows and this process, so only the toast
 * the user pressed can answer. Tickets live in memory for this run.
 */
export class ToastTickets {
  private readonly tickets = new Map<string, ToastTicket>();
  issue(approval: Approval): string {
    const nonce = randomBytes(16).toString('base64url');
    this.tickets.set(nonce, { key: approvalKey(approval), id: approval.id, createdAt: approval.createdAt });
    return nonce;
  }
  take(nonce: string): ToastTicket | undefined {
    const ticket = this.tickets.get(nonce);
    this.tickets.delete(nonce);
    return ticket;
  }
  forget(key: string) { for (const [nonce, ticket] of this.tickets) if (ticket.key === key) this.tickets.delete(nonce); }
}
/**
 * What an activation may do. Allow once needs an unused ticket for the same approval, still pending
 * with the same createdAt (not a newer request that reused the id); anything else only opens.
 */
export function resolveActivation(activation: ApprovalActivation, approvals: ReadonlyMap<string, Approval>, tickets: ToastTickets): { action: ApprovalActivation['action']; approval?: Approval } {
  const ticket = activation.nonce ? tickets.take(activation.nonce) : undefined;
  if (ticket && ticket.id === activation.id) {
    const approval = approvals.get(ticket.key);
    if (approval && approval.createdAt === ticket.createdAt) return { action: activation.action, approval };
  }
  const approval = approvalById(approvals.values(), activation.id);
  return approval ? { action: 'open', approval } : { action: 'open' };
}
/** What an activation drives in the app; main.ts wires these to the client and the windows. */
export interface ActivationSteps {
  approvals: ReadonlyMap<string, Approval>;
  tickets: ToastTickets;
  /** A fresh authenticated snapshot of the pending approvals. */
  refresh(): Promise<void>;
  /** Answers with the once option and confirms it; throws when that can't be done. */
  allowOnce(approval: Approval): Promise<void>;
  open(approval: Approval | undefined): Promise<void>;
  reveal(): void;
  /** The server can't be reached. Someone activated the app, so the rescue page must come forward even after a hidden start. */
  rescue(): Promise<void>;
}
/** Handles a toast or wayroost: activation; a bare start (no activation) brings the app forward as it is. */
export async function runActivation(activation: ApprovalActivation | null, steps: ActivationSteps): Promise<void> {
  if (!activation) { steps.reveal(); return; }
  try { await steps.refresh(); } catch { await steps.rescue(); return; }
  // Only the toast this run raised can answer; a bare or replayed wayroost: link just opens the card.
  const { action, approval } = resolveActivation(activation, steps.approvals, steps.tickets);
  if (approval && action === 'allow-once') {
    try { await steps.allowOnce(approval); return; } catch { /* Show the full card instead. */ }
  }
  const current = approval && steps.approvals.get(approvalKey(approval));
  await steps.open(current?.createdAt === approval?.createdAt ? current : undefined);
}
