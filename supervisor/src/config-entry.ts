import { executeConfig } from './config-executor.js';
import { StringDecoder } from 'node:string_decoder';
import { resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export async function readConfigInput(stream: AsyncIterable<string | Buffer>, limit = 1024 * 1024): Promise<string> {
  let input = '';
  let bytes = 0;
  const decoder = new StringDecoder('utf8');
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > limit) throw new Error();
    input += decoder.write(buffer);
  }
  return input + decoder.end();
}

if (process.argv[1] && await realpath(resolve(process.argv[1])).catch(() => '') === fileURLToPath(import.meta.url)) {
  const emit = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try { emit(JSON.stringify(await executeConfig(JSON.parse(await readConfigInput(process.stdin)))) + '\n'); }
  catch { emit('{"ok":false,"code":"invalid_parameters"}\n'); }
}
