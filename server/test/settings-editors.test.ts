import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import { jsonEditor } from '../src/settings/editors/json.js';
import { yamlEditor } from '../src/settings/editors/yaml.js';
import { applyValues, type SettingOperation } from '../src/settings/editors/types.js';

it('preserves JSON key order, tabs, CRLF, trailing whitespace and untouched number spellings', () => {
  const source = '{\r\n\t"10": 1e2,\r\n\t"2": -0,\r\n\t"models": {\r\n\t\t"demo-model": { "name": "Original", "enabled": true }\r\n\t},\r\n\t"last": "keep"\r\n}\r\n';
  const edited = jsonEditor.edit(source, [{ type: 'set', path: ['models', 'demo-model', 'name'], value: 'Updated' }]);
  expect(edited).toBe(source.replace('Original', 'Updated'));
  const appended = jsonEditor.edit(edited, [{ type: 'set', path: ['added'], value: { nested: true } }]);
  expect(appended).toContain('\r\n\t"added": {\r\n\t\t"nested": true\r\n\t}');
  expect(jsonEditor.edit(appended, [{ type: 'delete', path: ['added'] }])).toBe(edited);
});

it.each(['\n', '\r\n'])('preserves a leading JSON BOM through parsing, edits and round trips: %j', newline => {
  const source = `\uFEFF \t{${newline}\t"name": "Original",${newline}\t"keep": "literal \uFEFF",${newline}\t"count": 1e2${newline}}${newline} `;
  expect(jsonEditor.parse(source)).toEqual({ name: 'Original', keep: 'literal \uFEFF', count: 100 });
  expect(jsonEditor.edit(source, [])).toBe(source);
  const edited = jsonEditor.edit(source, [{ type: 'set', path: ['name'], value: 'Updated' }]);
  expect(edited).toBe(source.replace('Original', 'Updated'));
  const appended = jsonEditor.edit(edited, [{ type: 'set', path: ['added'], value: [1, 2] }]);
  expect(jsonEditor.parse(appended)).toEqual({ name: 'Updated', keep: 'literal \uFEFF', count: 100, added: [1, 2] });
  expect(jsonEditor.edit(appended, [{ type: 'delete', path: ['added'] }])).toBe(edited);
  expect(jsonEditor.edit(source, [{ type: 'set', path: [], value: 'Updated root' }]))
    .toBe(`\uFEFF \t"Updated root"${newline} `);
});

it.each([' \uFEFF{}', '\uFEFF\uFEFF{}', '{}\uFEFF', '\uFEFF{"name":', '\uFEFF{"x":1,"x":2}',
  '\uFEFF{"nested":{"x":1,"\\u0078":2}}'])('refuses misplaced BOMs and invalid JSON after a BOM: %j', source => {
  const error = expect.objectContaining({ code: 'parse_failed' });
  expect(() => jsonEditor.parse(source)).toThrowError(error);
  expect(() => jsonEditor.edit(source, [{ type: 'set', path: [], value: {} }])).toThrowError(error);
});

it('sets and deletes through nested arrays with sequential index semantics', () => {
  const source = '{\n  "rows": [\n    [{ "name": "one", "extra": 1 }, { "name": "two" }],\n    [1, 2, 3]\n  ],\n  "unchanged": true\n}\n';
  const operations: SettingOperation[] = [
    { type: 'set', path: ['rows', 0, 1, 'name'], value: 'updated' },
    { type: 'delete', path: ['rows', 0, 0, 'extra'] },
    { type: 'delete', path: ['rows', 1, 1] },
    { type: 'set', path: ['rows', 1, 2], value: 4 },
  ];
  const edited = jsonEditor.edit(source, operations);
  expect(jsonEditor.parse(edited)).toEqual({ rows: [[{ name: 'one' }, { name: 'updated' }], [1, 3, 4]], unchanged: true });
  expect(edited).toContain('"unchanged": true\n}\n');
});

it.each(['{}', '{ }', '{\n}', '{\n    }', '[]', '[ ]', '[\n]'])('adds and removes an item in an empty JSON container: %j', source => {
  const path = source.startsWith('{') ? ['added'] : [0];
  const edited = jsonEditor.edit(source, [{ type: 'set', path, value: { name: 'demo' } }]);
  expect(jsonEditor.edit(edited, [{ type: 'delete', path }])).toBe(source);
});

