# Agent Learn

从 0 到 1 手写的 Codex-like 单 Agent Runtime 学习项目，当前已经完成 CLI 产品化、Skill Loader，以及 MCP stdio Tool 的 Agent / CLI 完整主链路。

> “Codex-like”仅表示本学习项目借鉴了 Codex 等公开可见的产品概念和交互思路，不表示复制其专有源码，也不表示本项目由 OpenAI 开发、审核或认可。原创边界、第三方引用和 Codex 辅助使用情况见[《原创、借鉴、引用与 AI 辅助说明》](./原创借鉴与引用说明.md)。

## 当前能力

```text
god-agent CLI
  -> JSONL / 双向 JSON-RPC App Server
  -> Thread / Turn / Item Lifecycle
  -> Context Builder / o200k Token Budget / Compaction
  -> OpenAI Responses Provider / Summary SSE / Web Search
  -> Tool Registry / Permission / Workspace Sandbox
  -> Runtime Persistence / Cancel / Timeout / Retry
  -> Skill Catalog / read_skill 渐进披露
  -> MCP stdio / 新旧协议兼容 / tools/list / tools/call
  -> MCP Tool Adapter / Permission / Agent Loop / CLI
```

- 金额继续使用整数“分”由确定性 Tool 计算，LLM 只负责选择和解释。
- 默认 CLI 隐藏内部日志，`--debug` 保留完整学习型日志。
- Workspace 命令只能运行预注册配方，取消时终止独立子进程树。
- Skill 默认从 `<workspace>/skills/<name>/SKILL.md` 加载，可用 `AGENT_SKILLS_PATH` 覆盖根目录。
- MCP Server 由 `AGENT_MCP_CONFIG` 静态配置；Tool 使用 `mcp__<server>__<tool>` 命名并默认经过 CLI 审批。
- 当前没有进入 Electron 或 Multi-Agent。

最新本地基线：

```text
npm run check  通过
npm test       165/165 通过
```

## 目录结构

```text
src/
├── agent/        # Agent Loop 与 Event System
├── app-server/   # JSON-RPC App Server 与运行时组装
├── cli/          # god-agent 产品/调试双模式 CLI
├── domains/      # 确定性金融领域逻辑
├── llm/          # OpenAI Responses Provider 与 SSE 解析
├── mcp/          # MCP stdio Client、配置、Manager 与 Tool Adapter
├── permissions/  # 一次/本会话 Tool 审批
├── protocol/     # JSON-RPC、JSONL、Connection
├── runtime/      # Lifecycle、Context、Token、Compaction、Persistence
├── sandbox/      # Workspace 文件边界与受控命令进程
├── skills/       # Skill Loader
└── tools/        # Tool Registry、Workspace Tool、read_skill
skills/           # 项目级 SKILL.md 示例
tests/            # 单元、集成和 CLI Smoke Test
```

## 本地运行

```powershell
npm install
npm run check
npm test
node bin/god-agent.js --help
node bin/god-agent.js
```

真实模型调用由本机环境变量提供 `OPENAI_API_KEY`；可选配置包括 `OPENAI_BASE_URL`、`OPENAI_MODEL`、`AGENT_WORKSPACE`、`AGENT_SKILLS_PATH`、`AGENT_STATE_PATH` 和指向 MCP JSON 配置的 `AGENT_MCP_CONFIG`。

API Key、Token、本机状态文件和敏感配置不得提交到仓库。

下一阶段交接与可复制 Prompt：

- [MCP 收尾与 Electron 启动交接](./docs/工作交接-2026-08-04-MCP收尾与Electron启动.md)
- [继续实现 Electron 单 Agent 桌面端 Prompt](./docs/PROMPT-继续实现Electron单Agent桌面端.md)
- [Electron 真实 Thinking 与 Activity 分层展示方案](./docs/Electron-真实Thinking与Activity分层展示方案.md)

如发现遗漏署名、引用不当或权利冲突，请通过本仓库 GitHub Issues 联系维护者；核实后将及时补充出处、修订或移除相关内容。
