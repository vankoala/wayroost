import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./store', () => ({ toast: vi.fn() }));

import { droppedFiles, onDragOver, onDrop, registerDropTarget, type DropTarget } from './drop';
import { toast } from './store';

const file = (name: string) => new File(['x'], name, { type: 'text/plain' });
const item = (f: File | null, directory = false) => ({
  kind: 'file',
  getAsFile: () => f,
  webkitGetAsEntry: () => ({ isDirectory: directory }),
});
function drag(items: unknown[], types = ['Files']) {
  const dataTransfer = { types, items, files: [], dropEffect: 'copy' };
  return { event: { dataTransfer, preventDefault: vi.fn() } as never as Parameters<typeof onDrop>[0], dataTransfer };
}
function place(refusal: string | null = null) {
  const take = vi.fn();
  const entry = { current: { label: 'Drop here', refusal, take } satisfies DropTarget };
  return { take, entry, unregister: registerDropTarget(entry) };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((c) => c());
  vi.mocked(toast).mockClear();
});

describe('dropping files on the page', () => {
  it('hands them to the newest place that takes files', () => {
    const chat = place();
    const sheet = place();
    cleanups.push(chat.unregister);
    const notes = file('notes.md');
    onDrop(drag([item(notes)]).event);
    expect(sheet.take).toHaveBeenCalledWith([notes]);
    expect(chat.take).not.toHaveBeenCalled();

    sheet.unregister(); // the sheet closed
    onDrop(drag([item(notes)]).event);
    expect(chat.take).toHaveBeenCalledWith([notes]);
  });

  it('refuses where nothing takes files, so the browser never opens them instead', () => {
    const nowhere = drag([item(file('a.txt'))]);
    onDragOver(nowhere.event);
    expect(nowhere.event.preventDefault).toHaveBeenCalled();
    expect(nowhere.dataTransfer.dropEffect).toBe('none');
    onDrop(nowhere.event);

    const readOnly = place("Files can't be added to this chat.");
    cleanups.push(readOnly.unregister);
    const refused = drag([item(file('a.txt'))]);
    onDragOver(refused.event);
    expect(refused.dataTransfer.dropEffect).toBe('none');
    onDrop(refused.event);
    expect(refused.event.preventDefault).toHaveBeenCalled();
    expect(readOnly.take).not.toHaveBeenCalled();
  });

  it('leaves drags without files alone', () => {
    const chat = place();
    cleanups.push(chat.unregister);
    const text = drag([], ['text/plain']);
    onDragOver(text.event);
    onDrop(text.event);
    expect(text.event.preventDefault).not.toHaveBeenCalled();
    expect(chat.take).not.toHaveBeenCalled();
  });

  it('skips folders and says why', () => {
    const chat = place();
    cleanups.push(chat.unregister);
    const photo = file('photo.png');
    onDrop(drag([item(photo), item(null, true), { kind: 'string' }]).event);
    expect(chat.take).toHaveBeenCalledWith([photo]);
    expect(toast).toHaveBeenCalledWith("A folder can't be attached. Drop the files inside instead.");
  });

  it('falls back to the file list where the browser gives no items', () => {
    const f = file('a.txt');
    expect(droppedFiles({ items: [] as never, files: [f] as never })).toEqual({ files: [f], folders: 0 });
  });
});
