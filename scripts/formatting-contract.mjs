import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { format } from 'prettier';
const definitions = JSON.parse(await readFile('contracts/formatting-model.json', 'utf8'));
const name = (field) =>
  field
    .split('_')
    .map((part) => ({ id: 'ID', url: 'URL' })[part] || part[0].toUpperCase() + part.slice(1))
    .join('');
function type(value, go = false) {
  if (value.endsWith('?'))
    return go ? '*' + type(value.slice(0, -1), true) : type(value.slice(0, -1)) + ' | null';
  if (value.endsWith('[]'))
    return go ? '[]' + type(value.slice(0, -2), true) : type(value.slice(0, -2)) + '[]';
  return (
    (go ? { string: 'string', boolean: 'bool', integer: 'int64' } : { integer: 'number' })[value] ||
    value
  );
}
let go =
  '// 由 scripts/formatting-contract.mjs 生成，请修改 contracts/formatting-model.json。\npackage bridge\n';
let ts = '// 由 scripts/formatting-contract.mjs 生成，请修改 contracts/formatting-model.json。\n';
for (const [model, fields] of Object.entries(definitions)) {
  go += 'type ' + model + ' struct {\n';
  ts += 'export interface ' + model + ' {\n';
  for (const [field, value] of Object.entries(fields)) {
    go += name(field) + ' ' + type(value, true) + ' `json:"' + field + '"`\n';
    ts += field + ': ' + type(value) + ';\n';
  }
  go += '}\n';
  ts += '}\n';
}
const result = spawnSync('gofmt', [], { input: go, encoding: 'utf8' });
if (result.error || result.status !== 0) throw Error('格式化 Go 契约失败');
ts = await format(ts, {
  ...JSON.parse(await readFile('.prettierrc.json', 'utf8')),
  parser: 'typescript',
});
for (const [path, value] of [
  ['apps/api/formatting_contract.go', result.stdout],
  ['apps/admin/src/formatting-contract.ts', ts],
  ['apps/formatter/src/formatting-contract.ts', ts],
]) {
  if (process.argv.includes('--check')) {
    if ((await readFile(path, 'utf8')) !== value) throw Error(path + ' 与格式化契约不同步');
  } else await writeFile(path, value, 'utf8');
}
