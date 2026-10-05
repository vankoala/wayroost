import { request } from 'node:http';
import { usageSummaryRequestSchema, usageSummaryResultSchema, type UsageSummaryResult } from '../../shared/supervisor-config.js';

/** Read only bounded summaries from the gateway's private admin socket. */
export async function gatewayUsageSummary(input: unknown, signal?: AbortSignal): Promise<UsageSummaryResult> {
  const parsed = usageSummaryRequestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'invalid_parameters' };
  try {
    return await new Promise<UsageSummaryResult>((resolve, reject) => {
      const body = JSON.stringify(parsed.data);
      const client = request({ socketPath: '/run/wayroost-gateway/admin.sock', path: '/v1/usage/summary', method: 'POST',
        signal: AbortSignal.any([AbortSignal.timeout(3000), ...(signal ? [signal] : [])]),
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      }, response => {
        let size = 0;
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 1024 * 1024) { response.destroy(); reject(new Error('Usage summary is too large.')); }
          else chunks.push(chunk);
        });
        response.once('error', reject);
        response.once('aborted', () => reject(new Error('Usage summary ended early.')));
        response.once('end', () => {
          try {
            if (response.statusCode !== 200) throw new Error('Usage summary is unavailable.');
            resolve(usageSummaryResultSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
          } catch (error) { reject(error); }
        });
      });
      client.once('error', reject); client.end(body);
    });
  } catch { return { ok: false, code: 'unavailable' }; }
}
