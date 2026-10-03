import type { TaskList, TaskSummary } from '../shared/protocol.js';

const now = Date.now();
const base: TaskSummary = { id: '00000000-0000-4000-8000-000000000001', title: 'Demo worker task', role: 'worker',
  status: 'running', chat: '20260927_080000_abcdef', verified: true, dueAt: now - 60_000,
  overdue: true, updatedAt: now - 30_000, relays: [] };

export const demoTasks = {
  status: (): TaskList => ({ tasks: [
    { ...base, title: 'Demo unlinked task', verified: false,
      linkReason: 'Not linked: no successful launch proof.' },
    { ...base, id: '00000000-0000-4000-8000-000000000002', title: 'Demo held update', role: 'coder-lead',
      relays: [{ id: 'overdue#1', kind: 'overdue', queuedAt: now - 30_000, failures: 0,
        held: 'Held: current chat or readiness could not be resolved.' }] },
    { ...base, id: '00000000-0000-4000-8000-000000000003', title: 'Demo failed delivery', role: 'reviewer',
      status: 'finished', overdue: false,
      relays: [{ id: 'finished#1', kind: 'update', queuedAt: now - 30_000, failures: 5, skipped: 'not delivered' }] },
  ] }),
};
