import { Check, Code, Flag, MessageSquare, Phone, Search, ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { roleTileName, type Role, type RoleId, type RoleState } from '../roles';
import { Link } from './common';

// A role tile: a rounded square in the role colour, a glyph in --role-glyph,
// and a state badge on the corner. Never put words on a tile: the glyph contrast is
// AA for graphics, not for text.

const GLYPHS: Record<RoleId, LucideIcon> = {
  manager: Flag,
  agent: MessageSquare,
  coder: Code,
  reviewer: ShieldCheck,
  scout: Search,
  voice: Phone,
};

/** 28 in a feed, 32 in a list or the sidebar, 44 on the Team page, 64 on a role page. */
export type RoleTileSize = 28 | 32 | 44 | 64;

const BADGES: Partial<Record<RoleState, ReactNode>> = {
  needs: '!',
  stuck: '×',
  finished: <Check size={9} strokeWidth={3} aria-hidden="true" />,
};

export function RoleTile({
  role,
  state,
  size = 32,
  href,
}: {
  role: Role;
  state: RoleState;
  size?: RoleTileSize;
  /** A tile that opens something (the Team page, a role's own page in M2). */
  href?: string;
}) {
  const Glyph = GLYPHS[role.id];
  const name = roleTileName(role, state);
  const inner = (
    <>
      <Glyph strokeWidth={2.2} aria-hidden="true" />
      {state !== 'idle' && (
        <span className={`role-badge ${state}`} aria-hidden="true">
          {BADGES[state]}
        </span>
      )}
    </>
  );
  const className = `role-tile role-${role.id} role-size-${size}`;
  return href ? (
    <Link className={className} to={href} aria-label={name} title={role.name}>
      {inner}
    </Link>
  ) : (
    <span className={className} role="img" aria-label={name} title={name}>
      {inner}
    </span>
  );
}

/** The "Your team" row in the sidebar (and on Home on a phone) — six tiles, nothing else. */
export function TeamRow({ roles, states, size }: { roles: readonly Role[]; states: Record<RoleId, RoleState>; size: RoleTileSize }) {
  return (
    <div className="team-row" aria-label="Your team">
      {roles.map((role) => (
        <RoleTile key={role.id} role={role} state={states[role.id]} size={size} href={`/team?role=${role.id}`} />
      ))}
    </div>
  );
}