it.each([0, 1, 2])('deletes JSON object and array entries at position %i', index => {
  const object = '{ "a": 1, "b": 2, "c": 3 }';
  const key = ['a', 'b', 'c'][index]!;
  const edited = jsonEditor.edit(object, [{ type: 'delete', path: [key] }]);
  const expected: Record<string, number> = { a: 1, b: 2, c: 3 };
  delete expected[key];
  expect(jsonEditor.parse(edited)).toEqual(expected);
  const values = [1, 2, 3];
  values.splice(index, 1);
  expect(jsonEditor.parse(jsonEditor.edit('[1, 2, 3]', [{ type: 'delete', path: [index] }]))).toEqual(values);
});

it('creates missing containers and treats inherited property names as ordinary JSON keys', () => {
  const operations: SettingOperation[] = [
    { type: 'set', path: ['new', 0, 'name'], value: 'demo' },
    { type: 'set', path: ['__proto__', 'enabled'], value: true },
    { type: 'set', path: ['constructor'], value: 'demo-constructor' },
  ];
  const result = jsonEditor.parse(jsonEditor.edit('{}', operations));
  expect(result).toEqual(JSON.parse('{"new":[{"name":"demo"}],"__proto__":{"enabled":true},"constructor":"demo-constructor"}'));
  expect(Object.hasOwn(Object.prototype, 'enabled')).toBe(false);
});

it('replaces a JSON document root while preserving its surrounding whitespace', () => {
  expect(jsonEditor.edit(' \n{"a":1}\n ', [{ type: 'set', path: [], value: [1, 2] }])).toBe(' \n[1,2]\n ');
});

const yaml = '# Application settings\nmodel:\n  name: "demo-model" # Active model\n  endpoint: \'https://example.com\'\n  enabled: true\nlimits:\n  turns: 5 # Per conversation\nitems: ["first", \'second\']\n';

// The consumer oracle is ruamel.yaml safe loading with YAML 1.1; these verdicts need no Python dependency.
const consumerStrings = ['+.', '-.', '.', '+._', '-._', '+.nan', '-.nan', '.nAn', '.iNf',
  '+_8', '-_9', '+_08', '+_18', '_', '_0', '__7'];

it.each(consumerStrings)('preserves a plain YAML scalar that the consumer reads as a string: %s', value => {
  const source = `value: ${value}    # Keep spacing\nname: original\n`;
  expect(yamlEditor.parse(source)).toEqual({ value, name: 'original' });
  expect(yamlEditor.edit(source, [{ type: 'set', path: ['name'], value: 'updated' }]))
    .toBe(source.replace('name: original', 'name: updated'));
});

it.each(['._', '.__', '+_', '-_', '+__', '-__'])('refuses a plain YAML scalar that the consumer cannot load: %s', value => {
  const source = `value: ${value}\nname: original\n`;
  const error = expect.objectContaining({ code: 'parse_failed' });
  expect(() => yamlEditor.parse(source)).toThrowError(error);
  expect(() => yamlEditor.edit(source, [{ type: 'set', path: ['name'], value: 'updated' }])).toThrowError(error);
});

it.each(['._', '.__', '._1', '+_', '-__', '+_0', '-_0', '+_01', '-_10', '+__7', '+_77'])
  ('quotes consumer-sensitive YAML strings in values, keys and collections: %s', value => {
  const source = 'value: old # Keep comment\n';
  const edited = yamlEditor.edit(source, [
    { type: 'set', path: ['value'], value },
    { type: 'set', path: ['added'], value: { [value]: [value] } },
    { type: 'set', path: [value], value },
  ]);
  expect(edited).toContain(`value: "${value}" # Keep comment`);
  expect(edited).toContain(`"${value}":`);
  expect(parseDocument(edited, { version: '1.1' }).toJS()).toEqual({ value, added: { [value]: [value] }, [value]: value });
  expect(yamlEditor.parse(edited)).toEqual({ value, added: { [value]: [value] }, [value]: value });
  const root = yamlEditor.edit('old\n', [{ type: 'set', path: [], value }]);
  expect(root).toBe(`"${value}"\n`);
});

it.each([['+_0', 0], ['-_0', 0], ['+_1', 1], ['-__07', -7], ['+_012', 10], ['-_10', -10],
  ['+_7__', 7], ['+_77', 77], ['-_700', -700]] as const)(
  'reads and writes a signed underscore integer with the consumer value: %s', (scalar, value) => {
    const source = `value: ${scalar}    # Keep spacing\nname: original\n`;
    expect(yamlEditor.parse(source)).toEqual({ value, name: 'original' });
    const edited = yamlEditor.edit(source, [{ type: 'set', path: ['name'], value: 'updated' }]);
    expect(yamlEditor.parse(edited)).toEqual({ value, name: 'updated' });
    expect(parseDocument(edited, { version: '1.1' }).toJS()).toEqual({ value, name: 'updated' });
    expect(edited).toContain('# Keep spacing');
  });

