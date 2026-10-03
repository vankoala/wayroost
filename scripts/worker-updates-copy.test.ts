import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('documents completion-after-wait behavior without claiming wait suppression', () => {
  const security = readFileSync(new URL('../SECURITY.md', import.meta.url), 'utf8');
  const updates = security.split('### Worker updates (the task log)')[1]!.split('## Voice mode')[0]!;
  expect(updates).toContain('Completion updates may repeat wait results.');
  expect(updates).not.toMatch(/already heard|stay quiet|wait_for_reply.*counts/);
});
