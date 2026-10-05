import { startGateway } from './gateway.js';
import { parseCliOptions } from './cli.js';
import { EventEmitter } from 'node:events';

try {
  const options = parseCliOptions(process.argv.slice(2));
  options.credentialsDirectory ??= process.env.CREDENTIALS_DIRECTORY;
  const usageEvents = new EventEmitter();
  const gateway = await startGateway({ ...options, onDrained: () => stop(),
    onUsage: () => usageEvents.emit('changed'),
    usageEvents: publish => { usageEvents.on('changed', publish); return () => usageEvents.off('changed', publish); },
    log: entry => process.stdout.write(`${JSON.stringify(entry)}\n`) });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void gateway.close().catch(() => { process.exitCode = 1; });
  };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
} catch {
  process.stderr.write('Gateway could not start. Check the config, socket and listener ports.\n'
    + 'Usage: tsx gateway/src/index.ts --config FILE --socket ABSOLUTE_PATH [--listen main=8898] [--credentials-dir DIR]\n'
    + '  [--max-request-bytes N] [--backend-timeout-ms N] [--idle-timeout-ms N] [--health-timeout-ms N]\n');
  process.exitCode = 1;
}
