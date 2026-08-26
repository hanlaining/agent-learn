# God-Agent

God-Agent 是一个从 Agent Loop 逐步演进出来的本地 Agent Runtime 研究原型。它同时提供 CLI 和 Electron 桌面端，支持多 Chat、工具调用、Skill、MCP、固定软件团队与动态父子 Agent，并重点研究长程任务在崩溃、重复投递、并发接管和外部副作用结果未知时如何安全恢复。

项目当前定位是**单机、本地文件持久化的系统化工程与科研原型**，不是生产级多租户平台，也不是已完成的论文成果。

> “Codex-like”只表示项目学习了 Codex 等公开可见的 Agent 产品概念和交互思路，不表示复制专有源码，也不表示由 OpenAI 开发、审核或认可。原创边界、第三方引用和 Codex 辅助情况见[《原创、借鉴、引用与 AI 辅助说明》](./原创借鉴与引用说明.md)。

## 为什么做这个项目

普通 Agent Demo 往往只关心一次调用能否得到答案。God-Agent 关注的是更难的一层：

- 模型结果已经返回，但进程在持久化前崩溃，能否避免重复付费调用？
- 工具可能已经产生外部副作用，但客户端没有收到确认，能否避免盲目重放？
- 父 Agent 等待多个子任务时重启，Return 是否会丢失、重复消费或污染新 attempt？
- 新 Owner 接管任务后，旧 Owner 的迟到结果能否被 fencing 拒绝？
- 系统无法确认结果时，能否诚实进入 `outcome_unknown`，而不是伪造成功或无限重试？

项目用 Model/Tool WAL、稳定 Invocation ID、Lease/Fencing、Return Outbox/Receipt、Checkpoint、Snapshot CAS 和人工处置机制探索这些问题。

## 当前能力

```text
CLI / Electron Desktop
  -> JSONL / 双向 JSON-RPC App Server
  -> Thread / Turn / Item / RuntimeSession Lifecycle
  -> OpenAI Responses Provider / Summary SSE / Web Search
  -> Context Builder / o200k Token Budget / Compaction
  -> Tool Registry / Permission / Workspace Sandbox
  -> Skill Catalog / MCP stdio / Tool Adapter
  -> 多 Chat 并行与独立取消
  -> 固定软件团队 / 动态父子 Agent / Evidence / Return
  -> Model & Tool WAL / Lease & Fencing / Snapshot CAS
  -> outcome_unknown 检测、审计与人工裁决
```

Electron 桌面端已包含三栏工作区、历史任务、多 Chat、Runtime Timeline、父子 Agent 状态、权限审批、模型选择、本地预览和受限多标签浏览器。变更检查、任意桌面终端、正式安装发布和多机 Runtime 尚未完成。

## 三层研究证据

项目严格区分三类检查，不能互相替代：

| 层级 | 检查对象 | 当前边界 |
|---|---|---|
| Model Check | 确定性协议参考状态机与 WAL/recovery/lease 消融 | E2；不运行生产类，不代表真实系统 |
| Runtime Implementation Check | 直接运行生产 Runtime 类并重载真实 JSON | E2；Provider 和 Tool 仍为确定性 Fake |
| Process Check | 真 App Server 子进程强杀、重启和文件/RPC 恢复 | 窄范围 E3；不是完整 GATE-40，也不是端到端 exactly-once |

固定 Artifact、Claim–Evidence Matrix 和复现说明位于：

- [Claim–Evidence Matrix](./research/CLAIMS-EVIDENCE.zh-CN.md)
- [Research Artifact v0.1](./research/artifacts/v0.1/README.md)
- [第三方复现 SOP](./research/REPRODUCIBILITY.zh-CN.md)

## 当前验证基线

在 `main@3c78dca` 基础上的当前持续精进工作树中，2026-08-24 串行复验结果为：

当前数字的机器可读权威快照为 [`docs/evidence/current-evidence.json`](./docs/evidence/current-evidence.json)，结构约束见 [`current-evidence.schema.json`](./docs/evidence/current-evidence.schema.json)。`verify-evidence-consistency` 会同时拒绝测试算术错误、文档数字漂移，以及把 local pilot、Fake Provider、作者自测或 local-ready 抬成 formal、live、独立复现或 production-ready 的越界声明。

| 入口 | 结果 |
|---|---:|
| Runtime Store pretest | 19/19 |
| 正式测试文件发现门禁 | 115/115 文件零漏项 |
| 全量主测试 | 736 total：735 pass、1 个 Windows symlink 权限条件 skip、0 fail |
| `src` 源码覆盖 | 当前正式门禁 26,146/28,672 = 91.19%；loaded 116/122 = 95.082% |
| Electron 专项 | 76/76 |
| 离线 Benchmark 专项 | 10/10 |
| Runtime-E2E | 10/10 |
| Process Chaos 专项 | 17/17 |
| GATE-40 local pilot | 40 passed、0 failed、0 blocked；formal Verified 0/40 |
| Provider Capability Smoke | offline，`liveCalls=0` |
| TypeScript check / Electron build | passed |
| 本地 Release Readiness | 11/12、BLOCKED；官方审计 0 critical / 3 high；production blocked |

