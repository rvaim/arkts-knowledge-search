/*
 * 在线知识查询协议参考 DevEco Code 的 arkts_knowledge_search。
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * Copyright (c) 2026 rvaim
 * SPDX-License-Identifier: MIT
 */

import * as z from 'zod/v4';
import { AuthClient } from './auth.js';
import { KnowledgeError } from './errors.js';
import type { KnowledgeSearchResult } from './types.js';

export const KNOWLEDGE_SEARCH_ENDPOINT =
  'https://cn.devecostudio.huawei.com/codeGenie/bigSearch';

const MAX_ANSWER_LENGTH = 5 * 1024;
const RESULT_MARKER = '【检索信息】：';
const jsonSchema = z.json();
type JsonData = z.infer<typeof jsonSchema>;

const onlineSuccessSchema = z
  .object({
    code: z.number(),
    body: z
      .object({
        answer: z
          .object({
            prompt: z.string().optional(),
          })
          .optional(),
      })
      .optional(),
  })
  .passthrough();

const onlineErrorSchema = z
  .object({
    error_code: z.number(),
    error_msg: z.string().optional(),
  })
  .passthrough();

export function extractOnlineAnswer(prompt: string): string {
  const markerIndex = prompt.indexOf(RESULT_MARKER);
  if (markerIndex < 0) {
    return '';
  }
  return prompt
    .slice(markerIndex + RESULT_MARKER.length)
    .trim()
    .slice(0, MAX_ANSWER_LENGTH);
}

export class ArktsKnowledgeClient {
  private readonly auth: AuthClient;
  private readonly fetchClient: typeof fetch;

  public constructor(
    auth: AuthClient = new AuthClient(),
    fetchClient: typeof fetch = fetch
  ) {
    this.auth = auth;
    this.fetchClient = fetchClient;
  }

  public async search(question: string): Promise<KnowledgeSearchResult> {
    const accessToken = await this.auth.accessToken();
    const response = await this.fetchClient(KNOWLEDGE_SEARCH_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: accessToken,
        'Content-Type': 'application/json',
        'User-Agent': '@rvaim/arkts_knowledge_search',
        'accept-language': 'zh-CN',
      },
      body: JSON.stringify({ question }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.text();
    let data: JsonData;
    try {
      data = jsonSchema.parse(JSON.parse(body));
    } catch (error) {
      throw new KnowledgeError(
        'ONLINE_RESPONSE_INVALID',
        `在线知识服务返回了无法识别的数据，HTTP ${response.status}。`,
        error instanceof Error ? error : undefined
      );
    }
    const serviceError = onlineErrorSchema.safeParse(data);
    if (serviceError.success) {
      if (serviceError.data.error_code === 4016) {
        this.auth.invalidateAccessToken();
        throw new KnowledgeError(
          'ONLINE_LOGIN_REQUIRED',
          '在线知识查询授权已失效，请重新登录。'
        );
      }
      throw new KnowledgeError(
        'ONLINE_SERVICE_FAILED',
        serviceError.data.error_msg || '在线知识服务返回错误。'
      );
    }
    const result = onlineSuccessSchema.safeParse(data);
    if (!response.ok || !result.success || result.data.code !== 200) {
      throw new KnowledgeError(
        'ONLINE_SERVICE_FAILED',
        `在线知识服务请求失败，HTTP ${response.status}。`
      );
    }
    const prompt = result.data.body?.answer?.prompt;
    const answer = prompt ? extractOnlineAnswer(prompt) : '';
    if (!answer) {
      throw new KnowledgeError(
        'ONLINE_NO_RESULT',
        '在线知识服务没有返回可用答案。'
      );
    }
    return {
      question,
      answer,
      endpoint: KNOWLEDGE_SEARCH_ENDPOINT,
      queriedAt: new Date().toISOString(),
    };
  }
}
