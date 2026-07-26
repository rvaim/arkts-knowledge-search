import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as z from 'zod/v4';
import type {
  AuthStatus,
  LoginResult,
} from './auth.js';
import { errorMessage } from './errors.js';
import type { ThrownValue } from './errors.js';
import type { KnowledgeSearchResult } from './types.js';

export const PACKAGE_VERSION = '0.1.0';

export interface KnowledgeSearchPort {
  search(question: string): Promise<KnowledgeSearchResult>;
}

export interface KnowledgeAuthPort {
  login(): Promise<LoginResult>;
  logout(): boolean;
  status(): AuthStatus;
}

function textResult(value: object | string): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text:
          typeof value === 'string'
            ? value
            : JSON.stringify(value, null, 2),
      },
    ],
  };
}

function errorResult(error: ThrownValue): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: errorMessage(error),
      },
    ],
    isError: true,
  };
}

export function createKnowledgeServer(
  knowledge: KnowledgeSearchPort,
  auth: KnowledgeAuthPort
): McpServer {
  const server = new McpServer({
    name: 'arkts_knowledge_search',
    version: PACKAGE_VERSION,
  });

  server.registerTool(
    'arkts_knowledge_search',
    {
      title: '查询 ArkTS 与 HarmonyOS 在线知识',
      description:
        '查询 ArkTS、ArkUI、HarmonyOS 与 OpenHarmony 在线知识库。适用于 .ets 代码、装饰器、生命周期、状态刷新、SDK API、DevEco 或 hvigor 构建错误，以及 @kit.*、@ohos.* API。',
      inputSchema: {
        question: z
          .string()
          .min(1)
          .max(1000)
          .describe(
            '简洁的问题，应包含关键符号、API、装饰器、生命周期名称、构建错误或现象。'
          ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ question }) => {
      try {
        return textResult(await knowledge.search(question.trim()));
      } catch (error) {
        return errorResult(error as ThrownValue);
      }
    }
  );

  server.registerTool(
    'arkts_knowledge_status',
    {
      title: '检查 ArkTS 在线知识登录状态',
      description: '检查在线知识查询登录状态，不返回任何令牌。',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async () =>
      textResult({
        ...auth.status(),
        loginCommand:
          'npx -y @rvaim/arkts_knowledge_search login',
      })
  );

  server.registerTool(
    'arkts_knowledge_login',
    {
      title: '登录 ArkTS 在线知识查询',
      description:
        '打开华为官方登录页面，完成在线知识查询 OAuth 登录。不会安装或启动 DevEco Code。',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const result = await auth.login();
        return textResult({
          success: true,
          userName: result.userName,
          expiresAt: result.expiresAt,
          message: '在线知识查询登录成功。',
        });
      } catch (error) {
        return errorResult(error as ThrownValue);
      }
    }
  );

  server.registerTool(
    'arkts_knowledge_logout',
    {
      title: '退出 ArkTS 在线知识查询',
      description: '删除本 MCP 在本机保存的加密登录凭据。',
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async () =>
      textResult({
        removed: auth.logout(),
        message: '在线知识查询本地登录凭据已清理。',
      })
  );

  return server;
}

export async function startStdioServer(
  knowledge: KnowledgeSearchPort,
  auth: KnowledgeAuthPort
): Promise<void> {
  const server = createKnowledgeServer(knowledge, auth);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