it.each(['.nan', '.NaN', '.NAN', '.inf', '.Inf', '.INF', '+.inf', '-.Inf'])('refuses non-finite YAML floats: %s', value => {
  expect(() => yamlEditor.parse(`value: ${value}\n`)).toThrowError(expect.objectContaining({ code: 'parse_failed' }));
});

it.each(['\n', '\r\n'])('restores only trailing YAML comment spacing on aligned lines: %j', newline => {
  const source = [
    'name: old     # Edited value', "keep: 'two # words'     # Keep padding # extra",
    'items: [one, two]    # Collection', 'last: true  # Last value', '',
  ].join(newline);
  expect(yamlEditor.edit(source, [])).toBe(source);
  const edited = yamlEditor.edit(source, [{ type: 'set', path: ['name'], value: 'updated' }]);
  expect(edited).toBe(source.replace('name: old     #', 'name: updated #'));
  expect(yamlEditor.parse(edited)).toEqual({ name: 'updated', keep: 'two # words', items: ['one', 'two'], last: true });
});

it.each(['\n', '\r\n'])('keeps literal hash spacing when replacing a YAML mapping with a block scalar: %j', newline => {
  const source = ['doc:', '  a: old     # comment', '  b: old', 'keep: true     # Keep comment', ''].join(newline);
  const value = 'a: old # comment\nb: old\n';
  const edited = yamlEditor.edit(source, [{ type: 'set', path: ['doc'], value }]);
  expect(edited).toBe(['doc: |', '  a: old # comment', '  b: old', 'keep: true     # Keep comment', ''].join(newline));
  expect(yamlEditor.parse(edited)).toEqual({ doc: value, keep: true });
  expect(parseDocument(edited, { version: '1.1' }).toJS()).toEqual({ doc: value, keep: true });
});

it.each([
  { source: 'name: old\nkeep: value     # Keep comment\n', operations: [{ type: 'set', path: ['added'], value: true }],
    expected: { name: 'old', keep: 'value', added: true } },
  { source: 'name: old\nremove: unused\nkeep: value     # Keep comment\n', operations: [{ type: 'delete', path: ['remove'] }],
    expected: { name: 'old', keep: 'value' } },
  { source: 'name: old\nkeep: value     # Keep comment\n', operations: [{ type: 'set', path: ['name'], value: ['first', 'second'] }],
    expected: { name: ['first', 'second'], keep: 'value' } },
] as { source: string; operations: SettingOperation[]; expected: unknown }[])(
  'skips YAML comment spacing restoration when line counts change: $source', ({ source, operations, expected }) => {
    const edited = yamlEditor.edit(source, operations);
    expect(edited).toContain('keep: value # Keep comment\n');
    expect(yamlEditor.parse(edited)).toEqual(expected);
  });

it('does not move comment spacing between repeated YAML lines after deletion', () => {
  const source = 'items:\n  - repeated  # Same comment\n  - repeated     # Same comment\n  - repeated        # Same comment\nname: old\n';
  const edited = yamlEditor.edit(source, [{ type: 'delete', path: ['items', 0] }]);
  expect(edited).toBe('items:\n  - repeated # Same comment\n  - repeated # Same comment\nname: old\n');
  expect(yamlEditor.parse(edited)).toEqual({ items: ['repeated', 'repeated'], name: 'old' });
});

it.each([
  { source: "text: 'value    # literal'\nkeep: value     # Comment\n", value: 'value # literal' },
  { source: 'text: "value    # literal"\nkeep: value     # Comment\n', value: 'value # literal' },
  { source: 'text: |\n  value    # literal\nkeep: value     # Comment\n', value: 'value # literal\n' },
])('keeps edits to spaces before a hash inside YAML scalar values: $source', ({ source, value }) => {
  const edited = yamlEditor.edit(source, [{ type: 'set', path: ['text'], value }]);
  expect(yamlEditor.parse(edited)).toEqual({ text: value, keep: 'value' });
  expect(parseDocument(edited, { version: '1.1' }).toJS()).toEqual({ text: value, keep: 'value' });
  expect(edited).toContain('keep: value     # Comment\n');
});

it('does not restore whitespace before YAML values', () => {
  const source = "name: old\nkeep:    'value'     # Keep comment\nlast: true\n";
  const edited = yamlEditor.edit(source, [{ type: 'set', path: ['name'], value: 'updated' }]);
  expect(edited).toContain("keep: 'value' # Keep comment\n");
  expect(edited).not.toContain("keep:    'value'");
  expect(yamlEditor.parse(edited)).toEqual({ name: 'updated', keep: 'value', last: true });
});

