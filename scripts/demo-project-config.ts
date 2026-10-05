import type { ProjectConfigFinding, ProjectConfigOwner } from '../server/src/hub/project-config.js';
import type { ProjectConfigScanner } from '../server/src/hub/project-config-notice.js';

// The screens are photographed against demo folders, which are names rather than directories on
// this machine. So instead of reading a folder, the visual check is told what each one holds.

const found = (
  path: string,
  kind: ProjectConfigFinding['kind'],
  providers: ProjectConfigOwner[],
  reason: string,
): ProjectConfigFinding => ({ path, kind, providers, reason });

/** The webapp demo folder configures its own agents; the others say nothing. */
export const demoProjectConfig: ProjectConfigScanner = (folder) =>
  folder === '/home/me/code/webapp'
    ? {
        findings: [
          found('.claude/settings.json', 'grants-permissions', ['claude', 'copilot'], 'Can grant tool permissions or skip approval.'),
          found('.claude/hooks', 'runs-hooks', ['claude', 'copilot'], 'Can run hooks before or after tool use.'),
          found('paseo.json', 'runs-code', ['paseo'], 'Can load plugins or start a local command.'),
          found('AGENTS.md', 'instructions', ['claude', 'codex'], 'Instruction text only.'),
        ],
        errors: [],
      }
    : { findings: [], errors: [] };
