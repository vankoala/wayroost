import { authenticationDecision, authenticationError, authenticationHttpFailure, readAuthenticationBody, responseAuthenticationDecision, type AuthenticationDecision, type AuthenticationLoss, type AuthenticationSignal } from '../../shared/authentication';
import { authenticationBlocked, getAuthenticationGeneration, getState, markSignedOut, markUnpaired } from './store';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly kind: 'network' | 'auth' | 'http',
    readonly status?: number,
  ) {
    super(message);
  }
}

function markLoss({ loss, retire }: AuthenticationDecision): void {
  if (retire) markUnpaired();
  if (loss === 'session-expired') {
    markSignedOut();
  }
}

export function markAuthenticationLost(signal: AuthenticationSignal): AuthenticationLoss | null {
  const decision = authenticationDecision(signal);
  markLoss(decision);
  return decision.loss;
}

/** Pairing is the only request allowed after authentication has been suspended. */
export function beginAuthenticatedRequest(pairing = false): number {
  if (!pairing && authenticationBlocked()) throw new ApiError(getState().unpaired ? "This device isn't paired." : 'Your sign-in expired.', 'auth', 401);
  return getAuthenticationGeneration();
}

export function checkAuthenticationGeneration(generation: number): void {
  if (generation !== getAuthenticationGeneration()) throw new ApiError('Your sign-in expired.', 'auth', 401);
}

/** Desktop responses signal main; ordinary browsers classify their own sign-in loss. */
export async function checkAuthentication(response: Response, generation = getAuthenticationGeneration(), bearing = false): Promise<void> {
  if (typeof window !== 'undefined' && window.wayroostTray?.anomaly) {
    checkAuthenticationGeneration(generation);
    let forbidden = false;
    if (response.status === 403) {
      try {
        const data = await readAuthenticationBody(response.clone());
        forbidden = !!data && typeof data === 'object' && 'error' in data && authenticationError(data.error);
      } catch { forbidden = bearing; }
    }
    checkAuthenticationGeneration(generation);
    if (authenticationHttpFailure(response.status) || forbidden || response.type === 'opaqueredirect' || response.redirected) {
      window.wayroostTray.anomaly();
      throw new ApiError('Approvals are paused while your sign-in is checked.', 'auth', response.status);
    }
    return;
  }
  // Concurrent 401s from the same device still get classified after the first one suspends it.
  if (response.status === 401 && getState().sessionExpired && generation + 1 === getAuthenticationGeneration()) generation += 1;
  checkAuthenticationGeneration(generation);
  let suspendedGeneration = generation;
  const decision = await responseAuthenticationDecision(response, () => {
    markSignedOut();
    suspendedGeneration = getAuthenticationGeneration();
  });
  checkAuthenticationGeneration(suspendedGeneration);
  const { loss } = decision;
  markLoss(decision);
  if (loss) throw new ApiError(loss === 'unpaired' ? "This device isn't paired." : 'Your sign-in expired.', 'auth', 401);
}

/** Renderer failures are signals to main; only main's published state changes desktop authentication. */
export function reportAuthenticationAnomaly(generation: number): void {
  if (generation === getAuthenticationGeneration() && typeof window !== 'undefined') window.wayroostTray?.anomaly?.();
}
