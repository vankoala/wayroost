import { isAbsolute } from 'node:path';
import { configCredentialPath } from '../config.js';

export function safetyHelperConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const path = env.WAYROOST_SAFETY_CONFIG ?? configCredentialPath('safety-helper.json', env) ?? '/etc/wayroost/safety-helper.json';
  if (!path || !isAbsolute(path)) throw new Error('Missing absolute WAYROOST_SAFETY_CONFIG.');
  return path;
}
