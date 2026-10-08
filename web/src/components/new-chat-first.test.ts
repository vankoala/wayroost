// @vitest-environment jsdom
import { act, createElement as h, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateResponse, PaseoOptions, ProjectConfigReport } from '../../../shared/protocol.js';
import { api } from '../api';
import * as attachments from '../attach.js';
import * as previews from '../previews.js';
import { convKey, getState, setState } from '../store.js';
import { NewChatSheet } from './NewChatSheet';

// Starting something new: one box by default, the sheet of choices under "Advanced", what this
// device remembers between visits, and what the folder an agent is about to work in has to say.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
window.matchMedia = () =>
  ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList;

const connected = {
  hermes: { source: 'hermes' as const, state: 'connected' as const },
  paseo: { source: 'paseo' as const, state: 'connected' as const },
};
const paseoOptions: PaseoOptions = {
  providers: [{ id: 'claude', label: 'Claude Code', modes: [{ id: 'default', label: 'Always Ask' }], defaultModeId: 'default' }],
  workspaces: [{ path: '/home/me/code/webapp', label: 'webapp' }, { path: '/home/me/code/billing', label: 'billing' }],
};

let root: Root | null = null;
let host: HTMLElement | null = null;
let closed = 0;

beforeEach(() => {
  closed = 0;
  localStorage.clear();
  setState((s) => ({ ...s, statuses: connected, rollout: { settingsPages: true, revokes: true, chatFirst: true } }));
  vi.spyOn(api, 'hermesCommands').mockResolvedValue({ commands: [], runner: 'signalbox' });
  vi.spyOn(api, 'list').mockResolvedValue({ statuses: [connected.hermes, connected.paseo], conversations: [], approvals: [] });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.restoreAllMocks();
  history.replaceState(null, '', '/');
});

async function mount(props: Partial<Parameters<typeof NewChatSheet>[0]> = {}, strict = false): Promise<void> {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const sheet = h(NewChatSheet, { onClose: () => (closed += 1), ...props });
  await act(async () => root!.render(strict ? h(StrictMode, null, sheet) : sheet));
}

const on = (selector: string) => host!.querySelector(selector);
const all = (selector: string) => [...host!.querySelectorAll<HTMLElement>(selector)];
const button = (label: string) =>
  all('button').find((b) => b.textContent?.trim().startsWith(label)) as HTMLButtonElement | undefined;

