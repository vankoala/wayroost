import { beforeAll, describe, expect, it } from 'vitest';
import type { PhoneStatus } from '../../shared/protocol.js';
import { UserFacingError } from '../src/sources.js';
import { apiHeaders, makeApp, makeKeys, makeToken, postHeaders, type Keys } from './helpers.js';

// Settings → Phone: Hermes Phone's status and PIN, through the helper. The PIN itself is only
// in GET /api/phone/pin (never in the status) and is not cached by the browser.

class FakePhone {
  pin: string | null = null;
  puts: string[] = [];
  down = false;
  async phone(): Promise<PhoneStatus> {
    if (this.down) throw new UserFacingError("Hermes Phone isn't running.", 503);
    return { running: true, ok: true, pinSet: this.pin !== null, ownerNumber: '+15550100000' };
  }
  async phonePin() {
    return { pin: this.pin };
  }
  async setPhoneVoice(voice: string) {
    return { voice };
  }
  async setPhonePin(pin: string) {
    this.puts.push(pin);
    this.pin = pin;
    return this.phone();
  }
}

describe('app: /api/phone', () => {
  let keys: Keys;
  let token: string;
  beforeAll(async () => {
    keys = await makeKeys();
    token = await makeToken(keys);
  });

  it('reports the line without the PIN, reveals it only on request, and never lets it be cached', async () => {
    const phone = new FakePhone();
    phone.pin = '4321';
    const { app } = await makeApp(keys, { phone });
    const status = await app.inject({ url: '/api/phone', headers: apiHeaders(token) });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({ running: true, ok: true, pinSet: true, ownerNumber: '+15550100000' });
    expect(status.body).not.toContain('4321');
    const pin = await app.inject({ url: '/api/phone/pin', headers: apiHeaders(token) });
    expect(pin.json()).toEqual({ pin: '4321' });
    expect(pin.headers['cache-control']).toBe('no-store');
    await app.close();
  });

  it('changes the PIN, and refuses anything but 4-12 digits', async () => {
    const phone = new FakePhone();
    const { app } = await makeApp(keys, { phone });
    const put = (body: unknown) =>
      app.inject({ method: 'PUT', url: '/api/phone/pin', headers: postHeaders(token), payload: JSON.stringify(body) });
    expect((await put({ pin: '24680' })).json()).toMatchObject({ pinSet: true });
    for (const body of [{ pin: '123' }, { pin: '12a45' }, { pin: 1234 }, { pin: '1234567890123' }, {}, { pin: '1234', x: 1 }]) {
      expect((await put(body)).statusCode).toBe(400);
    }
    expect(phone.puts).toEqual(['24680']);
    await app.close();
  });

  it('needs Access, says when the line is down, and is a 404 without a helper', async () => {
    const phone = new FakePhone();
    const { app } = await makeApp(keys, { phone });
    const noAccess = { ...apiHeaders(token) } as Record<string, string>;
    for (const k of Object.keys(noAccess)) if (/access/i.test(k)) delete noAccess[k];
    expect((await app.inject({ url: '/api/phone/pin', headers: noAccess })).statusCode).toBe(401);
    phone.down = true;
    expect((await app.inject({ url: '/api/phone', headers: apiHeaders(token) })).statusCode).toBe(503);
    await app.close();
    const bare = await makeApp(keys);
    expect((await bare.app.inject({ url: '/api/phone', headers: apiHeaders(token) })).statusCode).toBe(404);
    await bare.app.close();
  });
});
