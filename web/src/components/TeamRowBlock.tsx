import { useStore } from '../store';
import { ROLES, roleStates } from '../roles';
import { TeamRow } from './RoleTile';

/**
 * The "Your team" row: role tiles with a state badge. In M1 a role's state is
 * read from the engine it runs on (see web/src/roles.ts).
 */
export function TeamRowBlock({ size = 28 }: { size?: 28 | 32 }) {
  const conversations = useStore((s) => s.conversations);
  const approvals = useStore((s) => s.approvals);
  const states = roleStates(Object.values(conversations), Object.values(approvals));
  return <TeamRow roles={ROLES} states={states} size={size} />;
}
