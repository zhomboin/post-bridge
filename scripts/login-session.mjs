export async function loginSession(
  config,
  { launch, acquire, browserProfile = async (path) => path },
  signal,
  timeoutMs = 300000,
) {
  const owner = await acquire(config.profileDir);
  let context;
  let closing;
  const close = () => (closing ??= context ? context.close() : Promise.resolve());
  const abort = () => {
    if (context) void close().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) return false;
    context = await launch(await browserProfile(config.profileDir), {
      headless: false,
      executablePath: config.executablePath,
      acceptDownloads: false,
      timeout: 10000,
    });
    if (signal.aborted) return false;
    const page = await context.newPage();
    await page.goto('https://mp.csdn.net/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    const until = Date.now() + timeoutMs;
    while (!signal.aborted && Date.now() < until && !page.isClosed()) {
      const matched = await page
        .locator('a[href]')
        .evaluateAll(
          (nodes, username) =>
            nodes.some((node) => {
              try {
                const url = new URL(node.href);
                return (
                  url.protocol === 'https:' &&
                  url.hostname === 'blog.csdn.net' &&
                  url.pathname.replace(/\/+$/, '') === '/' + username
                );
              } catch {
                return false;
              }
            }),
          config.username,
        )
        .catch(() => false);
      if (matched) return true;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return false;
  } finally {
    signal.removeEventListener('abort', abort);
    try {
      await close();
    } finally {
      await owner.release();
    }
  }
}
