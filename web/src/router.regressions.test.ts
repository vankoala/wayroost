// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { goBack, navigate } from './router';

beforeEach(() => history.replaceState(null, '', '/'));
afterEach(() => vi.restoreAllMocks());

describe('Back from a directly loaded thread', () => {
  it.each(['attention', 'working', 'hermes', 'paseo'])('returns to the %s inbox', (filter) => {
    history.replaceState(null, '', `/c/hermes/demo-chat?filter=${filter}`);
    const back = vi.spyOn(history, 'back');
    const push = vi.spyOn(history, 'pushState');

    goBack();

    expect(location.pathname + location.search).toBe(`/chats?filter=${filter}`);
    expect(history.state).toBeNull();
    expect(back).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it.each(['', '?filter=all', '?filter=made-up'])('returns to all chats for %s', (query) => {
    history.replaceState(null, '', `/c/hermes/demo-chat${query}`);
    goBack();
    expect(location.pathname + location.search).toBe('/chats');
  });

  it('uses browser history when the thread was opened in the app', async () => {
    history.replaceState(null, '', '/chats?filter=attention');
    navigate('/c/hermes/demo-chat?filter=working');
    const popped = new Promise<void>((resolve) => window.addEventListener('popstate', () => resolve(), { once: true }));

    goBack();
    await popped;

    expect(location.pathname + location.search).toBe('/chats?filter=attention');
  });
});
