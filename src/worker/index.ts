import { DurableObject } from 'cloudflare:workers';
import { Admission, type PublicSettings } from '../server/admission.js';
import { sha256 } from '../server/fairness.js';
import { PumpService } from '../server/PumpService.js';
import { PublicApi, TRUSTED_IP_HEADER } from '../server/public-api.js';
import { initializeGameSchema, initializeLedger } from '../server/schema.js';
import { DurableDatabase } from './sqlite.js';

interface Env extends PublicSettings {
  ASSETS: Fetcher;
  PUMP_ROOM: DurableObjectNamespace<PumpRoom>;
}

export class PumpRoom extends DurableObject<Env> {
  private readonly api: PublicApi;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const database = new DurableDatabase(ctx.storage.sql, (work) =>
      ctx.storage.transactionSync(work),
    );
    initializeGameSchema(database);
    initializeLedger(database);
    // Public deployments always use the intended rules, independent of local test mode.
    const service = new PumpService(database, undefined, {
      disablePopping: false,
    });
    this.api = new PublicApi(database, service, new Admission(database, env));
  }

  async fetch(request: Request): Promise<Response> {
    return this.api.fetch(request);
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (!path.startsWith('/api/')) return env.ASSETS.fetch(request);
    const headers = new Headers(request.headers);
    // Cloudflare supplies this address. Never trust a caller's forwarding headers.
    headers.set(
      TRUSTED_IP_HEADER,
      sha256(request.headers.get('CF-Connecting-IP') ?? 'unknown'),
    );
    try {
      const room = env.PUMP_ROOM.get(
        env.PUMP_ROOM.idFromName('pump-public-v1'),
      );
      return await room.fetch(new Request(request, { headers }));
    } catch (error) {
      console.error('Game storage unavailable', error);
      return Response.json(
        {
          error:
            'The game is temporarily unavailable. Please try again shortly.',
        },
        {
          status: 503,
          headers: {
            'Cache-Control': 'no-store',
            'Retry-After': '30',
            'X-Content-Type-Options': 'nosniff',
          },
        },
      );
    }
  },
} satisfies ExportedHandler<Env>;
