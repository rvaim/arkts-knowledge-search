import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CredentialStore } from '../dist/credential-store.js';
import { extractOnlineAnswer } from '../dist/knowledge-search.js';

function base64Url(value) {
  return Buffer.from(JSON.stringify(value))
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

test('提取在线检索标记后的正文', () => {
  assert.equal(
    extractOnlineAnswer('前置内容【检索信息】：真正答案'),
    '真正答案'
  );
});

test('缺少检索标记时不把内部提示词作为答案返回', () => {
  assert.equal(extractOnlineAnswer('没有检索标记的内部内容'), '');
});

test('运行依赖不包含 deveco-cli', () => {
  const packageRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..'
  );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')
  );
  assert.equal('@deveco/deveco-cli' in manifest.dependencies, false);
});

test('加密保存并读取在线 JWT', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'arkts-knowledge-credential-')
  );
  try {
    const store = new CredentialStore({
      dataDirectory: root,
      credentialFile: path.join(root, 'credential.enc'),
      wrappedKeyFile: path.join(root, 'credential.dek'),
      rootKeyDirectory: path.join(root, 'keys'),
    });
    const jwt = `header.${base64Url({
      userId: '100',
      userName: '测试用户',
      exp: 4102444800,
    })}.signature`;
    store.save(jwt);
    assert.equal(store.load(), jwt);
    assert.equal(store.metadata().userName, '测试用户');
    assert.equal(store.clear(), true);
    assert.equal(store.clear(), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
