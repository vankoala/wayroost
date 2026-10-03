import type { ConnectorGroup, ConnectorKind } from '../../../shared/protocol.js';

// The connectors Signalbox offers, in the order the page lists them. Sign-in
// connectors are entries in Hermes' own approved MCP catalog (optional-mcps/),
// by the same name, so installing one is Hermes' own one-click install.

export interface CatalogEntry {
  id: string;
  name: string;
  kind: ConnectorKind;
  group: ConnectorGroup;
  blurb: string;
  can: string[];
  caution?: string;
  /** The server answers without an account: connect it anonymously, with no sign-in page. */
  noSignIn?: boolean;
}

const signIn = (
  id: string,
  name: string,
  group: ConnectorGroup,
  blurb: string,
  can: string[],
  caution?: string,
): CatalogEntry => ({ id, name, kind: 'sign-in', group, blurb, can, ...(caution ? { caution } : {}) });

export const CATALOG: readonly CatalogEntry[] = [
  {
    id: 'google',
    name: 'Google',
    kind: 'google',
    group: 'google',
    blurb: 'Gmail, Calendar, Drive, Docs, Sheets and Contacts',
    can: [
      'Search and read your mail, and send or reply when you ask',
      'See and change your calendar',
      'Find, read and create files in Drive, Docs and Sheets',
      'Look up your contacts',
    ],
    caution:
      'Google signs in with a paste-back step: after you approve, the page fails to load on purpose. Copy its address and paste it here.',
  },
  signIn('notion', 'Notion', 'everyday', 'Pages and databases in your workspace', [
    'Search and read pages and databases',
    'Create and edit pages when you ask',
  ]),
  signIn('todoist', 'Todoist', 'everyday', 'Tasks and projects', ['See your tasks and projects', 'Add, complete and change tasks']),
  signIn('dropbox', 'Dropbox', 'everyday', 'Files in your Dropbox', ['Search and read files', 'Upload and organise files when you ask']),
  signIn('canva', 'Canva', 'everyday', 'Designs', ['Search your designs', 'Create and edit designs when you ask']),
  signIn('calendly', 'Calendly', 'everyday', 'Scheduling links and bookings', [
    'See your event types and upcoming bookings',
    'Make scheduling links',
  ]),
  signIn('strava', 'Strava', 'everyday', 'Activities and training (read-only)', [
    'Read your activities, fitness trends and training load',
  ]),
  signIn('craft', 'Craft', 'everyday', 'Docs, tasks and notes', ['Search and read your docs', 'Write docs and tasks when you ask']),
  signIn('miro', 'Miro', 'everyday', 'Boards and diagrams', ['Read boards', 'Add and edit items on boards when you ask']),
  signIn('gamma', 'Gamma', 'everyday', 'Presentations, docs and sites', ['Generate and edit presentations when you ask']),
  signIn('fireflies', 'Fireflies', 'everyday', 'Meeting transcripts and summaries', [
    'Search and read meeting transcripts, summaries and action items',
  ]),
  signIn('wordpress-com', 'WordPress.com', 'everyday', 'Posts, pages and stats', [
    'Read posts, pages, comments and stats',
    'Write drafts and publish when you ask',
  ]),
  signIn(
    'cloudflare',
    'Cloudflare',
    'building',
    'Your Cloudflare account (DNS, Workers, Access and more)',
    ['Read and change anything the account you sign in with can'],
    'Wayroost itself is protected by Cloudflare Access. Grant only the permissions you need when Cloudflare asks, and keep this on "Ask before changes".',
  ),
  {
    ...signIn('hugging_face', 'Hugging Face', 'building', 'Search models, datasets, Spaces and papers (no account needed)', [
      'Search and read public models, datasets, Spaces and papers',
    ]),
    caution: "Hugging Face's server works without signing in, so this connects the public Hub. Nothing of your account is shared.",
    noSignIn: true,
  },
  signIn('comfy-cloud', 'Comfy Cloud', 'building', 'Image, video, audio and 3D generation', [
    'Run generations on Comfy Cloud with your account (they may use credits)',
  ]),
  {
    id: 'whatsapp',
    name: 'WhatsApp',
    kind: 'status',
    group: 'elsewhere',
    blurb: 'Chat with Hermes and get trigger results on WhatsApp',
    can: ['Receive your messages to Hermes and send its replies'],
  },
  {
    id: 'shops',
    name: 'Shopping',
    kind: 'status',
    group: 'elsewhere',
    blurb: 'Instacart, Walmart, REI, Home Depot and more, through the signed-in Chrome on your PC',
    can: ['Fill carts and check out after you confirm'],
    caution: 'These are website sign-ins, not app connections: sign in or out in that Chrome on the PC.',
  },
];

export const SIGN_IN_IDS = new Set(CATALOG.filter((c) => c.kind === 'sign-in').map((c) => c.id));
