const LABELS = {
  now: 'Applies now',
  'next-chat': 'From the next chat',
  restart: 'Needs a restart',
};

/** When a changed setting takes effect; page links and read-only rows have no timing. */
export function SettingsTiming({ timing }: { timing: keyof typeof LABELS }) {
  return <small className="setting-timing">{LABELS[timing]}</small>;
}
