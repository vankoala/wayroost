import type {
  Approval,
  ApprovalAnswer,
  ApprovalOption,
  AttachmentRef,
  ConversationStatus,
  ConversationSummary,
  TimelineItem,
  ToolStatus,
} from '../../../shared/protocol.js';
import { readableBridgeText } from '../bridge/envelope.js';
import { MAX_APPROVAL_DETAIL, capitalize, clip, homeRelative, oneLine, pretty, str, stripDataUrls, summarizeArgs } from '../text.js';

// Pure mappings from Hermes dashboard shapes to the shared protocol.

export interface HermesSessionRow {
  id: string;
  source?: string | null;
  title?: string | null;
  preview?: string | null;
  model?: string | null;
  started_at?: number | null;
  last_active?: number | null;
  message_count?: number | null;
  cwd?: string | null;
  /** What it came from: a delegate_task parent, a /branch or /new source, or a compressed predecessor. */
  parent_session_id?: string | null;
  ended_at?: number | null;
  end_reason?: string | null;
  /** List rows: not ended, and written in the last 300 s. */
  is_active?: boolean | null;
  /** A compressed chat listed under its latest id: every id in the chain, and the first. */
  _lineage_ids?: string[] | null;
  _lineage_root_id?: string | null;
  /** /branch and /new markers, lifted out of model_config. */
  _branched_from?: string | null;
  _reset_from?: string | null;
  /** Detail rows only: raw model_config JSON (a delegate_task run's carries `_delegate_from`). */
  model_config?: unknown;
}

export interface HermesMessageRow {
  id: number | string;
  role: string;
  content?: unknown;
  timestamp?: number | null;
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }> | null;
  tool_call_id?: string | null;
  tool_name?: string | null;
  reasoning?: string | null;
  display_kind?: string | null;
}

const SOURCE_LABELS: Record<string, string> = {
  desktop: 'Desktop',
  tui: 'Terminal',
  cli: 'CLI',
  telegram: 'Telegram',
  discord: 'Discord',
  slack: 'Slack',
  whatsapp: 'WhatsApp',
  signal: 'Signal',
  email: 'Email',
  sms: 'SMS',
  cron: 'Scheduled',
  api_server: 'API',
};

/** A working directory as a project (home itself isn't a project). */
export function projectOf(cwd: string | null | undefined): { path: string; name: string } | undefined {
  if (!cwd || !cwd.startsWith('/')) return undefined;
  const path = cwd.replace(/\/+$/, '') || '/';
  if (/^\/home\/[^/]+$/.test(path) || path === '/root' || path === '/') return undefined;
  return { path, name: path.split('/').pop() || path };
}

/**
 * Where a chat works, for its header: its own folder, else the one Hermes runs a chat with no
 * folder in (`defaultFolder`, from the dashboard). Home reads "~".
 */
export function folderLabel(cwd: string | null | undefined, defaultFolder?: string): string | undefined {
  const path = str(cwd) ?? defaultFolder;
  if (!path) return undefined;
  return homeRelative(path.length > 1 ? path.replace(/\/+$/, '') : path);
}

export function shortModel(model: string | null | undefined): string | undefined {
  if (!model) return undefined;
  return model.split('/').pop() || model;
}

