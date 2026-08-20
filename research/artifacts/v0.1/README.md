# God-Agent Research Artifact v0.1

本目录冻结三个相互独立的科研检查层，均绑定源码基线
`05680a4ecf0f13f7b1b311363732d4922ad9af5b`：

- `model-check/`：确定性协议参考状态机 GATE-30；
- `runtime-implementation-check/`：生产 Runtime 类接线的 Implementation GATE-30；
- `process-check/`：Team Workflow Return 的单个真实 App Server 强杀/恢复窗口。

每个子目录都有独立 `artifact-manifest.json`。请使用
`research/reproducibility/src/cli.ts verify` 分别校验。

Process Check 严格只计为窄范围 E3 的 1/40。它不是完整 E3、不是
GATE-40、不是端到端 exactly-once，也不是生产可用声明。
