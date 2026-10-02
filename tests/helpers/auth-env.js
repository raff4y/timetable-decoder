// Local stand-in for Neon Auth, for tests: a generated key pair, a JWKS server,
// a fake "Neon Auth" endpoint that records password-reset calls, and the env
// vars that point server/auth.js at them. Reusable by other test files:
//
//   const env = await startAuthEnv();
//   const token = await env.sign({ sub: 'u1', email: 'a@b.co', emailVerified: true });
//   fetch(url, { headers: { Authorization: `Bearer ${token}` } });
//   await env.stop();

import http from 'node:http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

export const ISSUER = 'https://auth.test.invalid';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

export async function startAuthEnv() {
  const kid = 'test-key-1';
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'EdDSA', use: 'sig' };
  const other = await generateKeyPair('EdDSA');

  const jwksServer = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  const resetCalls = [];
  const neonServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      resetCalls.push({ url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
      res.setHeader('Content-Type', 'application/json');
      res.end('{"status":true}');
    });
  });
  const jwksPort = await listen(jwksServer);
  const neonPort = await listen(neonServer);

  const saved = {};
  const set = (k, v) => {
    saved[k] = process.env[k];
    process.env[k] = v;
  };
  set('NEON_AUTH_URL', `http://127.0.0.1:${neonPort}/neondb/auth`);
  set('NEON_AUTH_JWKS_URL', `http://127.0.0.1:${jwksPort}/.well-known/jwks.json`);
  set('NEON_AUTH_ISSUER', ISSUER);
  set('RESET_MIN_MS', '0');

  /** Sign a Neon-Auth-shaped JWT. `claims` become payload fields. */
  // `issuedAt`: seconds since the epoch, or false for a token with no iat at all.
  async function sign(claims = {}, { key = privateKey, expiresIn = '15m', issuer = ISSUER, kidOverride = kid, issuedAt } = {}) {
    const { sub, ...rest } = claims;
    const jwt = new SignJWT({ role: 'authenticated', ...rest })
      .setProtectedHeader({ alg: 'EdDSA', kid: kidOverride })
      .setSubject(sub)
      .setIssuer(issuer)
      .setExpirationTime(expiresIn);
    if (issuedAt !== false) jwt.setIssuedAt(issuedAt);
    return jwt.sign(key);
  }

  return {
    sign,
    /** A key the JWKS does not know about, for "forged token" tests. */
    foreignKey: other.privateKey,
    resetCalls,
    issuer: ISSUER,
    async stop() {
      await new Promise((r) => jwksServer.close(r));
      await new Promise((r) => neonServer.close(r));
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}