it.each(['\n', '\r\n'])('deletes a mapping entry beside an unindented nested YAML sequence without duplicating items: %j', newline => {
  const source = '- a:\n    items:\n    - one\n    remove: old\n'.replace(/\n/g, newline);
  const edited = yamlEditor.edit(source, [{ type: 'delete', path: [0, 'a', 'remove'] }]);
  const expected = [{ a: { items: ['one'] } }];
  expect(yamlEditor.parse(edited)).toEqual(expected);
  expect(parseDocument(edited, { version: '1.1' }).toJS()).toEqual(expected);
});

it.each(['\n', '\r\n'].flatMap(newline => [
  { source: 'a: 1', path: ['b'], expected: { a: 1, b: 2 } },
  { source: 'a: 1 # Keep comment', path: ['b'], expected: { a: 1, b: 2 } },
  { source: '- one', path: [1], expected: ['one', 2] },
  { source: 'items:\n- one', path: ['items', 1], expected: { items: ['one', 2] } },
].map(change => ({ ...change, newline }))))(
  'keeps the required separator when inserting after YAML EOF: $source, $newline', ({ source, path, expected, newline }) => {
    source = source.replace(/\n/g, newline);
    const edited = yamlEditor.edit(source, [{ type: 'set', path, value: 2 }]);
    expect(yamlEditor.parse(edited)).toEqual(expected);
    expect(parseDocument(edited, { version: '1.1' }).toJS()).toEqual(expected);
    expect(edited).toContain(source.includes('\r\n') ? '\r\n' : '\n');
    expect(edited.endsWith('\n')).toBe(false);
    if (source.includes('# Keep comment')) expect(edited).toContain('# Keep comment');
  });

const layoutChanges: { source: string; operations: SettingOperation[] }[] = [
  { source: 'value: old\nlast: true\n', operations: [{ type: 'set', path: ['value'], value: { new: 1 } }] },
  { source: 'value: old # Keep comment\nlast: true\n', operations: [{ type: 'set', path: ['value'], value: [1] }] },
  { source: 'items:\n  - only\nlast: true\n', operations: [{ type: 'delete', path: ['items', 0] }] },
  { source: 'items: # Keep comment\n  - only\nlast: true\n', operations: [{ type: 'delete', path: ['items', 0] }] },
  { source: 'value:\n  only: 1\nlast: true\n', operations: [{ type: 'delete', path: ['value', 'only'] }] },
  { source: 'value: []\nlast: true\n', operations: [{ type: 'set', path: ['value', 0], value: { new: 1 } }] },
  { source: 'value: {}\nlast: true\n', operations: [{ type: 'set', path: ['value', 'new'], value: 1 }] },
  { source: 'items:\n  - old # Keep comment\nlast: true\n', operations: [{ type: 'set', path: ['items', 0], value: { new: 1 } }] },
  { source: 'items:\n  - name: old\n    keep: true\nlast: true\n', operations: [{ type: 'set', path: ['items', 0, 'name'], value: { new: 1 } }] },
];

it.each(layoutChanges.flatMap(change => ['\n', '\r\n'].map(newline => ({ ...change, newline }))))(
  'keeps required YAML structure when collection layout changes: $source, $newline', ({ source, operations, newline }) => {
    source = source.replace(/\n/g, newline);
    const expected = applyValues(yamlEditor.parse(source), operations);
    const edited = yamlEditor.edit(source, operations);
    expect(yamlEditor.parse(edited)).toEqual(expected);
    expect(parseDocument(edited, { version: '1.1' }).toJS()).toEqual(expected);
    expect(edited).toContain(`last: true${newline}`);
    if (source.includes('# Keep comment')) expect(edited).toContain('# Keep comment');
    if (newline === '\r\n') expect(edited.replace(/\r\n/g, '')).not.toContain('\n');
  });

it('preserves YAML comments, map ordering and scalar quoting for set/delete round trips', () => {
  const edited = yamlEditor.edit(yaml, [
    { type: 'set', path: ['model', 'name'], value: 'updated-model' },
    { type: 'set', path: ['limits', 'turns'], value: 8 },
    { type: 'set', path: ['model', 'extra'], value: 'added' },
  ]);
  expect(edited).toContain('name: "updated-model" # Active model');
  expect(edited).toContain('endpoint: \'https://example.com\'');
  expect(edited).toContain('turns: 8 # Per conversation');
  expect(edited.indexOf('model:')).toBeLessThan(edited.indexOf('limits:'));
  const restored = yamlEditor.edit(edited, [
    { type: 'set', path: ['model', 'name'], value: 'demo-model' },
    { type: 'set', path: ['limits', 'turns'], value: 5 },
    { type: 'delete', path: ['model', 'extra'] },
  ]);
  expect(restored).toBe(yaml);
});

