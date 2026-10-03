// The approval card recognises only these argument shapes. These grammars
// describe visible work, not a guarantee about a program's installed code.
// In particular, package scripts still run project code and get Medium.

interface Grammar {
  flags?: RegExp;
  values?: Record<string, (value: string) => boolean>;
  operand?: (value: string) => boolean;
  min?: number;
  max?: number;
}

const literal = (value: string) => value.length > 0 && !value.includes('\0');
const number = (value: string) => /^\d+$/.test(value);
const path = (value: string) => literal(value);
const url = (value: string) => /^https?:\/\/[^\s]+$/.test(value);
const revision = (value: string) => /^[A-Za-z0-9_][A-Za-z0-9_./~^:@+-]*$/.test(value);
const script = (value: string) => /^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/.test(value);
const packageName = (value: string) => /^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+(?:@[A-Za-z0-9_.^~*-]+)?$/.test(value);

/** Options and literal operands, including values attached to their option. */
function operands(args: string[], grammar: Grammar): string[] | undefined {
  const found: string[] = [];
  let options = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (options && arg === '--') {
      options = false;
      continue;
    }
    if (options && arg.startsWith('-') && arg !== '-') {
      if (grammar.flags?.test(arg)) continue;
      const equals = arg.startsWith('--') ? arg.indexOf('=') : -1;
      const name = equals >= 0 ? arg.slice(0, equals) : arg;
      const accepts = grammar.values?.[name];
      if (!accepts) return undefined;
      const value = equals >= 0 ? arg.slice(equals + 1) : args[++i];
      if (value === undefined || !accepts(value)) return undefined;
    } else {
      if (!grammar.operand?.(arg)) return undefined;
      found.push(arg);
    }
  }
  return found.length >= (grammar.min ?? 0) && found.length <= (grammar.max ?? Infinity) ? found : undefined;
}

const FILES: Record<string, Grammar> = {
  pwd: { flags: /^-[LP]$/, max: 0 },
  cd: { flags: /^-[LP]$/, operand: path, max: 1 },
  ls: { flags: /^-[aAlhRrtSdiF1]+$|^--(?:all|almost-all|human-readable|recursive|directory|color=never)$/, operand: path },
  cat: { flags: /^-[AbEnstTv]+$|^--(?:number|number-nonblank|squeeze-blank|show-ends|show-tabs|show-all)$/, operand: path },
  head: { flags: /^-[qv]+$|^-n\d+$/, values: { '-n': number, '--lines': number, '-c': number, '--bytes': number }, operand: path },
  tail: { flags: /^-[qvfF]+$|^-n\d+$/, values: { '-n': number, '--lines': number, '-c': number, '--bytes': number }, operand: path },
  wc: { flags: /^-[clmwL]+$|^--(?:bytes|chars|lines|words|max-line-length)$/, operand: path },
  grep: {
    flags: /^-[EFGivnwclqorshH]+$|^--(?:ignore-case|invert-match|line-number|fixed-strings|extended-regexp|recursive)$/,
    values: { '-e': literal, '--regexp': literal, '-f': path, '--file': path, '-m': number, '--max-count': number }, operand: literal,
  },
  rm: { flags: /^-[rRfivd]+$|^--(?:recursive|force|verbose|dir|interactive|rec|for)$/, operand: path, min: 1 },
  rmdir: { flags: /^-[pv]+$|^--(?:parents|verbose|ignore-fail-on-non-empty)$/, operand: path, min: 1 },
  mkdir: { flags: /^-[pv]+$|^--(?:parents|verbose)$/, values: { '-m': (v) => /^[0-7]{3,4}$/.test(v), '--mode': (v) => /^[0-7]{3,4}$/.test(v) }, operand: path, min: 1 },
  cp: { flags: /^-[aRrpinv]+$|^--(?:archive|recursive|preserve|no-clobber|verbose)$/, operand: path, min: 2 },
  mv: { flags: /^-[inv]+$|^--(?:interactive|no-clobber|verbose)$/, operand: path, min: 2 },
  touch: { flags: /^-[acm]+$|^--(?:no-create)$/, operand: path, min: 1 },
  chmod: { flags: /^-[vfc]+$|^--(?:verbose|silent|quiet|changes)$/, operand: literal, min: 2 },
  chown: { flags: /^-[vfc]+$|^--(?:verbose|silent|quiet|changes)$/, operand: literal, min: 2 },
};

const GIT: Record<string, Grammar> = {
  status: {
    flags: /^-[sb]+$|^-u(?:no|normal|all)$|^--(?:short|branch|show-stash|porcelain(?:=v[12])?)$/,
    values: { '--untracked-files': (v) => /^(?:no|normal|all)$/.test(v) },
  },
  diff: {
    flags: /^-[pw]+$|^-U\d+$|^--(?:stat|numstat|shortstat|name-only|name-status|check|cached|staged|no-ext-diff|no-textconv|color=never)$/,
    values: { '-U': number, '--unified': number }, operand: revision,
  },
  log: {
    flags: /^--(?:oneline|stat|graph|all|no-merges|first-parent|reverse|no-decorate|decorate(?:=(?:short|full|no))?)$|^-n\d+$/,
    values: { '-n': number, '--max-count': number }, operand: revision,
  },
  show: {
    flags: /^-[ps]+$|^--(?:stat|name-only|name-status|oneline|no-ext-diff|no-textconv|color=never)$/, operand: revision,
  },
};

