import type { AppNotification, Approval, ConversationDetail, ConversationSummary, ListResponse, ServerEvent } from './protocol.js';

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string';
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const oneOf = (value: unknown, values: readonly string[]) => text(value) && values.includes(value);
const optional = (value: unknown, valid: (value: unknown) => boolean) => value === undefined || valid(value);
const boolean = (value: unknown) => typeof value === 'boolean';
const source = (value: unknown) => oneOf(value, ['hermes', 'paseo']);
const reference = (value: unknown): value is Record<string, unknown> => record(value) && source(value.source) && text(value.id);

/** Validate every nested approval field before shared descriptions, toasts or the tray. */
export function isApproval(value: unknown): value is Approval {
  return reference(value) && text(value.conversationId) && oneOf(value.kind, ['permission', 'question', 'secret']) &&
    text(value.title) && finite(value.createdAt) && optional(value.detail, text) && optional(value.filePath, text) &&
    optional(value.progress, text) && optional(value.detailTruncated, boolean) && optional(value.allowText, boolean) &&
    optional(value.multiSelect, boolean) && optional(value.detailKind, (kind) => oneOf(kind, ['command', 'edit', 'write', 'read', 'fetch', 'other'])) &&
    optional(value.secret, (secret) => record(secret) && oneOf(secret.input, ['password', 'code', 'login']) && optional(secret.confirm, boolean)) &&
    Array.isArray(value.options) && value.options.every((option: unknown) => record(option) && text(option.id) && text(option.label) &&
      oneOf(option.kind, ['allow', 'allow_session', 'allow_always', 'deny', 'choice']));
}

function isConversation(value: unknown): value is ConversationSummary {
  return reference(value) && text(value.title) && oneOf(value.status, ['idle', 'running', 'needs_approval', 'error']) &&
    finite(value.updatedAt) && finite(value.pendingApprovals) && optional(value.subtitle, text) && optional(value.preview, text) &&
    optional(value.agentLabel, text) && optional(value.subagent, boolean) && optional(value.hermesInPaseo, boolean) &&
    optional(value.project, (project) => record(project) && text(project.path) && text(project.name)) &&
    optional(value.parent, reference) && optional(value.aliases, (aliases) => Array.isArray(aliases) && aliases.every(reference)) &&
    optional(value.startedBy, (parent) => reference(parent) && text(parent.title));
}

export function isApprovalSnapshot(value: unknown): value is ListResponse {
  return record(value) && optional(value.role, (role) => oneOf(role, ['primary', 'shadow'])) && optional(value.notifications, boolean) &&
    Array.isArray(value.approvals) && value.approvals.every(isApproval) &&
    optional(value.approvalNotifications, (notifications) => Array.isArray(notifications) && notifications.every(isAppNotification)) &&
    Array.isArray(value.conversations) && value.conversations.every(isConversation) &&
    Array.isArray(value.statuses) && value.statuses.every((status: unknown) => record(status) && source(status.source) &&
      oneOf(status.state, ['connecting', 'connected', 'disconnected', 'needs_credentials', 'error', 'disabled']) && optional(status.message, text));
}

/** A native toast accepts only a routed alert and a local navigation target. */
export function isAppNotification(value: unknown): value is AppNotification {
  return record(value) && oneOf(value.event, ['agent-needs-you', 'agent-finished', 'agent-error', 'feed-card', 'stack-status',
    'settings-applied', 'settings-failed', 'mismatch-warning', 'security-card']) &&
    oneOf(value.source, ['hermes', 'paseo', 'brief', 'scout', 'agent', 'supervisor']) &&
    text(value.title) && optional(value.body, text) && text(value.url) && value.url.startsWith('/') &&
    !value.url.startsWith('//') && !/[\\\u0000-\u0020\u007f]/.test(value.url) && finite(value.at) &&
    optional(value.approval, (approval) => reference(approval) && text(approval.conversationId) && finite(approval.createdAt));
}

export function isApprovalDetail(value: unknown): value is ConversationDetail {
  return record(value) && isConversation(value.conversation) && Array.isArray(value.approvals) && value.approvals.every(isApproval) &&
    Array.isArray(value.items) && value.items.every((item: unknown) => record(item) && text(item.id) && text(item.kind));
}

export function isApprovalEvent(value: unknown): value is Extract<ServerEvent, { type: 'approval_upsert' | 'approval_removed' }> {
  return record(value) && (value.type === 'approval_upsert' ? isApproval(value.approval) :
    value.type === 'approval_removed' && source(value.source) && text(value.conversationId) && text(value.approvalId));
}