it('preserves YAML container comments and flow style when replacing a collection', () => {
  const edited = yamlEditor.edit('items: ["first", \'second\'] # Keep this comment\n', [
    { type: 'set', path: ['items'], value: ['updated'] },
  ]);
  expect(edited).toBe('items: [updated] # Keep this comment\n');
});

it('edits YAML sequences, creates missing maps and keeps four-space indentation and CRLF', () => {
  const source = '# Settings\r\nmodel:\r\n    name: "demo"\r\nitems:\r\n    - first\r\n    - second\r\n';
  const edited = yamlEditor.edit(source, [
    { type: 'set', path: ['model', 'name'], value: 'updated' },
    { type: 'delete', path: ['items', 0] },
    { type: 'set', path: ['added', 'nested'], value: true },
  ]);
  expect(edited).toContain('    name: "updated"\r\n');
  expect(edited).toContain('added:\r\n    nested: true\r\n');
  expect(yamlEditor.parse(edited)).toEqual({ model: { name: 'updated' }, items: ['second'], added: { nested: true } });
});

it.each([jsonEditor, yamlEditor])('refuses scalar traversal, sparse array insertion and root deletion', editor => {
  const source = '{"scalar":1,"items":[1]}';
  for (const operation of [
    { type: 'set', path: ['scalar', 'child'], value: true },
    { type: 'set', path: ['items', 3], value: true },
    { type: 'set', path: ['missing', 2], value: true },
    { type: 'delete', path: [] },
  ] as SettingOperation[]) expect(() => editor.edit(source, [operation])).toThrow('invalid path or value');
});

it('rejects non-finite values, sparse arrays and cycles before serializing', () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  for (const value of [NaN, Infinity, undefined, new Date(), [, 1], cyclic]) {
    expect(() => applyValues({}, [{ type: 'set', path: ['value'], value: value as never }])).toThrow('invalid path or value');
  }
});

it('reports parse errors without including file values', () => {
  expect(() => jsonEditor.parse('{"password":"demo-private"')).toThrow('Settings file is not valid JSON.');
  expect(() => yamlEditor.parse('password: ["demo-private"')).toThrow('Settings file is not valid YAML.');
  expect(() => yamlEditor.parse('name: first\nname: second\n')).toThrow('Settings file is not valid YAML.');
});

it.each(['off', 'on', 'yes', 'no', '012', 'null'])('quotes YAML strings ambiguous to a YAML 1.1 reader: %s', value => {
  const edited = yamlEditor.edit('approvals:\n  mode: auto\n', [{ type: 'set', path: ['approvals', 'mode'], value }]);
  expect(parseDocument(edited, { version: '1.1', merge: true }).toJS()).toEqual({ approvals: { mode: value } });
});

it.each(['old', '"old"', "'old'"].flatMap(scalar => ['<<', '='].map(value => ({ scalar, value }))))(
  'writes reserved YAML strings for the consumer when replacing $scalar with $value', ({ scalar, value }) => {
    const edited = yamlEditor.edit(`value: ${scalar} # Keep comment\n`, [{ type: 'set', path: ['value'], value }]);
    const consumer = spawnSync('python3', ['-c', 'import json, sys, yaml; print(json.dumps(yaml.safe_load(sys.stdin.read())))'],
      { input: edited, encoding: 'utf8' });
    expect(consumer.status, consumer.stderr).toBe(0);
    expect(JSON.parse(consumer.stdout)).toEqual({ value });
    expect(yamlEditor.parse(edited)).toEqual({ value });
    expect(edited).toContain('# Keep comment');
    if (scalar.startsWith('"')) expect(edited).toContain(`value: "${value}"`);
    if (scalar.startsWith("'")) expect(edited).toContain(`value: '${value}'`);
  });

it.each(['<<', '='])('writes a reserved YAML root string for the consumer: %s', value => {
  const edited = yamlEditor.edit('old # Root comment\n', [{ type: 'set', path: [], value }]);
  const consumer = spawnSync('python3', ['-c', 'import json, sys, yaml; print(json.dumps(yaml.safe_load(sys.stdin.read())))'],
    { input: edited, encoding: 'utf8' });
  expect(consumer.status, consumer.stderr).toBe(0);
  expect(JSON.parse(consumer.stdout)).toBe(value);
  expect(yamlEditor.parse(edited)).toBe(value);
  expect(edited).toContain('# Root comment');
});

