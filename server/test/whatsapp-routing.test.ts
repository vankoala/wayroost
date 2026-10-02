import { beforeAll, describe, expect, it } from 'vitest';
import type { WhatsAppRouting } from '../../shared/protocol.js';
import { UserFacingError } from '../src/sources.js';
import { apiHeaders, makeApp, makeKeys, makeToken, postHeaders, type Keys } from './helpers.js';

// Settings → WhatsApp: the whatsapp-routing Hermes plugin's settings, which the
// helper reads and writes as the Hermes user.

class FakeHelper {
  wa: WhatsAppRouting = { installed: true, active: true, replyRouting: true, returnMinutes: 30, freshAfterHours: 4 };
  puts: unknown[] = [];
  down = false;
  async whatsappRouting() {
    if (this.down) throw new UserFacingError("The Signalbox helper isn't running on the PC.", 503);
    return { ...this.wa };
  }
  async setWhatsappRouting(settings: Omit<WhatsAppRouting, 'installed' | 'active'>) {
    this.puts.push(settings);
    this.wa = { ...this.wa, ...settings };
    return { ...this.wa };
  }
}

describe('app: /api/whatsapp-routing', () => {
  let keys: Keys;
  let token: string;
  beforeAll(async () => {
    keys = await makeKeys();
    token = await makeToken(keys);
  });

  const put = (app: Awaited<ReturnType<typeof makeApp>>['app'], body: unknown, headers = postHeaders(token)) =>
    app.inject({ method: 'PUT', url: '/api/whatsapp-routing', headers, payload: JSON.stringify(body) });

  it('reads the settings', async () => {
    const helper = new FakeHelper();
    const { app } = await makeApp(keys, { whatsappRouting: helper });
    const res = await app.inject({ url: '/api/whatsapp-routing', headers: apiHeaders(token) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(helper.wa);
    await app.close();
  });

  it('saves a change and answers with the new settings', async () => {
    const helper = new FakeHelper();
    const { app } = await makeApp(keys, { whatsappRouting: helper });
    const res = await put(app, { replyRouting: false, returnMinutes: 60, freshAfterHours: 0 });
    expect(res.statusCode).toBe(200);
    expect(helper.puts).toEqual([{ replyRouting: false, returnMinutes: 60, freshAfterHours: 0 }]);
    expect(res.json()).toMatchObject({ replyRouting: false, returnMinutes: 60, freshAfterHours: 0, active: true });
    await app.close();
  });

  it('refuses values outside the choices, extra fields, and requests without Access', async () => {
    const helper = new FakeHelper();
    const { app } = await makeApp(keys, { whatsappRouting: helper });
    for (const body of [
      { replyRouting: 'no', returnMinutes: 30, freshAfterHours: 4 },
      { replyRouting: true, returnMinutes: 31, freshAfterHours: 4 },
      { replyRouting: true, returnMinutes: 30, freshAfterHours: 5 },
      { replyRouting: true, returnMinutes: 30 },
      { replyRouting: true, returnMinutes: 30, freshAfterHours: 4, installed: false },
    ]) {
      expect((await put(app, body)).statusCode).toBe(400);
    }
    const noAccess = { ...postHeaders(token) } as Record<string, string>;
    for (const k of Object.keys(noAccess)) if (/access/i.test(k)) delete noAccess[k];
    expect((await put(app, { replyRouting: false, returnMinutes: 30, freshAfterHours: 4 }, noAccess)).statusCode).toBe(401);
    expect(helper.puts).toEqual([]);
    await app.close();
  });

  it("says so when the helper isn't running, and is a 404 without one", async () => {
    const helper = new FakeHelper();
    helper.down = true;
    const { app } = await makeApp(keys, { whatsappRouting: helper });
    const res = await app.inject({ url: '/api/whatsapp-routing', headers: apiHeaders(token) });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/helper isn't running/);
    await app.close();

    const bare = await makeApp(keys);
    expect((await bare.app.inject({ url: '/api/whatsapp-routing', headers: apiHeaders(token) })).statusCode).toBe(404);
    await bare.app.close();
  });
});
