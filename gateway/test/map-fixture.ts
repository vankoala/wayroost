import type { RoleMap } from '../../shared/gateway.js';

export function demoMap(): RoleMap {
  const contract = { input: ['text'] as ['text'], toolCalling: true, thinkingLevels: false, maxOutputTokens: 4096, advertisedContext: 262144 };
  const backend = { baseUrl: 'http://127.0.0.1:8899/v1', servedName: 'demo-model-a', contextLength: 262144,
    maxOutputTokens: 4096, input: ['text'] as ['text'], toolCalling: true, thinkingLevels: false, listenerUid: 0 };
  return { version: 2, contracts: { main: { ...contract }, coder: { ...contract, advertisedContext: 131072 }, fast: { ...contract, advertisedContext: 131072 } },
    backends: { 'demo-a': backend, 'demo-b': { ...backend, servedName: 'demo-model-b', contextLength: 65536 } },
    profiles: { 'example/sglang': { main: 'demo-a', coder: 'demo-a', fast: 'demo-a' },
      'example/profile': { main: 'demo-b', coder: null, fast: null } }, roles: { main: 'demo-a', coder: 'demo-a', fast: 'demo-a' } };
}
