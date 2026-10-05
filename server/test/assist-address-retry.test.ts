import { afterEach, expect, it, vi } from 'vitest';

// The writing helper talks to whichever local model is up. A laptop's model can move from one
// address to another between attempts, so an address that closes the connection without saying
// anything must not end the attempt — but a model that is slow, or that answers badly, is a live
// model, and trying somewhere else would only waste the person's time.

const FIRST = 'http://127.0.0.1:19031/v1';
const SECOND = 'http://127.0.0.1:19032/v1';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

const models = (id: string) => new Response(JSON.stringify({ data: [{ id }] }));
const answered = (text: string) => new Response(JSON.stringify({ choices: [{ message: { content: text } }] }));
const dropped = () => new TypeError('fetch failed', { cause: Object.assign(new Error('closed'), { code: 'ECONNRESET' }) });

async function assist() {
  vi.stubEnv('WAYROOST_ASSIST_URLS', `${FIRST},${SECOND}`);
  vi.stubEnv('SIGNALBOX_ASSIST_URLS', undefined);
  vi.resetModules();
  const { Assist } = await import('../src/assist.js');
  return new Assist();
}

const asked = (fetch: ReturnType<typeof vi.fn>) => fetch.mock.calls.map((call) => String(call[0]));

it('asks the next address when the first one closes the connection without answering', async () => {
  const fetch = vi.fn(async (url: string) => {
    if (url === `${FIRST}/models`) return models('model-one');
    if (url === `${FIRST}/chat/completions`) throw dropped();
    if (url === `${SECOND}/models`) return models('model-two');
    return answered('written by the second model');
  });
  vi.stubGlobal('fetch', fetch);
  expect(await (await assist()).complete([{ role: 'user', content: 'Describe it' }])).toBe('written by the second model');
  expect(asked(fetch)).toEqual([`${FIRST}/models`, `${FIRST}/chat/completions`, `${SECOND}/models`, `${SECOND}/chat/completions`]);
});

it('keeps the address that took over, so the next writing does not probe again', async () => {
  const fetch = vi.fn(async (url: string) => {
    if (url === `${FIRST}/models`) return models('model-one');
    if (url === `${FIRST}/chat/completions`) throw dropped();
    if (url === `${SECOND}/models`) return models('model-two');
    return answered('still here');
  });
  vi.stubGlobal('fetch', fetch);
  const assist1 = await assist();
  await assist1.complete([{ role: 'user', content: 'One' }]);
  fetch.mockClear();
  expect(await assist1.complete([{ role: 'user', content: 'Two' }])).toBe('still here');
  expect(asked(fetch)).toEqual([`${SECOND}/chat/completions`]);
});

it('reports a model that took too long without asking another address', async () => {
  const fetch = vi.fn(async (url: string) => {
    if (url === `${FIRST}/models`) return models('model-one');
    throw Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' });
  });
  vi.stubGlobal('fetch', fetch);
  const err = await (await assist()).complete([{ role: 'user', content: 'Describe it' }]).catch((e: Error) => e);
  expect(err).toMatchObject({ status: 504, message: "The local model didn't answer in time." });
  expect(asked(fetch)).toEqual([`${FIRST}/models`, `${FIRST}/chat/completions`]);
});

it('reports a model that answered badly without asking another address', async () => {
  const fetch = vi.fn(async (url: string) => {
    if (url === `${FIRST}/models`) return models('model-one');
    return new Response('busy', { status: 500 });
  });
  vi.stubGlobal('fetch', fetch);
  const err = await (await assist()).complete([{ role: 'user', content: 'Describe it' }]).catch((e: Error) => e);
  expect(err).toMatchObject({ status: 502, message: 'The local model refused (500).' });
  expect(asked(fetch)).toEqual([`${FIRST}/models`, `${FIRST}/chat/completions`]);
});

it('reports a model that stopped halfway through its answer, without asking another address', async () => {
  const fetch = vi.fn(async (url: string) =>
    url === `${FIRST}/models`
      ? models('model-one')
      : ({ ok: true, status: 200, json: async () => { throw dropped(); } }) as unknown as Response,
  );
  vi.stubGlobal('fetch', fetch);
  const err = await (await assist()).complete([{ role: 'user', content: 'Describe it' }]).catch((e: Error) => e);
  expect(err).toMatchObject({ status: 504, message: 'The local model stopped answering halfway through.' });
  expect(asked(fetch)).toEqual([`${FIRST}/models`, `${FIRST}/chat/completions`]);
});