/** Read-only subcommands; no global config, pager, editor, alias or execution options. */
function git(args: string[]): boolean {
  const subcommand = args[0] ?? '';
  if (!Object.hasOwn(GIT, subcommand)) return false;
  const grammar = GIT[subcommand]!;
  const rest = args.slice(1);
  const separator = rest.indexOf('--');
  const before = separator < 0 ? rest : rest.slice(0, separator);
  return operands(before, grammar) !== undefined && (separator < 0 || rest.slice(separator + 1).every(path));
}

/** No exec, dlx, arbitrary options, or options passed through to a script. */
function packages(args: string[]): boolean {
  const [sub, ...rest] = args;
  if (/^(?:test|t)$/.test(sub ?? '')) return rest.length === 0;
  if (/^(?:run|run-script)$/.test(sub ?? '')) return rest.length === 1 && script(rest[0]!);
  if (/^(?:install|i|add|ci)$/.test(sub ?? '')) {
    const installed = operands(rest, {
      flags: /^-D$|^--(?:save-dev|save-exact|ignore-scripts|frozen-lockfile)$/, operand: packageName,
    });
    return installed !== undefined && (sub !== 'ci' || installed.length === 0);
  }
  return false;
}

/** Search paths and predicates with no execution, mutation or output-file actions. */
function find(args: string[]): boolean {
  let i = 0;
  while (i < args.length && !args[i]!.startsWith('-')) {
    if (!path(args[i++]!)) return false;
  }
  if (i === 0) return false;
  for (; i < args.length; i++) {
    const arg = args[i]!;
    if (/^-(?:print|print0|empty|a|and|o|or)$/.test(arg)) continue;
    const value = args[++i];
    if (value === undefined) return false;
    if (/^-(?:name|iname|path|ipath)$/.test(arg) && literal(value)) continue;
    if (arg === '-type' && /^[fdl]$/.test(value)) continue;
    if (/^-(?:maxdepth|mindepth)$/.test(arg) && number(value)) continue;
    return false;
  }
  return true;
}

/** Literal text and supported conversions; %n, %b and %(...) interpret more input. */
function printfFormat(format: string): boolean {
  for (let i = 0; i < format.length; i++) {
    if (format[i] !== '%') continue;
    if (format[i + 1] === '%') {
      i++;
      continue;
    }
    let end = i + 1;
    while (/[-+ #0']/.test(format[end] ?? '')) end++;
    if (format[end] === '*') end++;
    else while (/[0-9]/.test(format[end] ?? '')) end++;
    if (format[end] === '.') {
      end++;
      if (format[end] === '*') end++;
      else while (/[0-9]/.test(format[end] ?? '')) end++;
    }
    if (!/[diouxXfFeEgGaAcsqQ]/.test(format[end] ?? '')) return false;
    i = end;
  }
  return true;
}

/** A per-program grammar, applied to every command's actual arguments. */
export function supportedCommand(program: string, args: string[]): boolean {
  if (program === ':') return true;
  if (program === 'true' || program === 'false') return args.length === 0;
  if (program === 'echo') return !args.some((arg) => /^-[neE]+$/.test(arg) && arg !== '-n');
  if (program === 'printf') {
    // A literal format without %n (variable assignment), %b or %(...) (more
    // interpretation). Other words are data, even when they look like flags.
    return args.length > 0 && !args[0]!.startsWith('-') && printfFormat(args[0]!);
  }
  if (program === 'git') return git(args);
  if (program === 'npm' || program === 'pnpm' || program === 'yarn') return packages(args);
  if (program === 'find') return find(args);
  if (program === 'curl' || program === 'wget') {
    const urls = operands(args, program === 'curl' ? {
      flags: /^-[fsSLI]+$|^--(?:fail|silent|show-error|location|head)$/, values: { '-o': path, '--output': path }, operand: url,
    } : {
      flags: /^-[q]+$|^--(?:quiet)$/, values: { '-O': path, '--output-document': path }, operand: url,
    });
    return urls !== undefined && urls.length > 0;
  }
  const grammar = FILES[program];
  if (!grammar) return false;
  const given = operands(args, grammar);
  if (given === undefined) return false;
  if (program === 'chmod') return /^[0-7]{3,4}$|^[ugoa]*[+=-][rwxXstugo]+(?:,[ugoa]*[+=-][rwxXstugo]+)*$/.test(given[0]!);
  if (program === 'chown') return /^[A-Za-z_][A-Za-z0-9_-]*(?::[A-Za-z_][A-Za-z0-9_-]*)?$/.test(given[0]!);
  return true;
}
