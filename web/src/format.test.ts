import { describe, expect, it } from 'vitest';
import { folderPath, homeFolder } from './format';

describe('folder prefill', () => {
  it('finds the home folder the chats and projects use most', () => {
    expect(homeFolder(['/home/me/app', '/home/me/site', '/home/other/x', undefined, '/tmp/y', '/home/me'])).toBe('/home/me/');
    expect(homeFolder(['/home/menu-thing/app'])).toBe('/home/menu-thing/');
    expect(homeFolder([undefined, '/opt/x', '/homework/a'])).toBeUndefined();
  });

  it('drops the trailing slash a prefill leaves', () => {
    expect(folderPath(' /home/me/ ')).toBe('/home/me');
    expect(folderPath('/home/me/app//')).toBe('/home/me/app');
    expect(folderPath('/')).toBe('/');
    expect(folderPath('')).toBe('');
  });
});
