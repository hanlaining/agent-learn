# Agent Learn

从 0 到 1 手写一个采用 Codex-like 分层架构的 Agent 学习项目。

当前学习目标不是一次实现完整 Codex，而是按顺序理解并实现：

```text
Client
→ JSON-RPC Protocol
→ App Server
→ Thread / Turn / Item
→ Agent Runtime
→ Model / Tool
→ Approval / Sandbox
→ Skills / MCP
```

## 当前进度

- `T00`：TypeScript CLI 项目骨架，已完成。
- `T01-1`：JSON-RPC 消息类型，进行中。
- 当前入口：`src/cli/main.ts`。
- 当前输出：`Agent Lab ready`。

## 目录结构

```text
src/
├── app-server/   # Codex-like App Server，后续实现
├── cli/          # 第一阶段测试客户端
├── model/        # Model Provider Adapter，后续实现
├── protocol/     # JSON-RPC 与 App Server 协议
├── runtime/      # Agent Loop 与状态机，后续实现
└── tools/        # Tool Registry 与 Executor，后续实现
tests/            # 协议与 Runtime 测试
```

## 本地运行

```bash
npm install
npm run check
npm run dev
```

预期输出：

```text
Agent Lab ready
```

## 换电脑继续学习

```bash
git clone https://github.com/hanlaining/agent-learn.git
cd agent-learn
npm install
code .
```

API Key、Token 和本机配置不得提交到仓库。后续接入模型时，凭据通过本机环境变量提供。
