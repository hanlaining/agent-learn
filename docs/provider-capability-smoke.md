# Provider 能力矩阵与受控冒烟

本切片默认只运行本地 fixture，不读取 Key、不访问网络、不产生付费调用：

```powershell
npm run provider:smoke
```

报告中的 `liveCalls` 在离线模式固定为 `0`。`Idempotency-Key`、请求状态查询、Provider 取消和重试分别记录，不能把本地 WAL、AbortSignal 或一次成功响应解释为 Provider exactly-once。

## 当前矩阵

| Provider | Idempotency-Key | 请求状态查询 | Provider 取消 | 重试语义 | 本项目现状 |
| --- | --- | --- | --- | --- | --- |
| OpenAI Responses | 未接线（not-wired） | 未接线（not-wired） | 未接线（not-wired） | 客户端网络错误及 408/409/429/5xx 有上限指数退避 | 只发送 `POST /responses`；Abort 只取消本地传输 |
| OpenAI-compatible 网关 | 未知（unknown） | 未知（unknown） | 未知（unknown） | 必须按具体网关文档核对 | 兼容协议不是统一 Provider，不作推断 |

矩阵证据来自仓库源码和 fixture，不代表对所有账号、区域、网关或模型的线上承诺。

## 真实模式人工核对表

真实模式必须同时满足以下条件；任何一项缺失，工具会在发出请求前报告 `blocked`：

1. 明确设置 `PROVIDER_SMOKE_LIVE=1`。
2. 设置并核对 `PROVIDER_SMOKE_API_KEY`（或确认使用已配置的 Provider Key）；Key 不会写入报告。
3. `PROVIDER_SMOKE_MODEL` 必须出现在 `PROVIDER_SMOKE_MODEL_ALLOWLIST`。
4. 设置正数 `PROVIDER_SMOKE_MAX_REQUEST_COST_USD` 和 `PROVIDER_SMOKE_MAX_TOTAL_COST_USD`，并确认总额不小于单次额。
5. 设置正数 `PROVIDER_SMOKE_MAX_REQUESTS`，且覆盖显式操作的最坏尝试次数（`retry` 会额外预留一次）。
6. 设置正数 `PROVIDER_SMOKE_TIMEOUT_MS`。
7. 显式设置 `PROVIDER_SMOKE_OPERATIONS`（例如只做 `create`）；先确认每个状态/取消端点确实适用于目标 Provider。
8. 确认 `OPENAI_BASE_URL`/`PROVIDER_SMOKE_BASE_URL` 指向预期环境，确认服务端账单和数据留存策略。
9. 先运行离线 fixture 并保存报告，再人工复核命令行输出中的 `mode`、`liveCalls`、`requests`、`estimatedCostUsd`。

本次实现没有凭据、预算或用户明确授权，因此不执行真实冒烟；只验收离线路径和阻断路径。
