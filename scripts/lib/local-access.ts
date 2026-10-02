// Local stand-ins for Cloudflare Access, for demos and tests only:
//  - a signing key + token for one email (what Access would issue), and
//  - an "edge" proxy that stamps that token on every request and WebSocket
//    handshake before forwarding to the app, like Cloudflare's edge does.
// The app still verifies every token with its normal code path.
import { createServer, request, type Server } from 'node:http';
import { connect } from 'node:net';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWK } from 'jose';

export interface LocalAccess {
  issuer: string;
  aud: string;
  email: string;
  token: string;
  jwk: JWK;
  keySource: ReturnType<typeof createLocalJWKSet>;
}

export async function createLocalAccess(options: { issuer: string; aud?: string; email?: string }): Promise<LocalAccess> {
  const aud = options.aud ?? 'local-signalbox';
  const email = options.email ?? 'you@example.com';
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'local', alg: 'RS256', use: 'sig' };
  const token = await new SignJWT({ email, type: 'app' })
    .setProtectedHeader({ alg: 'RS256', kid: 'local' })
    .setIssuer(options.issuer)
    .setAudience([aud])
    .setIssuedAt()
    .setExpirationTime('12h')
    .sign(privateKey);
  return { issuer: options.issuer, aud, email, token, jwk, keySource: createLocalJWKSet({ keys: [jwk] }) };
}

/** Serves the public key where the app expects Cloudflare's certs endpoint. */
export async function startJwksServer(port: number, jwk: JWK): Promise<Server> {
  const server = createServer((req, res) => {
    res.writeHead(req.url === '/cdn-cgi/access/certs' ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((done) => server.listen(port, '127.0.0.1', done));
  return server;
}

/** Plays Cloudflare's edge: adds the Access token to HTTP requests and WebSocket upgrades. */
export async function startEdge(options: { port: number; appPort: number; token: string }): Promise<Server> {
  const { appPort, token } = options;
  const edge = createServer((req, res) => {
    const upstream = request(
      {
        host: '127.0.0.1',
        port: appPort,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, 'cf-access-jwt-assertion': token },
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
  });
  edge.on('upgrade', (req, socket, head) => {
    const up = connect(appPort, '127.0.0.1', () => {
      let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
      for (const [name, value] of Object.entries({ ...req.headers, 'cf-access-jwt-assertion': token })) {
        for (const v of [value].flat()) if (v !== undefined) raw += `${name}: ${v}\r\n`;
      }
      up.write(`${raw}\r\n`);
      if (head.length) up.write(head);
      socket.pipe(up).pipe(socket);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });
  await new Promise<void>((done) => edge.listen(options.port, '127.0.0.1', done));
  return edge;
}
