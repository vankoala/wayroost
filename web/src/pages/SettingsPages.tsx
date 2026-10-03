import { ArchivedSheet } from '../components/ArchivedSheet';
import { ConnectorsSheet } from '../components/ConnectorsSheet';
import { SchedulesSheet } from '../components/SchedulesSheet';
import { SkillsSheet } from '../components/SkillsSheet';
import { goBack, goBackTo, settingsPath } from '../router';

/**
 * The screens that used to be sheets, opened as pages with their own URLs.
 * Sheets are left for quick actions. Their markup and behaviour are
 * unchanged — only the container is a page now, and "back" leaves it the way a page
 * does.
 */

/** Settings → Your AI → Connectors. */
export function ConnectorsPage() {
  return <ConnectorsSheet as="page" onClose={() => goBackTo(settingsPath())} />;
}

/** Settings → Your AI → Skills. */
export function SkillsPage() {
  return <SkillsSheet as="page" onClose={() => goBackTo(settingsPath())} />;
}

/** Settings → Work → Archived threads. */
export function ArchivedPage() {
  return <ArchivedSheet as="page" onClose={() => goBackTo(settingsPath())} />;
}

/** Schedule: every job Hermes and Paseo runs, and the AI job builder. */
export function SchedulePage({ focus, startNew }: { focus?: string; startNew: boolean }) {
  return (
    <SchedulesSheet
      as="page"
      title="Schedule"
      onClose={goBack}
      {...(focus ? { focus } : {})}
      startNew={startNew}
    />
  );
}
