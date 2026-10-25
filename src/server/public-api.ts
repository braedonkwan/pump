import type {
  GameState,
  RoundRequest,
  RoomState,
  StartRequest,
} from '../shared/types.js';
import { Admission, ROOM_FULL_MESSAGE } from './admission.js';
import { GameError } from './errors.js';
import type { PumpService } from './PumpService.js';
import { transaction, type GameDatabase } from './storage.js';

export const PUBLIC_COOKIE = '__Host-pump_session';
export const TRUSTED_IP_HEADER = 'X-Pump-IP';
const ROUTES = new Set([
  'GET /api/pump/state',
  'GET /api/wallet',
  'GET /api/history',
  'POST /api/pump/start',
  'POST /api/pump/pump',
  'POST /api/pump/cashout',
  'POST /api/pump/heartbeat',
]);

function json(
  value: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      ...extraHeaders,
    },
  });
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (
    request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
    'application/json'
  )
    throw new GameError(415, 'Send a JSON request body.');
  const reader = request.body?.getReader();
  if (!reader) throw new GameError(400, 'A JSON request body is required.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) {
        await reader.cancel();
        throw new GameError(413, 'Request body is too large.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new GameError(400, 'Invalid JSON.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new GameError(400, 'Request body must be a JSON object.');
  return body as Record<string, unknown>;
}

export class PublicApi {
  constructor(
    private readonly database: GameDatabase,
    private readonly service: PumpService,
    private readonly admission: Admission,
  ) {}

  async fetch(request: Request): Promise<Response> {
    try {
      return await this.handle(request);
    } catch (error) {
      if (!(error instanceof GameError))
        console.error('Public game request failed', error);
      return json(
        {
          error:
            error instanceof GameError
              ? error.message
              : 'Something went wrong. Please try again.',
        },
        error instanceof GameError ? error.statusCode : 500,
        error instanceof GameError && error.retryAfterSeconds
          ? { 'Retry-After': String(error.retryAfterSeconds) }
          : {},
      );
    }
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    if (!ROUTES.has(route)) throw new GameError(404, 'API endpoint not found.');
    const origin = request.headers.get('origin');
    if (
      (origin && origin !== url.origin) ||
      (request.method === 'POST' && !origin)
    )
      throw new GameError(403, 'Cross-origin requests are not allowed.');
    if (request.headers.get('sec-fetch-site') === 'cross-site')
      throw new GameError(403, 'Cross-origin requests are not allowed.');

    const token = request.headers
      .get('cookie')
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${PUBLIC_COOKIE}=`))
      ?.slice(PUBLIC_COOKIE.length + 1);
    const existingPlayer = this.service.findSession(token);
    this.admission.throttle(
      request.headers.get(TRUSTED_IP_HEADER) ?? 'unknown',
      existingPlayer,
    );
    const body = request.method === 'POST' ? await readBody(request) : {};
    if (!existingPlayer && route !== 'GET /api/pump/state')
      throw new GameError(
        401,
        'Reconnect to restore your wallet before playing.',
      );

    // A synchronous transaction also prevents concurrent first visits overbooking the room.
    return transaction(this.database, () => {
      if (!existingPlayer) this.admission.requireSpace();
      const { playerId, newToken } = existingPlayer
        ? { playerId: existingPlayer, newToken: undefined }
        : this.service.getSession(undefined);
      const room = this.admission.claim(playerId);
      if (
        !room.admitted &&
        (route === 'POST /api/pump/start' || route === 'POST /api/pump/pump')
      )
        throw new GameError(503, ROOM_FULL_MESSAGE, 15);

      let value: GameState | RoomState | object;
      switch (route) {
        case 'GET /api/pump/state':
          value = { ...this.service.getState(playerId), room };
          break;
        case 'GET /api/wallet':
          value = this.service.getWallet(playerId);
          break;
        case 'GET /api/history':
          value = { rounds: this.service.getHistory(playerId) };
          break;
        case 'POST /api/pump/heartbeat':
          value = room;
          break;
        case 'POST /api/pump/start':
          value = {
            ...this.service.start(playerId, body as unknown as StartRequest),
            room,
          };
          break;
        case 'POST /api/pump/pump':
          value = {
            ...this.service.pump(playerId, body as unknown as RoundRequest),
            room,
          };
          break;
        case 'POST /api/pump/cashout':
          value = {
            ...this.service.cashout(playerId, body as unknown as RoundRequest),
            room,
          };
          break;
        default:
          throw new GameError(404, 'API endpoint not found.');
      }
      return json(
        value,
        200,
        newToken
          ? {
              'Set-Cookie': `${PUBLIC_COOKIE}=${newToken}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=31536000`,
            }
          : {},
      );
    });
  }
}
