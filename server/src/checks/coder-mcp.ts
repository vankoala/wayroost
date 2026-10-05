// The coder MCP: which copy of its script each registration names, and whether a
// process started before a move is still running it. Only start times and which of
// the two scripts a process runs are kept here, never its environment.
import { consumerRecord, scriptArgument } from './common.js';
import type { Check } from './engine.js';

const REGISTRATION_KEYS = { hermes: ['mcp_servers', 'coder'], pi: ['mcpServers', 'coder'] } as const;

/** The text a registration's command and arguments make, for matching against a script path. */
function registeredScript(document: Record<string, unknown>, path: readonly string[]): string {
  const entry = path.reduce<unknown>((current, segment) =>
    current !== null && typeof current === 'object' && Object.hasOwn(current, segment) ? (current as Record<string, unknown>)[segment] : undefined, document);
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return '';
  const command = (entry as Record<string, unknown>).command;
  const args = (entry as Record<string, unknown>).args;
  const parts = [typeof command === 'string' ? command : '', ...(Array.isArray(args) ? args.filter((arg): arg is string => typeof arg === 'string') : [])];
  return scriptArgument(parts) ?? '';
}

const minutes = (ms: number): string => `${Math.max(0, Math.round(ms / 60_000))} min`;

const parseTime = (iso: string | undefined): number => (iso === undefined ? 0 : Date.parse(iso) || 0);

export const coderMcpChecks: readonly Check[] = [
  {
    id: 'coder-mcp.registrations',
    requires: ['hermes.coder-mcp', 'pi.mcp', 'gateway.state'],
    unknown: 'The coder MCP registrations could not be read, so their script paths were not compared.',
    run: context => {
      const expected = context.deployment.coderMcp;
      if (!expected) return { state: 'unknown', sentence: 'This PC names no coder MCP scripts, so the registrations were not compared.' };
      const state = context.view('gateway.state').document;
      const moved = consumerRecord(state, 'coder-mcp', 'hermes-config')?.moved === true
        || consumerRecord(state, 'coder-mcp', 'pi-mcp')?.moved === true;
      const wanted = moved ? expected.gatewayCopy : expected.original;
      const wrong = Object.entries(REGISTRATION_KEYS)
        .filter(([name, path]) => {
          const view = name === 'hermes' ? 'hermes.coder-mcp' as const : 'pi.mcp' as const;
          return !context.value(view, path).exists || registeredScript(context.view(view).document, path) !== wanted;
        })
        .map(([name]) => name === 'hermes' ? "Hermes' registration" : "pi's registration");
      if (wrong.length) {
        return {
          state: 'warn',
          sentence: `${wrong.length} coder MCP ${wrong.length === 1 ? 'registration names' : 'registrations name'} a different script from the one ${moved ? 'the move points at' : 'pi and Hermes were moved back to'}.`,
          details: [...wrong, moved ? 'the gateway copy' : 'the original'],
        };
      }
      return { state: 'ok', sentence: `Both coder MCP registrations name ${moved ? 'the gateway copy' : 'the original script'}.`, details: ["Hermes' registration", "pi's registration"] };
    },
  },
  {
    id: 'coder-mcp.processes',
    requires: ['coderProcesses', 'gateway.state'],
    unknown: 'Running coder MCP processes could not be listed, so none was counted.',
    run: context => {
      const state = context.view('gateway.state').document;
      const records = [consumerRecord(state, 'coder-mcp', 'hermes-config'), consumerRecord(state, 'coder-mcp', 'pi-mcp')];
      const moved = records.some(record => record?.moved === true);
      const movedAt = Math.max(...records.map(record => parseTime(record?.movedAt)));
      const processes = context.coderProcesses();
      const fromCopy = processes.filter(process => process.script === 'gateway-copy');
      if (!moved) {
        // A move back leaves the old processes running the gateway copy until they exit.
        if (!fromCopy.length) return { state: 'ok', sentence: 'No coder MCP process runs from the gateway copy.', details: [`${processes.length} running`] };
        return {
          state: 'warn',
          sentence: `${fromCopy.length} coder MCP ${fromCopy.length === 1 ? 'process still runs' : 'processes still run'} from the gateway copy, although it was moved back.`,
          details: [`oldest ${minutes(context.at - Math.min(...fromCopy.map(process => process.startedAt)))} old`],
        };
      }
      const before = processes.filter(process => process.script !== 'gateway-copy' || (movedAt > 0 && process.startedAt < movedAt));
      if (!before.length) {
        return { state: 'ok', sentence: 'Every coder MCP process running from the gateway copy started after the move.', details: [`${fromCopy.length} running from it`] };
      }
      return {
        state: 'warn',
        sentence: `${before.length} coder MCP ${before.length === 1 ? 'process started' : 'processes started'} before the move and still run the old copy.`,
        details: [`oldest ${minutes(context.at - Math.min(...before.map(process => process.startedAt)))} old`],
      };
    },
  },
];
