/*
 * 在线认证流程参考 DevEco Code。
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * Copyright (c) 2026 rvaim
 * SPDX-License-Identifier: MIT
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as z from 'zod/v4';
import { KnowledgeError } from './errors.js';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const ROOT_KEY_ID = 'kek-v1';

const wrappedKeySchema = z.object({
  version: z.number(),
  algorithm: z.literal(ALGORITHM),
  kekId: z.string(),
  encryptedKey: z.string(),
  iv: z.string(),
  authTag: z.string(),
  timeStamp: z.number(),
});

const encryptedCredentialSchema = z.object({
  version: z.number(),
  algorithm: z.literal(ALGORITHM),
  ciphertext: z.string(),
  iv: z.string(),
  authTag: z.string(),
  timeStamp: z.number(),
});

const jwtPayloadSchema = z
  .object({
    userId: z.string().optional().default(''),
    userName: z.string().optional().default(''),
    exp: z.number().optional(),
    iat: z.number().optional(),
  })
  .passthrough();

export interface JwtMetadata {
  userId: string;
  userName: string;
  expiresAt: number | null;
}

export interface CredentialPaths {
  dataDirectory: string;
  credentialFile: string;
  wrappedKeyFile: string;
  rootKeyDirectory: string;
}

export function resolveCredentialPaths(): CredentialPaths {
  const configured = process.env.ARKTS_KNOWLEDGE_SEARCH_DATA_DIR?.trim();
  const dataDirectory =
    configured ||
    path.join(os.homedir(), '.config', 'arkts-knowledge-search');
  return {
    dataDirectory,
    credentialFile: path.join(dataDirectory, 'credential.enc'),
    wrappedKeyFile: path.join(dataDirectory, 'credential.dek'),
    rootKeyDirectory: path.join(dataDirectory, 'keys'),
  };
}

function writePrivateFile(filePath: string, data: string | Buffer): void {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, data, { mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
  fs.chmodSync(filePath, 0o600);
}

function decrypt(
  ciphertext: Buffer,
  key: Buffer,
  iv: string,
  authTag: string
): Buffer {
  const decipher = createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export class CredentialStore {
  private readonly paths: CredentialPaths;

  public constructor(paths: CredentialPaths = resolveCredentialPaths()) {
    this.paths = paths;
  }

  public save(jwtToken: string): void {
    const dataKey = this.loadOrCreateDataKey();
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, dataKey, iv);
    const ciphertext = Buffer.concat([
      cipher.update(jwtToken, 'utf8'),
      cipher.final(),
    ]);
    const credential = {
      version: 1,
      algorithm: ALGORITHM,
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      timeStamp: Date.now(),
    };
    writePrivateFile(
      this.paths.credentialFile,
      JSON.stringify(credential, null, 2)
    );
  }

  public load(): string {
    if (!fs.existsSync(this.paths.credentialFile)) {
      throw new KnowledgeError(
        'ONLINE_LOGIN_REQUIRED',
        '在线知识查询尚未登录，请运行 npx -y @rvaim/arkts_knowledge_search login。'
      );
    }
    try {
      const credential = encryptedCredentialSchema.parse(
        JSON.parse(fs.readFileSync(this.paths.credentialFile, 'utf8'))
      );
      const dataKey = this.loadDataKey();
      return decrypt(
        Buffer.from(credential.ciphertext, 'base64'),
        dataKey,
        credential.iv,
        credential.authTag
      ).toString('utf8');
    } catch (error) {
      throw new KnowledgeError(
        'ONLINE_CREDENTIAL_INVALID',
        '在线知识查询登录信息无法读取，请重新登录。',
        error instanceof Error ? error : undefined
      );
    }
  }

  public clear(): boolean {
    if (!fs.existsSync(this.paths.credentialFile)) {
      return false;
    }
    fs.unlinkSync(this.paths.credentialFile);
    return true;
  }

  public metadata(): JwtMetadata {
    return parseJwtMetadata(this.load());
  }

  private ensureDirectories(): void {
    fs.mkdirSync(this.paths.dataDirectory, {
      recursive: true,
      mode: 0o700,
    });
    fs.mkdirSync(this.paths.rootKeyDirectory, {
      recursive: true,
      mode: 0o700,
    });
  }

  private rootKeyPath(keyId: string): string {
    return path.join(this.paths.rootKeyDirectory, `${keyId}.bin`);
  }

  private loadOrCreateRootKey(keyId: string): Buffer {
    this.ensureDirectories();
    const keyPath = this.rootKeyPath(keyId);
    if (!fs.existsSync(keyPath)) {
      writePrivateFile(keyPath, randomBytes(KEY_LENGTH));
    }
    const key = fs.readFileSync(keyPath);
    if (key.length !== KEY_LENGTH) {
      throw new KnowledgeError(
        'ONLINE_CREDENTIAL_INVALID',
        '在线知识查询本地根密钥长度无效，请重新登录。'
      );
    }
    return key;
  }

  private loadOrCreateDataKey(): Buffer {
    this.ensureDirectories();
    if (fs.existsSync(this.paths.wrappedKeyFile)) {
      return this.loadDataKey();
    }
    const dataKey = randomBytes(KEY_LENGTH);
    const rootKey = this.loadOrCreateRootKey(ROOT_KEY_ID);
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, rootKey, iv);
    const encryptedKey = Buffer.concat([
      cipher.update(dataKey),
      cipher.final(),
    ]);
    const wrapped = {
      version: 1,
      algorithm: ALGORITHM,
      kekId: ROOT_KEY_ID,
      encryptedKey: encryptedKey.toString('base64'),
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      timeStamp: Date.now(),
    };
    writePrivateFile(
      this.paths.wrappedKeyFile,
      JSON.stringify(wrapped, null, 2)
    );
    return dataKey;
  }

  private loadDataKey(): Buffer {
    const wrapped = wrappedKeySchema.parse(
      JSON.parse(fs.readFileSync(this.paths.wrappedKeyFile, 'utf8'))
    );
    const rootKey = this.loadOrCreateRootKey(wrapped.kekId);
    const dataKey = decrypt(
      Buffer.from(wrapped.encryptedKey, 'base64'),
      rootKey,
      wrapped.iv,
      wrapped.authTag
    );
    if (dataKey.length !== KEY_LENGTH) {
      throw new KnowledgeError(
        'ONLINE_CREDENTIAL_INVALID',
        '在线知识查询本地数据密钥长度无效，请重新登录。'
      );
    }
    return dataKey;
  }
}

export function parseJwtMetadata(jwtToken: string): JwtMetadata {
  const parts = jwtToken.split('.');
  const payload = parts[1];
  if (parts.length !== 3 || !payload) {
    throw new KnowledgeError(
      'ONLINE_CREDENTIAL_INVALID',
      '在线知识查询 JWT 格式无效，请重新登录。'
    );
  }
  try {
    const base64 = payload
      .replaceAll('-', '+')
      .replaceAll('_', '/')
      .padEnd(payload.length + ((4 - (payload.length % 4)) % 4), '=');
    const parsed = jwtPayloadSchema.parse(
      JSON.parse(Buffer.from(base64, 'base64').toString('utf8'))
    );
    return {
      userId: parsed.userId,
      userName: parsed.userName,
      expiresAt: parsed.exp ? parsed.exp * 1000 : null,
    };
  } catch (error) {
    throw new KnowledgeError(
      'ONLINE_CREDENTIAL_INVALID',
      '在线知识查询 JWT 内容无效，请重新登录。',
      error instanceof Error ? error : undefined
    );
  }
}
