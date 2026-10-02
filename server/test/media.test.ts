import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ServerEvent } from '../../shared/protocol.js';
import { MediaLinks, localImagePath, mediaPathProblem } from '../src/media.js';
import { apiHeaders, makeApp, makeKeys, makeToken, type Keys } from './helpers.js';

let keys: Keys;
let token: string;
const cleanups: Array<() => Promise<unknown>> = [];

beforeAll(async () => {
  keys = await makeKeys();
  token = await makeToken(keys);
});

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe('local image links', () => {
  it('recognizes local image paths as agents write them', () => {
    expect(localImagePath('/home/me/Pictures/garden.png')).toBe('/home/me/Pictures/garden.png');
    expect(localImagePath('~/Pictures/garden.JPG')).toBe('~/Pictures/garden.JPG');
    expect(localImagePath('file:///home/me/My%20Photos/cat.webp')).toBe('/home/me/My Photos/cat.webp');
    expect(localImagePath('</home/me/My Photos/cat.gif>')).toBe('/home/me/My Photos/cat.gif');
    expect(localImagePath('/mnt/c/Users/me/Desktop/shot.jpeg')).toBe('/mnt/c/Users/me/Desktop/shot.jpeg');
    for (const not of [
      'https://example.com/a.png', // remote images stay links
      'Pictures/garden.png', // relative
      '/home/me/.ssh/id_ed25519', // not an image
      '/home/me/notes.svg', // SVG can carry scripts
      '/api/conversations/hermes/x.png', // our own API
      'file://evil.example/share/a.png',
      '/home/me/bad%zz.png',
    ]) {
      expect(localImagePath(not), not).toBeNull();
    }
  });

  it('signs only images in agent replies, for one conversation', () => {
    const links = new MediaLinks();
    const text = 'Look: ![garden](/home/me/garden.png "Spring") and ![logo](https://example.com/l.png) and `/home/me/x.png`';
    const out = links.rewrite('hermes', 's1', text);
    const url = /\]\((\/api\/media\/hermes\/s1\?p=[^&]+&s=[^ )]+) "Spring"\)/.exec(out)?.[1];
    expect(url).toBeDefined();
    expect(out).toContain('![logo](https://example.com/l.png)');
    expect(out).toContain('`/home/me/x.png`');

    const query = new URL(url!, 'https://x').searchParams;
    expect(links.verify('hermes', 's1', query.get('p')!, query.get('s')!)).toBe('/home/me/garden.png');
    expect(links.verify('hermes', 's2', query.get('p')!, query.get('s')!)).toBeNull();
    expect(links.verify('paseo', 's1', query.get('p')!, query.get('s')!)).toBeNull();
    const other = Buffer.from('/home/me/.ssh/id_ed25519').toString('base64url');
    expect(links.verify('hermes', 's1', other, query.get('s')!)).toBeNull();
    expect(new MediaLinks().verify('hermes', 's1', query.get('p')!, query.get('s')!)).toBeNull(); // another process
  });
});

describe('where images may come from', () => {
  it('never reads system, credential or agent-store folders', () => {
    for (const blocked of [
      '/etc/ssl/logo.png',
      '/root/x.png',
      '/var/lib/signalbox/x.png',
      '/proc/self/x.png',
      '~/.ssh/id.png',
      '/home/me/.config/app/icon.png',
      '/home/me/pics/../../../etc/x.png',
      '~/.hermes/sessions/s.png',
      '~/.hermes/browser-profile/Default/a.png',
      '~/.hermes/cache/bws_cache.png',
      '~/.hermes/profiles/work/sessions/a.png',
      '/home/me/.paseo/agents/a.png',
    ]) {
      expect(mediaPathProblem(blocked), blocked).not.toBeNull();
    }
    for (const allowed of [
      '/home/me/Pictures/garden.png',
      '~/Desktop/shot.jpg',
      '~/.hermes/images/upload_1.png',
      '~/.hermes/screenshots/page.png',
      '~/.hermes/profiles/work/cache/mcp/a.webp',
      '/home/me/.paseo/uploads/abc/photo.jpg',
      '/tmp/paseo-attachments-x1/abc.png',
      '/mnt/c/Users/me/Pictures/a.gif',
    ]) {
      expect(mediaPathProblem(allowed), allowed).toBeNull();
    }
  });
});

