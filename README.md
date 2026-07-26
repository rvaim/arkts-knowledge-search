# ArkTS Knowledge Search

把 DevEco Code 的 `arkts_knowledge_search` 在线知识查询能力独立为 MCP 服务。

本项目不安装、启动或依赖 DevEco Code，也不包含 `@deveco/deveco-cli`：

- 工具名称和 `question` 参数与 DevEco Code 的 `arkts_knowledge_search` 保持一致。
- 在线查询调用华为 `bigSearch` 服务。
- 登录使用独立的华为 OAuth 流程。
- JWT 加密保存在本机，短期 `accessToken` 只存在于进程内存，不会写入日志或 MCP 返回值。

## 使用

MCP 配置：

```json
{
  "mcpServers": {
    "arkts-knowledge-search": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "@rvaim/arkts_knowledge_search"
      ]
    }
  }
}
```

命令行：

```bash
# 检查登录状态
npx -y @rvaim/arkts_knowledge_search status

# 登录，只打开华为官方页面
npx -y @rvaim/arkts_knowledge_search login

# 查询在线知识
npx -y @rvaim/arkts_knowledge_search search "UIAbility onCreate 的调用顺序"
```

## MCP 工具

| 工具 | 用途 |
|---|---|
| `arkts_knowledge_search` | 查询 ArkTS、ArkUI、HarmonyOS 与 OpenHarmony 在线知识 |
| `arkts_knowledge_status` | 检查在线登录状态 |
| `arkts_knowledge_login` | 打开华为官方 OAuth 页面登录 |
| `arkts_knowledge_logout` | 清理本 MCP 保存的加密登录凭据 |

`arkts_knowledge_search` 接收一个 `question` 字符串。问题应简洁，并包含 API、装饰器、生命周期名称、构建错误或现象等关键信息。

## 登录与本地数据

在线登录使用：

```text
https://cn.devecostudio.huawei.com
```

登录凭据默认保存在：

```text
~/.config/arkts-knowledge-search/
```

可通过 `ARKTS_KNOWLEDGE_SEARCH_DATA_DIR` 修改目录。凭据使用 AES-256-GCM 加密，凭据文件与密钥文件权限设为当前用户可读写。

macOS 如需指定登录浏览器：

```bash
ARKTS_KNOWLEDGE_BROWSER="Google Chrome" npx -y @rvaim/arkts_knowledge_search login
```

当前登录仅支持中国站华为账号。在线接口属于华为服务，可能独立于本项目更新。

## 与 DevEco CLI 的关系

本包只负责在线知识查询。`@deveco/deveco-cli` 的本地文档、构建、运行、设备、模拟器和日志能力应由 AI 插件独立配置，不作为本包依赖。

## 许可证

本项目采用 MIT 许可证。派生来源与第三方声明见 [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md)。
