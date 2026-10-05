import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('coordinates cutover and rollback with server state permissions, supervisor config writes and catalogue writes', () => {
  const unit = readFileSync('deploy/wayroost-server.service', 'utf8');
  expect(unit).toContain('StateDirectory=wayroost-shadow');
  expect(unit).toContain('DynamicUser=yes');
  expect(unit).toContain('ProtectSystem=strict');
  const cutover = readFileSync('docs/shadow-cutover.md', 'utf8');
  expect(cutover).toContain('StateDirectory=wayroost\n');
  expect(cutover).toContain('StateDirectory=wayroost-shadow');
  expect(cutover).toContain('StateDirectory=\n');
  expect(cutover).toContain("supervisor's config verbs");
  expect(cutover).toContain('systemctl daemon-reload');
  expect(cutover).toContain('do not install or start the owner-side Safety');
  expect(cutover).toContain("Disable the supervisor's `configWrites` switch");
  expect(cutover).toContain('is never installed');
  expect(cutover).toContain('`SAFETY_OWNER` unset');
  expect(cutover).toContain('`paseo.worker-approvals`');
  expect(cutover).toContain('`paseo.provider-enabled`');
  expect(cutover).toContain('config verbs before cutover');
  expect(cutover).toContain('`configWrites` off before restoring');
  expect(cutover).toContain('settings.legacyRoutesViaPipeline');
  expect(cutover).not.toContain('restart the\n   Safety helper');
  expect(cutover).not.toContain('wayroost-paseo-safety.service');
});

it('pins every documented Signalbox recovery command to its explicit config and distinguishes rescue keys', () => {
  const docs = readFileSync('docs/configuration.md', 'utf8');
  const commands = docs.split('\n').filter(line => line.includes('sudo node /opt/signalbox/dist/server/pair-code.js'));
  expect(commands).toHaveLength(2);
  for (const command of commands) expect(command).toContain('--config /etc/signalbox/config.json');
  expect(docs).toContain('`SIGNALBOX_CONFIG` or `/etc/wayroost/config.json`');
  expect(docs).toContain('shown once by `install-supervisor.sh`');
  expect(docs).toContain('**device pairing codes**');
});
