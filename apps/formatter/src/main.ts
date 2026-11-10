import { readFileSync, statSync } from 'node:fs';
import { createFormatterServer } from './server.js';
import { closeRenderers } from './render.js';
const tokenFile = process.env.FORMATTER_TOKEN_FILE;
if (
  !tokenFile ||
  !statSync(tokenFile).isFile() ||
  statSync(tokenFile).size > 4096 ||
  statSync(tokenFile).mode & 0o077
)
  throw Error('渲染凭据必须为私有普通文件');
const token = readFileSync(tokenFile, 'utf8').trim();
if (token.length < 32) throw Error('渲染凭据无效');
const address = process.env.FORMATTER_ADDR ?? '127.0.0.1:18082';
const match = /^(127\.0\.0\.1):([0-9]+)$/.exec(address);
if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535)
  throw Error('渲染地址必须为本机回环地址');
const server = createFormatterServer({ token });
server.requestTimeout = 65000;
server.headersTimeout = 5000;
server.listen(Number(match[2]), match[1]);
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  server.close();
  await closeRenderers();
  server.closeAllConnections();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
