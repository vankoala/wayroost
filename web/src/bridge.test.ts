import { describe, expect, it } from 'vitest';
import { bridgeEnvelope, parseBridgeEnvelope } from '../../shared/protocol';
import { readableBridgeText } from './bridge';

const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const sender = 'Fix flaky login test (Claude Code)';
const envelope = bridgeEnvelope(sender, 'Can you skim the release notes for session fixes?');

describe('readableBridgeText', () => {
  it('reads a whole envelope as sender and text', () => {
    expect(readableBridgeText(oneLine(envelope, 1000))).toBe(`${sender}: Can you skim the release notes for session fixes?`);
  });

  it('names the sender when the server cut the text off (Hermes previews stop at 140)', () => {
    expect(readableBridgeText(oneLine(envelope, 140))).toBe(`Message from ${sender}`);
  });

  it('copes with a title cut off inside the sender or the "via"', () => {
    expect(readableBridgeText(oneLine(envelope, 40))).toBe('Message from Fix flaky login test (Cla…');
    expect(readableBridgeText(oneLine(envelope, 52))).toBe(`Message from ${sender}`);
    expect(readableBridgeText(oneLine(envelope, 58))).toBe(`Message from ${sender}`);
  });

  it('leaves everything else alone', () => {
    expect(readableBridgeText('Fix the [Message from] parser')).toBe('Fix the [Message from] parser');
    expect(readableBridgeText(undefined)).toBeUndefined();
  });

  it('agrees with the protocol parser on whole messages', () => {
    expect(parseBridgeEnvelope(envelope)).toEqual({ sender, text: 'Can you skim the release notes for session fixes?' });
    expect(parseBridgeEnvelope('[Message from someone] hi')).toBeNull();
  });
});
