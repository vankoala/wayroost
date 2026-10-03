import { describe, expect, it } from 'vitest';
import { supportedCommand } from '../../shared/command-grammar';

describe('Git command grammar', () => {
  it.each(Object.getOwnPropertyNames(Object.prototype))('rejects inherited subcommands: %s', (subcommand) => {
    expect(supportedCommand('git', [subcommand])).toBe(false);
    expect(supportedCommand('git', [subcommand, '--', 'demo.txt'])).toBe(false);
  });

  it.each(['status', 'diff', 'log', 'show'])('accepts recognised subcommands: %s', (subcommand) => {
    expect(supportedCommand('git', [subcommand])).toBe(true);
  });
});

describe('printf command grammar', () => {
  it.each([
    '%s\\n', '%s bytes', '%%n', '%%b', '%%(demo)T', '%%%s\\n',
    '%s %d %08x %.2f', '%-10s bytes', '%*.*f', '%s %unknown', 'plain text',
  ])('recognises conversions separately from literal format text: %s', (format) => {
    expect(supportedCommand('printf', [format, 'demo'])).toBe(true);
  });

  it.each([
    '%n', '%b', '%(demo)T', '%s%n', '%s %b', '%%%n', '%%%b', '%%%(%s)T',
    '%10n', '%-8b', '%*b', '%s %zunknown', '%', '%10', '-v',
  ])('rejects interpreting or unsupported conversions: %s', (format) => {
    expect(supportedCommand('printf', [format, 'demo'])).toBe(false);
  });

  it('bounds the time needed to reject long interpreting conversions', () => {
    const started = performance.now();
    expect(supportedCommand('printf', ['%' + '0'.repeat(59000) + 'n', 'demo'])).toBe(false);
    expect(supportedCommand('printf', ['%.' + '0'.repeat(59000) + 'b', 'demo'])).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
