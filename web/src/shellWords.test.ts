import { describe, expect, it } from 'vitest';
import { shellWords } from '../../shared/shell-words';

const texts = (command: string) => shellWords(command).map((w) => w.text);

describe('shellWords', () => {
  it('reads quotes and escapes the way the shell does', () => {
    expect(texts('rm "-R" /home/me/docs')).toEqual(['rm', '-R', '/home/me/docs']);
    expect(texts("rm '-r' x")).toEqual(['rm', '-r', 'x']);
    expect(texts('rm \\-r x')).toEqual(['rm', '-r', 'x']);
    expect(texts('rm -\\r x')).toEqual(['rm', '-r', 'x']);
    expect(texts('rm ""-r x')).toEqual(['rm', '-r', 'x']);
    expect(texts('r\\m "-"R x')).toEqual(['rm', '-R', 'x']);
    expect(texts('echo "a \\"b\\" \\\\ c"')).toEqual(['echo', 'a "b" \\ c']);
    expect(texts("echo 'a \\ b'")).toEqual(['echo', 'a \\ b']);
    expect(texts('rm "my file.txt"')).toEqual(['rm', 'my file.txt']);
  });

  it("reads $'...' escapes", () => {
    expect(texts("rm $'-r' x")).toEqual(['rm', '-r', 'x']);
    expect(texts("rm $'\\x2dr' x")).toEqual(['rm', '-r', 'x']);
    expect(texts("rm $'\\055R' x")).toEqual(['rm', '-R', 'x']);
    expect(texts("rm $'\\u002df' x")).toEqual(['rm', '-f', 'x']);
    expect(texts("echo $'a\\tb\\'c'")).toEqual(['echo', 'a\tb\'c']);
  });

  it("reads $'...' bytes, characters and NULs as bash does", () => {
    // Each expectation is what bash 5.1 hands printf for the same word.
    expect(texts("$'\\562\\155' -R x")).toEqual(['rm', '-R', 'x']);
    expect(texts("r$'m\\0suffix' -R x")).toEqual(['rm', '-R', 'x']);
    expect(texts("r$'m\\0suffix'X")).toEqual(['rmX']);
    expect(texts("$'a\\x00b'c $'a\\u0000b'c $'\\c@z'q")).toEqual(['ac', 'ac', 'q']);
    expect(texts("$'\\303\\251' $'\\u00e9' $'\\1621' $'\\x41\\x2'")).toEqual(['\u00e9', '\u00e9', 'r1', 'A\x02']);
    expect(texts("$'\\c?' $'\\ca' $'\\x' $'\\q'")).toEqual(['\x7f', '\x01', '\\x', '\\q']);
    // A byte that isn't UTF-8 can't read as any program's name.
    expect(texts("$'\\777'")).toEqual(['\ufffd']);
    // An escaped quote after a NUL still doesn't end the string.
    expect(texts("$'r\\0\\'x' y")).toEqual(['r', 'y']);
    // A leading byte-order mark is kept: bash runs a program named "\uFEFFnpm".
    expect(texts("$'\\uFEFFnpm' test")).toEqual(['\uFEFFnpm', 'test']);
    expect(texts("$'\\xEF\\xBB\\xBFnpm' $'\\357\\273\\277'")).toEqual(['\uFEFFnpm', '\uFEFF']);
  });

  it('keeps each word as written too', () => {
    expect(shellWords('rm -rf "~/old dir"')[2]).toEqual({ text: '~/old dir', raw: '"~/old dir"' });
  });

  it('marks expansions as unknown without running them', () => {
    const [, flags, file] = shellWords('rm $FLAGS "$f"');
    expect(flags).toMatchObject({ text: '$FLAGS', expands: true });
    expect(file).toMatchObject({ text: '$f', expands: true });
    expect(shellWords('rm $(cat list) x')[1]).toMatchObject({ text: '$(cat list)', expands: true });
    expect(shellWords('rm `cat list`')[1]).toMatchObject({ expands: true });
    expect(shellWords('echo "${HOME}/x"')[1]).toMatchObject({ text: '${HOME}/x', expands: true });
    // Even an unquoted lone $ is outside the conservative expansion grammar.
    expect(shellWords('echo $ 5')[1]).toEqual({ text: '$', raw: '$', expands: true });
  });

  it.each([
    '*', '?', 'docs/*.ts', 'demo?.txt', '[abc]', '[!abc]', '[^abc]', '[]a]',
    '[!]]', '[[:alpha:]]', '["a"]', '"demo"*', "'*'?", '\\*[abc]', '{a,b}*.ts',
  ])('marks unquoted filename patterns unknown: %s', (raw) => {
    const words = shellWords(`echo ${raw}`).slice(1);
    expect(words.length).toBeGreaterThan(0);
    for (const word of words) expect(word.expands).toBe(true);
  });

  it.each([
    "'*'", '"?"', '\\*', '\\?', "'[abc]'", '"[abc]"', '\\[abc]',
    '[abc\\]', '[', '[]', '[[', '"*"\\?',
  ])('keeps quoted, escaped and incomplete filename patterns literal: %s', (raw) => {
    expect(shellWords(`echo ${raw}`)[1]).not.toHaveProperty('expands');
  });

  it('bounds the time needed to recognise a long bracket pattern', () => {
    const started = performance.now();
    expect(shellWords(`echo ${'['.repeat(59000)}`)[1]).not.toHaveProperty('expands');
    expect(shellWords(`echo ${'['.repeat(59000)}]`)[1]).toHaveProperty('expands', true);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it.each(['$[counter++]', '$[INPUT]', '$[values[0] + 1]', '$[$[1 + 2] + 3]'])(
    'marks legacy arithmetic as one unknown word: %s', (expansion) => {
      for (const raw of [expansion, `"${expansion}"`]) {
        expect(shellWords(`echo ${raw}`)).toEqual([
          { text: 'echo', raw: 'echo' }, { text: expansion, raw, expands: true },
        ]);
      }
    },
  );

  it('marks unfinished legacy arithmetic unknown', () => {
    expect(shellWords('echo $[counter++')[1]).toMatchObject({ expands: true });
    expect(shellWords('echo "$[counter++"')[1]).toMatchObject({ expands: true });
  });

  it('keeps quoted and escaped legacy arithmetic literal', () => {
    expect(shellWords("echo '$[counter++]' \\$\\[counter++]")).toEqual([
      { text: 'echo', raw: 'echo' },
      { text: '$[counter++]', raw: "'$[counter++]'" },
      { text: '$[counter++]', raw: '\\$\\[counter++]' },
    ]);
  });

  it('splits on operators, joins continued lines and drops comments', () => {
    expect(texts('ls; rm -r x && echo ok | cat')).toEqual(['ls', ';', 'rm', '-r', 'x', '&', '&', 'echo', 'ok', '|', 'cat']);
    expect(shellWords('ls\nrm x')[1]).toMatchObject({ text: '\n', op: true });
    expect(texts('rm \\\n  -r x')).toEqual(['rm', '-r', 'x']);
    expect(texts('rm x # -r and more')).toEqual(['rm', 'x']);
    expect(texts('echo a#b')).toEqual(['echo', 'a#b']);
    expect(texts('echo ";"')).toEqual(['echo', ';']);
  });

  it('reads a redirection as one operator with its file descriptor', () => {
    expect(texts('rm 2>&1 -R x')).toEqual(['rm', '>&', '1', '-R', 'x']);
    expect(shellWords('rm 2>&1 -R x')[1]).toEqual({ text: '>&', raw: '2>&', op: true, redirect: true });
    expect(texts('ls &>out; ls &>> log')).toEqual(['ls', '&>', 'out', ';', 'ls', '&>>', 'log']);
    expect(texts('a>b c>>d e>|f')).toEqual(['a', '>', 'b', 'c', '>>', 'd', 'e', '>|', 'f']);
    expect(texts('cat <in <<EOF <<-END <<<w <&3 <>rw')).toEqual(
      ['cat', '<', 'in', '<<', 'EOF', '<<-', 'END', '<<<', 'w', '<&', '3', '<>', 'rw'],
    );
    // Only bare digits right before it are a file descriptor.
    expect(texts('echo a2>x "2">y')).toEqual(['echo', 'a2', '>', 'x', '2', '>', 'y']);
    // "&&" and a lone "&" are still control operators.
    expect(shellWords('a && b &')).toEqual([
      { text: 'a', raw: 'a' },
      { text: '&', raw: '&', op: true },
      { text: '&', raw: '&', op: true },
      { text: 'b', raw: 'b' },
      { text: '&', raw: '&', op: true },
    ]);
    // Process substitution is a word whose value isn't known.
    expect(shellWords('diff <(ls a) >(cat) b')[1]).toMatchObject({ text: '<(ls a)', expands: true });
    expect(shellWords('diff <(ls a) >(cat) b')[2]).toMatchObject({ text: '>(cat)', expands: true });
  });

  it('splits words only at a space or a tab, as bash does', () => {
    // bash keeps these inside the word: printf '[%s]' gives one word for each.
    expect(texts('npm\u00A0test')).toEqual(['npm\u00A0test']);
    expect(texts('a\vb c\fd \u00A0e \u2003f\u3000')).toEqual(['a\vb', 'c\fd', '\u00A0e', '\u2003f\u3000']);
    expect(texts('rm\t-r  x')).toEqual(['rm', '-r', 'x']);
  });

  it.each([
    '{Y..a..2}-]rf', '-{r,f}', '{r,}m', '{npm,}', '{,}', 'x{,}', '{"",a}',
    '{1..3}', '{01..03}', '{a..e..2}', '{3..1}', '{-1..1}', '{-05..5..5}',
    '{-r,{x,y}z}', '{a,{b,c}', '{x,{a}}', '{a{b,c}}', '{1..100000}',
    '{rm,a{1..65}}', '{a,b}'.repeat(7), '{demo..text}', '{a.."c"}',
  ])('marks brace expansion unresolved without expanding it: %s', (raw) => {
    expect(shellWords(`echo ${raw}`)).toEqual([
      { text: 'echo', raw: 'echo' },
      { text: raw.replaceAll('"', ''), raw, expands: true },
    ]);
  });

  it.each(['{x},-rf}', '{a}b,c}', '{a}}b,c}', '{a}..c}'])(
    'detects brace expansion across literal closing braces: %s', (raw) => {
      expect(shellWords(`echo ${raw}`)).toEqual([
        { text: 'echo', raw: 'echo' }, { text: raw, raw, expands: true },
      ]);
    },
  );

  it.each([
    ['{a}', '{a}'], ['{}', '{}'], ['"{a,b}"', '{a,b}'], ["'{1..3}'", '{1..3}'],
    ['\\{a,b}', '{a,b}'], ['{a,b\\}', '{a,b}'], ['{a\\,b}', '{a,b}'],
    ['{a".."b}', '{a..b}'], ['{a\\.\\.b}', '{a..b}'], ['"{"a,b}', '{a,b}'],
    ['{a","b}', '{a,b}'], ['{a,b', '{a,b'],
    ["'{x},-rf}'", '{x},-rf}'], ['"{x},-rf}"', '{x},-rf}'],
    ['\\{x},-rf}', '{x},-rf}'], ['{x}\\,-rf}', '{x},-rf}'], ['{x},-rf\\}', '{x},-rf}'],
    ["'{a}b,c}'", '{a}b,c}'], ['"{a}b,c}"', '{a}b,c}'],
    ['\\{a}b,c}', '{a}b,c}'], ['{a}b\\,c}', '{a}b,c}'], ['{a}b,c\\}', '{a}b,c}'],
  ])('keeps literal braces without expansion: %s', (raw, value) => {
    expect(shellWords(`echo ${raw}`)[1]).toEqual({ text: value, raw });
  });

  it.each([
    '$', '$.', '$HOME', '$(echo demo)', '`echo demo`', '<(echo demo)', '>(cat)',
    '@(a|b)', '!(demo)', '+(demo)', '*(demo)', '?(demo)', 'docs/@(a|b)',
    '!!', '!demo', 'demo!word', '[!]', '~demo', '~+', '~-', '~demo/docs', 'docs/~demo',
  ])('marks other unsupported expansions unresolved: %s', (raw) => {
    expect(shellWords(`echo ${raw}`)[1]).toMatchObject({ text: raw, raw, expands: true });
  });

  it.each([
    ['~', '~'], ['~/docs', '~/docs'], ['"~demo"', '~demo'], ['\\~demo', '~demo'],
    ["'!!'", '!!'], ['\\!demo', '!demo'], ['"demo!word"', 'demo!word'],
    ['"$"', '$'], ['\\$', '$'], ["'$HOME'", '$HOME'], ['\\$HOME', '$HOME'],
    ['"@(a|b)"', '@(a|b)'], ['\\@\\(a\\|b\\)', '@(a|b)'],
  ])('keeps supported tildes and quoted or escaped expansion syntax literal: %s', (raw, value) => {
    expect(shellWords(`echo ${raw}`)[1]).toEqual({ text: value, raw });
  });

  it('bounds brace detection without generating words', () => {
    const started = performance.now();
    for (const raw of [
      '{'.repeat(30000) + 'a,b' + '}'.repeat(30000),
      '{a,'.repeat(20000) + 'demo' + '}'.repeat(20000),
      '{a,b}'.repeat(12000),
      '{a}'.repeat(20000) + 'b,c}',
    ]) {
      expect(shellWords(`echo ${raw}`)).toHaveLength(2);
      expect(shellWords(`echo ${raw}`)[1]).toEqual({ text: raw, raw, expands: true });
    }
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('runs an unclosed quote to the end', () => {
    expect(texts('rm "-r x')).toEqual(['rm', '-r x']);
    expect(texts("rm '-r x")).toEqual(['rm', '-r x']);
  });
});
