import { BackgroundGate } from '../server/src/background.js';
// Demo data for For you (the demo server and the UI check): a few cards like the
// ones Hermes' 7am brief and daytime checks post, a stand-in for the pulse jobs
// so the proactivity level can be changed, and phone notifications that go nowhere.

import type { ScheduleJob, ScheduleList } from '../shared/protocol.js';
import type { EventHub } from '../server/src/hub.js';
import { PushSender } from '../server/src/feed/push.js';
import { BRIEF_JOB, Feed, SCOUT_JOB, SCOUT_SCHEDULES } from '../server/src/feed/service.js';
import { FeedStore } from '../server/src/feed/store.js';
import type { HermesSource } from '../server/src/sources.js';

const quiet = { info() {}, warn() {}, error() {} };

function job(id: string, name: string, scheduleInput: string): ScheduleJob {
  return {
    source: 'hermes', id, name, title: name, plumbing: false, schedule: scheduleInput, scheduleInput, state: 'active', skills: [], deliver: 'local',
    deliverLabel: 'Local', failureStreak: 0, runs: 0, trigger: false, script: true,
  };
}

/** The pulse jobs, as the level switch sees them. */
export class DemoPulseJobs {
  jobs = [job('demo-brief', BRIEF_JOB, '0 7 * * *'), job('demo-scout', SCOUT_JOB, SCOUT_SCHEDULES.normal)];
  async list(): Promise<ScheduleList> {
    return { jobs: this.jobs, targets: [] };
  }
  async setPaused(_source: string, id: string, paused: boolean): Promise<void> {
    this.jobs.find((j) => j.id === id)!.state = paused ? 'paused' : 'active';
  }
  async update(_source: string, id: string, changes: { schedule?: string }): Promise<void> {
    if (changes.schedule) this.jobs.find((j) => j.id === id)!.scheduleInput = changes.schedule;
  }
}

export function demoFeed(hub: EventHub, hermes: Pick<HermesSource, 'createConversation'>, stateDir: string): Feed {
  const store = new FeedStore(stateDir);
  const feed = new Feed({ background: new BackgroundGate('primary'),
    store,
    hub,
    hermes,
    schedules: new DemoPulseJobs(),
    // Notifications "work" but never leave the machine.
    push: new PushSender(stateDir, 'https://wayroost.example.com', quiet, (async () => new Response(null, { status: 201 })) as unknown as typeof fetch, new BackgroundGate('primary')),
    log: quiet,
  });
  feed.ingest('brief', [
    {
      key: 'mail:demo-rsvp',
      kind: 'reply',
      title: "Dana (book club): RSVP for Thursday's meetup",
      detail: "She asks who's coming and whether you can bring snacks.",
      action: "Draft a reply saying you'll be there and will bring snacks.",
      topic: 'Book club forms',
    },
    {
      key: 'event:demo-haircut',
      kind: 'prepare',
      title: 'Haircut at 3:30 PM',
      detail: "It's about 25 minutes away, so leave by 3:00.",
      action: 'Check the traffic at 2:45 and tell me when to leave.',
      topic: 'Appointments',
    },
  ]);
  feed.ingest('scout', [
    {
      key: 'loop:demo-library',
      kind: 'reminder',
      title: 'Return the library books',
      detail: 'You said you would do it today.',
      action: "Find the library's opening hours in last month's email and remind me at 5 PM.",
    },
    {
      key: 'note:demo-github',
      kind: 'heads-up',
      title: 'GitHub: 3 review requests on signalbox',
      detail: 'Nothing urgent: two are dependency updates.',
      topic: 'GitHub notifications',
    },
    {
      key: 'mail:demo-scam',
      kind: 'warning',
      title: 'Looks like a scam: "Account suspended" from paypa1-support',
      detail: "It wants you to sign in through a link. Don't; it's not PayPal.",
    },
  ]);
  return feed;
}
