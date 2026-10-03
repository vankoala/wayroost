import { ROLES, ROLE_BY_ID, ROLE_STATE_LABEL, roleStates, type RoleId } from '../roles';
import { useStore } from '../store';
import { Page } from '../components/common';
import { RoleTile } from '../components/RoleTile';

/**
 * Team: the role tiles and one line each. M2 builds the real Team screens;
 * M1 shows the cast so the route and the sidebar row have somewhere
 * to go. A tile's state comes from web/src/roles.ts.
 */
export function TeamPage({ role }: { role?: string }) {
  const conversations = useStore((s) => s.conversations);
  const approvals = useStore((s) => s.approvals);
  const states = roleStates(Object.values(conversations), Object.values(approvals));
  const asked = role && role in ROLE_BY_ID ? (role as RoleId) : null;

  return (
    <Page className="page-team" title="Team">
      <p className="page-lead">
        The people who do the work, and what each one is for. You talk to the Manager; it hands the rest out.
      </p>
      <div className="team-grid">
        {ROLES.map((item) => (
          <article
            key={item.id}
            className={`team-card${asked === item.id ? ' asked' : ''}`}
            aria-label={`${item.name}, ${ROLE_STATE_LABEL[states[item.id]]}`}
          >
            <RoleTile role={item} state={states[item.id]} size={44} />
            <div className="team-card-text">
              <h2>{item.name}</h2>
              <p>{item.about}</p>
              <p className="team-card-state">{ROLE_STATE_LABEL[states[item.id]]}</p>
            </div>
          </article>
        ))}
      </div>
      <p className="page-note">
        Models, instructions and limits per role come with the Team settings in the next build.
      </p>
    </Page>
  );
}
