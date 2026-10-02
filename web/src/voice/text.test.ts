import { describe, expect, it } from 'vitest';
import { completeSentences, hasWord, MAX_CHUNK, speakable, speechPieces, splitSentences } from './text';

// Sentence cases ported with those rules.

const TRICKY = [
  'Hi Mr. Smith. The U.S. oven is 2.4GHz. Tonight: chicken, rice. Enjoy!',
  'He said "Go. Now." Then left. (a pinch. Or two.) now. Ok.',
  'Run `ls. -la` then. Shopping:\n- eggs\n* milk\n\nDone? Yes!',
  'Use 1.5 cups, e.g. flour; bake at 180. Then rest — 10:30 is fine.',
];

/** Feed a reply one character at a time, the way it streams in. */
function stream(text: string): [string[], string] {
  const pieces: string[] = [];
  let rest = '';
  for (const ch of text) {
    const [ready, remainder] = completeSentences(rest + ch);
    if (ready) pieces.push(ready);
    rest = remainder;
  }
  return [pieces, rest];
}

describe('splitSentences', () => {
  it.each(['Mr.', 'Dr.', 'e.g.', 'i.e.', 'U.S.', 'etc.', 'vs.', 'Jan.'])('never splits after %s', (abbr) => {
    expect(splitSentences(`We met ${abbr} Smith today. Then we left.`)).toEqual([`We met ${abbr} Smith today.`, 'Then we left.']);
  });

  it.each(['1.5', '99.9%', '4:3', '2.4GHz', '10:30', '0.25'])('never splits numbers like %s', (num) => {
    expect(splitSentences(`Use ${num} here please. Next one.`)).toEqual([`Use ${num} here please.`, 'Next one.']);
  });

  it('cuts at terminals, blank lines and bullets, but not at a plain newline', () => {
    expect(splitSentences('One. Two! Three? Four')).toEqual(['One.', 'Two!', 'Three?', 'Four']);
    expect(splitSentences('Visit example.com/a.b today.')).toEqual(['Visit example.com/a.b today.']);
    expect(splitSentences('Shopping:\n- eggs\n* milk\n• bread and  butter')).toEqual([
      'Shopping:',
      '- eggs',
      '* milk',
      '• bread and  butter',
    ]);
    expect(splitSentences('first line\nsecond line')).toEqual(['first line\nsecond line']);
    expect(splitSentences('Para one\n\nPara two')).toEqual(['Para one', 'Para two']);
  });

  it("doesn't cut inside quotes, brackets, links or code", () => {
    expect(splitSentences('He said "Go. Now." Then left.')).toEqual(['He said "Go. Now."', 'Then left.']);
    expect(splitSentences('Add salt (a pinch. Or two.) now. Next.')).toEqual(['Add salt (a pinch. Or two.) now.', 'Next.']);
    expect(splitSentences('See [the guide. Part 1](http://a.b/c. d) now. Ok.')).toEqual([
      'See [the guide. Part 1](http://a.b/c. d) now.',
      'Ok.',
    ]);
    expect(splitSentences('Run `ls. -la` then. Ok.')).toEqual(['Run `ls. -la` then.', 'Ok.']);
    expect(splitSentences('She said “Hi. Bye.” Then went.')).toEqual(['She said “Hi. Bye.”', 'Then went.']);
  });

  it('splits long sentences at a comma, a semicolon or dash, a space, or hard', () => {
    const commas = `${Array(80).fill('word').join(', ')}.`;
    const chunks = splitSentences(commas);
    expect(chunks.every((c) => c.length <= MAX_CHUNK)).toBe(true);
    expect(chunks[0]!.endsWith(',')).toBe(true);
    expect(chunks[0]!.length).toBeGreaterThan(200);
    expect(chunks.join(' ')).toBe(commas);
    expect(splitSentences(`${'a'.repeat(100)}; ${'b'.repeat(100)}— ${'c'.repeat(100)}`)).toEqual([
      `${'a'.repeat(100)}; ${'b'.repeat(100)}—`,
      'c'.repeat(100),
    ]);
    expect(splitSentences(Array(60).fill('words').join(' '))[0]!.endsWith('words')).toBe(true);
    expect(splitSentences('x'.repeat(500))).toEqual(['x'.repeat(240), 'x'.repeat(240), 'x'.repeat(20)]);
  });

  it('never returns empty or wordless pieces', () => {
    for (const text of [...TRICKY, '', '   ', '...', '!!! ?', '- \n- ', 'Hi. . . . Ok.', '... Hello']) {
      for (const piece of splitSentences(text)) {
        expect(piece).toBe(piece.trim());
        expect(hasWord(piece)).toBe(true);
      }
    }
    expect(splitSentences('Hello. ... World.')).toEqual(['Hello. ...', 'World.']);
    expect(splitSentences('... Hello there.')).toEqual(['... Hello there.']);
  });
});

