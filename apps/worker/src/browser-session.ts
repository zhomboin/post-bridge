import { chromium, type BrowserContext } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activeBrowserProfile } from './account-credentials.js';
import type { Config } from './config.js';
import type { Session } from './types.js';

export async function browserSession(
  config: Config,
  build: (context: BrowserContext) => Pick<Session, 'run'>,
): Promise<Session> {
  const temp = await mkdtemp(join(tmpdir(), 'pb-'));
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(
      await activeBrowserProfile(config.profileDir),
      {
        headless: config.headless,
        executablePath: config.executablePath,
        serviceWorkers: 'block',
        chromiumSandbox: true,
        timeout: 30000,
        acceptDownloads: false,
        env: { ...process.env, TMPDIR: temp },
      },
    );
    const adapter = build(context);
    return {
      run: adapter.run,
      close: async () => {
        try {
          await context!.close();
        } finally {
          await rm(temp, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    try {
      await context?.close();
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
    throw error;
  }
}
