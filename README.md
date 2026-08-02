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
- `T01`：JSON-RPC 消息类型、类型守卫和协议测试，已完成。
- `T02`：JSONL、Request Map、双向 Connection 和 `initialize` 握手，已完成。
- 金融 Walking Skeleton：模拟流水通过 App Server 返回月度汇总，已完成。
- 下一步：由学习者手写 Runtime 生命周期接入和 Agent Loop。
- 当前入口：`src/cli/main.ts`。
- 当前输出：`2026-07` 收入、支出、净现金流和分类支出。

## 目录结构

```text
src/
├── app-server/   # Codex-like App Server 与金融 RPC 入口
├── cli/          # 第一阶段测试客户端
├── domains/      # 业务领域；当前包含确定性金融汇总
├── model/        # Model Provider Adapter，后续实现
├── protocol/     # JSON-RPC 与 App Server 协议
├── runtime/      # Thread / Turn / Item；下一阶段手写接入
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
2026-07 财务摘要
收入：¥10,000.00
支出：¥3,150.00
净现金流：¥6,850.00
```

## 换电脑继续学习

```bash
git clone https://github.com/hanlaining/agent-learn.git
cd agent-learn
npm install
code .
```

API Key、Token 和本机配置不得提交到仓库。后续接入模型时，凭据通过本机环境变量提供。
