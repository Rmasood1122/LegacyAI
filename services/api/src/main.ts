// Process entry point. Fails closed: bad configuration or an unsafe database role stops
// the process with a non-zero exit code BEFORE it listens for requests.
import { createApp } from './app.ts';
import { ConfigError, loadConfig } from './modules/platform/index.ts';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    // ConfigError messages name variables only, never values.
    console.error(err instanceof ConfigError ? err.message : 'Invalid configuration');
    process.exit(1);
  }

  let app;
  try {
    app = await createApp(config);
  } catch (err) {
    console.error(`Startup failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    process.exit(1);
  }

  await app.identity.hasher.warmUp();
  await app.http.app.listen({ port: config.port, host: '0.0.0.0' });

  const shutdown = async (): Promise<void> => {
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

void main();
