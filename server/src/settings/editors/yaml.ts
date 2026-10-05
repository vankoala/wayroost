import { CST, Lexer, isAlias, isCollection, isMap, isNode, isScalar, parseAllDocuments, parseDocument, visit,
  type SchemaOptions } from 'yaml';
import { applyValues, nestedValue, SettingsWriteError, validateValue, type FormatEditor, type SettingValue } from './types.js';

const numericTags: SchemaOptions['customTags'] = tags => tags.map(tag => {
  if (typeof tag === 'string' || tag.collection) return tag;
  if (tag.tag === 'tag:yaml.org,2002:int' && !tag.format) return { ...tag,
    test: /^(?:[+-]?(?:0|[1-9][0-9_]*)|[+-]_[0-7_]*)$/,
    resolve(...args: Parameters<typeof tag.resolve>) {
      const [source, onError, options] = args;
      if (!/^[+-]_/.test(source)) return tag.resolve(source, onError, options);
      const digits = source.slice(1).replace(/_/g, '');
      if (!digits) throw new Error();
      // Leading zeros still select octal after the consumer removes underscores.
      const value = BigInt(digits.startsWith('0') ? `0o${digits}` : digits) * (source[0] === '-' ? -1n : 1n);
      return options.intAsBigInt ? value : Number(value);
    } };
  if (tag.tag !== 'tag:yaml.org,2002:float') return tag;
  if (tag.format === 'EXP') return { ...tag, test: /^[+-]?(?:[0-9][0-9_]*\.[0-9_]*|\.[0-9][0-9_]*)[eE][+-][0-9]+$/ };
  if (tag.format || tag.test?.test('.inf')) return tag;
  // A bare dot or a signed leading dot is a string to the YAML 1.1 consumer.
  return { ...tag, test: /^(?:[+-]?[0-9][0-9_]*\.[0-9_]*|\.[0-9][0-9_]*)$/ };
});
const options = { version: '1.1', intAsBigInt: true, prettyErrors: false, logLevel: 'silent', uniqueKeys: true,
  customTags: numericTags, keepSourceTokens: true } as const;

function unsafePlain(source: string): boolean {
  return /^[yYnN]$/.test(source) || /^\._/.test(source)
    || /^[+-]?(?:[0-9][0-9_]*(?::[0-9_]+)+(?:\.[0-9_]*)?|0[0-9_]*[89][0-9_]*)$/.test(source)
    || /^[+-]\.(?=[0-9_]*[0-9])[0-9_]+/.test(source)
    || (/^[+-]?(?:[0-9][0-9_]*(?:\.[0-9_]*)?|\.[0-9_]+)[eE][+-]?[0-9]+$/.test(source)
      && (!source.includes('.') || !/[eE][+-][0-9]+$/.test(source)));
}

function unsupportedYaml(): never {
  throw new SettingsWriteError('unsupported_yaml', "Settings file uses YAML features Wayroost won't edit automatically.");
}

function document(source: string) {
  try {
    const documents = parseAllDocuments(source, options);
    if (documents.length > 1) unsupportedYaml();
    const result = documents[0] ?? parseDocument(source, options);
    visit(result, (_key, node) => {
      if (!isNode(node)) return;
      if (isAlias(node)) unsupportedYaml();
      if (node.tag || node.anchor) unsupportedYaml();
      if (isMap(node)) for (const pair of node.items) {
        if (pair.srcToken?.start.some(token => token.type === 'explicit-key-ind')
          || !isScalar(pair.key) || (pair.key.type === 'PLAIN' && pair.key.source === '<<')) unsupportedYaml();
      }
    });
    if (result.errors.length || result.warnings.length) throw new Error();
    if (result.directives?.yaml.version !== '1.1') throw new Error();
    result.setSchema('1.1', { customTags: numericTags });
    result.schema.tags = result.schema.tags.filter(tag => tag.tag !== 'tag:yaml.org,2002:merge').map(tag => {
      const stringify = tag.stringify;
      if (!stringify || !['tag:yaml.org,2002:int', 'tag:yaml.org,2002:float'].includes(tag.tag)) return tag;
      return { ...tag, stringify(node, context, onComment, onChompKeep) {
        const output = stringify(node, context, onComment, onChompKeep);
        // Scientific notation needs a decimal mantissa and a signed exponent for the consumer.
        const exponential = output.match(/^([+-]?[0-9]+(?:\.[0-9]+)?)[eE]([+-]?[0-9]+)$/);
        if (!exponential) return output;
        const mantissa = exponential[1]!.includes('.') ? exponential[1] : `${exponential[1]}.0`;
        const exponent = /^[+-]/.test(exponential[2]!) ? exponential[2] : `+${exponential[2]}`;
        return `${mantissa}e${exponent}`;
      } };
    });
    visit(result, {
      Scalar(_key, node) {
        // These plain spellings differ between YAML 1.1 readers or change on serialization.
        const source = node.source ?? '';
        if (node.type === 'PLAIN' && unsafePlain(source)) throw new Error();
        if (typeof node.value === 'bigint') {
          const number = Number(node.value);
          if (!Number.isSafeInteger(number)) throw new Error();
          node.value = number;
        }
      },
      Map(_key, node) {
        for (const pair of node.items) {
          if (!isScalar(pair.key) || typeof pair.key.value !== 'string') throw new Error();
        }
      },
    });
    const value: unknown = result.toJS();
    validateValue(value);
    return { result, value };
  } catch (error) {
    if (error instanceof SettingsWriteError && error.code === 'unsupported_yaml') throw error;
    throw new SettingsWriteError('parse_failed', 'Settings file is not valid YAML.');
  }
}

