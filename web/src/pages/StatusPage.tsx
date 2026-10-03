import { LoaderCircle } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import type { DevicePresence } from '../../../shared/protocol';
import { PHONE_VERBS, type ComponentStatus, type ModelProfile, type SupervisorVerb } from '../../../shared/supervisor';
import { Link, Page } from '../components/common';
import { getState, toast, useStore } from '../store';
import {
  NOT_SET_UP_CHIP,
  STATE_CHIP,
  UNAVAILABLE_LINE,
  actionLabel,
  actionLines,
  busyLine,
  mainAction,
  offersTiming,
  overallTone,
  runningLine,
  switchProfiles,
  terminalAction,
  usePower,
  type PowerRequest,
} from '../power';

export interface PowerConfirmation {
  message: string;
  isCurrent: () => boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

interface ActionFocus {
  trigger: HTMLButtonElement;
  owned: boolean;
}

/**
 * Status & power: a card per component with a plain name, a state chip, one
 * plain sentence and one main action. Ports, units and the model profile sit under
 * Details. While an action runs the page follows it: an attention banner whose
 * "Show progress" opens the lines the action printed.
 *
 * A phone confirms each tap: the server answers 202 with a summary and a single-use
 * token, and the same request goes back with that token.
 */
export function StatusPage({ onConfirm }: { onConfirm: (confirmation: PowerConfirmation) => void }) {
  const power = usePower();
  const { loaded, refresh, act, lines, actionGuard } = power;
  const device = useStore((s) => s.device);
  const authLost = useStore((s) => s.unpaired || s.sessionExpired);
  const identified = !authLost && !!device?.id && (device.kind === 'desktop' || device.kind === 'phone');
  const status = identified ? power.status : null;
  const unavailable = !identified || power.unavailable;
  const sentence = identified ? power.sentence : null;
  const presence = identified ? power.presence : [];
  // A phone may restart things and switch the model, and nothing else.
  const phone = device?.kind === 'phone';
  /** The card whose "Now / When idle" (or profile) menu is open. */
  const [menu, setMenu] = useState<{ component: ComponentStatus; verb: SupervisorVerb; profile?: ModelProfile; trigger: HTMLButtonElement } | null>(
    null,
  );
  const [asking, setAsking] = useState<string | null>(null);
  const requestFocus = useRef<ActionFocus | null>(null);
  const [returnFocus, setReturnFocus] = useState<ActionFocus | null>(null);
  const live = useRef(true);
  const [showProgress, setShowProgress] = useState(false);
  const action = identified ? power.action : undefined;
  const finished = !!action && terminalAction(action);
  const running = action && (finished || !unavailable) ? action : undefined;

  useEffect(() => {
    setMenu(null);
    setAsking(null);
    setReturnFocus(null);
    setShowProgress(false);
  }, [device?.id, device?.kind, authLost]);

  useEffect(() => {
    if (!unavailable) return;
    setMenu(null);
    setAsking(null);
    setReturnFocus(null);
  }, [unavailable]);

  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);

  useEffect(() => {
    if (!asking) return;
    const owner = requestFocus.current;
    const release = () => { if (owner) owner.owned = false; };
    document.addEventListener('focusin', release);
    document.addEventListener('pointerdown', release);
    return () => {
      document.removeEventListener('focusin', release);
      document.removeEventListener('pointerdown', release);
    };
  }, [asking]);

  useEffect(() => {
    // Wait for the request's disabled buttons and the confirmation sheet to clear.
    if (returnFocus?.owned && returnFocus.trigger.isConnected && !returnFocus.trigger.disabled &&
      (document.activeElement === document.body || document.activeElement === returnFocus.trigger)) {
      returnFocus.trigger.focus({ preventScroll: true });
    }
  }, [returnFocus]);