export function sessionSummary(
  row: HermesSessionRow,
  status: ConversationStatus,
  pendingApprovals: number,
  defaultFolder?: string,
): ConversationSummary {
  // Both come from the first message; for a chat an agent messaged or started
  // through the bridge that's an envelope, so show who it's from instead.
  const preview = str(row.preview) ? oneLine(readableBridgeText(row.preview!), 140) : undefined;
  const title = str(row.title) ? oneLine(readableBridgeText(row.title!), 80) : preview ? oneLine(preview, 60) : 'New chat';
  const source = row.source ?? '';
  const model = shortModel(row.model);
  // Where it works, like a Paseo agent's header. The model is on the chat's own controls (and can change).
  const subtitle = [SOURCE_LABELS[source] ?? (source || undefined), folderLabel(row.cwd, defaultFolder)].filter(Boolean).join(' · ');
  const project = projectOf(row.cwd);
  const aliases = earlierIds(row);
  return {
    source: 'hermes',
    id: row.id,
    title,
    ...(subtitle ? { subtitle } : {}),
    ...(preview ? { preview } : {}),
    status,
    updatedAt: Math.round(((row.last_active ?? row.started_at ?? 0) as number) * 1000),
    pendingApprovals,
    ...(project ? { project } : {}),
    ...(model ? { agentLabel: model } : {}),
    ...(aliases.length ? { aliases } : {}),
  };
}

/** The ids a compressed chat had before its current one: sub-agents may name their parent by them. */
export function earlierIds(row: HermesSessionRow): Array<{ source: 'hermes'; id: string }> {
  const ids = Array.isArray(row._lineage_ids) ? row._lineage_ids : [];
  return [...new Set(ids)].filter((id) => typeof id === 'string' && id && id !== row.id).map((id) => ({ source: 'hermes', id }));
}

/** Map `session.active_list` status to ours. */
export function activeStatus(status: string | undefined): ConversationStatus {
  if (status === 'waiting') return 'needs_approval';
  if (status === 'working' || status === 'starting' || status === 'streaming' || status === 'resuming') return 'running';
  return 'idle';
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        const p = part as { type?: string; text?: string };
        if (p.type === 'text' && typeof p.text === 'string') return p.text;
        if (p.type?.includes('image')) return '[image]';
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

const REF_LINE = /^@(image|file):(.+)$/;

/** A reference value as Hermes writes it: quoted with `, " or ' when it has spaces. */
function unquote(value: string): string {
  const v = value.trim();
  return v.length >= 2 && '`"\''.includes(v[0]!) && v.endsWith(v[0]!) ? v.slice(1, -1) : v;
}

export function attachmentKind(name: string): AttachmentRef['kind'] {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff'].includes(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (['txt', 'md', 'csv', 'json', 'log', 'yaml', 'yml', 'toml', 'ini', 'xml', 'html', 'css', 'js', 'ts', 'py', 'sh'].includes(ext)) {
    return 'text';
  }
  return 'file';
}

/**
 * A stored user turn: the typed text plus the files sent with it. Hermes
 * appends `@image:<path>` lines for images, and clients put `@file:<path>`
 * lines before the text for other files.
 */
export function userContent(content: unknown): { text: string; attachments: AttachmentRef[] } {
  // Native-vision turns are stored as parts, with the images inline as data URLs.
  // Those never go to the phone; the `@image:` lines in the text stand for them.
  const isImage = (part: unknown) =>
    typeof part === 'object' && part !== null && String((part as { type?: unknown }).type ?? '').includes('image');
  const inlineImages = Array.isArray(content) ? content.filter(isImage).length : 0;
  const lines = contentText(Array.isArray(content) ? content.filter((part) => !isImage(part)) : content).split('\n');
  const ref = (line: string): AttachmentRef | null => {
    const match = REF_LINE.exec(line.trim());
    if (!match) return null;
    const name = unquote(match[2]!).split('/').pop() || match[2]!;
    return { name, kind: match[1] === 'image' ? 'image' : attachmentKind(name) };
  };
  // Only the reference blocks before and after the text are attachments; a
  // reference typed mid-message stays part of the message.
  const leading: AttachmentRef[] = [];
  const trailing: AttachmentRef[] = [];
  let start = 0;
  let end = lines.length;
  for (; start < end; start++) {
    if (!lines[start]!.trim()) continue;
    const found = ref(lines[start]!);
    if (!found) break;
    leading.push(found);
  }
  for (; end > start; end--) {
    if (!lines[end - 1]!.trim()) continue;
    const found = ref(lines[end - 1]!);
    if (!found) break;
    trailing.unshift(found);
  }
  const text = lines.slice(start, end).join('\n').trim();
  const attachments = [...leading, ...trailing];
  const named = attachments.filter((a) => a.kind === 'image').length;
  for (let i = named; i < inlineImages; i++) attachments.push({ name: `Image ${i + 1}`, kind: 'image' });
  return { text: skillInvocationText(text) ?? text, attachments };
}

