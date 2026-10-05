import { describe, expect, it } from 'vitest';
import { parseCliOptions } from '../src/cli.js';

const base = ['--config', '/home/me/demo-roles.json', '--socket', '/home/me/demo/admin.sock'];

describe('gateway CLI options', () => {
  it('passes listeners and every limit through to the gateway', () => {
    expect(parseCliOptions([...base, '--credentials-dir', '/home/me/demo-credentials', '--listen', 'main=8898', '--listen', 'coder=8899', '--max-request-bytes', '67108864',
      '--backend-timeout-ms', '1800000', '--idle-timeout-ms', '900000', '--health-timeout-ms', '5000'])).toEqual({
      configFile: '/home/me/demo-roles.json', adminSocket: '/home/me/demo/admin.sock',
      credentialsDirectory: '/home/me/demo-credentials', ports: { main: 8898, coder: 8899 },
      maxRequestBytes: 67108864, backendTimeoutMs: 1800000, idleTimeoutMs: 900000, healthTimeoutMs: 5000,
    });
  });

  it('leaves unset limits to the gateway defaults', () => {
    expect(parseCliOptions(base)).toEqual({ configFile: '/home/me/demo-roles.json', adminSocket: '/home/me/demo/admin.sock' });
  });

  it.each([
    [],
    ['--config', '/home/me/demo-roles.json'],
    [...base, '--max-request-bytes', '0'],
    [...base, '--max-request-bytes', '-1'],
    [...base, '--backend-timeout-ms', '1e6'],
    [...base, '--idle-timeout-ms', ''],
    [...base, '--health-timeout-ms', '12.5'],
    [...base, '--listen', 'scout=8898'],
    [...base, '--listen', 'main=8898', '--listen', 'main=8899'],
    [...base, '--unknown', 'demo'],
    [...base, 'positional'],
  ])('rejects malformed arguments %#', (...args) => {
    expect(() => parseCliOptions(args)).toThrow();
  });
});