  // Progress stays in the shared cache, including the final result and lines.
  useEffect(() => {
    if (!showProgress || !running) return;
    let live = true;
    let timer: ReturnType<typeof setInterval> | null = null;
    const pull = () => {
      if (!live || document.hidden) return;
      void actionLines(running.id);
    };
    const followVisibility = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
      if (document.hidden) return;
      pull();
      if (!finished) timer = setInterval(pull, 1_500);
    };
    document.addEventListener('visibilitychange', followVisibility);
    followVisibility();
    return () => {
      live = false;
      if (timer !== null) clearInterval(timer);
      document.removeEventListener('visibilitychange', followVisibility);
    };
  }, [showProgress, running?.id, finished]);

  const send = async (request: PowerRequest, owner: ActionFocus) => {
    const session = getState();
    const current = actionGuard();
    if (!current() || !identified || session.device?.id !== device?.id || session.device?.kind !== device?.kind || session.unpaired || session.sessionExpired) return;
    requestFocus.current = owner;
    setMenu(null);
    setAsking(request.target);
    const result = await act(request);
    if (!live.current) return;
    if (!current()) {
      if (requestFocus.current === owner) setAsking(null);
      return;
    }
    setAsking(null);
    if (result.kind === 'confirm') {
      onConfirm({
        message: result.confirm.summary || `Do "${actionLabel(request.verb)}" on that service?`,
        isCurrent: current,
        onConfirm: () => { if (live.current && current()) void send({ ...request, confirm: result.confirm.confirm }, owner); },
        onCancel: () => { if (live.current) setReturnFocus(owner); },
      });
      return;
    }
    setReturnFocus(owner);
    if (result.kind === 'busy') {
      toast(result.message);
      refresh();
      return;
    }
    if (result.kind === 'error') {
      toast(result.message);
      return;
    }
    toast(
      request.when === 'idle'
        ? `${actionLabel(request.verb)} queued — it waits until nothing is mid-turn.`
        : `${actionLabel(request.verb)} started. This page follows it.`,
      'info',
    );
  };

  const ask = (component: ComponentStatus, verb: SupervisorVerb, when?: 'now' | 'idle', profile?: string) => {
    if (!menu) return;
    void send({
      verb,
      target: component.id,
      ...(when ? { when } : {}),
      ...(profile ? { profile } : {}),
    }, { trigger: menu.trigger, owned: true });
  };

  const onAction = (component: ComponentStatus, verb: SupervisorVerb, trigger: HTMLButtonElement) => {
    if (menu?.component.id === component.id && menu.verb === verb) {
      setMenu(null);
      return;
    }
    if (verb === 'switch-model') {
      const profiles = switchProfiles(component);
      // One thing to switch to: go straight to the timing question.
      if (profiles.length === 1) setMenu({ component, verb, profile: profiles[0], trigger });
      else setMenu({ component, verb, trigger });
      return;
    }
    if (offersTiming(verb)) setMenu({ component, verb, trigger });
    else void send({ verb, target: component.id }, { trigger, owned: true });
  };

  const statusTone = status && !unavailable ? overallTone(status.overall) : 'off';

  return (
    <Page className="page-power" title="Status & power">
      <p className="page-lead">
        {status && !unavailable ? (
          <>
            <span className={`pip ${statusTone}`} aria-hidden="true" /> {status.sentence}
          </>
        ) : (
          (sentence ?? UNAVAILABLE_LINE)
        )}
      </p>
      {status && !unavailable && busyLine(status.busy) && <p className="page-note power-busy-line">{busyLine(status.busy)}</p>}

      {running && (
        <div className="attention power-banner" role="status">
          {!finished && <LoaderCircle size={20} className="spin" aria-hidden="true" />}
          <span className="grow">
            <strong>{runningLine(running)}</strong>
            {finished && power.result && <p className="power-result">{power.result}</p>}
            {running.state === 'waiting-for-idle' && (
              <>
                <br />
                <span className="muted">Nothing is touched until a chat is between turns.</span>
              </>
            )}
          </span>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setShowProgress((shown) => !shown)}
            aria-expanded={showProgress}
          >
            {showProgress ? 'Hide progress' : 'Show progress'}
          </button>
          {finished && <button type="button" className="btn btn-text" onClick={() => { power.dismiss(running.id); setShowProgress(false); }}>Dismiss</button>}
        </div>
      )}
      {running && showProgress && (
        <div className="power-lines">
          {lines?.length ? (
            <pre>{lines.join('\n')}</pre>
          ) : (
            <p className="muted">Nothing printed yet.</p>
          )}
        </div>
      )}

      {identified && power.completed.filter((completed) => completed.id !== running?.id).map((completed) => (
        <div key={completed.id} className="power-card power-completed" role="status">
          <strong>{runningLine(completed)}</strong>
          {completed.result && <p className="power-result">{completed.result}</p>}
          <button type="button" className="btn btn-text" onClick={() => power.dismiss(completed.id)}>Dismiss</button>
          <details className="power-details">
            <summary>Show progress</summary>
            <div className="power-lines">
              {completed.lines.length ? <pre>{completed.lines.join('\n')}</pre> : <p className="muted">Nothing printed yet.</p>}
            </div>
          </details>
        </div>
      ))}

      {unavailable || !status ? (
        <div className="power-card power-none">
          <h2>{sentence ?? UNAVAILABLE_LINE}</h2>
          <p className="power-sentence">
            Wayroost asks the supervisor on this PC what is running, and that answer isn&rsquo;t here yet, so nothing
            can be started or stopped from here. Everything else in the app works as usual.
          </p>
          <button type="button" className="btn btn-secondary" onClick={refresh} disabled={!loaded}>
            Try again
          </button>
        </div>
      ) : (
        status.components.map((component) => (
          <PowerCard
            key={component.id}
            component={phone ? { ...component, actions: component.actions.filter((verb) => PHONE_VERBS.includes(verb)) } : component}
            asking={asking === component.id}
            restoreFocus={menu === null && asking === null}
            menu={menu?.component.id === component.id ? menu : null}
            onAction={(verb, trigger) => onAction(component, verb, trigger)}
            onPickProfile={(profile) => setMenu((current) => current ? { ...current, profile } : null)}
            onWhen={(when, profile) => ask(component, 'switch-model', when, profile?.id ?? menu?.profile?.id)}
            onTiming={(when) => ask(component, menu?.verb ?? 'restart', when)}
            onCloseMenu={() => setMenu(null)}
          />
        ))
      )}

      {status && !unavailable && status.notSetUp?.map((item) => (
        <article key={item.id} className="power-card power-not-set-up">
          <div className="power-head">
            <h2>{item.name}</h2>
            <span className="state-chip">{NOT_SET_UP_CHIP}</span>
          </div>
          <p className="power-sentence">{item.sentence}</p>
        </article>
      ))}

      {presence.length > 0 && <Presence presence={presence} own={device?.id} />}

      <p className="page-note">
        Ports, process names and logs live under Details on each card. To change what a service does, use{' '}
        <Link to="/settings">Settings</Link>.
      </p>

    </Page>
  );
}

