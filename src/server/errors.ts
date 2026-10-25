export class GameError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'GameError';
  }
}
