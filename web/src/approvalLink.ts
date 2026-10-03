import type { Approval } from '../../shared/protocol';

// The desktop app's "Open" on an approval toast loads the conversation's page
// with `#approval-<encodeURIComponent(id)>`, naming the card to show first.

const PREFIX = '#approval-';

/** The approval id a location hash names, if it is an approval link. */
export function linkedApprovalId(hash: string): string | undefined {
  if (!hash.startsWith(PREFIX) || hash.length === PREFIX.length) return undefined;
  try {
    return decodeURIComponent(hash.slice(PREFIX.length));
  } catch {
    return undefined;
  }
}

/** Pending approvals in dock order, with the one the link names first while it is still pending. */
export function orderForLink(approvals: Approval[], hash: string): Approval[] {
  const id = linkedApprovalId(hash);
  const at = id === undefined ? -1 : approvals.findIndex((a) => a.id === id);
  return at <= 0 ? approvals : [approvals[at]!, ...approvals.slice(0, at), ...approvals.slice(at + 1)];
}
