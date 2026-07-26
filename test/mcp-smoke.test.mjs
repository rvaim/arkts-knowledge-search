import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('stdio MCP 可以启动并列出全部在线知识工具', async () => {
  const packageRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..'
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(packageRoot, 'dist', 'index.js')],
    cwd: packageRoot,
    stderr: 'pipe',
  });
  const client = new Client({
    name: 'arkts-knowledge-search-test',
    version: '0.1.0',
  });
  try {
    await client.connect(transport);
    const result = await client.listTools();
    const names = result.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      'arkts_knowledge_login',
      'arkts_knowledge_logout',
      'arkts_knowledge_search',
      'arkts_knowledge_status',
    ]);
    const searchTool = result.tools.find(
      (tool) => tool.name === 'arkts_knowledge_search'
    );
    assert.deepEqual(searchTool.inputSchema.required, ['question']);
  } finally {
    await client.close();
  }
});