it.each(['value: { nested: old, items: [old] } # Keep comment\n', 'value: # Keep comment\n  nested: old\n  items:\n    - old\n']
  .flatMap(source => ['<<', '='].map(value => ({ source, value }))))(
  'writes reserved YAML strings in nested collections, new paths and keys for the consumer: $value in $source', ({ source, value }) => {
    const nested = { nested: value, items: [value, { [value]: value }] };
    const edited = yamlEditor.edit(source, [
      { type: 'set', path: ['value'], value: nested },
      { type: 'set', path: ['added', 'items', 0], value },
      { type: 'set', path: [value], value },
    ]);
    const expected = { value: nested, added: { items: [value] }, [value]: value };
    const consumer = spawnSync('python3', ['-c', 'import json, sys, yaml; print(json.dumps(yaml.safe_load(sys.stdin.read())))'],
      { input: edited, encoding: 'utf8' });
    expect(consumer.status, consumer.stderr).toBe(0);
    expect(JSON.parse(consumer.stdout)).toEqual(expected);
    expect(yamlEditor.parse(edited)).toEqual(expected);
    expect(edited).toContain('# Keep comment');
  });

it.each([
  ['multiple documents', 'name: first\n---\nname: second\n'],
  ['empty second document', 'name: first\n---\n'],
  ['non-specific key tag', '! on: old\n'],
  ['non-specific value tag', 'value: ! false\n'],
  ['root tag', '! old\n'],
  ['sequence item tag', 'items: [! old]\n'],
  ['non-specific map tag', 'value: ! { name: old }\n'],
  ['non-specific sequence tag', 'value: ! [old]\n'],
  ['string tag', 'value: !!str false\n'],
  ['integer tag', 'value: !!int 2\n'],
  ['boolean tag', 'value: !!bool true\n'],
  ['float tag', 'value: !!float 1.5\n'],
  ['null tag', 'value: !!null null\n'],
  ['map tag', 'value: !!map { name: old }\n'],
  ['sequence tag', 'value: !!seq [old]\n'],
  ['local tag', 'value: !application old\n'],
  ['verbatim tag', 'value: !<tag:yaml.org,2002:str> old\n'],
  ['tag handle', '%TAG !app! tag:example.com,2026:\n---\nvalue: !app!setting old\n'],
  ['scalar anchor', 'value: &base old\n'],
  ['map anchor', 'value: &base { name: old }\n'],
  ['sequence anchor', 'value: &base [old]\n'],
  ['alias', 'value: *base\n'],
  ['key alias', '*base: old\n'],
  ['merge key', 'settings:\n  <<: { enabled: true }\n'],
  ['flow merge key', 'settings: { <<: { enabled: true } }\n'],
  ['explicit key', '? explicit\n: val\nkeep: old\n'],
  ['multiline explicit key', '? |-\n  first\n  second\n: val\nkeep: old\n'],
  ['separate explicit key', '?\n  explicit\n: val\nkeep: old\n'],
  ['commented explicit key', '? explicit # Key comment\n: val\nkeep: old\n'],
  ['nested explicit key', 'items:\n- ? explicit\n  : val\n  keep: old\n'],
  ['flow explicit key', 'settings: { ? explicit: val }\nkeep: old\n'],
  ['sequence key', '? [a, b]\n: old\n'],
  ['map key', '? { name: old }\n: old\n'],
] as const)('refuses YAML with a %s during parsing and editing', (_feature, source) => {
  const error = expect.objectContaining({ name: 'SettingsWriteError', code: 'unsupported_yaml',
    message: "Settings file uses YAML features Wayroost won't edit automatically." });
  expect(() => yamlEditor.parse(source)).toThrowError(error);
  for (const operations of [[], [{ type: 'set', path: ['name'], value: 'updated' }],
    [{ type: 'delete', path: ['name'] }]] as SettingOperation[][]) {
    expect(() => yamlEditor.edit(source, operations)).toThrowError(error);
  }
});

it('preserves YAML feature spellings in comments, quoted strings and block scalars', () => {
  const source = '# --- !!str ! &base *base << ? key\n"<<": "! on"\n"?": \'? key\'\nvalue: \'&base *base !!str\'\ntext: |\n  ---\n  ! false\n  ? key\nname: old\n';
  const edited = yamlEditor.edit(source, [{ type: 'set', path: ['name'], value: 'updated' }]);
  expect(edited).toBe(source.replace('name: old', 'name: updated'));
  expect(yamlEditor.parse(edited)).toEqual({ '<<': '! on', '?': '? key', value: '&base *base !!str', text: '---\n! false\n? key\n', name: 'updated' });
});

