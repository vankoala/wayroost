import type { CommandCatalog, Source } from '../../shared/protocol';
import { api } from './api';

// "/" command catalogs, fetched the first time "/" is typed and kept for a
// few minutes. A failed fetch isn't kept, and neither is an empty list (an
// agent that has just started may not have reported its commands yet), so the
// next "/" asks again.

const TTL_MS = 5 * 60_000;
const cache = new Map<string, { at: number; catalog: Promise<CommandCatalog> }>();

function cached(key: string, load: () => Promise<CommandCatalog>): Promise<CommandCatalog> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.catalog;
  const catalog = load();
  cache.set(key, { at: Date.now(), catalog });
  const forget = () => {
    if (cache.get(key)?.catalog === catalog) cache.delete(key);
  };
  catalog.then((c) => {
    if (!c.commands.length) forget();
  }, forget);
  return catalog;
}

/** Commands and skills offered in a conversation. */
export const conversationCommands = (source: Source, id: string) =>
  cached(`${source}:${id}`, () => api.commands(source, id));

/** Commands and skills for a Hermes chat that doesn't exist yet. */
export const newHermesChatCommands = () => cached('hermes:new', () => api.hermesCommands());
