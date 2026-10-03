import { UserFacingError } from './sources.js';

export type ServerRole = 'shadow' | 'primary';

/** Unattended work goes through this gate; authenticated user actions do not. */
export class BackgroundGate {
  readonly role: ServerRole;

  constructor(role: ServerRole) {
    this.role = role === 'primary' ? 'primary' : 'shadow';
  }

  run<T>(work: () => T): T | undefined {
    return this.role === 'primary' ? work() : undefined;
  }

  require(): void {
    if (this.role !== 'primary') throw new UserFacingError('Background work is off in shadow mode.', 503);
  }
}

export const shadowBackground = new BackgroundGate('shadow');
