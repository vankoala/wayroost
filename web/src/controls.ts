import type { ControlOption, ConversationControl, ConversationControls } from '../../shared/protocol';

// The model, reasoning and mode chips above the message box: what each chip
// says, how the picker groups and filters options, and the context ring's numbers.

/** More options than this get a filter box in the picker. */
export const FILTER_ABOVE = 8;

export function selectedOption(control: ConversationControl): ControlOption | undefined {
  return control.value === null ? undefined : control.options.find((o) => o.id === control.value);
}

/** The picked option, else what the backend says is in use (e.g. a model set elsewhere), else the setting's name. */
export function chipText(control: ConversationControl): string {
  return selectedOption(control)?.label ?? control.valueLabel ?? control.label;
}

/** "950", "18.2k", "200k", "1M". */
export function formatTokens(n: number): string {
  const short = (value: number, unit: string) => `${value < 100 ? String(Number(value.toFixed(1))) : Math.round(value)}${unit}`;
  if (n < 1000) return String(Math.round(n));
  if (n < 999_500) return short(n / 1000, 'k');
  return short(n / 1_000_000, 'M');
}

/** Share of the context window in use, 0–100. */
export function contextShare(context: NonNullable<ConversationControls['context']>): number {
  if (!(context.max > 0)) return 0;
  return Math.min(100, Math.max(0, Math.round((context.used / context.max) * 100)));
}

export interface OptionGroup {
  /** Section header; null for options without a group. */
  label: string | null;
  options: ControlOption[];
}

/** Options matching the filter, in sections by group (in the order the backend gave them). */
export function pickerGroups(options: ControlOption[], filter = ''): OptionGroup[] {
  const q = filter.trim().toLowerCase();
  const shown = q
    ? options.filter((o) => [o.label, o.description, o.group].some((text) => text?.toLowerCase().includes(q)))
    : options;
  const groups: OptionGroup[] = [];
  for (const option of shown) {
    const label = option.group ?? null;
    let group = groups.find((g) => g.label === label);
    if (!group) {
      group = { label, options: [] };
      groups.push(group);
    }
    group.options.push(option);
  }
  return groups;
}
