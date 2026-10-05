import { isDeepStrictEqual } from 'node:util';

export type SettingValue = null | boolean | number | string | SettingValue[] | { [key: string]: SettingValue };
export type SettingPath = readonly (string | number)[];
export type SettingOperation =
  | { type: 'set'; path: SettingPath; value: SettingValue }
  | { type: 'delete'; path: SettingPath };
export type ValuePrecondition = { path: SettingPath; value: SettingValue } | { path: SettingPath; exists: boolean };
export interface FormatEditor {
  parse(source: string): SettingValue;
  edit(source: string, operations: readonly SettingOperation[]): string;
}

export class SettingsWriteError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'SettingsWriteError'; }
}

export function invalidOperation(): never {
  throw new SettingsWriteError('invalid_operation', 'Settings operation has an invalid path or value.');
}

export function validatePath(path: SettingPath): void {
  if (!Array.isArray(path) || path.some(segment => typeof segment !== 'string'
    && !(typeof segment === 'number' && Number.isSafeInteger(segment) && segment >= 0))) invalidOperation();
}

export function validateValue(value: unknown, ancestors = new Set<unknown>()): asserts value is SettingValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || !value || ancestors.has(value)) invalidOperation();
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) invalidOperation();
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) invalidOperation();
      validateValue(value[index], ancestors);
    }
  } else {
    for (const entry of Object.values(value)) validateValue(entry, ancestors);
  }
  ancestors.delete(value);
}

export function valueAt(root: SettingValue, path: SettingPath): { exists: boolean; value?: SettingValue } {
  validatePath(path);
  let value = root;
  for (const segment of path) {
    if (value === null || typeof value !== 'object') return { exists: false };
    if (Array.isArray(value) ? typeof segment !== 'number' : typeof segment !== 'string') return { exists: false };
    if (!Object.hasOwn(value, segment)) return { exists: false };
    value = (value as Record<string | number, SettingValue>)[segment]!;
  }
  return { exists: true, value };
}

export function checkPreconditions(root: SettingValue, preconditions: readonly ValuePrecondition[]): void {
  for (const precondition of preconditions) {
    const current = valueAt(root, precondition.path);
    if ('value' in precondition) validateValue(precondition.value);
    if ('value' in precondition ? !current.exists || !isDeepStrictEqual(current.value, precondition.value) : current.exists !== precondition.exists) {
      throw new SettingsWriteError('precondition_failed', 'A settings value no longer meets its precondition.');
    }
  }
}

export function nestedValue(path: SettingPath, value: SettingValue): SettingValue {
  for (let index = path.length - 1; index >= 0; index--) {
    const segment = path[index]!;
    if (typeof segment === 'number') {
      if (segment !== 0) invalidOperation();
      value = [value];
    } else value = { [segment]: value };
  }
  return value;
}

/** Operations run in order; deleting an array element shifts the following indices. */
export function applyValues(root: SettingValue, operations: readonly SettingOperation[]): SettingValue {
  let result = structuredClone(root);
  for (const operation of operations) {
    validatePath(operation.path);
    if (operation.type !== 'set' && operation.type !== 'delete') invalidOperation();
    if (operation.type === 'set') validateValue(operation.value);
    if (operation.path.length === 0) {
      if (operation.type !== 'set') invalidOperation();
      result = structuredClone(operation.value);
      continue;
    }
    let parent = result;
    for (let index = 0; index < operation.path.length; index++) {
      const segment = operation.path[index]!;
      if (parent === null || typeof parent !== 'object') invalidOperation();
      if (Array.isArray(parent) ? typeof segment !== 'number' || segment > parent.length : typeof segment !== 'string') invalidOperation();
      const record = parent as Record<string | number, SettingValue>;
      const exists = Object.hasOwn(parent, segment);
      if (index === operation.path.length - 1 || !exists) {
        if (operation.type === 'set') {
          Object.defineProperty(parent, segment, { value: nestedValue(operation.path.slice(index + 1), structuredClone(operation.value)),
            writable: true, enumerable: true, configurable: true });
        } else if (exists) {
          if (Array.isArray(parent)) parent.splice(segment as number, 1);
          else delete record[segment];
        }
        break;
      }
      parent = record[segment]!;
    }
  }
  return result;
}
