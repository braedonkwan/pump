import { readFile } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import type { RoundRequest, StartRequest } from '../shared/types.js';
import { GameError } from './errors.js';
import type { PumpService } from './PumpService.js';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

async function readBody(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  if (!request.headers['content-type']?.startsWith('application/json')) {
    throw new GameError(415, 'Send a JSON request body.');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 4096) {
      request.resume();
      throw new GameError(413, 'Request body is too large.');
    }
    chunks.push(buffer);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new GameError(400, 'Invalid JSON.');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GameError(400, 'Request body must be a JSON object.');
  }
  return value as Record<string, unknown>;
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(value));
}

export function createApp(
  service: PumpService,
  clientDirectory = resolve('dist/client'),
  options: { sessionCookieName?: string } = {},
) {
  const cookieName = options.sessionCookieName ?? 'pump_session';
  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'same-origin');
    const url = new URL(request.url ?? '/', 'http://localhost');

    if (!url.pathname.startsWith('/api/')) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        throw new GameError(405, 'Method not allowed.');
      }
      let pathname: string;
      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        throw new GameError(400, 'Invalid URL encoding.');
      }
      const file = resolve(
        clientDirectory,
        `.${pathname === '/' ? '/index.html' : pathname}`,
      );
      const fromRoot = relative(clientDirectory, file);
      if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
        throw new GameError(404, 'Not found.');
      }
      let content: Buffer;
      try {
        content = await readFile(file);
      } catch (error) {
        if (
          error instanceof Error &&
          'code' in error &&
          (error.code === 'ENOENT' || error.code === 'EISDIR')
        ) {
          throw new GameError(
            404,
            'Not found. Run npm run build to prepare the frontend.',
          );
        }
        throw error;
      }
      response.writeHead(200, {
        'Content-Type': MIME_TYPES[extname(file)] ?? 'application/octet-stream',
        'Cache-Control':
          extname(file) === '.html' ? 'no-cache' : 'public, max-age=3600',
      });
      response.end(request.method === 'HEAD' ? undefined : content);
      return;
    }

    response.setHeader('Cache-Control', 'no-store');
    const route = `${request.method} ${url.pathname}`;
    const routes = [
      'GET /api/wallet',
      'GET /api/history',
      'GET /api/pump/state',
      'POST /api/pump/start',
      'POST /api/pump/pump',
      'POST /api/pump/cashout',
    ];
    if (!routes.includes(route))
      throw new GameError(404, 'API endpoint not found.');

    const origin = request.headers.origin;
    if (origin) {
      let allowed = false;
      try {
        const parsed = new URL(origin);
        allowed =
          ['http:', 'https:'].includes(parsed.protocol) &&
          parsed.host === request.headers.host;
      } catch {
        // Opaque or malformed origins must fail closed, rather than raising a 500.
      }
      if (!allowed)
        throw new GameError(403, 'Cross-origin requests are not allowed.');
    }
    const body = request.method === 'POST' ? await readBody(request) : {};
    const cookie = request.headers.cookie
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1);
    const { playerId, newToken } = service.getSession(cookie);
    if (newToken) {
      const secure = process.env.COOKIE_SECURE === 'true' ? '; Secure' : '';
      response.setHeader(
        'Set-Cookie',
        `${cookieName}=${newToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${secure}`,
      );
    }

    switch (route) {
      case 'GET /api/wallet':
        sendJson(response, 200, service.getWallet(playerId));
        break;
      case 'GET /api/history':
        sendJson(response, 200, { rounds: service.getHistory(playerId) });
        break;
      case 'GET /api/pump/state':
        sendJson(response, 200, service.getState(playerId));
        break;
      case 'POST /api/pump/start':
        sendJson(
          response,
          200,
          service.start(playerId, {
            betCents: body.betCents as StartRequest['betCents'],
            requestId: body.requestId as StartRequest['requestId'],
          }),
        );
        break;
      case 'POST /api/pump/pump':
      case 'POST /api/pump/cashout': {
        const action: RoundRequest = {
          roundId: body.roundId as RoundRequest['roundId'],
          expectedVersion:
            body.expectedVersion as RoundRequest['expectedVersion'],
        };
        sendJson(
          response,
          200,
          route.endsWith('/pump')
            ? service.pump(playerId, action)
            : service.cashout(playerId, action),
        );
        break;
      }
    }
  }

  return createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      const status = error instanceof GameError ? error.statusCode : 500;
      if (status === 500) console.error(error);
      if (!response.headersSent) {
        sendJson(response, status, {
          error:
            error instanceof GameError
              ? error.message
              : 'Something went wrong. Please try again.',
        });
      } else response.end();
    });
  });
}
