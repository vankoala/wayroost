import { RESCUE_ACTIONS, SUPERVISOR_ROUTES } from '../../shared/supervisor.js';
import type { SupervisorStatus } from '../../shared/supervisor.js';
import { responseAuthenticationLoss } from '../../shared/authentication.js';
import { desktopOrigin, ListenerIdentityError, pinnedRequest } from './tls.js';
import { ListenerCertificateDateError, ListenerNotPairedError } from '../../lib/loopback-tls.js';
export interface RescueTransport { pin?: () => string | undefined; development?: boolean }
export class RescueUnauthorized extends Error { constructor() { super('Save a valid supervisor rescue key in the recovery form to restore rescue access.'); } }
/** Checks a rescue key against the supervisor's status route before anything stores it; independent of server pairing. */
export async function checkRescueKey(origin: string, key: string, transport: RescueTransport = {}): Promise<SupervisorStatus> {
  try { return await new RescueClient(origin, async () => key, transport).status(); } catch (error) {
    if (error instanceof ListenerIdentityError) throw new ListenerIdentityError('supervisor');
    if (error instanceof ListenerCertificateDateError || error instanceof ListenerNotPairedError) throw error;
    if (error instanceof RescueUnauthorized) throw new Error('The supervisor refused that rescue key. Check it and try again.');
    throw new Error('Couldn’t reach the supervisor to check the rescue key. Try again in a moment.');
  }
}
export class RescueClient {
  constructor(private readonly origin: string, private readonly key: () => Promise<string>, private readonly transport: RescueTransport = {}) {
    desktopOrigin(origin, transport.development);
  }
  private async request(path: string, body?: unknown): Promise<unknown> {
    const url = new URL(path, this.origin);
    // Retain this request's pin while its matching credential is read.
    const pin = this.transport.pin?.();
    const headers = { Authorization: `Bearer ${await this.key()}`, 'Content-Type': 'application/json' };
    const response = url.protocol === 'https:' ? await pinnedRequest(url, pin, headers, body ? JSON.stringify(body) : undefined) : await fetch(url, { method: body ? 'POST' : 'GET',
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(5000) });
    // Rescue authenticates a separate supervisor credential; its failure never revokes the paired device.
    if (await responseAuthenticationLoss(response)) throw new RescueUnauthorized();
    if (!response.ok) throw new Error(`Rescue request failed (${response.status}).`);
    return response.json();
  }
  async status(): Promise<SupervisorStatus> { return await this.request(SUPERVISOR_ROUTES.status) as SupervisorStatus; }
  async restart(): Promise<unknown> { return this.request(SUPERVISOR_ROUTES.actions, { ...RESCUE_ACTIONS[0], when: 'now' }); }
}