> 证据快照兼容说明：机器可读权威快照记录的历史测试发现为 **113/113**（2026-08-24 快照）；当前工作树在后续复验中已纳入 **115/115**。这里保留 `113/113` 仅用于验证历史快照与文档的绑定，不将历史数字当作当前结果。

这些结果只说明固定基线在对应自动化环境中通过。真实 Provider、Electron 真窗口人工交互、外部工具副作用、跨机器部署、完整 Process 矩阵、统计显著性和第三方无指导复现仍不能据此宣称完成。

## 快速开始

当前已验证支持范围为 Node.js 20.x（`>=20 <21`）。科研复现参考环境为 Node.js 20.19.0；其他版本应记录为环境变体，不能直接视为已支持。

```powershell
npm ci
npx --no-install tsx scripts/demo-preflight.ts
npm run check
```

自检会检查 Node、关键文件、本地依赖、Electron 构建和系统临时目录。它只判断 `OPENAI_API_KEY` 等环境变量名是否存在，不读取或输出配置值。未配置 Provider 不会阻断离线演示。

### 离线可靠性演示（推荐必达轨道）

离线轨道不读取真实 Key，也不会产生真实模型费用：

```powershell
npm run benchmark:offline -- --suite gate30 --seed 20260824 --dry-run
npm run test:benchmarks
npm run provider:smoke
```

完整三分钟脚本、断网兜底和 Claim 边界见[《复试三分钟演示》](./docs/DEMO-复试三分钟演示.md)。

### Electron 桌面端

```powershell
npm run electron:build
npm run electron:dev
```

没有 `OPENAI_API_KEY` 时，桌面 Runtime 可以启动并展示离线界面，但 `turn/run` 会被禁用。不要把桌面壳启动等同于真实模型链路已验证。

### CLI

```powershell
node bin/god-agent.js --help
node bin/god-agent.js
```

CLI 默认隐藏内部调试日志；使用 `--debug` 可显示 Runtime、Model 和 Tool 日志。真实模型对话同样需要在本机进程环境中配置 `OPENAI_API_KEY`。

## 配置与安全

常用可选环境变量：

- `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL`
- `AGENT_WORKSPACE`、`AGENT_STATE_PATH`、`AGENT_SKILLS_PATH`
- `AGENT_MCP_CONFIG`

API Key、Token、Bearer、私有 Base URL、本机状态文件和敏感 MCP 配置不得写入 README、日志、截图、Artifact 或提交记录。Provider Capability Smoke 默认是离线模式；只有显式满足其全部 live 闸门时才允许真实调用。

## 目录结构

```text
src/
├── agent/          # Agent Loop 与事件
├── agents/         # Agent Run、父子关系、固定团队与调度
├── app-server/     # JSON-RPC App Server 与生产组装
├── cli/            # CLI 产品与调试入口
├── electron/       # Electron Main、Preload、Controller 与 Renderer
├── execution/      # Dynamic/Team Execution Engine
├── llm/            # Responses Provider、WAL 与能力 Smoke
├── mcp/            # MCP stdio Client、Manager 与 Tool Adapter
├── permissions/    # Tool 审批与能力边界
├── runtime/        # Lifecycle、Snapshot、Lease、Context 与持久化
├── sandbox/        # Workspace 文件边界与受控命令
├── skills/         # Skill Loader
└── tools/          # Tool Registry 与 Workspace Tools
research/           # Benchmark、Runtime-E2E、Artifact、指标与复现材料
scripts/            # 构建、Demo、Benchmark、Smoke 与容量入口
tests/              # 单元、集成、E2E 和故障回归
```

## 当前不应声称

- 完整复刻 Codex 或达到 Codex 稳定性；
- 生产级多智能体平台；
- 端到端 exactly-once；
- 多 Agent 已被证明普遍优于单 Agent；
- GATE-30/GATE-100 是 30/100 个真实软件工程任务；
- 逻辑模拟延迟等同真实 Provider 的 p50/p95；
- 已完成论文、外部统计或第三方复现。

## 许可证、引用与反馈

当前包元数据声明为 ISC；第三方依赖仍受各自许可证约束。正式公开分发前还需补齐独立 LICENSE/NOTICE 与依赖许可证清单。

如发现遗漏署名、引用不当或权利冲突，请通过仓库 GitHub Issues 联系维护者；核实后将补充出处、修订或移除相关内容。
