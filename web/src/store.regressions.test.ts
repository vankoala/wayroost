// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyEvent } from './store';

beforeEach(() => history.replaceState(null, '', '/'));
afterEach(() => vi.restoreAllMocks());

describe('server-driven thread ID changes', () => {
  const cases = (['hermes', 'paseo'] as const).flatMap((source) =>
    ['attention', 'working', 'hermes', 'paseo', 'all', 'made-up', ''].map((filter) => ({ source, filter })),
  );

  it.each(cases)('preserves the parsed $filter filter for $source', ({ source, filter }) => {
    const query = filter ? `?filter=${filter}` : '';
    history.replaceState({ signalbox: true }, '', `/c/${source}/demo-old${query}`);
    const push = vi.spyOn(history, 'pushState');
    const replace = vi.spyOn(history, 'replaceState');

    applyEvent({ type: 'conversation_moved', source, from: 'demo-old', to: 'demo-next' });

    const expected = ['attention', 'working', 'hermes', 'paseo'].includes(filter) ? `?filter=${filter}` : '';
    expect(location.pathname + location.search).toBe(`/c/${source}/demo-next${expected}`);
    expect(history.state).toEqual({ signalbox: true });
    expect(push).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it.each(['/chats?filter=working', '/c/hermes/demo-other?filter=working', '/c/paseo/demo-old?filter=working'])(
    'keeps an unrelated route at %s', (path) => {
      history.replaceState(null, '', path);
      applyEvent({ type: 'conversation_moved', source: 'hermes', from: 'demo-old', to: 'demo-next' });
      expect(location.pathname + location.search).toBe(path);
    },
  );
});