describe('completeSentences', () => {
  it.each([
    'For spices e.g',
    'For spices e.',
    'Call Dr. ',
    'It is done.',
    'Really?',
    'Add 1.',
    'Add 1.5',
    'Ratio 4:',
    'She said "stop. ',
    'Add salt (a pinch. ',
    'Run `ls. ',
    '- ',
    'Items:\n-',
    'Hello wor',
    '',
  ])('holds back an unfinished tail: %j', (buffer) => {
    expect(completeSentences(buffer)).toEqual(['', buffer]);
  });

  it('gives back every sentence that more text can no longer change', () => {
    expect(completeSentences('Preheat the oven. Then add the rice! ')).toEqual(['Preheat the oven. Then add the rice!', ' ']);
    expect(completeSentences('One. Two. Three')).toEqual(['One. Two.', ' Three']);
    expect(completeSentences('Bake at 180. Then 2.')).toEqual(['Bake at 180.', ' Then 2.']);
    expect(completeSentences('Buy these:\n- eg')).toEqual(['Buy these:', '\n- eg']);
  });

  it('loses no characters, however the reply arrives, and agrees with the final split', () => {
    for (const text of TRICKY) {
      const [pieces, rest] = stream(text);
      expect(pieces.join('') + rest).toBe(text);
    }
    const text = TRICKY[0]!;
    const [pieces, rest] = stream(text);
    expect([...pieces.flatMap((piece) => splitSentences(piece)), ...splitSentences(rest)]).toEqual(splitSentences(text));
  });
});

describe('speakable', () => {
  it('skips code blocks, tables, images and markup', () => {
    expect(speakable('Here is the fix:\n\n```ts\nconst a = 1;\n```\n\nRun the tests.')).toBe('Here is the fix: Run the tests.');
    expect(speakable('```bash\nrm -rf build')).toBe('');
    expect(speakable('| a | b |\n|---|---|\n| 1 | 2 |')).toBe('');
    expect(speakable('Look ![chart](/api/media/x.png) here.')).toBe('Look here.');
    expect(speakable('<details><summary>More</summary></details>Done.')).toBe('More Done.');
  });

  it('says links and paths briefly', () => {
    expect(speakable('Read [the guide](https://example.com/a(b)) first.')).toBe('Read the guide first.');
    expect(speakable('See https://files.example.com/x?y=1 now.')).toBe('See a link now.');
    expect(speakable('I changed /usr/local/src/signalbox/server/src/app.ts and ~/notes/today.md.')).toBe(
      'I changed app.ts and today.md.',
    );
    expect(speakable('Run `npm test` in the repo.')).toBe('Run npm test in the repo.');
  });

  it('drops headings, bullets, emphasis and emoji', () => {
    expect(speakable('## Summary\n- **Fixed** the _login_ bug ✅\n2. Added ~~old~~ tests 🎉')).toBe(
      'Summary Fixed the login bug Added old tests',
    );
    expect(speakable('> quoted *text*')).toBe('quoted text');
    expect(speakable('---')).toBe('');
    expect(speakable('snake_case_name and 2*3*4')).toBe('snake_case_name and 2*3*4');
  });
});

describe('speechPieces', () => {
  it('drops a long code block whole instead of reading half of it', () => {
    const code = Array(40).fill('const value = compute(alpha, beta);').join('\n');
    const pieces = speechPieces(`Here is the change.\n\n\`\`\`ts\n${code}\n\`\`\`\n\nThat fixes it.`);
    expect(pieces).toEqual(['Here is the change.', 'That fixes it.']);
  });

  it('splits long spoken sentences after cleaning them up', () => {
    const long = `**Note:** ${Array(70).fill('word').join(', ')}.`;
    const pieces = speechPieces(long);
    expect(pieces[0]!.startsWith('Note: word,')).toBe(true);
    expect(pieces.every((p) => p.length <= MAX_CHUNK)).toBe(true);
  });
});
