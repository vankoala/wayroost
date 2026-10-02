// Response headers applied to everything the app serves. The CSP is the main
// defence against injected markup in agent output: no inline or third-party
// script can run, and images can't beacon data to outside hosts.

export interface HeaderOptions {
  /** Voice mode is on: this page (and only this page) may ask for the microphone. */
  microphone?: boolean;
}

export function securityHeaders(publicOrigin: string, options: HeaderOptions = {}): Record<string, string> {
  const wsOrigin = publicOrigin.replace(/^http/, 'ws');
  const csp = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self' ${wsOrigin}`,
    "manifest-src 'self'",
    "worker-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ].join('; ');

  const headers: Record<string, string> = {
    'content-security-policy': csp,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'permissions-policy': `camera=(), microphone=${options.microphone ? '(self)' : '()'}, geolocation=(), payment=(), usb=(), serial=(), hid=()`,
  };
  if (publicOrigin.startsWith('https://')) {
    headers['strict-transport-security'] = 'max-age=31536000';
  }
  return headers;
}
