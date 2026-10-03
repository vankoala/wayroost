import { isAbsolute } from 'node:path';
import { credential, ElevenLabs } from './cloud-api.js';
import { startCloudRpc } from './cloud-rpc.js';

try {
  const socket = process.env.WAYROOST_VOICE_CLOUD_SOCKET;
  if (!socket || !isAbsolute(socket) || Buffer.byteLength(socket) > 107) throw new Error();
  const server = await startCloudRpc(socket, new ElevenLabs(credential(process.env)));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
} catch {
  console.error('Cloud voice could not start. Check the credential and runtime socket.');
  process.exitCode = 1;
}
