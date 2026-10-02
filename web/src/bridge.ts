// Messages agents send each other through the Signalbox bridge arrive wrapped
// in an envelope (shared/protocol.ts). Titles and previews are cut short on the
// server, often inside that envelope, so they're read leniently here: the web
// shows who sent it and what they wrote, never the boilerplate.

const PREFIX = '[Message from ';
const VIA = ' via Signalbox';

/** "Some chat vi" → "Some chat": drops a " via Signalbox" that was cut short. */
function withoutCutVia(text: string): string {
  for (let i = text.indexOf(' '); i >= 0; i = text.indexOf(' ', i + 1)) {
    if (VIA.startsWith(text.slice(i))) return text.slice(0, i);
  }
  return text;
}

/** A title or preview as it should read: "<sender>: <text>", "Message from <sender>", or unchanged. */
export function readableBridgeText(text: string): string;
export function readableBridgeText(text: string | undefined): string | undefined;
export function readableBridgeText(text: string | undefined): string | undefined {
  if (!text?.startsWith(PREFIX)) return text;
  const via = text.indexOf(VIA);
  if (via < 0) {
    // Cut off in or just after the sender's name.
    const cut = text.slice(PREFIX.length).replace(/…$/u, '');
    const whole = withoutCutVia(cut);
    const sender = whole.trim();
    if (!sender) return 'Message from another agent';
    return whole === cut ? `Message from ${sender}…` : `Message from ${sender}`;
  }
  const sender = text.slice(PREFIX.length, via).trim();
  const end = text.indexOf(']', via);
  const body = end < 0 ? '' : text.slice(end + 1).trim();
  return body ? `${sender}: ${body}` : `Message from ${sender}`;
}
