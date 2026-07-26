#!/usr/bin/env node

import { AuthClient } from './auth.js';
import { errorMessage } from './errors.js';
import type { ThrownValue } from './errors.js';
import { ArktsKnowledgeClient } from './knowledge-search.js';
import { startStdioServer } from './server.js';
import type { KnowledgeStatus } from './types.js';

function createClients(): {
  auth: AuthClient;
  knowledge: ArktsKnowledgeClient;
} {
  const auth = new AuthClient();
  return {
    auth,
    knowledge: new ArktsKnowledgeClient(auth),
  };
}

function parseQuestion(args: string[]): string {
  const question = args.join(' ').trim();
  if (!question) {
    throw new Error('请提供要查询的 ArkTS 或 HarmonyOS 问题。');
  }
  return question;
}

function status(auth: AuthClient): KnowledgeStatus {
  return {
    ...auth.status(),
    loginCommand: 'npx -y @rvaim/arkts_knowledge_search login',
  };
}

function printHelp(): void {
  console.log(`ArkTS 在线知识查询 MCP

用法：
  arkts-knowledge-search                  启动 stdio MCP
  arkts-knowledge-search serve            启动 stdio MCP
  arkts-knowledge-search search <问题>    查询在线知识
  arkts-knowledge-search status           检查登录状态
  arkts-knowledge-search login            登录在线知识查询
  arkts-knowledge-search logout           清理本地登录凭据`);
}

async function main(): Promise<void> {
  const [command = 'serve', ...args] = process.argv.slice(2);
  const { auth, knowledge } = createClients();

  if (command === 'serve') {
    await startStdioServer(knowledge, auth);
    return;
  }
  if (command === 'search') {
    console.log(
      JSON.stringify(await knowledge.search(parseQuestion(args)), null, 2)
    );
    return;
  }
  if (command === 'status') {
    console.log(JSON.stringify(status(auth), null, 2));
    return;
  }
  if (command === 'login') {
    console.log('正在打开华为官方登录页面，请在浏览器中完成登录。');
    const result = await auth.login();
    console.log(
      JSON.stringify(
        {
          success: true,
          userName: result.userName,
          expiresAt: result.expiresAt,
        },
        null,
        2
      )
    );
    return;
  }
  if (command === 'logout') {
    console.log(
      auth.logout()
        ? '在线知识查询本地登录凭据已清理。'
        : '当前没有在线知识查询登录凭据。'
    );
    return;
  }
  if (command === '--help' || command === '-h' || command === 'help') {
    printHelp();
    return;
  }
  throw new Error(`未知命令：${command}`);
}

main().catch((error) => {
  console.error(errorMessage(error as ThrownValue));
  process.exitCode = 1;
});
