import { parentPort, workerData } from 'node:worker_threads';
import { convertWechat } from './wechat.js';
import { validateWechat } from './wechat-validate.js';

try {
  const result =
    workerData.operation === 'convert'
      ? convertWechat(workerData.markdown)
      : { issues: validateWechat(workerData.markdown, workerData.blocks) };
  parentPort!.postMessage({ result });
} catch (error) {
  parentPort!.postMessage({ error: error instanceof Error ? error.message : 'invalid_request' });
}
