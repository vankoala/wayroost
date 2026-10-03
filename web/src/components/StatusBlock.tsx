import { settingsPath } from '../router';
import { UNAVAILABLE_LINE, overallTone, powerDetailLines, usePower } from '../power';
import { Link } from './common';

/**
 * The block pinned to the bottom of the sidebar, and its copy on Home on a phone
 *: green when everything is running, terracotta when something needs
 * attention, red when something is down — plus one plain line. It links to
 * Status & power.
 */
export function StatusBlock({ className = '' }: { className?: string }) {
  const { status, unavailable, sentence } = usePower();
  const live = status && !unavailable;
  const tone = live ? overallTone(status.overall) : 'off';
  // The server's own words when the supervisor isn't answering ("The supervisor isn't running.").
  const line = live ? status.sentence : (sentence ?? UNAVAILABLE_LINE);
  const details = live ? powerDetailLines(status) : [];

  return (
    <Link
      to={settingsPath('status')}
      className={`status-block ${className}`.trim()}
      data-tone={tone}
      aria-label={`Status: ${line}. Open Status and power.`}
    >
      <span className={`pip ${tone}`} aria-hidden="true" />
      <span className="status-lines">
        <strong>{line}</strong>
        {details.map((detail) => (
          <span key={detail} className="status-detail">
            {detail}
          </span>
        ))}
      </span>
    </Link>
  );
}
