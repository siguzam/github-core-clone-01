// app.ts — the entry's HTTP server. Routes:
//   GET  /healthz                      200 {"ok":true}, no auth (the env's boot check)
//   GET  /api/v3/                      the API root, X-OAuth-Scopes, no auth (as the starter ships it)
//   /api/v3/...                        REST v3 (auth: Bearer MAKEFUN_SHOP_TOKEN)
//   POST /api/graphql                  GraphQL v4 (auth)
//   POST /mcp                          MCP over Streamable HTTP (auth)
//   /<owner>/<repo>.git/...            git smart HTTP (the client always sends the token; not enforced here)
//   anything else                      404 {"message":"Not Found"}
// Every response carries an x-github-request-id header (the protocol checks
// require it even on 401s and 404s). Node 22, standard library only.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { Forge, VIEWER } from './store.ts';
import { handleRest, bearerToken, tokenOk, type RestContext } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { infoRefs, uploadPack, receivePack } from './githttp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 256 * 1024 * 1024;

const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

const forge = new Forge();

function requestId(): string {
  return randomBytes(16).toString('hex');
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = typeof body === 'string' ? body : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
    ...extraHeaders,
  });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': requestId(),
    ...extraHeaders,
  });
  res.end(body);
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function headersOf(req: IncomingMessage): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    out[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const path = pathOf(req);
      const method = req.method ?? 'GET';
      const query = queryOf(req);
      const headers = headersOf(req);

      // The env's boot check: 200 {"ok":true}, no auth.
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      // The GitHub API root (as the starter ships it): no auth, scopes header.
      if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
        sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
        return;
      }

      // ---- git smart HTTP (no auth enforcement; the client always sends the token)
      const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
      if (gitMatch !== null) {
        const owner = decodeURIComponent(gitMatch[1]!);
        const repoName = decodeURIComponent(gitMatch[2]!);
        const action = gitMatch[3]!;
        if (action === 'info/refs' && method === 'GET') {
          const service = query.get('service') ?? '';
          const result = infoRefs(forge, owner, repoName, service, headers['git-protocol']);
          if (result.contentType.startsWith('application/json')) {
            sendJson(res, result.status, result.body.toString('utf8'));
          } else {
            sendBuffer(res, result.status, result.body, result.contentType);
          }
          return;
        }
        if (action === 'git-upload-pack' && method === 'POST') {
          const body = await readBody(req);
          const result = uploadPack(forge, owner, repoName, body, headers['git-protocol']);
          if (result.contentType.startsWith('application/json')) {
            sendJson(res, result.status, result.body.toString('utf8'));
          } else {
            sendBuffer(res, result.status, result.body, result.contentType);
          }
          return;
        }
        if (action === 'git-receive-pack' && method === 'POST') {
          const body = await readBody(req);
          const result = receivePack(forge, owner, repoName, body);
          if (result.contentType.startsWith('application/json')) {
            sendJson(res, result.status, result.body.toString('utf8'));
          } else {
            sendBuffer(res, result.status, result.body, result.contentType);
          }
          return;
        }
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }

      // ---- REST v3 (auth required)
      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        const presented = bearerToken(headers);
        if (!tokenOk({ forge, baseUrl: '', token: SHOP_TOKEN }, presented)) {
          sendJson(res, 401, { message: 'Requires authentication' });
          return;
        }
        // The Link pagination headers must be absolute URLs on this origin,
        // so they are built from the Host header the client dialled.
        const origin = `http://${headers.host ?? '127.0.0.1'}`;
        const bodyBuf = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
        const ctx: RestContext = { forge, baseUrl: origin, token: SHOP_TOKEN };
        const result = handleRest(ctx, {
          method,
          path,
          query,
          headers,
          bodyText: bodyBuf.toString('utf8'),
        });
        if (result.status === 204) {
          res.writeHead(204, { 'x-github-request-id': requestId() });
          res.end();
          return;
        }
        sendJson(res, result.status, result.body, result.headers ?? {});
        return;
      }

      // ---- GraphQL v4 (auth required)
      if (path === '/api/graphql' && method === 'POST') {
        const presented = bearerToken(headers);
        if (!tokenOk({ forge, baseUrl: '', token: SHOP_TOKEN }, presented)) {
          sendJson(res, 401, { message: 'Requires authentication' });
          return;
        }
        const bodyBuf = await readBody(req);
        let parsed: unknown;
        try {
          parsed = JSON.parse(bodyBuf.toString('utf8'));
        } catch {
          sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
          return;
        }
        const runOne = (op: unknown): { data: Record<string, unknown> | null; errors: Array<{ message: string; path?: (string | number)[] }> } => {
          if (op === null || typeof op !== 'object' || Array.isArray(op)) {
            return { data: null, errors: [{ message: 'Invalid operation' }] };
          }
          const o = op as Record<string, unknown>;
          const q = typeof o.query === 'string' ? o.query : '';
          const vars = o.variables !== null && typeof o.variables === 'object' && !Array.isArray(o.variables)
            ? (o.variables as Record<string, unknown>)
            : {};
          return executeGraphQL(forge, VIEWER, q, vars);
        };
        if (Array.isArray(parsed)) {
          sendJson(res, 200, parsed.map(runOne));
        } else {
          sendJson(res, 200, runOne(parsed));
        }
        return;
      }

      // ---- MCP (auth required)
      if (path === '/mcp' && method === 'POST') {
        const presented = bearerToken(headers);
        if (!tokenOk({ forge, baseUrl: '', token: SHOP_TOKEN }, presented)) {
          sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Requires authentication' } });
          return;
        }
        const bodyBuf = await readBody(req);
        const result = handleMcp(forge, bodyBuf.toString('utf8'));
        if (result.body === undefined) {
          res.writeHead(result.status, { 'x-github-request-id': requestId() });
          res.end();
          return;
        }
        sendJson(res, result.status, result.body);
        return;
      }

      // ---- everything else: GitHub's 404 body
      sendJson(res, 404, { message: 'Not Found' });
    })().catch((err: unknown) => {
      try {
        if (!res.headersSent) {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } else {
          res.end();
        }
      } catch {
        // The socket is already gone; nothing left to do.
      }
    });
  });
}
