# 第 4 轮生产发行阻断整改计划（L2）

审计时间：2026-08-26  
范围：仅生产发行成熟度；不修改依赖、`package-lock.json`、`docs/evidence/current-evidence.json`、阈值或正式分数。

## 当前门禁原始摘要

`npm run release:check` 当前结果为 `BLOCKED`（11 pass、0 warning、3 blocking）：

1. **dependency-risk**：官方 npm registry 报告 `0 critical / 3 high`。
   - `electron`：`GHSA-9f4c-93c8-jc8g`、`GHSA-r4w5-6pfg-jxp5`
   - `extract-zip`：`GHSA-jmr9-qjv8-65gv`
   - `nanoid`：`GHSA-2v37-7h3g-55p8`
2. **release-artifact-evidence**：缺少 `dist/release/release-artifact.json`。
3. **release-supply-chain-evidence**：缺少 `dist/release/release-supply-chain.json`。

本轮 `test-discovery` 已恢复为 PASS（115/115）；这不代表候选发行物证据已生成。

## 可在本机完成的项目

以下项目可在当前工作区重复执行，且不会产生生产证据或改变权威评分：

- `npm run check`
- `npm run test:release`
- `npm run test:security`
- `npm run test:sbom`
- `npm run security:scan`
- `npm run sbom:generate`（默认写入 `.tmp/release/bom.cdx.json`，不能直接当候选 SBOM）
- `npx --no-install tsx --test tests/release-artifact-gate-cases.ts`

这些命令只验证结构、路径安全、SHA 绑定和失败关闭行为。测试夹具、离线构建、Electron 输出目录和本机截图均不得复制为 `dist/release` 下的正式 receipt。

## 必须由外部真实环境完成的项目

### A. 依赖 high 风险

当前不擅自改依赖或 lockfile。由依赖负责人在隔离分支完成以下闭环：

1. 对三个 advisory 确认受影响版本、修复版本和 Electron/Chromium 再分发影响；
2. 评估升级、补丁或经安全负责人批准的例外（责任人、理由、到期日、补偿控制）；
3. 在新候选上重新执行官方 `npm audit --json --registry=https://registry.npmjs.org/`；
4. 仅当 critical/high 均为 0，或正式批准的例外被发布政策明确允许时，才可关闭 `dependency-risk`。

在此之前，风险只能登记和缓解，不能标记为已修复，也不能提高生产成熟度分数。

### B. 候选发行物与四类 receipt

由签名/QA/运维责任人生成全新的 `candidateRef`，按 [RELEASE-EXTERNAL-EVIDENCE-SUBMISSION-PACKET.zh-CN.md](RELEASE-EXTERNAL-EVIDENCE-SUBMISSION-PACKET.zh-CN.md) 提交：

- 真实 Windows 安装器及 SHA-256；
- 时间戳 Authenticode 签名 receipt（不得提交私钥）；
- 独立执行者在干净 Windows 上的安装、冷启动、卸载 receipt；
- `N → N+1` 升级、异常中断、备份恢复及回滚 receipt；
- 至少 `durationSeconds >= 3600`、`failureCount = 0`、恢复验证为真的长稳 receipt；
- 同一候选的 `release-artifact.json`，且四个 receipt 路径互不重复。

`release-artifact-gate` 只读取和校验这些文件，不负责签名、安装或长稳运行。缺任一项即保持 BLOCKED。

### C. SBOM、扫描和数据完整性索引

在候选 manifest 形成后，由构建流水线生成并固定同一 `candidateRef`：

- `god-agent.cdx.json`：CycloneDX 1.5，组件计数与索引一致；
- `security-scan.json`：真实扫描结果，`status=passed`、`findings=[]`；
- `data-integrity.json`：状态摘要、备份/恢复、无数据丢失三项均为 `true`；
- `release-supply-chain.json`：精确记录三文件 SHA-256 及 `releaseArtifactSha256`。

这些文件必须由真实候选生成；手工填写“passed”、占位 JSON 或测试 fixture 不得用于放行。

## 最短外部执行清单

1. 依赖负责人提供三个 high advisory 的修复/例外审批记录。
2. 发布流水线从冻结源码和 lockfile 构建并签名安装器，保存签名原始输出。
3. 独立 QA 在干净 Windows 完成安装、冷启动、卸载、升级中断和回滚演练。
4. 运维在同一候选上运行 3600 秒长稳并保存原始日志、指标和摘要。
5. 生成候选 manifest 与供应链索引，逐项计算 SHA-256。
6. 在干净环境执行：

   ```powershell
   npm run check
   npm run test:release
   npm run test:security
   npm run test:sbom
   npm run release:check
   ```

7. 发布、安全、运维及非作者复核责任人对同一候选 SHA 签字。

## 评分与最终意见

本轮没有新增真实生产证据，生产发行成熟度保持 **68/100**，不得因为本地测试通过或文档补充上调。当前结论为 **BLOCKED / NO-GO**；只有上述外部项目全部形成可追溯证据并使 `release:check` 无 blocking 后，才进入 90+ 复评。
