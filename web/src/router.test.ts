import { describe, expect, it } from 'vitest';
import {
  chatsPath,
  conversationPath,
  parseChatsFilter,
  parseRoute,
  schedulePath,
  settingsPath,
} from './router';

// Every place is a page with its own URL; the routes Signalbox already had must
// still open the same thing.

describe('parseRoute', () => {
  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf'])('treats inherited settings key %s as an unknown page', (key) => {
    expect(parseRoute(`/settings/${key}`)).toEqual({ name: 'settings', page: 'overview' });
  });

  it('opens the new pages at their own addresses', () => {
    expect(parseRoute('/')).toEqual({ name: 'home' });
    expect(parseRoute('/chats')).toEqual({ name: 'chats' });
    expect(parseRoute('/tasks')).toEqual({ name: 'tasks' });
    expect(parseRoute('/schedule')).toEqual({ name: 'schedule' });
    expect(parseRoute('/team')).toEqual({ name: 'team' });
  });

  it('keeps a deep link to a thread', () => {
    expect(parseRoute('/c/hermes/20260927_071000_a1b2c3')).toEqual({
      name: 'conversation',
      source: 'hermes',
      id: '20260927_071000_a1b2c3',
    });
    expect(parseRoute('/c/paseo/5f0c2a8e-login/')).toEqual({
      name: 'conversation',
      source: 'paseo',
      id: '5f0c2a8e-login',
    });
    // An id that isn't valid percent-decoding lands in the inbox rather than throwing.
    expect(parseRoute('/c/hermes/%zz')).toEqual({ name: 'chats' });
  });

  it('files the settings pages under /settings', () => {
    expect(parseRoute('/settings')).toEqual({ name: 'settings', page: 'overview' });
    expect(parseRoute('/settings/')).toEqual({ name: 'settings', page: 'overview' });
    expect(parseRoute('/settings/status')).toEqual({ name: 'settings', page: 'status' });
    expect(parseRoute('/settings/devices')).toEqual({ name: 'settings', page: 'devices' });
    expect(parseRoute('/settings/connectors')).toEqual({ name: 'settings', page: 'connectors' });
    expect(parseRoute('/settings/skills')).toEqual({ name: 'settings', page: 'skills' });
    expect(parseRoute('/settings/archived')).toEqual({ name: 'settings', page: 'archived' });
    expect(parseRoute('/settings/voice')).toEqual({ name: 'settings', page: 'voice' });
  });

  it('sends an unknown address to the inbox', () => {
    expect(parseRoute('/nothing-here')).toEqual({ name: 'chats' });
  });

  it('ignores the query string when routing', () => {
    expect(parseRoute('/chats?filter=attention')).toEqual({ name: 'chats' });
    expect(parseRoute('/schedule?focus=hermes%3A4&new=1')).toEqual({ name: 'schedule' });
  });
});

describe('paths', () => {
  it('builds the address for each page', () => {
    expect(conversationPath('hermes', 'a b')).toBe('/c/hermes/a%20b');
    expect(chatsPath()).toBe('/chats');
    expect(chatsPath('attention')).toBe('/chats?filter=attention');
    expect(settingsPath()).toBe('/settings');
    expect(settingsPath('status')).toBe('/settings/status');
    expect(schedulePath()).toBe('/schedule');
    expect(schedulePath({ focus: 'hermes:4' })).toBe('/schedule?focus=hermes%3A4');
    expect(schedulePath({ startNew: true })).toBe('/schedule?new=1');
  });

  it('reads the chats filter back out of an address', () => {
    expect(parseChatsFilter('/chats')).toBe('all');
    expect(parseChatsFilter('/chats?filter=working')).toBe('working');
    expect(parseChatsFilter('/chats?filter=made-up')).toBe('all');
  });
});
