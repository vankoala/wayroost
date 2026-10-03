import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';

/** DER for the fixed X.509 v3 loopback certificate; cryptography stays in Node’s built-in crypto. */
function der(tag: number, value: Buffer): Buffer {
  const length = value.length < 128 ? Buffer.from([value.length]) : (() => {
    const bytes: number[] = []; let size = value.length;
    while (size) { bytes.unshift(size & 255); size >>>= 8; }
    return Buffer.from([0x80 | bytes.length, ...bytes]);
  })();
  return Buffer.concat([Buffer.from([tag]), length, value]);
}
const sequence = (...values: Buffer[]) => der(0x30, Buffer.concat(values));
const oid = (hex: string) => der(0x06, Buffer.from(hex, 'hex'));
const extension = (id: string, value: Buffer, critical = false) => sequence(oid(id), ...(critical ? [der(0x01, Buffer.from([0xff]))] : []), der(0x04, value));
function time(date: Date): Buffer {
  const value = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z').replace('T', '');
  const utc = date.getUTCFullYear() >= 1950 && date.getUTCFullYear() < 2050;
  return der(utc ? 0x17 : 0x18, Buffer.from(utc ? value.slice(2) : value, 'ascii'));
}

export function selfSignedLoopbackCertificate(): { certificate: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const algorithm = sequence(oid('2a8648ce3d040302')); // ecdsa-with-SHA256
  const name = sequence(der(0x31, sequence(oid('550403'), der(0x0c, Buffer.from('Wayroost loopback')))));
  const serial = randomBytes(16); serial[0] = (serial[0]! & 0x7f) | 1;
  const generated = Math.floor(Date.now() / 1000) * 1000;
  const start = new Date(generated - 86400000);
  const end = new Date(generated + 3650 * 86400000);
  const extensions = sequence(
    extension('551d11', sequence(der(0x87, Buffer.from([127, 0, 0, 1])), der(0x82, Buffer.from('localhost')))),
    extension('551d13', sequence(), true), // basicConstraints: CA=false
    extension('551d0f', der(0x03, Buffer.from([7, 0x80])), true), // digitalSignature
    extension('551d25', sequence(oid('2b06010505070301'))), // serverAuth
  );
  const tbs = sequence(der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, serial), algorithm, name,
    sequence(time(start), time(end)), name, publicKey.export({ type: 'spki', format: 'der' }), der(0xa3, extensions));
  const certificate = sequence(tbs, algorithm, der(0x03, Buffer.concat([Buffer.from([0]), sign('sha256', tbs, privateKey)])));
  return {
    certificate: `-----BEGIN CERTIFICATE-----\n${certificate.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`,
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}