describe('finding images in replies and tools', () => {
  const links = new MediaLinks();
  const names = (media: Array<{ name: string }>) => media.map((m) => m.name);

  it('shows images however the agent names them, once each', () => {
    const { text, media } = links.assistant(
      'hermes',
      's1',
      [
        'Here you go: MEDIA:/home/me/Pictures/garden.png',
        'Also [the chart](/home/me/out/chart.webp) and `~/Desktop/shot.jpg`.',
        'Inline: ![logo](/home/me/logo.png) and again /home/me/Pictures/garden.png',
        'Not these: https://example.com/a.png, ./rel.png, /etc/passwd.png, /home/me/notes.txt',
        '```',
        '/home/me/build/output/sprite.png',
        '```',
      ].join('\n'),
    );
    expect(names(media)).toEqual(['garden.png', 'chart.webp', 'shot.jpg']);
    expect(text).toContain('Here you go: garden.png');
    expect(text).toMatch(/!\[logo\]\(\/api\/media\/hermes\/s1\?p=/); // inline stays inline
    expect(text).toContain('/home/me/build/output/sprite.png'); // code is left alone
    expect(media.every((m) => m.url.startsWith('/api/media/hermes/s1?p='))).toBe(true);
  });

  it('caps previews per message', () => {
    const many = Array.from({ length: 9 }, (_, i) => `/home/me/p${i}.png`).join(' ');
    expect(links.assistant('paseo', 'a1', many).media).toHaveLength(4);
  });

  it('finds images tools looked at or made', () => {
    expect(names(links.tool('hermes', 's1', '{\n  "image_url": "~/Pictures/garden.png",\n  "question": "what?"\n}', 'A garden'))).toEqual([
      'garden.png',
    ]);
    expect(names(links.tool('hermes', 's1', undefined, '{"success":true,"host_image":"/home/me/.hermes/cache/images/gen.png"}'))).toEqual([
      'gen.png',
    ]);
    expect(names(links.tool('hermes', 's1', undefined, 'Saved. MEDIA:/home/me/.hermes/screenshots/page.png'))).toEqual(['page.png']);
    expect(links.tool('hermes', 's1', '{"path":"/home/me/app/main.ts"}', 'ok')).toEqual([]);
    expect(links.tool('hermes', 's1', '{"path":"/home/me/.ssh/key.png"}', 'ok')).toEqual([]);
  });

  it('keeps media the item already had', () => {
    const [item] = links.items('hermes', 's1', [
      { kind: 'assistant', id: 'a', text: 'see /home/me/b.png', media: [{ url: '/x', name: 'a.png' }] },
    ]);
    expect(names((item as { media: Array<{ name: string }> }).media)).toEqual(['a.png', 'b.png']);
  });
});

describe('media route', () => {
  async function setup() {
    const ctx = await makeApp(keys);
    cleanups.push(() => ctx.app.close());
    return ctx;
  }

  it('serves images the agent showed, and nothing else', async () => {
    const { app, hermes } = await setup();
    const detail = (await app.inject({ url: '/api/conversations/hermes/with-image', headers: apiHeaders(token) })).json();
    const url = /\]\(([^)]+)\)/.exec(detail.items[0].text)?.[1];
    expect(url).toMatch(/^\/api\/media\/hermes\/with-image\?p=/);

    const res = await app.inject({ url: url!, headers: apiHeaders(token) });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(hermes.calls).toContain('image:with-image:/home/me/Pictures/garden.png');

    // A path the server never signed, or a signed link used elsewhere, is refused before any backend call.
    const p = Buffer.from('/etc/passwd.png').toString('base64url');
    const forged = await app.inject({ url: `/api/media/hermes/with-image?p=${p}&s=${'A'.repeat(43)}`, headers: apiHeaders(token) });
    expect(forged.statusCode).toBe(404);
    const moved = await app.inject({ url: url!.replace('/with-image?', '/other?'), headers: apiHeaders(token) });
    expect(moved.statusCode).toBe(404);
    expect(hermes.calls.filter((c) => c.startsWith('image:'))).toHaveLength(1);

    // Same API rules as everything else: no marker header, no image.
    const noMarker = await app.inject({ url: url!, headers: { ...apiHeaders(token), 'x-signalbox-request': '' } });
    expect(noMarker.statusCode).toBe(403);
  });

  it('signs links in live replies too, and refuses files that are not really images', async () => {
    const { app, hub } = await setup();
    const events: ServerEvent[] = [];
    const socket = { readyState: 1, bufferedAmount: 0, send: (p: string) => events.push(JSON.parse(p)), terminate() {} };
    hub.subscribe(hub.add(socket as never, 'owner@example.com'), 'hermes', 'c1');
    hub.publish({
      type: 'items_upsert',
      source: 'hermes',
      conversationId: 'c1',
      items: [{ kind: 'assistant', id: 'a', text: '![x](/home/me/fake.png)' }],
    });
    const item = (events[0] as Extract<ServerEvent, { type: 'items_upsert' }>).items[0] as { text: string };
    const url = /^!\[x\]\((\/api\/media\/hermes\/c1\?p=[^)]+)\)$/.exec(item.text)?.[1];
    expect(url).toBeDefined();

    // The fake backend hands back a shell script for this ".png".
    const res = await app.inject({ url: url!, headers: apiHeaders(token) });
    expect(res.statusCode).toBe(415);
    expect(res.body).not.toContain('echo');
  });
});
