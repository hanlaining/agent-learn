# Process Check 公开范围

本目录只公开本次新运行的 `process-chaos-report.json`、
`runtime-leases.json` 和对应 Manifest。

Runner 同时生成的 raw `runtime-state.json` 含复核机器上的计划路径，
因此未纳入公开 v0.1。复核者可以重新运行 Runner，在自己的机器上生成并
检查该状态文件；公开包不能独立重查其中全部原始状态细节，相应 Claim 已降级。

本次实验只覆盖 Team Workflow Return 的一个固定 seed 和一个计入矩阵的
真实进程故障窗口，即 1/40。GATE-40、完整 E3、跨主机验证、真实外部 Tool、
真实 Provider、端到端 exactly-once 和生产可用均未完成。
