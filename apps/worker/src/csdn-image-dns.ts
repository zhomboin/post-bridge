import { Resolver } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

interface ImageResolver {
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
  cancel(): void;
}

const restricted = new BlockList();
for (const [prefix, length] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const)
  restricted.addSubnet(prefix, length, 'ipv4');
for (const [prefix, length] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3ffe::', 16],
  ['3fff::', 20],
] as const)
  restricted.addSubnet(prefix, length, 'ipv6');

function publicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !restricted.check(address, 'ipv4');
  return family === 6 && /^[23][0-9a-f]{3}:/i.test(address) && !restricted.check(address, 'ipv6');
}

async function dnsRecords(query: Promise<string[]>): Promise<string[]> {
  try {
    return await query;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENODATA') return [];
    throw error;
  }
}

// 检查专用公网图源的 DNS。CSDN 自己解析和读取图源，执行器不下载原图。
export async function verifyImageSourceDNS(
  sources: string[],
  signal: AbortSignal,
  resolver: ImageResolver = new Resolver({ timeout: 2500, tries: 1 }),
): Promise<void> {
  signal.throwIfAborted();
  const hosts = new Set(sources.map((source) => new URL(source).hostname));
  const cancel = () => resolver.cancel();
  const deadline = setTimeout(cancel, 3500);
  signal.addEventListener('abort', cancel, { once: true });
  try {
    await Promise.all(
      [...hosts].map(async (host) => {
        if (
          isIP(host) ||
          !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(host) ||
          /(?:^|\.)(?:local|localhost)$/.test(host)
        )
          throw new Error('图源域名不符合公网约束');
        const [v4, v6] = await Promise.all([
          dnsRecords(resolver.resolve4(host)),
          dnsRecords(resolver.resolve6(host)),
        ]);
        const addresses = [...v4, ...v6];
        if (!addresses.length || !addresses.every(publicAddress))
          throw new Error('图源 DNS 含非公网地址');
      }),
    );
    signal.throwIfAborted();
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener('abort', cancel);
    cancel();
  }
}