it.each(['', '# Settings\n', '---\nname: old\n...\n'])('edits an empty or explicitly delimited single YAML document: %j', source => {
  const edited = yamlEditor.edit(source, [{ type: 'set', path: [], value: { name: 'updated' } }]);
  expect(yamlEditor.parse(edited)).toEqual({ name: 'updated' });
  if (source.includes('# Settings')) expect(edited).toContain('# Settings');
  if (source.startsWith('---')) expect(edited).toMatch(/^---\nname: updated\n\.\.\.\n$/);
});

it.each(['9007199254740993', '-9007199254740993', '0x20000000000001'])('rejects unsupported YAML integers before losing precision: %s', id => {
  const source = `id: ${id}\nname: original\n`;
  expect(() => yamlEditor.parse(source)).toThrow('Settings file is not valid YAML.');
  expect(() => yamlEditor.edit(source, [{ type: 'set', path: ['name'], value: 'updated' }])).toThrow('Settings file is not valid YAML.');
});

it.each(['1: old\n', 'on: old\n'])('rejects YAML mapping keys that cannot be addressed as strings: %j', source => {
  expect(() => yamlEditor.parse(source)).toThrow('Settings file is not valid YAML.');
  expect(() => yamlEditor.edit(source, [{ type: 'delete', path: ['1'] }])).toThrow('Settings file is not valid YAML.');
});

it('edits quoted numeric and ambiguous YAML keys consistently', () => {
  const source = '"1": old\n"on": old\n';
  const edited = yamlEditor.edit(source, [{ type: 'set', path: ['1'], value: 'updated' }, { type: 'delete', path: ['on'] }]);
  expect(yamlEditor.parse(edited)).toEqual({ '1': 'updated' });
});

it('rejects a YAML directive that selects a different consumer schema', () => {
  expect(() => yamlEditor.parse('%YAML 1.2\n---\nmode: off\n')).toThrow('Settings file is not valid YAML.');
});

it('drops integer-only scalar presentation when setting a fractional number', () => {
  const edited = yamlEditor.edit('amount: 0x10 # Keep comment\n', [{ type: 'set', path: ['amount'], value: 1.5 }]);
  expect(yamlEditor.parse(edited)).toEqual({ amount: 1.5 });
  expect(edited).toContain('# Keep comment');
});

it.each([
  ['1:59', 119], ['1:59:00', 7140], ['1:59.5', 119.5], ['08', '08'], ['09', '09'], ['-08', '-08'],
  ['-.5', '-.5'], ['+.5', '+.5'], ['.5e3', '.5e3'], ['-.5e+3', '-.5e+3'], ['+.5e-3', '+.5e-3'],
  ['1e3', '1e3'], ['1e+3', '1e+3'], ['1.0e3', '1.0e3'], ['1.e3', '1.e3'],
] as const)('refuses YAML scalar spellings that cannot be preserved for the consumer: %s', (scalar, value) => {
  const source = `value: ${scalar}\nname: original\n`;
  const consumer = spawnSync('python3', ['-c', 'import json, sys, yaml; print(json.dumps(yaml.safe_load(sys.stdin.read())))'],
    { input: source, encoding: 'utf8' });
  expect(consumer.status, consumer.stderr).toBe(0);
  expect(JSON.parse(consumer.stdout)).toEqual({ value, name: 'original' });
  expect(() => yamlEditor.parse(source)).toThrow('Settings file is not valid YAML.');
  expect(() => yamlEditor.edit(source, [{ type: 'set', path: ['name'], value: 'updated' }])).toThrow('Settings file is not valid YAML.');
});

it.each(['y', 'Y', 'n', 'N'])('refuses plain single-letter YAML booleans read as strings by the consumer: %s', scalar => {
  const source = `value: ${scalar} # Keep comment\nname: original\n`;
  const consumer = spawnSync('python3', ['-c', 'import json, sys, yaml; print(json.dumps(yaml.safe_load(sys.stdin.read())))'],
    { input: source, encoding: 'utf8' });
  expect(consumer.status, consumer.stderr).toBe(0);
  expect(JSON.parse(consumer.stdout)).toEqual({ value: scalar, name: 'original' });
  expect(() => yamlEditor.parse(source)).toThrow('Settings file is not valid YAML.');
  expect(() => yamlEditor.edit(source, [{ type: 'set', path: ['value'], value: /^[yY]$/.test(scalar) }]))
    .toThrow('Settings file is not valid YAML.');
});

