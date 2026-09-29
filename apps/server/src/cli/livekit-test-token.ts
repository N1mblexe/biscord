/**
 * Prints the LiveKit public URL and a short-lived token for LiveKit's public connection test.
 *
 *   pnpm --filter @hearth/server livekit-test-token
 *   docker compose -f docker-compose.prod.yml exec server node dist/cli/livekit-test-token.js
 *
 * The token joins a throwaway `connection-test-<random>` room only (never a Hearth `voice_*` room), can
 * publish mic/camera and subscribe, and expires after 10 minutes.
 */
import { EnvError, loadEnv } from '../env.js';
import { CONNECTION_TEST_TTL_SECONDS, mintConnectionTestToken } from '../livekit/connection-test-token.js';

async function main(): Promise<number> {
  const env = loadEnv();
  const { url, token, roomName } = await mintConnectionTestToken(env);
  console.log(`LiveKit URL: ${url}`);
  console.log(`Token:       ${token}`);
  console.log(`Room:        ${roomName} (expires in ${CONNECTION_TEST_TTL_SECONDS / 60} min)`);
  console.log('Open https://livekit.io/connection-test and paste the URL and token.');
  if (url.startsWith('ws://')) {
    console.error('Note: LIVEKIT_PUBLIC_URL is ws://; the HTTPS connection-test page needs a wss:// URL.');
  }
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    if (err instanceof EnvError) console.error(err.message);
    else console.error('Minting the LiveKit test token failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  },
);