async function type(text: string): Promise<void> {
  const box = on('textarea') as HTMLTextAreaElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, text);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function click(el: HTMLElement | undefined): Promise<void> {
  expect(el, 'expected to find this control').toBeDefined();
  await act(async () => el!.click());
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function attachPhoto(prepared?: Promise<attachments.PendingAttachment>) {
  const photo: attachments.PendingAttachment = {
    id: 'demo-photo', name: 'demo.png', mimeType: 'image/png', data: 'ZGVtbw==', size: 4, previewUrl: 'blob:demo-photo',
  };
  vi.spyOn(attachments, 'prepareFile').mockReturnValue(prepared ?? Promise.resolve(photo));
  const release = vi.spyOn(attachments, 'releasePreview').mockImplementation(() => {});
  await pickFiles([new File(['demo'], photo.name, { type: photo.mimeType })]);
  return { photo, release };
}

async function pickFiles(files: File[]): Promise<void> {
  const picker = on('input[type=file]') as HTMLInputElement;
  Object.defineProperty(picker, 'files', { value: files, configurable: true });
  await act(async () => picker.dispatchEvent(new Event('change', { bubbles: true })));
}

/** The sheet loads its choices first, then asks about the folder 500 ms after it settles. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 900));
  });
}

describe('the one box', () => {
  it('asks nothing but the message', async () => {
    await mount();
    expect(on('.segmented')).toBeNull(); // no Hermes-or-Paseo choice
    expect(on('select')).toBeNull(); // no model picker
    expect(on('input[aria-label="Folder for this Hermes chat"]')).toBeNull(); // no folder to name
    expect(on('textarea')?.getAttribute('placeholder')).toContain('Ask Hermes anything');
    expect(on('input[type=file]')).not.toBeNull(); // files go in as they always did
    expect(button('Advanced')).toBeDefined();
    expect(button('Start chat')!.disabled).toBe(true); // nothing said yet
  });

  it('starts a Hermes chat with nothing chosen, and opens it', async () => {
    const create = vi.spyOn(api, 'createHermes').mockResolvedValue({ source: 'hermes', id: 'fresh-chat' });
    await mount();
    await type('Which trains are late tonight?');
    await click(button('Start chat'));
    expect(create).toHaveBeenCalledWith({ text: 'Which trains are late tonight?', attachments: [] });
    expect(closed).toBe(1);
    expect(location.pathname).toBe('/c/hermes/fresh-chat');
  });

  it.each([
    { advanced: false, strict: false }, { advanced: true, strict: false },
    { advanced: false, strict: true }, { advanced: true, strict: true },
  ])('leaves a newer sheet open when a dismissed start succeeds (Advanced: $advanced, StrictMode: $strict)', async ({ advanced, strict }) => {
    if (advanced) localStorage.setItem('wayroost.newChat.advanced', '1');
    vi.spyOn(api, 'hermesOptions').mockResolvedValue({ models: [], defaultModel: null });
    const pending = deferred<CreateResponse>();
    vi.spyOn(api, 'createHermes').mockReturnValue(pending.promise);
    history.replaceState(null, '', '/chats');
    await mount({}, strict);
    await type('First chat');
    await click(button('Start chat'));
    await click(on('button[aria-label="Close"]') as HTMLButtonElement);
    await act(async () => root!.unmount());
    root = null;
    host!.remove();
    await mount({}, strict);
    await type('Draft for another chat');
    await act(async () => pending.resolve({ source: 'hermes', id: 'demo-dismissed-chat' }));
    expect(closed).toBe(1);
    expect(location.pathname).toBe('/chats');
    expect((on('textarea') as HTMLTextAreaElement).value).toBe('Draft for another chat');
    expect(api.list).toHaveBeenCalledTimes(1);
  });

  it.each([
    { advanced: false, failure: false }, { advanced: true, failure: false },
    { advanced: false, failure: true }, { advanced: true, failure: true },
  ])('disables photo removal until creation settles (Advanced: $advanced, failure: $failure)', async ({ advanced, failure }) => {
    if (advanced) localStorage.setItem('wayroost.newChat.advanced', '1');
    vi.spyOn(api, 'hermesOptions').mockResolvedValue({ models: [], defaultModel: null });
    const pending = deferred<CreateResponse>();
    vi.spyOn(api, 'createHermes').mockReturnValue(pending.promise);
    const keep = vi.spyOn(previews, 'keepPreviews');
    await mount({}, true);
    const { photo, release } = await attachPhoto();
    await click(button('Start chat'));
    const remove = on(`button[aria-label="Remove ${photo.name}"]`) as HTMLButtonElement;
    expect(remove.matches(':disabled')).toBe(true);
    await click(remove);
    expect(release).not.toHaveBeenCalled();
    expect(on('.attach-thumb')?.getAttribute('src')).toBe(photo.previewUrl);
    await act(async () => {
      if (failure) pending.reject(new Error('Chat could not be created'));
      else pending.resolve({ source: 'hermes', id: 'demo-removal-chat' });
    });
    if (failure) {
      expect(remove.matches(':disabled')).toBe(false);
      await click(remove);
      expect(release).toHaveBeenCalledExactlyOnceWith(photo);
      expect(on('.attach-thumb')).toBeNull();
      expect(keep).not.toHaveBeenCalled();
    } else {
      expect(keep).toHaveBeenCalledExactlyOnceWith(convKey('hermes', 'demo-removal-chat'), null, [photo], []);
      await act(async () => root!.unmount());
      root = null;
      expect(release).not.toHaveBeenCalled();
    }
  });

  it.each([
    { advanced: false, existing: false }, { advanced: true, existing: false },
    { advanced: false, existing: true }, { advanced: true, existing: true },
  ])('releases previews prepared after dismissal once (Advanced: $advanced, existing: $existing)', async ({ advanced, existing }) => {
    if (advanced) localStorage.setItem('wayroost.newChat.advanced', '1');
    vi.spyOn(api, 'hermesOptions').mockResolvedValue({ models: [], defaultModel: null });
    const pending = deferred<attachments.PendingAttachment>();
    await mount({}, true);
    const { photo, release } = await attachPhoto(existing ? undefined : pending.promise);
    const late = { ...photo, id: 'demo-late-photo', name: 'late.png', previewUrl: 'blob:demo-late-photo' };
    if (existing) {
      vi.mocked(attachments.prepareFile).mockReturnValue(pending.promise);
      await pickFiles([new File(['demo'], late.name, { type: late.mimeType })]);
    }
    await click(on('button[aria-label="Close"]') as HTMLButtonElement);
    await act(async () => root!.unmount());
    root = null;
    expect(release).toHaveBeenCalledTimes(existing ? 1 : 0);
    host!.remove();
    await mount({}, true);
    await type('A new draft');
    await act(async () => pending.resolve(late));
    expect(release.mock.calls.map(([file]) => file)).toEqual(existing ? [photo, late] : [late]);
    expect(on('.attach-thumb')).toBeNull();
    expect((on('textarea') as HTMLTextAreaElement).value).toBe('A new draft');
    await act(async () => root!.unmount());
    root = null;
    expect(release).toHaveBeenCalledTimes(existing ? 2 : 1);
  });

  it.each([false, true])('releases a partially prepared batch after dismissal (Advanced: %s)', async (advanced) => {
    if (advanced) localStorage.setItem('wayroost.newChat.advanced', '1');
    vi.spyOn(api, 'hermesOptions').mockResolvedValue({ models: [], defaultModel: null });
    const pending = deferred<attachments.PendingAttachment>();
    await mount({}, true);
    const { photo, release } = await attachPhoto();
    const first = { ...photo, id: 'demo-batch-first', name: 'first.png', previewUrl: 'blob:demo-batch-first' };
    const second = { ...photo, id: 'demo-batch-second', name: 'second.png', previewUrl: 'blob:demo-batch-second' };
    vi.mocked(attachments.prepareFile).mockResolvedValueOnce(first).mockReturnValueOnce(pending.promise);
    await pickFiles([first, second].map((file) => new File(['demo'], file.name, { type: file.mimeType })));
    expect(attachments.prepareFile).toHaveBeenCalledTimes(3);
    expect(on('.attach-name')?.textContent).toBe(photo.name);
    await act(async () => root!.unmount());
    root = null;
    expect(release.mock.calls.map(([file]) => file)).toEqual([photo]);
    await act(async () => pending.resolve(second));
    expect(release.mock.calls.map(([file]) => file)).toEqual([photo, first, second]);
  });

  it.each([false, true])('waits for photo preparation before starting (Advanced: %s)', async (advanced) => {
    if (advanced) localStorage.setItem('wayroost.newChat.advanced', '1');
    vi.spyOn(api, 'hermesOptions').mockResolvedValue({ models: [], defaultModel: null });
    const create = vi.spyOn(api, 'createHermes').mockResolvedValue({ source: 'hermes', id: 'prepared-photo-chat' });
    const pending = deferred<attachments.PendingAttachment>();
    await mount();
    await type('Describe this photo');
    const { photo } = await attachPhoto(pending.promise);
    expect(button('Start chat')!.disabled).toBe(true);
    await click(button('Start chat'));
    expect(create).not.toHaveBeenCalled();
    await act(async () => pending.resolve(photo));
    expect(button('Start chat')!.disabled).toBe(false);
    await click(button('Start chat'));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      text: 'Describe this photo', attachments: attachments.toUpload([photo]),
    }));
  });

  it.each([false, true])('allows starting after photo preparation fails (Advanced: %s)', async (advanced) => {
    if (advanced) localStorage.setItem('wayroost.newChat.advanced', '1');
    vi.spyOn(api, 'hermesOptions').mockResolvedValue({ models: [], defaultModel: null });
    const create = vi.spyOn(api, 'createHermes').mockResolvedValue({ source: 'hermes', id: 'text-only-chat' });
    const pending = deferred<attachments.PendingAttachment>();
    await mount();
    await type('Just the message');
    await attachPhoto(pending.promise);
    expect(button('Start chat')!.disabled).toBe(true);
    await act(async () => pending.reject(new Error('Photo could not be prepared')));
    expect(button('Start chat')!.disabled).toBe(false);
    await click(button('Start chat'));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ text: 'Just the message', attachments: [] }));
  });

  it.each([
    { advanced: false, strict: false }, { advanced: true, strict: false },
    { advanced: false, strict: true }, { advanced: true, strict: true },
  ])('keeps pending previews through dismissal (Advanced: $advanced, StrictMode: $strict)', async ({ advanced, strict }) => {
    if (advanced) localStorage.setItem('wayroost.newChat.advanced', '1');
    vi.spyOn(api, 'hermesOptions').mockResolvedValue({ models: [], defaultModel: null });
    const pending = deferred<CreateResponse>();
    vi.spyOn(api, 'createHermes').mockReturnValue(pending.promise);
    const keep = vi.spyOn(previews, 'keepPreviews');
    await mount({}, strict);
    const { photo, release } = await attachPhoto();
    await click(button('Start chat'));
    await click(on('button[aria-label="Close"]') as HTMLButtonElement);
    expect(closed).toBe(1);
    await act(async () => root!.unmount());
    root = null;
    expect(release).not.toHaveBeenCalled();
    expect(keep).not.toHaveBeenCalled();
    const id = `demo-pending-photo-${advanced}-${strict}`;
    await act(async () => pending.resolve({ source: 'hermes', id }));
    expect(keep).toHaveBeenCalledExactlyOnceWith(convKey('hermes', id), null, [photo], []);
    expect(previews.previewsFor(convKey('hermes', id), [
      { kind: 'user', id: 'demo-first-message', text: '', attachments: [{ kind: 'image', name: photo.name }] },
    ]).get('demo-first-message')).toEqual([photo.previewUrl]);
    expect(release).not.toHaveBeenCalled();
  });

  it.each([false, true])('releases dismissed previews once when creation fails (Advanced: %s)', async (advanced) => {
    if (advanced) localStorage.setItem('wayroost.newChat.advanced', '1');
    vi.spyOn(api, 'hermesOptions').mockResolvedValue({ models: [], defaultModel: null });
    const pending = deferred<CreateResponse>();
    vi.spyOn(api, 'createHermes').mockReturnValue(pending.promise);
    const keep = vi.spyOn(previews, 'keepPreviews');
    await mount({}, true);
    const { photo, release } = await attachPhoto();
    await click(button('Start chat'));
    await act(async () => root!.unmount());
    root = null;
    expect(release).not.toHaveBeenCalled();
    await act(async () => pending.reject(new Error('Chat could not be created')));
    expect(release).toHaveBeenCalledTimes(1);
    expect(release.mock.calls[0]![0]).toEqual(photo);
    expect(keep).not.toHaveBeenCalled();
  });

  it.each([false, true])('keeps previews for retry after creation fails while open (Advanced: %s)', async (advanced) => {
    if (advanced) localStorage.setItem('wayroost.newChat.advanced', '1');
    vi.spyOn(api, 'hermesOptions').mockResolvedValue({ models: [], defaultModel: null });
    const pending = deferred<CreateResponse>();
    const create = vi.spyOn(api, 'createHermes').mockReturnValueOnce(pending.promise)
      .mockResolvedValue({ source: 'hermes', id: 'demo-photo-retry' });
    await mount({}, true);
    const { photo, release } = await attachPhoto();
    await click(button('Start chat'));
    await act(async () => pending.reject(new Error('Chat could not be created')));
    expect(release).not.toHaveBeenCalled();
    expect(on('.attach-thumb')?.getAttribute('src')).toBe(photo.previewUrl);
    expect(button('Start chat')!.disabled).toBe(false);
    await click(button('Start chat'));
    expect(create).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ attachments: attachments.toUpload([photo]) }));
    await act(async () => root!.unmount());
    root = null;
    expect(release).not.toHaveBeenCalled();
  });

  it.each([false, true])('releases unsent previews on close after creation fails (Advanced: %s)', async (advanced) => {
    if (advanced) localStorage.setItem('wayroost.newChat.advanced', '1');
    vi.spyOn(api, 'hermesOptions').mockResolvedValue({ models: [], defaultModel: null });
    const pending = deferred<CreateResponse>();
    vi.spyOn(api, 'createHermes').mockReturnValue(pending.promise);
    await mount({}, true);
    const { photo, release } = await attachPhoto();
    await click(button('Start chat'));
    await act(async () => pending.reject(new Error('Chat could not be created')));
    expect(release).not.toHaveBeenCalled();
    await act(async () => root!.unmount());
    root = null;
    expect(release).toHaveBeenCalledTimes(1);
    expect(release.mock.calls[0]![0]).toEqual(photo);
  });

  it('says so when Hermes is not there to take it', async () => {
    setState((s) => ({
      ...s,
      statuses: { ...connected, hermes: { source: 'hermes', state: 'needs_credentials', message: 'Sign in to Hermes.' } },
    }));
    await mount();
    expect(on('.error-text')?.textContent).toContain('Sign in to Hermes.');
    expect(button('Start chat')!.disabled).toBe(true);
  });

  it('with only Paseo running there is no chat to offer, so the sheet shows', async () => {
    setState((s) => ({ ...s, statuses: { ...connected, hermes: { source: 'hermes', state: 'disabled' } } }));
    await mount();
    expect(on('.segmented')).not.toBeNull();
  });
});

describe('Advanced, and what this device remembers', () => {
  it('opens the sheet of choices and remembers it here', async () => {
    vi.spyOn(api, 'paseoOptions').mockResolvedValue(paseoOptions);
    await mount();
    await click(button('Advanced'));
    expect(on('.segmented')).not.toBeNull();
    expect(localStorage.getItem('wayroost.newChat.advanced')).toBe('1');
  });

  it('opens the sheet first the next time, without being asked again', async () => {
    vi.spyOn(api, 'paseoOptions').mockResolvedValue(paseoOptions);
    await mount();
    await click(button('Advanced'));
    await act(async () => root!.unmount());
    root = null;
    await mount();
    expect(on('.segmented')).not.toBeNull();
    expect(button('Advanced')).toBeUndefined();
    expect(button('Ask in one box instead')).toBeDefined();
  });

  it('goes back to the box, and remembers that too', async () => {
    await mount();
    await click(button('Advanced'));
    await click(button('Ask in one box instead'));
    expect(on('.segmented')).toBeNull();
    expect(on('textarea')?.getAttribute('placeholder')).toContain('Ask Hermes anything');
    expect(localStorage.getItem('wayroost.newChat.advanced')).toBe('0');
  });

  it('carries what was typed over to the sheet', async () => {
    vi.spyOn(api, 'paseoOptions').mockResolvedValue(paseoOptions);
    await mount();
    await type('Summarise the changelog');
    await click(button('Advanced'));
    expect((on('textarea') as HTMLTextAreaElement).value).toBe('Summarise the changelog');
  });

  it('keeps the current text and attachments through a complete round trip', async () => {
    vi.spyOn(api, 'paseoOptions').mockResolvedValue(paseoOptions);
    const create = vi.spyOn(api, 'createHermes').mockResolvedValue({ source: 'hermes', id: 'draft-chat' });
    await mount({ initialText: 'Original message' });
    await type('Message from the box');
    const { photo } = await attachPhoto();
    await click(button('Advanced'));
    expect((on('textarea') as HTMLTextAreaElement).value).toBe('Message from the box');
    expect(on('.attach-name')?.textContent).toBe(photo.name);
    await type('Message edited in Advanced');
    await click(button('Ask in one box instead'));
    expect((on('textarea') as HTMLTextAreaElement).value).toBe('Message edited in Advanced');
    expect(on('.attach-name')?.textContent).toBe(photo.name);
    await click(button('Start chat'));
    expect(create).toHaveBeenCalledWith({ text: 'Message edited in Advanced', attachments: attachments.toUpload([photo]) });
  });

  it('transfers live photo previews between views and releases them when the sheet closes', async () => {
    vi.spyOn(api, 'paseoOptions').mockResolvedValue(paseoOptions);
    await mount();
    const { photo, release } = await attachPhoto();
    await click(button('Advanced'));
    expect(on('.attach-thumb')?.getAttribute('src')).toBe(photo.previewUrl);
    expect(release).not.toHaveBeenCalled();
    await click(button('Ask in one box instead'));
    expect(on('.attach-thumb')?.getAttribute('src')).toBe(photo.previewUrl);
    expect(release).not.toHaveBeenCalled();
    await act(async () => root!.unmount());
    root = null;
    expect(release).toHaveBeenCalledTimes(1);
    expect(release.mock.calls[0]![0]).toEqual(photo);
  });

  it.each([false, true])('keeps previews through StrictMode handoffs and releases them once on close (Advanced: %s)', async (advanced) => {
    if (advanced) localStorage.setItem('wayroost.newChat.advanced', '1');
    vi.spyOn(api, 'hermesOptions').mockResolvedValue({ models: [], defaultModel: null });
    vi.spyOn(api, 'paseoOptions').mockResolvedValue(paseoOptions);
    await mount({}, true);
    const { photo, release } = await attachPhoto();
    for (const label of advanced ? ['Ask in one box instead', 'Advanced'] : ['Advanced', 'Ask in one box instead']) {
      await click(button(label));
      expect(on('.attach-thumb')?.getAttribute('src')).toBe(photo.previewUrl);
      expect(release).not.toHaveBeenCalled();
    }
    await act(async () => root!.unmount());
    root = null;
    expect(release).toHaveBeenCalledTimes(1);
    expect(release.mock.calls[0]![0]).toEqual(photo);
  });

  it.each([false, true])('keeps sent previews after a StrictMode handoff (Advanced: %s)', async (advanced) => {
    if (advanced) localStorage.setItem('wayroost.newChat.advanced', '1');
    vi.spyOn(api, 'hermesOptions').mockResolvedValue({ models: [], defaultModel: null });
    vi.spyOn(api, 'paseoOptions').mockResolvedValue(paseoOptions);
    vi.spyOn(api, 'createHermes').mockResolvedValue({ source: 'hermes', id: 'photo-chat' });
    await mount({}, true);
    const { release } = await attachPhoto();
    await click(button(advanced ? 'Ask in one box instead' : 'Advanced'));
    expect(release).not.toHaveBeenCalled();
    await click(button('Start chat'));
    expect(closed).toBe(1);
    await act(async () => root!.unmount());
    root = null;
    expect(release).not.toHaveBeenCalled();
  });

  it.each([false, true])('prevents switching views while a chat is being created (Advanced: %s)', async (advanced) => {
    if (advanced) localStorage.setItem('wayroost.newChat.advanced', '1');
    vi.spyOn(api, 'hermesOptions').mockResolvedValue({ models: [], defaultModel: null });
    vi.spyOn(api, 'paseoOptions').mockResolvedValue(paseoOptions);
    const pending = deferred<CreateResponse>();
    const create = vi.spyOn(api, 'createHermes').mockReturnValue(pending.promise);
    await mount();
    await type('Only one chat');
    await click(button('Start chat'));
    expect(create).toHaveBeenCalledTimes(1);
    const toggle = button(advanced ? 'Ask in one box instead' : 'Advanced')!;
    expect(toggle.disabled).toBe(true);
    await click(toggle);
    await click(button('Start chat'));
    expect(create).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve({ source: 'hermes', id: 'only-chat' }));
  });

  it('a folder to work in asks for the sheet, whichever view this device is on', async () => {
    vi.spyOn(api, 'paseoOptions').mockResolvedValue(paseoOptions);
    await mount({ initialCwd: '/home/me/code/webapp' });
    expect(on('.segmented')).not.toBeNull();
    expect(localStorage.getItem('wayroost.newChat.advanced')).toBeNull(); // not remembered: it was asked for
  });

  it('a Paseo agent asking for a new thread gets the sheet too', async () => {
    vi.spyOn(api, 'paseoOptions').mockResolvedValue(paseoOptions);
    await mount({ initialSource: 'paseo' });
    expect(on('.segmented')).not.toBeNull();
  });

  it('a device that cannot store anything still gets the box', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('Site data is blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Site data is blocked');
    });
    await mount();
    expect(on('textarea')?.getAttribute('placeholder')).toContain('Ask Hermes anything');
    expect(button('Advanced')).toBeDefined();
    await click(button('Advanced')); // switching still works, it just is not remembered
    expect(on('.segmented')).not.toBeNull();
  });
});

describe('what the folder says about itself', () => {
  beforeEach(() => {
    vi.spyOn(api, 'paseoOptions').mockResolvedValue(paseoOptions);
    vi.spyOn(api, 'folderStatus').mockResolvedValue({ status: 'exists' });
  });

  it('is shown before the agent starts, in plain words, with the files behind it', async () => {
    const report: ProjectConfigReport = {
      notices: [{ text: 'This folder has hooks Claude Code runs without asking.', files: ['.claude/hooks.json', '.claude/settings.json'] }],
    };
    const check = vi.spyOn(api, 'projectConfig').mockResolvedValue(report);
    await mount({ initialCwd: '/home/me/code/webapp', initialSource: 'paseo' });
    await settle();
    expect(check).toHaveBeenCalledWith('/home/me/code/webapp', 'claude');
    expect(on('.notice-card')?.textContent).toContain('This folder has hooks Claude Code runs without asking.');
    expect(on('.notice-card')?.textContent).toContain('.claude/hooks.json');
    expect(on('.notice-card')?.textContent).toContain('Only file names and findings are shown.');
    expect(on('.notice-card')?.textContent).not.toContain('reads the names, not the contents');
  });

  it('is asked again when the folder changes', async () => {
    const check = vi.spyOn(api, 'projectConfig').mockResolvedValue({ notices: [] });
    await mount({ initialCwd: '/home/me/code/webapp', initialSource: 'paseo' });
    await settle();
    expect(check).toHaveBeenCalledTimes(1);
    await click(all('[role="radio"]').find((b) => b.textContent?.includes('billing'))); // the other folder on offer
    await settle();
    expect(check).toHaveBeenLastCalledWith('/home/me/code/billing', 'claude');
  });

  it('does not stand between you and starting the agent', async () => {
    vi.spyOn(api, 'projectConfig').mockResolvedValue({ notices: [], unreadable: true });
    const launch = vi.spyOn(api, 'createPaseo').mockResolvedValue({ source: 'paseo', id: 'fresh-agent' });
    await mount({ initialCwd: '/home/me/code/webapp', initialSource: 'paseo' });
    await settle();
    expect(on('.notice-card')?.textContent).toContain('Some of it could not be read');
    await type('Tidy the tests');
    await click(button('Launch agent'));
    expect(launch).toHaveBeenCalled();
    expect(location.pathname).toBe('/c/paseo/fresh-agent');
  });

  it('scans before a fast launch and waits for the advice without blocking on findings', async () => {
    const pending = deferred<ProjectConfigReport>();
    const check = vi.spyOn(api, 'projectConfig').mockReturnValue(pending.promise);
    const launch = vi.spyOn(api, 'createPaseo').mockResolvedValue({ source: 'paseo', id: 'fast-agent' });
    await mount({ initialCwd: '/home/me/code/webapp', initialSource: 'paseo' });
    await type('Tidy the tests');
    await click(button('Launch agent'));
    expect(check).toHaveBeenCalledExactlyOnceWith('/home/me/code/webapp', 'claude');
    expect(launch).not.toHaveBeenCalled();
    await act(async () => pending.resolve({ notices: [{ text: 'This folder has hooks Claude Code runs without asking.', files: ['.claude/hooks.json'] }] }));
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('shares an in-flight advisory request with the launch and proceeds if it fails', async () => {
    const pending = deferred<ProjectConfigReport>();
    const check = vi.spyOn(api, 'projectConfig').mockReturnValue(pending.promise);
    const launch = vi.spyOn(api, 'createPaseo').mockResolvedValue({ source: 'paseo', id: 'unreadable-agent' });
    await mount({ initialCwd: '/home/me/code/webapp', initialSource: 'paseo' });
    await settle();
    await type('Tidy the tests');
    await click(button('Launch agent'));
    expect(check).toHaveBeenCalledTimes(1);
    expect(launch).not.toHaveBeenCalled();
    await act(async () => pending.reject(new Error('Advice unavailable')));
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('scans the current folder and provider if they change just before launch', async () => {
    vi.mocked(api.paseoOptions).mockResolvedValue({
      ...paseoOptions,
      providers: [...paseoOptions.providers, { id: 'codex', label: 'Codex', modes: [] }],
    });
    const check = vi.spyOn(api, 'projectConfig').mockResolvedValue({ notices: [] });
    const launch = vi.spyOn(api, 'createPaseo').mockResolvedValue({ source: 'paseo', id: 'changed-agent' });
    await mount({ initialCwd: '/home/me/code/webapp', initialSource: 'paseo' });
    await settle();
    await click(button('Codex'));
    await click(all('[role="radio"]').find((b) => b.textContent?.includes('billing')));
    await type('Tidy the tests');
    await click(button('Launch agent'));
    expect(check).toHaveBeenLastCalledWith('/home/me/code/billing', 'codex');
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/home/me/code/billing', providerId: 'codex' }));
  });

  it('scans again after creating a folder and ignores the earlier unreadable result', async () => {
    const path = '/home/me/code/new-app';
    vi.mocked(api.folderStatus).mockResolvedValue({ status: 'missing' });
    const mkdir = vi.spyOn(api, 'createFolder').mockResolvedValue({ path });
    const old = deferred<ProjectConfigReport>();
    const check = vi.spyOn(api, 'projectConfig').mockReturnValueOnce(old.promise).mockResolvedValue({ notices: [] });
    const pending = deferred<CreateResponse>();
    const launch = vi.spyOn(api, 'createPaseo').mockReturnValue(pending.promise);
    await mount({ initialCwd: path, initialSource: 'paseo' });
    await settle();
    await type('Tidy the tests');
    await click(button('Launch agent'));
    expect(mkdir).toHaveBeenCalledWith(path);
    expect(check).toHaveBeenCalledTimes(2);
    expect(launch).toHaveBeenCalledTimes(1);
    await act(async () => old.resolve({ notices: [], unreadable: true }));
    expect(on('.notice-card')).toBeNull();
    await act(async () => pending.resolve({ source: 'paseo', id: 'new-folder-agent' }));
  });

  it('reports a failed advisory request as unreadable and keeps launch available', async () => {
    vi.spyOn(api, 'projectConfig').mockRejectedValue(new Error('Advice unavailable'));
    await mount({ initialCwd: '/home/me/code/webapp', initialSource: 'paseo' });
    await settle();
    expect(on('.notice-card')?.textContent).toContain('Some of it could not be read');
    await type('Tidy the tests');
    expect(button('Launch agent')!.disabled).toBe(false);
  });

  it.each([false, true])('ignores a stale advisory response after the folder changes (failure: %s)', async (failure) => {
    const pending = deferred<ProjectConfigReport>();
    vi.spyOn(api, 'projectConfig').mockReturnValueOnce(pending.promise).mockResolvedValue({ notices: [] });
    await mount({ initialCwd: '/home/me/code/webapp', initialSource: 'paseo' });
    await settle();
    await click(all('[role="radio"]').find((b) => b.textContent?.includes('billing')));
    await settle();
    await act(async () => {
      if (failure) pending.reject(new Error('Advice unavailable'));
      else pending.resolve({ notices: [{ text: 'Old folder warning.', files: ['.claude/hooks.json'] }] });
    });
    expect(on('.notice-card')).toBeNull();
  });

  it('says nothing about a folder with nothing to say', async () => {
    vi.spyOn(api, 'projectConfig').mockResolvedValue({ notices: [] });
    await mount({ initialCwd: '/home/me/code/webapp', initialSource: 'paseo' });
    await settle();
    expect(on('.notice-card')).toBeNull();
  });

  it('is not asked for a Hermes chat', async () => {
    const check = vi.spyOn(api, 'projectConfig').mockResolvedValue({ notices: [] });
    vi.spyOn(api, 'hermesOptions').mockResolvedValue({ models: [], defaultModel: null });
    await mount({ initialCwd: '/home/me/code/webapp', initialSource: 'hermes' });
    await settle();
    expect(check).not.toHaveBeenCalled();
  });
});


describe('site new-chat default', () => {
  it.each([false, true])('uses chatFirst=%s when this device has no saved preference', async chatFirst => {
    setState(s => ({ ...s, rollout: { settingsPages: true, revokes: true, chatFirst } }));
    vi.spyOn(api, 'paseoOptions').mockResolvedValue(paseoOptions);
    await mount();
    expect(!!on('.advanced-toggle')).toBe(chatFirst);
    expect(!!on('.basic-toggle')).toBe(!chatFirst);
  });

  it.each([false, true])('a saved Basic choice wins over chatFirst=%s', async chatFirst => {
    localStorage.setItem('wayroost.newChat.advanced', '0');
    setState(s => ({ ...s, rollout: { settingsPages: true, revokes: true, chatFirst } }));
    await mount();
    expect(on('.advanced-toggle')).not.toBeNull();
  });
});