it.each(['y', 'Y', 'n', 'N'].flatMap(value => [`"${value}"`, `'${value}'`]))(
  'preserves quoted YAML letters for the consumer: %s', scalar => {
    const source = `value: ${scalar} # Keep comment\nname: original\n`;
    const expected = { value: scalar.replace(/["']/g, ''), name: 'updated' };
    const edited = yamlEditor.edit(source, [{ type: 'set', path: ['name'], value: 'updated' }]);
    const consumer = spawnSync('python3', ['-c', 'import json, sys, yaml; print(json.dumps(yaml.safe_load(sys.stdin.read())))'],
      { input: edited, encoding: 'utf8' });
    expect(consumer.status, consumer.stderr).toBe(0);
    expect(JSON.parse(consumer.stdout)).toEqual(expected);
    expect(yamlEditor.parse(edited)).toEqual(expected);
    expect(edited).toContain('# Keep comment');
    expect(edited).toContain(`value: ${scalar}`);
  });

it.each([['"-.5"', '-.5'], ["'+.5'", '+.5'], ['".5e3"', '.5e3']] as const)(
  'preserves quoted YAML floats for the consumer: %s', (scalar, value) => {
    const source = `value: ${scalar}\nname: original\n`;
    const edited = yamlEditor.edit(source, [{ type: 'set', path: ['name'], value: 'updated' }]);
    const consumer = spawnSync('python3', ['-c', 'import json, sys, yaml; print(json.dumps(yaml.safe_load(sys.stdin.read())))'],
      { input: edited, encoding: 'utf8' });
    expect(consumer.status, consumer.stderr).toBe(0);
    expect(JSON.parse(consumer.stdout)).toEqual({ value, name: 'updated' });
    expect(edited).toContain(`value: ${scalar}`);
  });

it.each([['.5', 0.5], ['-0.5', -0.5], ['+0.5', 0.5], ['.5e+3', 500], ['1.0e+3', 1000], ['1.e-3', 0.001]] as const)(
  'preserves supported YAML floats for the consumer: %s', (scalar, value) => {
    const edited = yamlEditor.edit(`value: ${scalar}\nname: original\n`, [{ type: 'set', path: ['name'], value: 'updated' }]);
    const consumer = spawnSync('python3', ['-c', 'import json, sys, yaml; print(json.dumps(yaml.safe_load(sys.stdin.read())))'],
      { input: edited, encoding: 'utf8' });
    expect(consumer.status, consumer.stderr).toBe(0);
    expect(JSON.parse(consumer.stdout)).toEqual({ value, name: 'updated' });
  });

it.each([1e-7, -1e-7, 1e21])('writes a numeric YAML value in consumer-compatible scientific notation: %s', value => {
  const edited = yamlEditor.edit('value: 0\n', [{ type: 'set', path: ['value'], value }]);
  const consumer = spawnSync('python3', ['-c', 'import json, sys, yaml; print(json.dumps(yaml.safe_load(sys.stdin.read())))'],
    { input: edited, encoding: 'utf8' });
  expect(consumer.status, consumer.stderr).toBe(0);
  expect(JSON.parse(consumer.stdout)).toEqual({ value });
  expect(yamlEditor.parse(edited)).toEqual({ value });
});

it('preserves quoted numeric strings for the YAML consumer', () => {
  const source = 'timeout: "1:59"\nid: \'08\'\nname: original\n';
  const edited = yamlEditor.edit(source, [{ type: 'set', path: ['name'], value: 'updated' }]);
  const consumer = spawnSync('python3', ['-c', 'import json, sys, yaml; print(json.dumps(yaml.safe_load(sys.stdin.read())))'],
    { input: edited, encoding: 'utf8' });
  expect(consumer.status, consumer.stderr).toBe(0);
  expect(JSON.parse(consumer.stdout)).toEqual({ timeout: '1:59', id: '08', name: 'updated' });
  expect(edited).toContain('timeout: "1:59"');
  expect(edited).toContain("id: '08'");
});

it.each(['{"x":1,"x":2}', '{"nested":{"x":1,"\\u0078":2}}'])('rejects duplicate JSON keys during parsing and editing: %s', source => {
  expect(() => jsonEditor.parse(source)).toThrow('Settings file is not valid JSON.');
  for (const operation of [{ type: 'set', path: ['x'], value: 3 }, { type: 'delete', path: ['x'] }] as SettingOperation[]) {
    expect(() => jsonEditor.edit(source, [operation])).toThrow('Settings file is not valid JSON.');
  }
});
