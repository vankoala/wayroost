// Opt-in preload for the full legacy suite: confine TCP to the assigned development ports.
const net = require('node:net');
const path = require('node:path');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const held = new Set();
const ports = [8898, 8899];
const listen = net.Server.prototype.listen;
const connect = net.Socket.prototype.connect;
const isLocal = host => host === undefined || ['127.0.0.1', 'localhost', '::1'].includes(host);
const root = process.env.WAYROOST_TEST_ROOT || process.cwd();
const isOwnedPath = value => {
  if (path.resolve(value).startsWith(`${root}${path.sep}`)) return true;
  // Gateway socket operations use the validated directory descriptor instead of a replaceable pathname.
  if (!/^\/proc\/self\/fd\/\d+\/[^/]+$/.test(value)) return false;
  return fs.realpathSync(path.dirname(value)).startsWith(`${root}${path.sep}`);
};

net.Server.prototype.listen = function (...args) {
  const options = typeof args[0] === 'object' ? { ...args[0] } : undefined;
  const address = options ? options.path ?? options.port : args[0];
  if (typeof address === 'string' && !/^\d+$/.test(address)) {
    if (!isOwnedPath(address)) throw new Error('Test Unix listener is outside the clone.');
    return listen.apply(this, args);
  }
  const host = options ? options.host : typeof args[1] === 'string' ? args[1] : undefined;
  if (!isLocal(host)) throw new Error('Test TCP listener must be loopback.');
  const port = Number(address) === 0 ? ports.find(value => !held.has(value)) : Number(address);
  if (!ports.includes(port) || held.has(port)) throw new Error('Test listener is outside the two available development ports.');
  held.add(port);
  let released = false;
  const release = () => { if (!released) { released = true; held.delete(port); } };
  this.once('close', release); this.once('error', release);
  if (options) args[0] = { ...options, port, host: '127.0.0.1' };
  else { args[0] = port; if (typeof args[1] === 'string') args[1] = '127.0.0.1'; else args.splice(1, 0, '127.0.0.1'); }
  try { return listen.apply(this, args); } catch (error) { release(); throw error; }
};

net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = typeof first === 'object' ? first : typeof first === 'string' && !/^\d+$/.test(first)
    ? { path: first } : { port: first, host: typeof args[1] === 'string' ? args[1] : undefined };
  if (options.path ? isOwnedPath(options.path) : isLocal(options.host) && ports.includes(Number(options.port))) {
    return connect.apply(this, args);
  }
  // Intentional unavailable-backend checks fail locally without a network call.
  const error = Object.assign(new Error('Test network connection blocked by development-port guard.'), { code: 'ECONNREFUSED' });
  queueMicrotask(() => this.destroy(error));
  return this;
};

// Some legacy protocol tests replace the entire child environment.
const spawn = childProcess.spawn;
childProcess.spawn = function (command, args, options) {
  if (command === process.execPath) {
    const original = options?.env || process.env;
    options = { ...options, env: { ...original, WAYROOST_TEST_ROOT: root,
      NODE_OPTIONS: `${original.NODE_OPTIONS || ''} --require=${__filename}` } };
  }
  return spawn.call(this, command, args, options);
};
