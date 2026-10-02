import { TriangleAlert } from 'lucide-react';
import { SCHEDULE_TOOL_LEVELS, type ScheduleToolLevel, type ScheduleTools } from '../../../shared/protocol';

// "What it can use" for Hermes scheduled jobs and mail triggers. Cron runs are unattended and
// Hermes approves their tool calls itself, so the choice starts at the least: "Nothing".

export const TOOL_LABEL: Record<ScheduleToolLevel, string> = {
  none: 'Nothing — it only writes',
  web: 'Web search',
  travel: 'Web + flights & maps',
  all: 'Everything (full access)',
};

const TOOL_HINT: Record<ScheduleToolLevel, string> = {
  none: "Writes from its instructions and skills. Can't look anything up or change anything.",
  web: 'Searches the web and reads pages.',
  travel: 'The web, plus Kiwi flight search and Mapbox maps, directions and live traffic.',
  all: "Commands, files, the browser, the Windows desktop and every connected app: Hermes' standard set, and it overrides any limit set in Hermes.",
};

/** "Web search", "Custom: terminal, file, web + connected apps", "Hermes decides". */
export function toolsLabel(tools: ScheduleTools): string {
  if (tools.level === 'default') return "Hermes decides (its setting for scheduled jobs)";
  if (tools.level === 'custom') {
    const list = tools.toolsets ?? [];
    const named = list.filter((t) => t !== 'no_mcp');
    return `Custom: ${named.join(', ')}${list.includes('no_mcp') ? '' : ' + connected apps'}`;
  }
  return TOOL_LABEL[tools.level];
}

/** Worth a warning: full access, or Hermes' own setting, which Signalbox can't see (it may allow everything). */
export function toolsCaution(tools: ScheduleTools): boolean {
  return tools.full || tools.level === 'default';
}

/** The level a job's form starts at: its own level, or "keep" for a setting the levels don't cover. */
export function initialTools(tools: ScheduleTools | undefined, fallback: ScheduleToolLevel): ScheduleToolLevel | 'keep' {
  if (!tools) return fallback;
  return tools.level === 'custom' || tools.level === 'default' ? 'keep' : tools.level;
}

export function ToolsField({
  name,
  value,
  onChange,
  current,
  suggestion,
}: {
  /** Radio group name (unique per form). */
  name: string;
  value: ScheduleToolLevel | 'keep';
  onChange: (value: ScheduleToolLevel | 'keep') => void;
  /** The job's present setting: offered as "Keep as it is" when it isn't one of the levels. */
  current?: ScheduleTools;
  /** The job builder's reason for its pick. */
  suggestion?: string;
}) {
  const keep = current && (current.level === 'custom' || current.level === 'default');
  return (
    <fieldset className="tools-field">
      <legend>What it can use</legend>
      {keep && (
        <label className="tools-option">
          <input type="radio" name={name} value="keep" checked={value === 'keep'} onChange={() => onChange('keep')} />
          <span>
            Keep as it is
            <span className="muted tools-hint">{toolsLabel(current)}</span>
          </span>
        </label>
      )}
      {SCHEDULE_TOOL_LEVELS.map((level) => (
        <label key={level} className="tools-option">
          <input type="radio" name={name} value={level} checked={value === level} onChange={() => onChange(level)} />
          <span>
            {TOOL_LABEL[level]}
            <span className="muted tools-hint">{TOOL_HINT[level]}</span>
          </span>
        </label>
      ))}
      {suggestion && <p className="muted tools-hint">Suggested because: {suggestion}</p>}
      {value === 'keep' && current?.level === 'default' ? (
        <p className="tools-warning">
          <TriangleAlert size={14} /> Hermes' own setting decides, and Signalbox can't see it. If Hermes sets no limit, that's
          everything. Pick one above to be sure.
        </p>
      ) : (
        (value === 'all' || (value === 'keep' && current?.full)) && (
          <p className="tools-warning">
            <TriangleAlert size={14} /> It runs while you're away and Hermes approves every step itself, so mail or web
            pages it reads could steer it. Choose this only when the job truly needs it.
          </p>
        )
      )}
    </fieldset>
  );
}
