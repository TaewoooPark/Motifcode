/** Local-only OAuth + protected MCP fixture. No real accounts or provider secrets. */
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function createOAuthFixture() {
  let origin = '';
  const codes = new Map<string, { challenge: string; resource: string; redirect: string; client: string }>();
  const accessTokens = new Set<string>(); const refreshTokens = new Set<string>();
  const counts = { discovery: 0, registration: 0, authorizationPage: 0, approved: 0, denied: 0, exchange: 0, refresh: 0, unauthorized: 0, initialize: 0, list: 0, read: 0 };
  const fact = `MOTIF-OAUTH-${randomBytes(6).toString('hex')}`;
  const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('Content-Type', 'application/json');
    const url = new URL(request.url ?? '/', origin);
    let body = ''; for await (const chunk of request) body += chunk;
    const json = (value: unknown, status = 200) => { response.writeHead(status).end(JSON.stringify(value)); };
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      counts.discovery++; json({ resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ['read'] }); return;
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      counts.discovery++; json({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'], authorization_response_iss_parameter_supported: true }); return;
    }
    if (url.pathname === '/register') {
      counts.registration++;
      try { json({ ...JSON.parse(body), client_id: `motif-fixture-${randomBytes(4).toString('hex')}` }, 201); } catch { json({ error: 'invalid_client_metadata' }, 400); }
      return;
    }
    if (url.pathname === '/authorize') {
      counts.authorizationPage++;
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      const fields = [...url.searchParams].map(([name, value]) => `<input type="hidden" name="${escape(name)}" value="${escape(value)}">`).join('');
      response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Motif OAuth test provider</title></head><body><main><h1>Motif OAuth test provider</h1><p>This local fixture grants access to one public test fact. No real account is connected.</p><form method="post" action="/approve">${fields}<button name="decision" value="approve" type="submit">Approve test access</button><button name="decision" value="deny" type="submit">Deny test access</button></form></main></body></html>`); return;
    }
    if (url.pathname === '/approve') {
      const fields = request.method === 'POST' ? new URLSearchParams(body) : url.searchParams;
      let redirect: URL;
      try { redirect = new URL(fields.get('redirect_uri')!); if (redirect.protocol !== 'http:' || redirect.hostname !== '127.0.0.1' || redirect.pathname !== '/callback') throw Error(); }
      catch { json({ error: 'invalid_request' }, 400); return; }
      redirect.searchParams.set('state', fields.get('state') ?? ''); redirect.searchParams.set('iss', origin);
      if (fields.get('decision') === 'deny') { counts.denied++; redirect.searchParams.set('error', 'access_denied'); }
      else {
        if (fields.get('code_challenge_method') !== 'S256' || !fields.get('code_challenge')) { json({ error: 'invalid_request' }, 400); return; }
        counts.approved++;
        const code = randomBytes(24).toString('base64url');
        codes.set(code, { challenge: fields.get('code_challenge')!, resource: fields.get('resource') ?? '', redirect: fields.get('redirect_uri')!, client: fields.get('client_id') ?? '' });
        redirect.searchParams.set('code', code);
      }
      response.writeHead(302, { Location: redirect.href }).end(); return;
    }
    if (url.pathname === '/token') {
      const fields = new URLSearchParams(body);
      if (fields.get('grant_type') === 'refresh_token') {
        counts.refresh++;
        if (!refreshTokens.has(fields.get('refresh_token') ?? '') || fields.get('resource') !== `${origin}/mcp`) { json({ error: 'invalid_grant' }, 400); return; }
      } else {
        counts.exchange++;
        const code = fields.get('code') ?? ''; const grant = codes.get(code); codes.delete(code);
        if (!grant || grant.challenge !== createHash('sha256').update(fields.get('code_verifier') ?? '').digest('base64url') || grant.redirect !== fields.get('redirect_uri') || grant.resource !== `${origin}/mcp` || fields.get('resource') !== grant.resource || fields.get('client_id') !== grant.client) { json({ error: 'invalid_grant' }, 400); return; }
      }
      const token = `fixture-access-${randomBytes(20).toString('hex')}`; const refresh = `fixture-refresh-${randomBytes(20).toString('hex')}`;
      accessTokens.add(token); refreshTokens.add(refresh); json({ access_token: token, refresh_token: refresh, token_type: 'Bearer', expires_in: 3600, scope: 'read' }); return;
    }
    if (url.pathname === '/mcp') {
      const token = request.headers.authorization?.replace(/^Bearer /, '');
      if (!token || !accessTokens.has(token)) { counts.unauthorized++; response.setHeader('WWW-Authenticate', `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource", scope="read"`); json({ error: 'unauthorized' }, 401); return; }
      if (request.method === 'GET') { response.writeHead(405).end(); return; }
      if (request.method === 'DELETE') { response.writeHead(204).end(); return; }
      let rpc: { id?: unknown; method?: string; params?: { protocolVersion?: string; name?: string } };
      try { rpc = JSON.parse(body); } catch { json({ error: 'invalid_request' }, 400); return; }
      if (rpc.method?.startsWith('notifications/')) { response.writeHead(202).end(); return; }
      let result: unknown;
      if (rpc.method === 'initialize') { counts.initialize++; result = { protocolVersion: rpc.params?.protocolVersion ?? '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'motif-oauth-fixture', version: '1.0.0' } }; }
      else if (rpc.method === 'tools/list') { counts.list++; result = { tools: [{ name: 'read_public_fact', description: 'Read the public proof string of the local OAuth test fixture.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } }] }; }
      else if (rpc.method === 'tools/call' && rpc.params?.name === 'read_public_fact') { counts.read++; result = { content: [{ type: 'text', text: fact }] }; }
      else { json({ jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'Method not found' } }); return; }
      json({ jsonrpc: '2.0', id: rpc.id, result }); return;
    }
    json({ error: 'not_found' }, 404);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture listener unavailable.');
  origin = `http://127.0.0.1:${address.port}`;
  return {
    origin, mcpUrl: `${origin}/mcp`, fact, counts,
    /** Test automation simulates the user's explicit Approve/Deny button. */
    approve: async (authorizationUrl: URL, decision: 'approve' | 'deny' = 'approve') => {
      const action = new URL('/approve', origin); action.search = authorizationUrl.search; action.searchParams.set('decision', decision);
      return fetch(action);
    },
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const fixture = await createOAuthFixture();
  console.log(JSON.stringify({ origin: fixture.origin, mcpUrl: fixture.mcpUrl, fact: fixture.fact }));
  const close = () => { console.log(JSON.stringify({ counts: fixture.counts })); void fixture.close(); };
  process.once('SIGINT', close); process.once('SIGTERM', close);
}
