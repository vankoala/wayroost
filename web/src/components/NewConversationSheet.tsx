import { Check, Folder, LoaderCircle, Zap } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { FolderStatus, HermesOptions, PaseoOptions, ProjectConfigReport, Source } from '../../../shared/protocol';
import { api, ApiError, refreshList } from '../api';
import { releasePreview, toUpload, type PendingAttachment } from '../attach';
import { newHermesChatCommands } from '../commands';
import { folderPath, homeFolder, homeRelative } from '../format';
import { keepPreviews } from '../previews';
import { conversationPath, navigate } from '../router';
import { applyCommandResult, convKey, getState, toast, useStore } from '../store';
import { useFileDrop } from '../drop';
import { AttachButton, AttachmentChips, dropRefusal, useFileAdder } from './Attachments';
import { SOURCE_NAMES, Sheet, SourceAvatar, statusLabel, useEnabledSources } from './common';
import { useSlashMenu } from './SlashMenu';

export function NewConversationSheet({
  onClose,
  initialCwd,
  initialSource,
  initialText,
  initialAttachments,
  onBasic,
}: {
  onClose: () => void;
  initialCwd?: string;
  /** Opened from a conversation ("/new"): start on its source. */
  initialSource?: Source;
  initialText?: string;
  /** What the one-box view already held when Advanced opened. */
  initialAttachments?: PendingAttachment[];
  /** Back to the one box, for the device that opened Advanced from there. */
  onBasic?: (text: string, files: PendingAttachment[]) => void;
}) {
  const statuses = useStore((s) => s.statuses);
  const conversations = useStore((s) => s.conversations);
  const enabled = useEnabledSources();
  const [tab, setTab] = useState<Source>(() => {
    if (initialSource && enabled.includes(initialSource)) return initialSource;
    if (!enabled.includes('hermes')) return 'paseo';
    if (!enabled.includes('paseo')) return 'hermes';
    return statuses.hermes.state === 'connected' || statuses.paseo.state !== 'connected' ? 'hermes' : 'paseo';
  });
  const [text, setText] = useState(initialText ?? '');
  const [attachments, setAttachments] = useState<PendingAttachment[]>(initialAttachments ?? []);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  const unsent = useRef(attachments);
  const prepared = useRef(new WeakSet(attachments));
  const changeAttachments = (next: PendingAttachment[]) => {
    // Preparation may finish after dismissal; only new previews still need freeing.
    for (const file of next) {
      if (!mounted.current && !prepared.current.has(file)) releasePreview(file);
      prepared.current.add(file);
    }
    if (mounted.current) {
      unsent.current = next;
      setAttachments(next);
    }
  };
  const adder = useFileAdder(attachments, changeAttachments);
  useFileDrop({
    label: 'Drop to attach to the new chat',
    refusal: dropRefusal(adder, busy ? 'Starting the chat…' : null),
    take: (files) => void adder.add(files),
  });
  const textRef = useRef<HTMLTextAreaElement>(null);
  const labelId = useId();
  // "/" commands for a new Hermes chat; Paseo has no catalog before an agent exists.
  const slash = useSlashMenu({ text, setText, inputRef: textRef, load: tab === 'hermes' ? newHermesChatCommands : null });

  // Files not sent when the sheet closes: free their thumbnails.
  const previewMount = useRef(0);
  const submitting = useRef(false);
  useEffect(() => {
    const mount = ++previewMount.current;
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Let cleanup and setup replay before freeing thumbnails that may still be in use.
      queueMicrotask(() => {
        // A pending start owns its previews until the request succeeds or fails.
        if (previewMount.current === mount && !submitting.current) {
          unsent.current.forEach(releasePreview);
          unsent.current = [];
        }
      });
    };
  }, []);

  // Paseo choices
  const [options, setOptions] = useState<PaseoOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [providerId, setProviderId] = useState('');
  const [modeId, setModeId] = useState<string | undefined>();
  const [cwd, setCwd] = useState(initialCwd ?? '');
  const [customCwd, setCustomCwd] = useState(false);
  const [hermesCwd, setHermesCwd] = useState(initialCwd ?? '');
  // Opened from a project, or edited: no home-folder prefill.
  const [hermesCwdTouched, setHermesCwdTouched] = useState(Boolean(initialCwd));
  const [acknowledged, setAcknowledged] = useState(false);

  // Your home folder, from the folders your chats and projects use: prefills the folder fields.
  const home = useMemo(
    () =>
      homeFolder([
        ...Object.values(conversations).map((c) => c.project?.path),
        ...(options?.workspaces.map((w) => w.path) ?? []),
      ]),
    [conversations, options],
  );
  useEffect(() => {
    if (!hermesCwdTouched && home) setHermesCwd(home);
  }, [home, hermesCwdTouched]);

  // Hermes choices: the model this chat starts on.
  const [hermesOptions, setHermesOptions] = useState<HermesOptions | null>(null);
  const [hermesModel, setHermesModel] = useState<string | null>(null);
  const [modelCostOk, setModelCostOk] = useState(false);
  const [modelNeedsOk, setModelNeedsOk] = useState(false);
  useEffect(() => {
    if (tab !== 'hermes' || hermesOptions || statuses.hermes.state !== 'connected') return;
    api
      .hermesOptions()
      .then((o) => {
        setHermesOptions(o);
        setHermesModel(o.defaultModel ?? o.models[0]?.id ?? null);
      })
      .catch(() => {}); // No picker then: the chat starts on Hermes' default model.
  }, [tab, hermesOptions, statuses.hermes.state]);
  const chosenModel = hermesOptions?.models.find((m) => m.id === hermesModel);
  const modelChanged = Boolean(hermesModel && hermesModel !== hermesOptions?.defaultModel);
  // A paid model other than the default needs an explicit OK, as Hermes asks before an expensive one.
  const modelCosts =
    tab === 'hermes' &&
    modelChanged &&
    (modelNeedsOk || Boolean(chosenModel?.description && chosenModel.description !== 'Free'));
  useEffect(() => {
    setModelCostOk(false);
    setModelNeedsOk(false);
  }, [hermesModel]);
  const modelGroups = useMemo(() => {
    const groups = new Map<string, NonNullable<typeof hermesOptions>['models']>();
    for (const m of hermesOptions?.models ?? []) {
      const group = m.group ?? 'Models';
      groups.set(group, [...(groups.get(group) ?? []), m]);
    }
    return [...groups];
  }, [hermesOptions]);

  useEffect(() => {
    if (tab !== 'paseo' || options) return;
    api
      .paseoOptions()
      .then((o) => {
        setOptions(o);
        const first = o.providers[0];
        if (first) {
          setProviderId(first.id);
          setModeId(first.defaultModeId);
        }
        if (initialCwd) {
          // Opened from a project: keep that folder.
          if (!o.workspaces.some((w) => w.path === initialCwd)) setCustomCwd(true);
        } else if (o.workspaces[0]) setCwd(o.workspaces[0].path);
        else {
          setCustomCwd(true);
          setCwd(homeFolder([...Object.values(getState().conversations).map((c) => c.project?.path)]) ?? '');
        }
      })
      .catch((err: Error) => setOptionsError(err.message));
  }, [tab, options]);

  const provider = useMemo(() => options?.providers.find((p) => p.id === providerId), [options, providerId]);
  const mode = provider?.modes.find((m) => m.id === modeId);
  // Agents/modes that act without asking need an explicit OK (the server checks too).
  const actsOnItsOwn = tab === 'paseo' && Boolean(provider && (mode ? mode.autoApproves : provider.autoApproves));
  useEffect(() => setAcknowledged(false), [providerId, modeId]);
  const status = statuses[tab];
  const offline = status.state !== 'connected';

  // The folder typed for this chat: checked as you type (through Paseo, which runs as you), and made
  // when you start if it's new, since Hermes quietly starts a chat elsewhere when its folder doesn't exist.
  const typedFolder = tab === 'hermes' ? (hermesCwdTouched ? folderPath(hermesCwd) : '') : customCwd ? folderPath(cwd) : '';
  const canCheckFolders = statuses.paseo.state === 'connected';
  const [folderCheck, setFolderCheck] = useState<{ path: string; status: FolderStatus } | null>(null);
  useEffect(() => {
    if (!typedFolder.startsWith('/') || !canCheckFolders) return;
    let live = true;
    const timer = setTimeout(() => {
      api
        .folderStatus(typedFolder)
        .then(({ status: found }) => live && setFolderCheck({ path: typedFolder, status: found }))
        .catch(() => live && setFolderCheck({ path: typedFolder, status: 'unknown' }));
    }, 400);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [typedFolder, canCheckFolders]);
  const folderStatus = folderCheck?.path === typedFolder ? folderCheck.status : undefined;
  const folderUnusable = folderStatus === 'missing-parent' || folderStatus === 'not-a-folder';

  // What the chosen folder's own files would let this agent do, read before it starts (the server runs
  // as you, so it reads what the agent will read). Advice: nothing here stops the launch.
  const paseoFolder = tab === 'paseo' && options && !offline ? folderPath(cwd) : '';
  const [configReport, setConfigReport] = useState<{ path: string; provider: string; report: ProjectConfigReport } | null>(null);
  const configRequest = useRef<{ path: string; provider: string; promise: Promise<ProjectConfigReport> } | null>(null);
  const folderConfig = configReport?.path === paseoFolder && configReport.provider === providerId ? configReport.report : null;
  const checkFolderConfig = (path: string, provider: string) => {
    if (configRequest.current?.path === path && configRequest.current.provider === provider) return configRequest.current.promise;
    const promise = api.projectConfig(path, provider).catch((): ProjectConfigReport => ({ notices: [], unreadable: true }));
    configRequest.current = { path, provider, promise };
    return promise;
  };
  useEffect(() => {
    setConfigReport(null);
    if (!paseoFolder.startsWith('/') || !providerId) return;
    let live = true;
    const timer = setTimeout(() => {
      const promise = checkFolderConfig(paseoFolder, providerId);
      promise.then((report) => {
        if (live && configRequest.current?.promise === promise) setConfigReport({ path: paseoFolder, provider: providerId, report });
      });
    }, 500);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [paseoFolder, providerId]);

  const canSubmit =
    !busy &&
    !adder.busy &&
    !offline &&
    !folderUnusable &&
    (text.trim().length > 0 || attachments.length > 0) &&
    (tab === 'hermes'
      ? (!hermesCwd.trim() || hermesCwd.trim().startsWith('/')) && (!modelCosts || modelCostOk)
      : Boolean(providerId) && cwd.trim().startsWith('/') && (!actsOnItsOwn || acknowledged));

  const resetSubmission = () => {
    submitting.current = false;
    if (mounted.current) setBusy(false);
    else {
      unsent.current.forEach(releasePreview);
      unsent.current = [];
    }
  };

  const submit = async () => {
    if (!canSubmit || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    const files = attachments;
    try {
      // A new folder is made first, so the chat starts in it. Asked now if the check hasn't answered yet.
      let found: FolderStatus | undefined = folderStatus;
      if (typedFolder.startsWith('/') && canCheckFolders && found === undefined) {
        found = (await api.folderStatus(typedFolder).catch(() => ({ status: 'unknown' as const }))).status;
      }
      if (found === 'missing-parent' || found === 'not-a-folder') {
        setFolderCheck({ path: typedFolder, status: found });
        resetSubmission();
        return;
      }
      if (found === 'missing') {
        await api.createFolder(typedFolder);
        setFolderCheck({ path: typedFolder, status: 'exists' });
        configRequest.current = null;
      }
      if (tab === 'paseo') {
        const path = folderPath(cwd);
        const report = await checkFolderConfig(path, providerId);
        setConfigReport({ path, provider: providerId, report });
      }
      const created =
        tab === 'hermes'
          ? await api.createHermes({
              text: text.trim(),
              // The untouched home-folder prefill means Hermes' usual folder.
              cwd: hermesCwdTouched ? folderPath(hermesCwd) || undefined : undefined,
              attachments: toUpload(files),
              ...(modelChanged && hermesModel ? { model: hermesModel } : {}),
              ...(modelCosts && modelCostOk ? { confirmModel: true } : {}),
            })
          : await api.createPaseo({
              providerId,
              cwd: folderPath(cwd),
              text: text.trim(),
              ...(modeId ? { modeId } : {}),
              ...(actsOnItsOwn ? { acknowledgeAutoApprove: acknowledged } : {}),
              ...(files.length ? { attachments: toUpload(files) } : {}),
            });
      // The new conversation's first message shows these photos' thumbnails.
      const key = convKey(created.source, created.id);
      keepPreviews(key, null, files, getState().details[key]?.items.map((i) => i.id) ?? []);
      unsent.current = [];
      submitting.current = false;
      if (mounted.current) {
        onClose();
        navigate(conversationPath(created.source, created.id));
      }
      if (created.command) applyCommandResult(created.source, created.id, created.command);
      if (created.notice) toast(created.notice, 'info');
      refreshList().catch(() => {});
    } catch (err) {
      // Hermes wants a yes for this model's cost: show the box to tick.
      if (err instanceof ApiError && err.status === 409 && tab === 'hermes' && modelChanged) setModelNeedsOk(true);
      toast((err as Error).message);
      resetSubmission();
    }
  };

  return (
    <Sheet
      title="New conversation"
      onClose={onClose}
      footer={
        <div className="new-chat-foot">
          <button type="button" className="btn btn-primary btn-block" disabled={!canSubmit} onClick={submit}>
            {busy && <LoaderCircle size={18} className="spin" />}
            {tab === 'hermes' ? 'Start chat' : 'Launch agent'}
          </button>
          {onBasic && (
            <button
              type="button"
              className="link-btn basic-toggle"
              disabled={busy || adder.busy}
              onClick={() => {
                unsent.current = [];
                onBasic(text, attachments);
              }}
            >
              Ask in one box instead
            </button>
          )}
        </div>
      }
    >
      <div className="segmented" role="tablist" hidden={enabled.length < 2}>
        {enabled.map((s) => (
          <button key={s} type="button" role="tab" aria-pressed={tab === s} aria-selected={tab === s} onClick={() => setTab(s)}>
            <SourceAvatar source={s} small />
            {SOURCE_NAMES[s]}
          </button>
        ))}
      </div>

      {offline && (
        <p className="error-text">
          {SOURCE_NAMES[tab]}: {status.message ?? statusLabel(status.state)}
        </p>
      )}

      <div className="field">
        <span id={labelId}>{tab === 'hermes' ? 'Message' : 'Task'}</span>
        <div className="field-box">
          <textarea
            key={tab}
            ref={textRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              slash.track(e.target);
            }}
            onKeyDown={slash.onKeyDown}
            placeholder={tab === 'hermes' ? 'Ask Hermes anything, or type / for commands' : 'What should the agent do?'}
            autoFocus={tab === 'hermes'}
            aria-labelledby={labelId}
            {...slash.inputProps}
          />
          <div className="field-tools">
            <AttachButton adder={adder} disabled={busy} />
            <span className="field-hint">{attachments.length ? '' : 'Photos, PDFs or text files'}</span>
          </div>
        </div>
        {slash.menu}
        <fieldset disabled={busy} style={{ display: 'contents' }} aria-label="Attachments">
          <AttachmentChips attachments={attachments} onChange={changeAttachments} />
        </fieldset>
      </div>

      {tab === 'hermes' && !offline && hermesOptions && hermesOptions.models.length > 0 && (
        <label className="field">
          <span>Model</span>
          <select
            value={hermesModel ?? ''}
            onChange={(e) => setHermesModel(e.target.value)}
            aria-label="Model for this Hermes chat"
          >
            {modelGroups.map(([group, models]) => (
              <optgroup key={group} label={group}>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                    {m.id === hermesOptions.defaultModel ? ' (default)' : ''}
                    {m.description ? ` · ${m.description}` : ''}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <small>For this chat only. Hermes' default stays as it is.</small>
        </label>
      )}

      {modelCosts && (
        <button type="button" role="checkbox" className="ack" aria-checked={modelCostOk} onClick={() => setModelCostOk((ok) => !ok)}>
          <span className="box">{modelCostOk && <Check size={14} strokeWidth={3} />}</span>
          <span>
            <strong>{chosenModel?.label}</strong> is billed{chosenModel?.description ? ` (${chosenModel.description})` : ''}. I
            understand.
          </span>
        </button>
      )}

      {tab === 'hermes' && !offline && (
        <label className="field">
          <span>Folder (optional)</span>
          <input
            type="text"
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="Hermes' default folder"
            value={hermesCwd}
            onChange={(e) => {
              setHermesCwdTouched(true);
              setHermesCwd(e.target.value);
            }}
            aria-label="Folder for this Hermes chat"
          />
          <FolderNote status={folderStatus} />
          <small>Where Hermes works for this chat. Leave it as it is for Hermes' usual folder.</small>
        </label>
      )}

      {tab === 'paseo' && !offline && (
        <>
          {!options && !optionsError && (
            <p className="muted">
              <LoaderCircle size={14} className="spin" /> Loading agents…
            </p>
          )}
          {optionsError && <p className="error-text">{optionsError}</p>}
          {options && (
            <>
              <div className="field">
                <span>Agent</span>
                <div className="pick-row" role="radiogroup" aria-label="Agent">
                  {options.providers.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      role="radio"
                      className="chip"
                      aria-checked={p.id === providerId}
                      aria-pressed={p.id === providerId}
                      onClick={() => {
                        setProviderId(p.id);
                        setModeId(p.defaultModeId);
                      }}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>

              {provider && provider.modes.length > 1 && (
                <div className="field">
                  <span>Permissions</span>
                  <div className="pick-row">
                    {provider.modes.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        className="chip"
                        aria-pressed={m.id === modeId}
                        title={m.description}
                        onClick={() => setModeId(m.id)}
                      >
                        {m.autoApproves && <Zap size={13} className="auto-mark" aria-label="acts without asking" />}
                        {m.label}
                      </button>
                    ))}
                  </div>
                  <small>{mode?.description ?? 'Modes marked ⚡ act without asking you first.'}</small>
                </div>
              )}

              {actsOnItsOwn && (
                <button
                  type="button"
                  role="checkbox"
                  className="ack"
                  aria-checked={acknowledged}
                  onClick={() => setAcknowledged((a) => !a)}
                >
                  <span className="box">{acknowledged && <Check size={14} strokeWidth={3} />}</span>
                  <span>
                    <strong>{provider?.label}</strong>
                    {mode ? ` in “${mode.label}”` : ''} can edit files and run commands without asking you.
                    I understand.
                  </span>
                </button>
              )}

              <div className="field">
                <span>Folder</span>
                {/* Said while the folder is still a choice, not after you have committed to it. */}
                {folderConfig && (folderConfig.notices.length > 0 || folderConfig.unreadable) && (
                  <FolderConfigNote report={folderConfig} />
                )}
                {options.workspaces.length > 0 && (
                  <div className="options" role="radiogroup" aria-label="Folder">
                    {options.workspaces.map((w) => (
                      <button
                        key={w.path}
                        type="button"
                        role="radio"
                        className="option"
                        aria-checked={!customCwd && w.path === cwd}
                        onClick={() => {
                          setCustomCwd(false);
                          setCwd(w.path);
                        }}
                      >
                        <span className="radio" />
                        <span className="label">
                          <div>{w.label}</div>
                          <div>{homeRelative(w.path)}</div>
                        </span>
                      </button>
                    ))}
                    <button
                      type="button"
                      role="radio"
                      className="option"
                      aria-checked={customCwd}
                      onClick={() => {
                        setCustomCwd(true);
                        setCwd(home ?? '');
                      }}
                    >
                      <span className="radio" />
                      <span className="label">
                        <div>
                          <Folder size={14} /> Another folder…
                        </div>
                      </span>
                    </button>
                  </div>
                )}
                {customCwd && (
                  <input
                    type="text"
                    inputMode="url"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    placeholder="/home/you/project"
                    value={cwd}
                    onChange={(e) => setCwd(e.target.value)}
                    aria-label="Folder path"
                  />
                )}
                {customCwd && <FolderNote status={folderStatus} />}
              </div>
            </>
          )}
        </>
      )}

    </Sheet>
  );
}

/** What the folder check found, under a folder field. */
function FolderNote({ status }: { status: FolderStatus | undefined }) {
  if (status === 'missing') return <small className="folder-note">New folder: it's made when you start.</small>;
  if (status === 'missing-parent') {
    return <small className="folder-note bad">The folder it goes in doesn't exist. Check the path.</small>;
  }
  if (status === 'not-a-folder') return <small className="folder-note bad">That's a file, not a folder.</small>;
  return null;
}

/**
 * What the agent is about to work under can configure itself: hooks it runs, permissions it
 * grants itself, code it starts. Said plainly, with the file names, before the launch.
 * Wayroost reads those files as you; it never shows what is inside them.
 */
function FolderConfigNote({ report }: { report: ProjectConfigReport }) {
  return (
    <div className="notice-card" role="note">
      <div className="notice-title">This folder configures its agents</div>
      {report.notices.map((notice) => (
        <div className="notice-line" key={notice.text}>
          <p className="notice-text">{notice.text}</p>
          <p className="notice-files">{notice.files.join('  ·  ')}</p>
        </div>
      ))}
      {report.unreadable && <p className="notice-text">Some of it could not be read, so this may not be all of it.</p>}
      <p className="notice-foot">Only file names and findings are shown. The agent starts when you launch it.</p>
    </div>
  );
}
