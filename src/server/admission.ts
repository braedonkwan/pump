import type { RoomState } from '../shared/types.js';
import { PRESENCE_INTERVAL_MS } from '../shared/settings.js';
import { GameError } from './errors.js';
import { transaction, type GameDatabase } from './storage.js';

export interface PublicSettings {
  MAX_ACTIVE_PLAYERS?: string;
  PLAYER_IDLE_SECONDS?: string;
  SESSION_REQUESTS_PER_MINUTE?: string;
  SESSION_REQUEST_BURST?: string;
  IP_REQUESTS_PER_MINUTE?: string;
  IP_REQUEST_BURST?: string;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < 1
  )
    throw new Error('Public game limits must be positive integers.');
  return Number(value);
}

export function publicConfig(settings: PublicSettings) {
  return {
    maxPlayers: positiveInteger(settings.MAX_ACTIVE_PLAYERS, 25),
    idleMs: positiveInteger(settings.PLAYER_IDLE_SECONDS, 180) * 1_000,
    sessionPerMinute: positiveInteger(
      settings.SESSION_REQUESTS_PER_MINUTE,
      120,
    ),
    sessionBurst: positiveInteger(settings.SESSION_REQUEST_BURST, 30),
    ipPerMinute: positiveInteger(settings.IP_REQUESTS_PER_MINUTE, 1_000),
    ipBurst: positiveInteger(settings.IP_REQUEST_BURST, 100),
  };
}

export const ROOM_FULL_MESSAGE = 'Game full. Please try again shortly.';

export class Admission {
  private readonly config: ReturnType<typeof publicConfig>;
  private nextCleanup = 0;

  constructor(
    private readonly database: GameDatabase,
    settings: PublicSettings = {},
    private readonly now: () => number = Date.now,
  ) {
    this.config = publicConfig(settings);
    if (
      this.config.idleMs < PRESENCE_INTERVAL_MS * 2 ||
      this.config.idleMs > 3_600_000
    )
      throw new Error('PLAYER_IDLE_SECONDS must be between 120 and 3600.');
    database.exec(`
      CREATE TABLE IF NOT EXISTS player_leases (
        player_id TEXT PRIMARY KEY REFERENCES players(id),
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS lease_expiry ON player_leases(expires_at);
      CREATE TABLE IF NOT EXISTS request_buckets (
        bucket_key TEXT PRIMARY KEY,
        tokens REAL NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS bucket_expiry ON request_buckets(updated_at);
    `);
  }

  throttle(ipHash: string, playerId?: string): void {
    this.cleanup();
    this.consume(`ip:${ipHash}`, this.config.ipBurst, this.config.ipPerMinute);
    if (playerId)
      this.consume(
        `session:${playerId}`,
        this.config.sessionBurst,
        this.config.sessionPerMinute,
      );
  }

  requireSpace(): void {
    this.cleanup();
    if (this.activePlayers() >= this.config.maxPlayers)
      throw new GameError(503, ROOM_FULL_MESSAGE, 15);
  }

  claim(playerId: string): RoomState {
    return transaction(this.database, () => {
      this.cleanup();
      const now = this.now();
      const lease = this.database
        .prepare('SELECT expires_at FROM player_leases WHERE player_id = ?')
        .get(playerId);
      const activePlayers = this.activePlayers();
      const existing = lease && Number(lease.expires_at) > now;
      if (!existing && activePlayers >= this.config.maxPlayers)
        return {
          admitted: false,
          activePlayers,
          maxPlayers: this.config.maxPlayers,
        };

      // A recent action can skip an idle heartbeat. Leave time for the next one.
      if (
        !existing ||
        Number(lease.expires_at) - now <=
          Math.max(this.config.idleMs / 2, PRESENCE_INTERVAL_MS * 2)
      ) {
        this.database
          .prepare(
            `INSERT INTO player_leases (player_id, expires_at) VALUES (?, ?)
          ON CONFLICT(player_id) DO UPDATE SET expires_at = excluded.expires_at`,
          )
          .run(playerId, now + this.config.idleMs);
      }
      return {
        admitted: true,
        activePlayers: activePlayers + (existing ? 0 : 1),
        maxPlayers: this.config.maxPlayers,
      };
    });
  }

  private activePlayers(): number {
    return Number(
      this.database
        .prepare(
          'SELECT COUNT(*) AS total FROM player_leases WHERE expires_at > ?',
        )
        .get(this.now())?.total,
    );
  }

  private cleanup(): void {
    const now = this.now();
    if (now < this.nextCleanup) return;
    this.nextCleanup = now + 60_000;
    this.database
      .prepare('DELETE FROM player_leases WHERE expires_at <= ?')
      .run(now);
    const ttl = Math.max(
      3_600_000,
      (60_000 * this.config.ipBurst) / this.config.ipPerMinute,
      (60_000 * this.config.sessionBurst) / this.config.sessionPerMinute,
    );
    this.database
      .prepare('DELETE FROM request_buckets WHERE updated_at < ?')
      .run(now - ttl);
  }

  private consume(key: string, burst: number, perMinute: number): void {
    transaction(this.database, () => {
      const now = this.now();
      const bucket = this.database
        .prepare(
          'SELECT tokens, updated_at FROM request_buckets WHERE bucket_key = ?',
        )
        .get(key);
      if (
        !bucket &&
        Number(
          this.database
            .prepare('SELECT COUNT(*) AS total FROM request_buckets')
            .get()?.total,
        ) >= 4096
      )
        throw new GameError(
          429,
          'The game is busy. Please try again shortly.',
          60,
        );
      const tokens = bucket
        ? Math.min(
            burst,
            Number(bucket.tokens) +
              (Math.max(0, now - Number(bucket.updated_at)) * perMinute) /
                60_000,
          )
        : burst;
      if (tokens < 1)
        throw new GameError(
          429,
          'Too many requests. Please wait a moment and try again.',
          Math.max(1, Math.ceil(((1 - tokens) * 60) / perMinute)),
        );
      this.database
        .prepare(
          `INSERT INTO request_buckets (bucket_key, tokens, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(bucket_key) DO UPDATE SET tokens = excluded.tokens, updated_at = excluded.updated_at`,
        )
        .run(key, tokens - 1, now);
    });
  }
}
