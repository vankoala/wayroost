import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('coordinates cutover and rollback with the installed server state permissions and separate Safety role', () => {
  const unit = readFileSync('deploy/wayroost-server.service', 'utf8');
  expect(unit).toContain('StateDirectory=wayroost-shadow');
  expect(unit).toContain('DynamicUser=yes');
  expect(unit).toContain('ProtectSystem=strict');
  const cutover = readFileSync('docs/shadow-cutover.md', 'utf8');
  expect(cutover).toContain('StateDirectory=wayroost\n');
  expect(cutover).toContain('StateDirectory=wayroost-shadow');
  expect(cutover).toContain('StateDirectory=\n');
  expect(cutover).toContain('wayroost-paseo-safety.service');
  expect(cutover).toContain('systemctl daemon-reload');
  expect(cutover).toContain('Safety companion');
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