/** One service: name, state chip, one sentence, one main button, Details. */
function PowerCard({
  component,
  asking,
  restoreFocus,
  menu,
  onAction,
  onPickProfile,
  onTiming,
  onWhen,
  onCloseMenu,
}: {
  component: ComponentStatus;
  asking: boolean;
  restoreFocus: boolean;
  menu: { verb: SupervisorVerb; profile?: ModelProfile } | null;
  onAction: (verb: SupervisorVerb, trigger: HTMLButtonElement) => void;
  onPickProfile: (profile: ModelProfile) => void;
  /** "Now" or "When idle" for the action the menu is offering. */
  onTiming: (when: 'now' | 'idle') => void;
  /** The same question, for a model switch that also chose a profile. */
  onWhen: (when: 'now' | 'idle', profile?: ModelProfile) => void;
  onCloseMenu: () => void;
}) {
  const chip = STATE_CHIP[component.state];
  const main = mainAction(component);
  // The plum button is saved for a service that isn't healthy.
  const mainIsPrimary = chip.tone !== 'ok';
  const profiles = component.actions.includes('switch-model') ? switchProfiles(component) : [];
  const needsProfile = menu?.verb === 'switch-model' && !menu.profile && profiles.length !== 1;
  const menuId = useId();
  const menuRef = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const opened = useRef(false);
  const focusLast = useRef(false);

  useEffect(() => {
    if (menu) {
      const items = menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
      const item = focusLast.current ? items?.[items.length - 1] : items?.[0];
      item?.focus();
      focusLast.current = false;
      opened.current = true;
    } else if (opened.current) {
      if (restoreFocus) trigger.current?.focus();
      opened.current = false;
    }
  }, [menu?.verb, menu?.profile?.id, restoreFocus]);

  const openAction = (event: MouseEvent<HTMLButtonElement> | KeyboardEvent<HTMLButtonElement>, verb: SupervisorVerb) => {
    trigger.current = event.currentTarget;
    onAction(verb, event.currentTarget);
  };
  const openWithKey = (event: KeyboardEvent<HTMLButtonElement>, verb: SupervisorVerb) => {
    if (!offersTiming(verb) || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return;
    event.preventDefault();
    if (menu?.verb === verb) {
      menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
      return;
    }
    focusLast.current = event.key === 'ArrowUp';
    openAction(event, verb);
  };

  return (
    <article
      className={`power-card tone-${chip.tone}`}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && menu) {
          event.preventDefault();
          onCloseMenu();
        }
      }}
    >
      <div className="power-head">
        <h2>{component.name}</h2>
        <span className={`state-chip ${chip.tone}`}>{chip.label}</span>
      </div>
      <p className="power-sentence">
        {component.sentence}
        {component.busy && <span className="power-busy"> · busy</span>}
      </p>

      <div className="power-actions">
        {main && (
          <button
            type="button"
            className={`btn ${mainIsPrimary ? 'btn-primary' : 'btn-secondary'}`}
            onClick={(event) => openAction(event, main)}
            onKeyDown={(event) => openWithKey(event, main)}
            disabled={asking}
            aria-haspopup={offersTiming(main) || main === 'switch-model' ? 'menu' : undefined}
            aria-expanded={offersTiming(main) ? menu?.verb === main : undefined}
            aria-controls={menu?.verb === main ? menuId : undefined}
          >
            {asking && <LoaderCircle size={16} className="spin" aria-hidden="true" />}
            {actionLabel(main)}
          </button>
        )}
        {component.actions.slice(1).map((verb) => (
          <button
            key={verb}
            type="button"
            className="btn btn-secondary"
            onClick={(event) => openAction(event, verb)}
            onKeyDown={(event) => openWithKey(event, verb)}
            aria-haspopup={offersTiming(verb) ? 'menu' : undefined}
            aria-expanded={offersTiming(verb) ? menu?.verb === verb : undefined}
            aria-controls={menu?.verb === verb ? menuId : undefined}
            disabled={asking}
          >
            {actionLabel(verb)}
          </button>
        ))}
      </div>

      {menu && (
        <div
          ref={menuRef}
          id={menuId}
          className="power-menu"
          role="menu"
          aria-label={actionLabel(menu.verb)}
          onKeyDown={(event) => {
            const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
            const index = items.indexOf(document.activeElement as HTMLButtonElement);
            let next: number;
            if (event.key === 'ArrowDown') next = (index + 1) % items.length;
            else if (event.key === 'ArrowUp') next = (index - 1 + items.length) % items.length;
            else if (event.key === 'Home') next = 0;
            else if (event.key === 'End') next = items.length - 1;
            else return;
            event.preventDefault();
            items[next]?.focus();
          }}
        >
          {needsProfile ? (
            profiles.map((profile) => (
              <button key={profile.id} type="button" role="menuitem" onClick={() => onPickProfile(profile)}>
                <strong>{profile.name}</strong>
                {profile.loadSeconds ? (
                  <span className="muted"> · about {Math.max(1, Math.round(profile.loadSeconds / 60))} min to load</span>
                ) : null}
              </button>
            ))
          ) : (
            <>
              <p className="power-menu-label">
                {menu.profile ? `${menu.profile.name}:` : `${actionLabel(menu.verb)} ${component.name}?`}
              </p>
              <button type="button" role="menuitem" onClick={() => (menu.profile ? onWhen('now', menu.profile) : onTiming('now'))}>
                Now
              </button>
              <button type="button" role="menuitem" onClick={() => (menu.profile ? onWhen('idle', menu.profile) : onTiming('idle'))}>
                When idle
                <span className="muted"> · waits until nothing is mid-turn</span>
              </button>
            </>
          )}
          <button type="button" role="menuitem" className="link-btn power-menu-cancel" onClick={onCloseMenu}>
            Cancel
          </button>
        </div>
      )}

      <details className="power-details">
        <summary>Details</summary>
        <dl className="power-facts">
          {component.since ? <Fact label="In this state since" value={clockTime(component.since)} /> : null}
          {component.model ? (
            <Fact
              label="Model"
              value={component.model.profiles.find((p) => p.id === component.model?.live)?.name ?? component.model.live ?? 'none loaded'}
            />
          ) : null}
          {Object.entries(component.details ?? {}).map(([key, value]) => (
            <Fact key={key} label={key} value={value} code />
          ))}
        </dl>
      </details>
    </article>
  );
}

function Fact({ label, value, code = false }: { label: string; value: string; code?: boolean }) {
  return (
    <div className="power-fact">
      <dt>{label}</dt>
      <dd>{code ? <code>{value}</code> : value}</dd>
    </div>
  );
}

/** "9:41". Full date and time on hover. */
function clockTime(ms: number): string {
  const at = new Date(ms);
  return at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

const PRESENCE_WORDS: Record<DevicePresence['state'], string> = { active: 'in use', idle: 'idle', locked: 'locked' };

/** What each paired device last said about itself (M1 shows it; nothing is routed by it yet). */
function Presence({ presence, own }: { presence: DevicePresence[]; own: string | undefined }) {
  return (
    <section className="power-presence" aria-label="Devices">
      <h2 className="group-title">Devices</h2>
      <ul>
        {presence.map((report) => (
          <li key={report.device}>
            {report.device === own ? 'This device' : report.kind === 'phone' ? 'A phone' : 'A desktop'}:{' '}
            {PRESENCE_WORDS[report.state]} <span className="muted">· {clockTime(report.at)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
