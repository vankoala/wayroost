const warned = new Set<string>();

/** Prefer Wayroost names; warn once, without ever logging an environment value. */
export function wayroostEnv(
  suffix: string,
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = console.warn,
): string | undefined {
  const name = `WAYROOST_${suffix}`;
  const legacy = `SIGNALBOX_${suffix}`;
  if (env[name] !== undefined) return env[name];
  if (env[legacy] !== undefined) {
    if (!warned.has(legacy)) {
      warned.add(legacy);
      warn(`Wayroost: ${legacy} is deprecated; use ${name}.`);
    }
    return env[legacy];
  }
  return undefined;
}