// A `/skill` invocation is stored as the whole expanded skill body. Show what
// the user typed instead. Mirrors hermes-agent apps/shared/src/skill-scaffold.ts
// (markers byte for byte from agent/skill_commands.py).
const INVOCATION_PREFIX = '[IMPORTANT: The user has invoked the ';
const SINGLE_MARKER = 'The full skill content is loaded below.]';
const SINGLE_INSTRUCTION = 'The user has provided the following instruction alongside the skill invocation: ';
const RUNTIME_NOTE = '\n\n[Runtime note:';
const BUNDLE_MARKER = ' skill bundle,';
const BUNDLE_INSTRUCTION = '\nUser instruction: ';
const BUNDLE_SKILL_BLOCK = '\n\n[Loaded as part of the ';
const SKILL_NAME = /^\[IMPORTANT: The user has invoked the "([^"]*)"/;

function between(text: string, marker: string, end: string, fromEnd = false): string {
  const index = fromEnd ? text.lastIndexOf(marker) : text.indexOf(marker);
  if (index < 0) return '';
  const tail = text.slice(index + marker.length);
  const stop = tail.indexOf(end);
  return (stop >= 0 ? tail.slice(0, stop) : tail).trim();
}

/** `/work fix the leak` for a scaffolded skill turn; null for ordinary text. */
export function skillInvocationText(text: string): string | null {
  if (!text.startsWith(INVOCATION_PREFIX)) return null;
  const name = (SKILL_NAME.exec(text)?.[1] ?? '').trim();
  if (!name) return null;
  const label = name.startsWith('/') ? name : `/${name}`;
  const instruction = text.includes(BUNDLE_MARKER)
    ? between(text, BUNDLE_INSTRUCTION, BUNDLE_SKILL_BLOCK)
    : text.includes(SINGLE_MARKER)
      ? between(text, SINGLE_INSTRUCTION, RUNTIME_NOTE, true)
      : '';
  return instruction ? `${label} ${instruction.replace(/\s+/g, ' ')}` : label;
}

export function toolResultStatus(result: unknown): ToolStatus {
  let value = result;
  if (typeof value === 'string') {
    const t = value.trim();
    if (!t.startsWith('{')) return 'done';
    try {
      value = JSON.parse(t);
    } catch {
      return 'done';
    }
  }
  if (value && typeof value === 'object') {
    const r = value as Record<string, unknown>;
    if (r.error) return 'error';
    if (r.success === false) return 'error';
    if (typeof r.exit_code === 'number' && r.exit_code !== 0) return 'error';
  }
  return 'done';
}

