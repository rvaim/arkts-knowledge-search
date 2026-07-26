import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ArktsKnowledgeClient,
  KNOWLEDGE_SEARCH_ENDPOINT,
} from '../dist/knowledge-search.js';

test('在线查询发送短期令牌并解析结果', async () => {
  let requestedUrl = '';
  let authorization = '';
  const auth = {
    async accessToken() {
      return 'secret-access-token';
    },
    invalidateAccessToken() {
      throw new Error('不应失效');
    },
  };
  const fetchClient = async (url, init) => {
    requestedUrl = String(url);
    authorization = init.headers.Authorization;
    return new Response(
      JSON.stringify({
        code: 200,
        body: {
          answer: {
            prompt: '说明【检索信息】：在线答案',
          },
        },
      }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      }
    );
  };
  const client = new ArktsKnowledgeClient(auth, fetchClient);
  const result = await client.search('Navigation');
  assert.equal(requestedUrl, KNOWLEDGE_SEARCH_ENDPOINT);
  assert.equal(authorization, 'secret-access-token');
  assert.equal(result.question, 'Navigation');
  assert.equal(result.answer, '在线答案');
});

test('在线服务返回 4016 时使短期令牌失效', async () => {
  let invalidated = false;
  const auth = {
    async accessToken() {
      return 'secret-access-token';
    },
    invalidateAccessToken() {
      invalidated = true;
    },
  };
  const client = new ArktsKnowledgeClient(
    auth,
    async () =>
      new Response(
        JSON.stringify({
          error_code: 4016,
          error_msg: '授权失败',
        }),
        { status: 200 }
      )
  );
  await assert.rejects(client.search('Navigation'), /授权已失效/);
  assert.equal(invalidated, true);
});
