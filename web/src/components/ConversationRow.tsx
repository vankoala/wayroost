import { Bot, CornerDownRight, Feather } from 'lucide-react';
import type { ConversationSummary } from '../../../shared/protocol';
import { readableBridgeText } from '../bridge';
import { shortTime } from '../format';
import { conversationPath, navigate, parseChatsFilter, useUrl } from '../router';
import { SourceAvatar } from './common';

/** Run by its parent's agent (delegate_task, a Task sub-agent): read-only here. */
export function SubagentTag() {
  return (
    <span className="tag tag-subagent" title="Run by the chat above it; read-only here">
      <Bot size={11} strokeWidth={2.4} /> Sub-agent
    </span>
  );
}

/** "Hermes · in Paseo": a Hermes session running as a Paseo agent. */
export function HermesInPaseoTag() {
  return (
    <span className="tag tag-linked" title="A Hermes session running inside Paseo">
      <Feather size={11} strokeWidth={2.4} /> Hermes · in Paseo
    </span>
  );
}

export function ConversationRow({
  c,
  active,
  needsYou,
  from,
  nested,
  compact,
}: {
  c: ConversationSummary;
  active: boolean;
  needsYou: boolean;
  /** Title of the chat that started this one, when worth showing. */
  from?: string;
  /** Indented under its parent thread. */
  nested?: boolean;
  /** Inside a project card: the folder is already shown, so lead with the agent. */
  compact?: boolean;
}) {
  const filter = parseChatsFilter(useUrl());
  const preview = readableBridgeText(c.preview);
  const detail = compact
    ? [c.source === 'paseo' && !c.hermesInPaseo ? c.agentLabel : undefined, preview].filter(Boolean).join(' · ')
    : (preview ?? c.subtitle ?? '');
  // Started by another chat through the bridge; nested rows already sit under theirs.
  const startedBy = !from && !nested && c.startedBy ? readableBridgeText(c.startedBy.title) : undefined;
  return (
    <button
      type="button"
      className={`row${nested ? ' nested' : ''}`}
      aria-current={active ? 'page' : undefined}
      onClick={() => navigate(conversationPath(c.source, c.id, filter))}
    >
      <SourceAvatar source={c.source} live={c.status === 'running'} linked={c.hermesInPaseo} small={nested} />
      <div className="row-main">
        <div className="row-title">{readableBridgeText(c.title)}</div>
        <div className="row-sub">
          {c.subagent && <SubagentTag />}
          {c.hermesInPaseo && <HermesInPaseoTag />}
          {from ? (
            <span className="from" title={`Started by ${from}`}>
              <CornerDownRight size={12} />
              {/* Another agent's chat through the bridge was "started by"; anything else came "via". */}
              <span className="from-text">
                {c.startedBy ? 'started by' : 'via'} {readableBridgeText(from)}
              </span>
            </span>
          ) : startedBy ? (
            <span className="from">
              <CornerDownRight size={12} />
              <span className="from-text">started by {startedBy}</span>
            </span>
          ) : (
            <span className="row-text">{detail || (compact ? c.agentLabel : '')}</span>
          )}
        </div>
      </div>
      <div className="row-meta">
        <span>{c.updatedAt ? shortTime(c.updatedAt) : ''}</span>
        {needsYou ? (
          <span className="pill approval">Needs you</span>
        ) : c.status === 'running' ? (
          <span className="pill running">Working</span>
        ) : c.status === 'error' ? (
          <span className="pill error">Error</span>
        ) : null}
      </div>
    </button>
  );
}