function commentLines(source: string): (string | undefined)[] {
  let normalized = '';
  let scalar = false;
  let line = 0;
  const comments = new Set<number>();
  for (const token of new Lexer().lex(source)) {
    if (token === CST.SCALAR) { scalar = true; continue; }
    if (token === CST.DOCUMENT || token === CST.FLOW_END) continue;
    // Scalar contents may include hashes that are part of the value.
    if (!scalar && token.startsWith('#') && /(\S) +$/.test(normalized)) {
      normalized = normalized.replace(/(\S) +$/, '$1 ');
      comments.add(line);
    }
    normalized += token;
    line += token.split('\n').length - 1;
    scalar = false;
  }
  return normalized.split('\n').map((value, index) => comments.has(index) ? value : undefined);
}

function restoreCommentSpacing(source: string, output: string): string {
  const original = source.split('\n');
  const rendered = output.split('\n');
  if (original.length !== rendered.length) return output;
  const oldLines = commentLines(source);
  const newLines = commentLines(output);
  return rendered.map((line, index) => oldLines[index] !== undefined && oldLines[index] === newLines[index]
    ? original[index]! : line).join('\n');
}

export const yamlEditor: FormatEditor = {
  parse(source): SettingValue { return document(source).value; },
  edit(source, operations) {
    const { result, value } = document(source);
    applyValues(value, operations);
    if (!operations.length) return source;
    for (const operation of operations) {
      if (operation.type === 'delete') {
        if (result.hasIn(operation.path)) result.deleteIn(operation.path);
        continue;
      }
      let path = operation.path;
      let replacement = operation.value;
      for (let depth = 1; depth < path.length; depth++) if (!result.hasIn(path.slice(0, depth))) {
        replacement = nestedValue(path.slice(depth), replacement);
        path = path.slice(0, depth);
        break;
      }
      const previous = result.getIn(path, true);
      if (isScalar(previous) && typeof previous.value === typeof operation.value
        && (operation.value === null || typeof operation.value !== 'object')) {
        previous.value = operation.value;
        if (typeof operation.value === 'number' && !Number.isInteger(operation.value)) previous.format = undefined;
      } else {
        const next = result.createNode(replacement);
        if (isNode(previous)) {
          next.comment = previous.comment;
          next.commentBefore = previous.commentBefore;
          next.spaceBefore = previous.spaceBefore;
          if (isCollection(previous) && isCollection(next)) next.flow = previous.flow;
          if (isScalar(previous) && isScalar(next) && typeof previous.value === 'string' && typeof next.value === 'string') next.type = previous.type;
        }
        result.setIn(path, next);
      }
    }
    visit(result, {
      Pair(_key, pair) {
        if (typeof pair.key === 'string' && (pair.key === '<<' || pair.key === '=' || unsafePlain(pair.key))) {
          pair.key = result.createNode(pair.key);
        }
      },
      Scalar(_key, node) {
        // YAML 1.1 readers give these plain strings special tags.
        if (typeof node.value === 'string' && (node.value === '<<' || node.value === '=' || unsafePlain(node.value))
          && node.type !== 'QUOTE_SINGLE' && node.type !== 'QUOTE_DOUBLE') {
          node.type = 'QUOTE_DOUBLE';
        }
      },
    });
    const indent = source.match(/\n( +)\S/)?.[1]?.length ?? 2;
    const flowPadding = source.match(/[\[{]([ \t]*)[^\s\]}]/)?.[1];
    let output: string;
    try { output = result.toString({ indent, lineWidth: 0, flowCollectionPadding: flowPadding === undefined || flowPadding.length > 0 }); }
    catch { throw new SettingsWriteError('invalid_operation', 'YAML operation cannot preserve the document structure.'); }
    if (!source.endsWith('\n')) output = output.replace(/\n$/, '');
    if (source.includes('\r\n')) output = output.replace(/\n/g, '\r\n');
    return restoreCommentSpacing(source, output);
  },
};
