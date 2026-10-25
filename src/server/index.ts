import { createApp } from './app.js';
import { getGameConfig } from './config.js';
import { openDatabase } from './database.js';
import { PumpService } from './PumpService.js';

const port = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}
const config = getGameConfig();
const database = openDatabase(config.databasePath);
const server = createApp(
  new PumpService(database, undefined, {
    disablePopping: config.testMode,
  }),
  undefined,
  { sessionCookieName: config.sessionCookieName },
);
server.listen(port, process.env.HOST ?? '127.0.0.1', () => {
  console.log(`Pump server: http://${process.env.HOST ?? '127.0.0.1'}:${port}`);
  if (config.testMode)
    console.log('Testing mode: popping disabled; separate wallet and history.');
});
server.on('error', (error) => {
  console.error(error);
  database.close();
  process.exitCode = 1;
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close(() => {
      database.close();
      process.exit(0);
    });
  });
}
