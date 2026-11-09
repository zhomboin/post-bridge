import { contentPlatforms } from './content-contract.js';
import { platformRegistry } from './content-runtime.js';
import { browserSession } from './browser-session.js';
import { CSDNAdapter } from './csdn.js';
import { CSDNReadAdapter } from './csdn-read.js';
import { XiaohongshuAdapter } from './xiaohongshu.js';

const factories = {
  csdn: (config: Parameters<typeof browserSession>[0]) =>
    browserSession(config, (context) => {
      const writer = new CSDNAdapter(context, {
        username: config.username,
        displayName: config.displayName,
      });
      const reader = new CSDNReadAdapter(context, { username: config.username });
      const definition = contentPlatforms.find((entry) => entry.id === 'csdn')!;
      return {
        run: (job, hooks, signal) =>
          [definition.sync_job, definition.read_job].includes(job.kind)
            ? reader.run(job, hooks, signal)
            : writer.run(job, hooks, signal),
      };
    }),
  xiaohongshu: (config: Parameters<typeof browserSession>[0]) =>
    browserSession(config, (context) => {
      const adapter = new XiaohongshuAdapter(context, {
        accountId: config.accountId!,
        username: config.username,
        userId: config.userId || '',
      });
      return { run: (job, hooks, signal) => adapter.run(job, hooks, signal) };
    }),
};

export const runtimePlatforms = platformRegistry(
  contentPlatforms.map((definition) => ({
    definition,
    open: factories[definition.id as keyof typeof factories],
  })),
);
