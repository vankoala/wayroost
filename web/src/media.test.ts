import { afterEach, describe, expect, it, vi } from 'vitest';
import { cachedMedia, isMediaUrl, loadMedia } from './media';

const link = (n: number | string) => `/api/media/hermes/20260927_080000_abcdef?p=L2hvbWUvbWUv${n}&s=sig-${n}`;
const png = () => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { headers: { 'content-type': 'image/png' } });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('isMediaUrl', () => {
  it('accepts only links shaped like the ones the server signs', () => {
    expect(isMediaUrl(link(1))).toBe(true);
    expect(isMediaUrl('/api/media/paseo/a%3Ab?p=eA&s=eQ')).toBe(true);
    expect(isMediaUrl('https://evil.example/api/media/hermes/a?p=x&s=y')).toBe(false);
    expect(isMediaUrl('/api/media/hermes/a?p=x&s=y&more=1')).toBe(false);
    expect(isMediaUrl('/api/conversations/hermes/a')).toBe(false);
  });
});

describe('loadMedia', () => {
  it('fetches once with the API marker and hands out a blob: URL', async () => {
    const fetch = vi.fn(async () => png());
    vi.stubGlobal('fetch', fetch);
    const [a, b] = await Promise.all([loadMedia(link('a')), loadMedia(link('a'))]);
    expect(a).toMatch(/^blob:/);
    expect(b).toBe(a);
    expect(cachedMedia(link('a'))).toBe(a);
    expect(fetch).toHaveBeenCalledTimes(1);
    const init = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(init[1].headers).toEqual({ 'x-signalbox-request': '1' });
  });

  it("shows the server's reason, and doesn't ask again right away", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ error: 'This image link has expired. Reopen the conversation.' }, { status: 404 }),
    );
    vi.stubGlobal('fetch', fetch);
    await expect(loadMedia(link('gone'))).rejects.toThrow('This image link has expired. Reopen the conversation.');
    await expect(loadMedia(link('gone'))).rejects.toThrow('expired');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('refuses anything that is not an image type', async () => {
    const create = vi.spyOn(URL, 'createObjectURL');
    vi.stubGlobal('fetch', async () => new Response('<script>alert(1)</script>', { headers: { 'content-type': 'text/html' } }));
    await expect(loadMedia(link('html'))).rejects.toThrow("isn't an image");
    expect(create).not.toHaveBeenCalled();
  });

  it('never fetches other URLs', async () => {
    const fetch = vi.fn(async () => png());
    vi.stubGlobal('fetch', fetch);
    await expect(loadMedia('https://evil.example/x.png')).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps about 30 and revokes the ones it drops', async () => {
    vi.stubGlobal('fetch', async () => png());
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const first = await loadMedia(link('lru-0'));
    for (let i = 1; i <= 40; i++) await loadMedia(link(`lru-${i}`));
    expect(revoke).toHaveBeenCalledWith(first);
    expect(cachedMedia(link('lru-0'))).toBeUndefined();
    expect(cachedMedia(link('lru-40'))).toMatch(/^blob:/);
  });
});