export function formatToolResult(result: unknown): string {
  let value = result;
  if (typeof value === 'string') {
    const t = value.trim();
    if (t.startsWith('{')) {
      try {
        value = JSON.parse(t);
      } catch {
        return clip(stripDataUrls(value as string));
      }
    } else {
      return clip(stripDataUrls(value as string));
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const r = value as Record<string, unknown>;
    // vision_analyze and friends hand the model the image itself; show their summary.
    if (r._multimodal === true && typeof r.text_summary === 'string') return clip(r.text_summary);
    if (typeof r.output === 'string') {
      const code = typeof r.exit_code === 'number' && r.exit_code !== 0 ? `\n(exit code ${r.exit_code})` : '';
      return clip(stripDataUrls(r.output + code));
    }
    if (typeof r.content === 'string') return clip(stripDataUrls(r.content));
    if (typeof r.error === 'string') return clip(r.error);
  }
  return clip(stripDataUrls(pretty(value)));
}

/** Convert stored message rows (chronological) to timeline items. */
export function messagesToItems(rows: HermesMessageRow[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  const toolIndex = new Map<string, number>();

  for (const row of rows) {
    if (row.display_kind === 'hidden') continue;
    const at = row.timestamp ? Math.round(row.timestamp * 1000) : undefined;

    if (row.role === 'user') {
      // Hermes' own note when it re-ran a turn it lost in a crash: a notice, not something you wrote.
      if (row.display_kind === 'auto_continue') {
        items.push({ kind: 'notice', id: `m${row.id}`, level: 'info', text: 'Hermes resumed the interrupted turn.' });
        continue;
      }
      const { text, attachments } = userContent(row.content);
      if (text || attachments.length) {
        items.push({
          kind: 'user',
          id: `m${row.id}`,
          text,
          ...(attachments.length ? { attachments } : {}),
          ...(at ? { at } : {}),
        });
      }
      continue;
    }

    if (row.role === 'assistant') {
      if (str(row.reasoning)) items.push({ kind: 'reasoning', id: `r${row.id}`, text: row.reasoning!.trim() });
      const text = contentText(row.content).trim();
      if (text) items.push({ kind: 'assistant', id: `m${row.id}`, text, ...(at ? { at } : {}) });
      for (const call of row.tool_calls ?? []) {
        const callId = call.id ?? `${row.id}-${items.length}`;
        const args = call.function?.arguments;
        const summary = summarizeArgs(args);
        toolIndex.set(callId, items.length);
        items.push({
          kind: 'tool',
          id: `t${callId}`,
          name: call.function?.name ?? 'tool',
          ...(summary ? { summary } : {}),
          status: 'done',
          input: clip(stripDataUrls(pretty(args))),
        });
      }
      continue;
    }

    if (row.role === 'tool') {
      const at = row.tool_call_id ? toolIndex.get(row.tool_call_id) : undefined;
      const output = formatToolResult(row.content);
      if (at !== undefined) {
        const item = items[at];
        if (item?.kind === 'tool') items[at] = { ...item, output, status: toolResultStatus(row.content) };
      } else {
        items.push({
          kind: 'tool',
          id: `m${row.id}`,
          name: row.tool_name ?? 'tool',
          status: toolResultStatus(row.content),
          output,
        });
      }
    }
  }
  return items;
}

// ---- Approvals & questions ------------------------------------------------

const CHOICES: Record<string, { label: string; kind: ApprovalOption['kind'] }> = {
  once: { label: 'Allow once', kind: 'allow' },
  session: { label: 'Allow for this chat', kind: 'allow_session' },
  always: { label: 'Always allow', kind: 'allow_always' },
  deny: { label: 'Deny', kind: 'deny' },
};

export function permissionChoices(params: Record<string, unknown>): string[] {
  if (Array.isArray(params.choices)) {
    const valid = params.choices.filter((c): c is string => typeof c === 'string' && c in CHOICES);
    if (valid.includes('deny') && valid.length > 1) return valid;
  }
  const out = ['once'];
  if (params.allow_session !== false && !params.smart_denied) out.push('session');
  if (params.allow_permanent !== false) out.push('always');
  out.push('deny');
  return out;
}

export function permissionApproval(
  id: string,
  conversationId: string,
  params: Record<string, unknown>,
  createdAt: number,
): Approval {
  const description = str(params.description);
  const tool = str(params.tool_name);
  const command = str(params.command);
  return {
    id,
    source: 'hermes',
    conversationId,
    kind: 'permission',
    title: description ? capitalize(description) : tool ? `Use ${tool}` : 'Run a command',
    ...(command ? { detail: clip(command, MAX_APPROVAL_DETAIL) } : {}),
    ...(command && command.length > MAX_APPROVAL_DETAIL ? { detailTruncated: true } : {}),
    options: permissionChoices(params).map((c) => ({ id: c, label: CHOICES[c]!.label, kind: CHOICES[c]!.kind })),
    createdAt,
  };
}

export interface ClarifyQuestion {
  qid: string | null;
  question: string;
  choices: string[];
  multiSelect: boolean;
}

/** Normalize single and batch `clarify` requests into a list of questions. */
export function clarifyQuestions(params: Record<string, unknown>): ClarifyQuestion[] {
  const toChoices = (c: unknown) => (Array.isArray(c) ? c.filter((x): x is string => typeof x === 'string') : []);
  if (Array.isArray(params.questions)) {
    const locked = (params.answers ?? {}) as Record<string, unknown>;
    return params.questions
      .map((q) => q as Record<string, unknown>)
      .filter((q) => typeof q.qid === 'string' && !(String(q.qid) in locked))
      .map((q) => {
        const choices = toChoices(q.choices);
        return {
          qid: String(q.qid),
          question: str(q.question) ?? 'Hermes has a question',
          choices,
          multiSelect: q.multi_select === true && choices.length > 0,
        };
      });
  }
  const choices = toChoices(params.choices);
  return [
    {
      qid: null,
      question: str(params.question) ?? 'Hermes has a question',
      choices,
      multiSelect: params.multi_select === true && choices.length > 0,
    },
  ];
}

/** Hermes treats an empty answer as "skip". */
export const SKIP_OPTION = '__skip';

export function questionApproval(
  id: string,
  conversationId: string,
  q: ClarifyQuestion,
  createdAt: number,
  progress?: string,
): Approval {
  return {
    id,
    source: 'hermes',
    conversationId,
    kind: 'question',
    title: oneLine(q.question, 300),
    ...(q.question.length > 300 ? { detail: clip(q.question, 4000) } : {}),
    options: [
      ...q.choices.map((label, i) => ({ id: String(i), label, kind: 'choice' as const })),
      { id: SKIP_OPTION, label: 'Skip', kind: 'deny' as const },
    ],
    allowText: true,
    ...(q.multiSelect ? { multiSelect: true } : {}),
    ...(progress ? { progress } : {}),
    createdAt,
  };
}

/** Turn the user's pick(s) / text into the answer string Hermes expects. */
export function clarifyAnswer(
  q: ClarifyQuestion,
  answer: { optionId?: string; optionIds?: string[]; text?: string },
): string | null {
  const pick = (id: string) => {
    const index = Number(id);
    return Number.isInteger(index) && index >= 0 && index < q.choices.length ? q.choices[index]! : null;
  };
  if (answer.optionId === SKIP_OPTION) return '';
  const text = answer.text?.trim();
  if (q.multiSelect) {
    const ids = answer.optionIds ?? (answer.optionId ? [answer.optionId] : []);
    const picked = ids.map(pick);
    if (picked.some((p) => p === null)) return null;
    const values = [...(picked as string[]), ...(text ? [text] : [])];
    return values.length ? JSON.stringify(values) : null;
  }
  if (answer.optionId !== undefined) return pick(answer.optionId);
  return text ?? null;
}

// ---- Password, secret, code and login prompts --------------------------------
//
// Hermes asks these as server→client requests answered with one string,
// `{ value }`, where '' declines (tui_gateway/contracts/server_requests.py,
// asked from tui_gateway/agent_callbacks.py). For `vault.save_login` that string
// is JSON, `{"identifier": …, "password": …}`. They become secret cards only
// when the config turns `hermes.secretPrompts` on.

/** The one button on a secret card. The value arrives as the answer's text, or its login. */
export const SECRET_DECLINE = '__decline';
/** Longest password, secret, code, username or login password Signalbox passes on. */
export const MAX_SECRET_CHARS = 4096;

type SecretInput = NonNullable<Approval['secret']>['input'];

/** A card for a Hermes password prompt, or null for a request that isn't one. */
export function secretApproval(
  id: string,
  conversationId: string,
  method: string,
  params: Record<string, unknown>,
  createdAt: number,
): Approval | null {
  let title: string;
  let detail: string | undefined;
  let decline = 'Skip';
  let input: SecretInput = 'password';
  switch (method) {
    case 'sudo':
      // The command it wants to run (redacted by Hermes); the desktop app shows it too.
      detail = str(params.command);
      title = detail
        ? 'Hermes asks for your sudo password'
        : 'Hermes asks for your sudo password without saying what it will run';
      decline = 'Decline';
      break;
    case 'secret': {
      const name = str(params.env_var);
      title = name ? `Hermes asks for ${oneLine(name, 80)}` : 'Hermes asks for a secret';
      detail = str(params.prompt);
      break;
    }
    case 'vault.unlock_prompt': {
      const vault = str(params.display_name) ?? str(params.backend);
      title = vault ? `Vault master password for ${oneLine(vault, 60)}` : 'Vault master password';
      decline = 'Keep locked';
      break;
    }
    case 'vault.code': {
      const site = str(params.site);
      title = site ? `2FA code for ${oneLine(site, 100)}` : '2FA code';
      detail = str(params.hint);
      input = 'code';
      break;
    }
    case 'vault.save_login': {
      // `site` is the host; the detail is the exact origin Hermes saves it for and signs in to.
      const site = str(params.site) ?? str(params.origin);
      title = site ? `Save a login for ${oneLine(site, 100)}` : 'Save a login';
      detail = str(params.origin);
      decline = 'Decline';
      input = 'login';
      break;
    }
    default:
      return null;
  }
  return {
    id,
    source: 'hermes',
    conversationId,
    kind: 'secret',
    secret: { input, ...(method === 'sudo' ? { confirm: true } : {}) },
    title,
    ...(detail ? { detail: clip(detail, MAX_APPROVAL_DETAIL) } : {}),
    ...(detail && detail.length > MAX_APPROVAL_DETAIL ? { detailTruncated: true } : {}),
    options: [{ id: SECRET_DECLINE, label: decline, kind: 'deny' }],
    createdAt,
  };
}

/**
 * The result Hermes expects for a secret card (`{ value }`): what was typed,
 * exactly (a login as the JSON Hermes wants), or '' to decline. Otherwise a
 * problem to show, which never repeats what was sent.
 */
export function secretAnswer(input: SecretInput, answer: ApprovalAnswer): { value: string } | { problem: string } {
  const { optionId, optionIds, text, login } = answer;
  if (optionId === SECRET_DECLINE && optionIds === undefined && text === undefined && login === undefined) {
    return { value: '' };
  }
  const most = MAX_SECRET_CHARS.toLocaleString('en-US');
  if (input === 'login') {
    if (optionId !== undefined || optionIds !== undefined || text !== undefined || login === undefined) {
      return { problem: 'Send the username and password, or decline.' };
    }
    const { identifier, password } = login;
    if (typeof identifier !== 'string' || typeof password !== 'string' || !identifier.trim() || !password.trim()) {
      return { problem: 'Enter both the username and the password, or decline.' };
    }
    if (identifier.length > MAX_SECRET_CHARS || password.length > MAX_SECRET_CHARS) {
      return { problem: `That's too long. The username and password can each be up to ${most} characters.` };
    }
    return { value: JSON.stringify({ identifier, password }) };
  }
  if (optionId !== undefined || optionIds !== undefined || login !== undefined || text === undefined) {
    return { problem: 'Send the password or code, or decline.' };
  }
  if (!text.trim()) return { problem: 'Enter the password or code, or decline.' };
  if (text.length > MAX_SECRET_CHARS) {
    return { problem: `That's too long. Passwords and codes can be up to ${most} characters.` };
  }
  return { value: text };
}
