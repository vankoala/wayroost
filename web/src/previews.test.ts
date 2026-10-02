import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AttachmentRef, TimelineItem } from '../../shared/protocol';
import { forgetPreviews, keepPreviews, movePreviews, previewsFor } from './previews';

const photo = (name: string, previewUrl?: string) => ({ name, ...(previewUrl ? { previewUrl } : {}) });
const user = (id: string, ...attachments: AttachmentRef[]): TimelineItem => ({ kind: 'user', id, text: '', attachments });
const image = (name: string): AttachmentRef => ({ name, kind: 'image' });
const text = (name: string): AttachmentRef => ({ name, kind: 'text' });

afterEach(() => vi.restoreAllMocks());

describe('previews of sent photos', () => {
  it('follow a message from its optimistic copy to the server copy', () => {
    const old = user('m1');
    keepPreviews('c1', 'pending-1', [photo('cat.png', 'blob:cat'), photo('notes.txt')], [old.id]);
    const pending = user('pending-1', image('cat.png'), text('notes.txt'));
    expect(previewsFor('c1', [old, pending]).get('pending-1')).toEqual(['blob:cat']);

    const confirmed = user('srv-9', image('cat.png'), text('notes.txt'));
    const shown = previewsFor('c1', [old, confirmed]);
    expect(shown.get('srv-9')).toEqual(['blob:cat']);
    expect(shown.has('pending-1')).toBe(false);
  });

  it('pair repeated names with the right messages', () => {
    keepPreviews('c2', 'pending-a', [photo('image.jpg', 'blob:first')], []);
    keepPreviews('c2', 'pending-b', [photo('image.jpg', 'blob:second'), photo('image.jpg', 'blob:third')], ['pending-a']);
    // Both server copies land in one update.
    const items = [user('s1', image('image.jpg')), user('s2', image('image.jpg'), image('image.jpg'))];
    const shown = previewsFor('c2', items);
    expect(shown.get('s1')).toEqual(['blob:first']);
    expect(shown.get('s2')).toEqual(['blob:second', 'blob:third']);
  });

  it('never land on a message that existed before the send', () => {
    const earlier = user('old', image('image.jpg'));
    keepPreviews('c3', 'pending-x', [photo('image.jpg', 'blob:new')], [earlier.id]);
    // A reload dropped the optimistic copy before the server's copy arrived.
    expect(previewsFor('c3', [earlier]).size).toBe(0);
    expect(previewsFor('c3', [earlier, user('fresh', image('image.jpg'))]).get('fresh')).toEqual(['blob:new']);
  });

  it('find the first message of a new conversation', () => {
    keepPreviews('c4', null, [photo('scan.png', 'blob:scan')], []);
    expect(previewsFor('c4', [user('first', image('scan.png'))]).get('first')).toEqual(['blob:scan']);
  });

  it('stop waiting for a match after a while', () => {
    keepPreviews('c5', null, [photo('late.png', 'blob:late')], [], 0);
    expect(previewsFor('c5', [user('u', image('late.png'))], 11 * 60_000).size).toBe(0);
  });

  it('can be forgotten or moved to a new conversation id', () => {
    keepPreviews('c6', 'pending-f', [photo('a.png', 'blob:a')], []);
    forgetPreviews('c6', 'pending-f');
    expect(previewsFor('c6', [user('pending-f', image('a.png'))]).size).toBe(0);

    keepPreviews('c7', 'pending-m', [photo('b.png', 'blob:b')], []);
    movePreviews('c7', 'c7-next');
    expect(previewsFor('c7-next', [user('s', image('b.png'))]).get('s')).toEqual(['blob:b']);
  });

  it('return the same array while nothing changed', () => {
    keepPreviews('c8', 'pending-s', [photo('s.png', 'blob:s')], []);
    const items = [user('pending-s', image('s.png'))];
    expect(previewsFor('c8', items).get('pending-s')).toBe(previewsFor('c8', [...items]).get('pending-s'));
  });

  it('keep at most 20 and revoke the oldest', () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    for (let i = 0; i < 25; i++) keepPreviews('c9', `pending-${i}`, [photo(`${i}.png`, `blob:${i}`)], []);
    expect(revoke).toHaveBeenCalledWith('blob:0');
    expect(revoke).toHaveBeenCalledWith('blob:4');
    expect(revoke).not.toHaveBeenCalledWith('blob:5');
    expect(previewsFor('c9', [user('pending-0', image('0.png'))]).size).toBe(0);
    expect(previewsFor('c9', [user('pending-24', image('24.png'))]).get('pending-24')).toEqual(['blob:24']);
  });
});
