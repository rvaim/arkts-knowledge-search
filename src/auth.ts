/*
 * OAuth 协议流程参考 DevEco Code。
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * Copyright (c) 2026 rvaim
 * SPDX-License-Identifier: MIT
 */

import { randomUUID, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type {
  IncomingMessage,
  Server,
  ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { URL } from 'node:url';
import * as z from 'zod/v4';
import { runInteractiveLogin } from './command.js';
import {
  CredentialStore,
  parseJwtMetadata,
} from './credential-store.js';
import type { JwtMetadata } from './credential-store.js';
import { KnowledgeError } from './errors.js';

const BASE_URL = 'https://cn.devecostudio.huawei.com';
const LOGIN_PATH = 'console/DevEcoIDE/apply';
const LOGIN_SUCCESS_PATH = 'console/DevEcoCode/loginSuccess';
const LOGIN_FAILED_PATH = 'console/DevEcoCode/loginFailed';
const TEMP_TOKEN_PATH = 'authrouter/auth/api/temptoken/check';
const JWT_TOKEN_PATH = 'authrouter/auth/api/jwToken/check';
const APP_ID = '1008';
const API_VERSION = '1.0.0';
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const ACCESS_TOKEN_CACHE_MS = 25 * 60 * 1000;

const tokenCheckSchema = z
  .object({
    status: z.boolean(),
    userInfo: z
      .object({
        accessToken: z.string(),
        refreshToken: z.string().optional(),
        nationalCode: z.string().optional(),
        realName: z.union([z.string(), z.boolean()]).optional(),
      })
      .optional(),
  })
  .passthrough();

interface CallbackData {
  tempToken: string;
  siteId: string;
}

export interface LoginResult {
  userName: string;
  expiresAt: string | null;
}

export interface AuthStatus {
  authenticated: boolean;
  expiresAt: string | null;
  message: string;
}

type BrowserOpener = (url: string) => Promise<void>;
type FetchClient = typeof fetch;

class LocalAuthServer {
  private server: Server | null = null;
  private port = 0;
  private readonly clientSecret: string;
  private resolveCallback: ((value: CallbackData) => void) | null = null;
  private rejectCallback: ((reason: Error) => void) | null = null;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;

  public constructor(clientSecret: string) {
    this.clientSecret = clientSecret;
  }

  public start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((request, response) => {
        this.handleRequest(request, response);
      });
      server.keepAliveTimeout = 1;
      server.on('error', (error) => {
        reject(
          new KnowledgeError(
            'ONLINE_LOGIN_SERVER_FAILED',
            '无法启动本地登录回调服务。',
            error
          )
        );
      });
      server.listen(0, '127.0.0.1', () => {
        this.server = server;
        this.port = (server.address() as AddressInfo).port;
        resolve(this.port);
      });
    });
  }

  public waitForCallback(
    timeoutMs: number = LOGIN_TIMEOUT_MS
  ): Promise<CallbackData> {
    return new Promise((resolve, reject) => {
      this.resolveCallback = resolve;
      this.rejectCallback = reject;
      this.timeoutId = setTimeout(() => {
        this.rejectCallback?.(
          new KnowledgeError(
            'ONLINE_LOGIN_TIMEOUT',
            '在线知识查询登录超时，请重新运行登录命令。'
          )
        );
        this.clearCallback();
      }, timeoutMs);
    });
  }

  public stop(): Promise<void> {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
    }
    this.clearCallback();
    if (!this.server) {
      return Promise.resolve();
    }
    const server = this.server;
    this.server = null;
    server.closeAllConnections?.();
    return new Promise((resolve) => {
      const timeout = setTimeout(resolve, 100);
      server.close(() => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  private clearCallback(): void {
    this.resolveCallback = null;
    this.rejectCallback = null;
    this.timeoutId = null;
  }

  private handleRequest(
    request: IncomingMessage,
    response: ServerResponse
  ): void {
    const host = request.headers.host ?? '';
    const expectedHosts = [
      `127.0.0.1:${this.port}`,
      `localhost:${this.port}`,
    ];
    if (!expectedHosts.includes(host.toLowerCase())) {
      response.writeHead(400);
      response.end('Bad Host');
      return;
    }
    const url = new URL(request.url ?? '', `http://${host}`);
    if (url.pathname !== '/callback') {
      response.writeHead(404);
      response.end('Not Found');
      return;
    }
    if (request.method === 'POST') {
      this.handlePost(request, response, url.searchParams);
      return;
    }
    this.handleCallback(response, url.searchParams);
  }

  private handlePost(
    request: IncomingMessage,
    response: ServerResponse,
    urlParams: URLSearchParams
  ): void {
    const chunks: Buffer[] = [];
    let length = 0;
    request.on('data', (chunk: Buffer) => {
      length += chunk.length;
      if (length > 16 * 1024) {
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8').trim();
      this.handleCallback(
        response,
        body ? new URLSearchParams(body) : urlParams
      );
    });
  }

  private handleCallback(
    response: ServerResponse,
    params: URLSearchParams
  ): void {
    const code = params.get('code');
    const tempToken = params.get('tempToken');
    const siteId = params.get('siteId');
    const quit = params.get('quit');
    if (!this.validCode(code)) {
      response.writeHead(400);
      response.end('Bad Request');
      return;
    }
    if (quit === 'true' || quit === 'access_denied' || quit === 'quit') {
      this.rejectCallback?.(
        new KnowledgeError(
          'ONLINE_LOGIN_CANCELLED',
          '用户取消了在线知识查询登录。'
        )
      );
      response.writeHead(302, {
        Location: `${BASE_URL}/${LOGIN_FAILED_PATH}`,
      });
      response.end();
      this.clearCallback();
      return;
    }
    if (!tempToken || !siteId) {
      this.rejectCallback?.(
        new KnowledgeError(
          'ONLINE_LOGIN_FAILED',
          '华为登录回调缺少必要参数。'
        )
      );
      response.writeHead(302, {
        Location: `${BASE_URL}/${LOGIN_FAILED_PATH}`,
      });
      response.end();
      this.clearCallback();
      return;
    }
    if (siteId !== '1') {
      this.rejectCallback?.(
        new KnowledgeError(
          'ONLINE_REGION_UNSUPPORTED',
          '在线知识查询登录目前仅支持中国站华为账号。'
        )
      );
      response.writeHead(302, {
        Location: `${BASE_URL}/${LOGIN_FAILED_PATH}`,
      });
      response.end();
      this.clearCallback();
      return;
    }
    this.resolveCallback?.({ tempToken, siteId });
    response.writeHead(302, {
      Location: `${BASE_URL}/${LOGIN_SUCCESS_PATH}`,
    });
    response.end();
    this.clearCallback();
  }

  private validCode(code: string | null): boolean {
    const received = Buffer.from(code ?? '', 'utf8');
    const expected = Buffer.from(this.clientSecret, 'utf8');
    return (
      received.length === expected.length &&
      timingSafeEqual(received, expected)
    );
  }
}

export class AuthClient {
  private readonly store: CredentialStore;
  private readonly fetchClient: FetchClient;
  private readonly browserOpener: BrowserOpener;
  private cachedAccessToken: string | null = null;
  private cachedAccessTokenUntil = 0;
  private accessTokenPromise: Promise<string> | null = null;

  public constructor(
    store: CredentialStore = new CredentialStore(),
    fetchClient: FetchClient = fetch,
    browserOpener: BrowserOpener = runInteractiveLogin
  ) {
    this.store = store;
    this.fetchClient = fetchClient;
    this.browserOpener = browserOpener;
  }

  public async login(): Promise<LoginResult> {
    const clientSecret = randomUUID().replaceAll('-', '');
    const server = new LocalAuthServer(clientSecret);
    try {
      const port = await server.start();
      const callbackPromise = server.waitForCallback();
      const loginUrl =
        `${BASE_URL}/${LOGIN_PATH}` +
        `?port=${port}&appid=${APP_ID}&code=${clientSecret}`;
      await this.browserOpener(loginUrl);
      const callback = await callbackPromise;
      const jwtToken = await this.exchangeTempToken(callback.tempToken);
      const tokenInfo = await this.checkJwtToken(jwtToken, false);
      if (!tokenInfo.status || !tokenInfo.userInfo?.accessToken) {
        throw new KnowledgeError(
          'ONLINE_LOGIN_FAILED',
          '华为登录服务没有返回有效令牌。'
        );
      }
      this.store.save(jwtToken);
      this.cachedAccessToken = tokenInfo.userInfo.accessToken;
      this.cachedAccessTokenUntil = Date.now() + ACCESS_TOKEN_CACHE_MS;
      const metadata = parseJwtMetadata(jwtToken);
      return {
        userName: metadata.userName,
        expiresAt: metadata.expiresAt
          ? new Date(metadata.expiresAt).toISOString()
          : null,
      };
    } finally {
      await server.stop();
    }
  }

  public logout(): boolean {
    this.cachedAccessToken = null;
    this.cachedAccessTokenUntil = 0;
    return this.store.clear();
  }

  public status(): AuthStatus {
    try {
      const metadata = this.store.metadata();
      const expired =
        metadata.expiresAt !== null && metadata.expiresAt <= Date.now();
      return {
        authenticated: !expired,
        expiresAt: metadata.expiresAt
          ? new Date(metadata.expiresAt).toISOString()
          : null,
        message: expired
          ? '在线知识查询登录已过期，请重新登录。'
          : '在线知识查询登录信息已就绪。',
      };
    } catch {
      return {
        authenticated: false,
        expiresAt: null,
        message: '在线知识查询尚未登录。',
      };
    }
  }

  public async accessToken(): Promise<string> {
    if (
      this.cachedAccessToken &&
      this.cachedAccessTokenUntil > Date.now()
    ) {
      return this.cachedAccessToken;
    }
    if (!this.accessTokenPromise) {
      this.accessTokenPromise = this.refreshAccessToken().finally(() => {
        this.accessTokenPromise = null;
      });
    }
    return this.accessTokenPromise;
  }

  public invalidateAccessToken(): void {
    this.cachedAccessToken = null;
    this.cachedAccessTokenUntil = 0;
  }

  private async refreshAccessToken(): Promise<string> {
    const jwtToken = this.store.load();
    const metadata: JwtMetadata = parseJwtMetadata(jwtToken);
    if (metadata.expiresAt && metadata.expiresAt <= Date.now()) {
      throw new KnowledgeError(
        'ONLINE_LOGIN_REQUIRED',
        '在线知识查询登录已过期，请重新运行 npx -y @rvaim/arkts_knowledge_search login。'
      );
    }
    const tokenInfo = await this.checkJwtToken(jwtToken, true);
    const accessToken = tokenInfo.userInfo?.accessToken;
    if (!tokenInfo.status || !accessToken) {
      throw new KnowledgeError(
        'ONLINE_LOGIN_REQUIRED',
        '在线知识查询登录无效，请重新运行 npx -y @rvaim/arkts_knowledge_search login。'
      );
    }
    this.cachedAccessToken = accessToken;
    this.cachedAccessTokenUntil = Date.now() + ACCESS_TOKEN_CACHE_MS;
    return accessToken;
  }

  private async exchangeTempToken(tempToken: string): Promise<string> {
    const url = new URL(`${BASE_URL}/${TEMP_TOKEN_PATH}`);
    url.searchParams.set('tempToken', tempToken.split('&')[0] ?? tempToken);
    url.searchParams.set('site', 'CN');
    url.searchParams.set('version', API_VERSION);
    url.searchParams.set('appid', APP_ID);
    const response = await this.fetchClient(url, {
      headers: requestHeaders(),
      signal: AbortSignal.timeout(20_000),
    });
    const jwtToken = (await response.text()).trim();
    if (!response.ok || jwtToken.split('.').length !== 3) {
      throw new KnowledgeError(
        'ONLINE_LOGIN_FAILED',
        `无法换取在线知识查询 JWT，HTTP ${response.status}。`
      );
    }
    return jwtToken;
  }

  private async checkJwtToken(jwtToken: string, refresh: boolean) {
    const response = await this.fetchClient(
      `${BASE_URL}/${JWT_TOKEN_PATH}`,
      {
        headers: {
          ...requestHeaders(),
          refresh: String(refresh),
          jwtToken,
        },
        signal: AbortSignal.timeout(20_000),
      }
    );
    if (!response.ok) {
      throw new KnowledgeError(
        'ONLINE_AUTH_FAILED',
        `在线知识查询令牌校验失败，HTTP ${response.status}。`
      );
    }
    try {
      return tokenCheckSchema.parse(JSON.parse(await response.text()));
    } catch (error) {
      throw new KnowledgeError(
        'ONLINE_AUTH_FAILED',
        '在线知识查询令牌服务返回了无法识别的数据。',
        error instanceof Error ? error : undefined
      );
    }
  }
}

function requestHeaders(): Record<string, string> {
  return {
    'User-Agent': '@rvaim/arkts_knowledge_search',
    'accept-language': 'zh-CN',
  };
}
