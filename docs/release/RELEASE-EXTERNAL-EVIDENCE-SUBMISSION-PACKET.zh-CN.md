# 生产发行真实证据提交包（候选级）

本文件是给构建、签名、验收和发布责任人的提交说明。它定义**文件命名、字段、来源和验收映射**，便于主控在同一个 `candidateRef` 上复核。文档本身不是 receipt，也不能把占位 JSON、测试夹具、截图或手工填写的 `passed` 当作证据。

## 1. 适用边界与放行原则

- 证据必须来自真实候选安装包、真实签名工具、独立的干净 Windows 机器、真实升级/回滚演练和至少 3600 秒的长稳运行。
- 所有路径必须是工作区内的普通文件：使用 `/`、相对路径、禁止绝对路径、`\\`、符号链接和路径逃逸。
- 所有 receipt 与索引必须写入同一个 `candidateRef`；替换安装包、源码或任一 receipt 后，必须生成新的候选并重算全部 SHA-256。
- `release-artifact-gate` 和 `release:check` 只验证结构、候选绑定和摘要一致性；通过不等于 Provider 已验证、不等于生产批准。非作者复核、依赖 high 风险处置和发布签字仍是独立硬门禁。

## 2. 提交包目录与固定命名

推荐将候选包整理为下列结构（`<candidateRef>` 仅使用稳定、无秘密的标识符）：

```text
dist/release/
  release-artifact.json
  release-supply-chain.json
  installers/god-agent-<version>-win32-x64-setup.exe
  evidence/<candidateRef>/signature.json
  evidence/<candidateRef>/clean-machine.json
  evidence/<candidateRef>/upgrade-rollback.json
  evidence/<candidateRef>/long-stability.json
  evidence/<candidateRef>/raw/                  # 原始日志/验签输出（普通文件）
```

门禁以 `release-artifact.json` 和其中的 `*Path` 字段为准；上面的目录是可审计的推荐命名，不得在 manifest 中写入未实际存在的路径。建议所有候选使用 UTC 时间和版本化文件名，避免覆盖旧候选。

## 3. `release-artifact.json`（发行物总 manifest）

文件位置固定为 `dist/release/release-artifact.json`，顶层键必须**精确**为：

| 键 | 类型/固定值 | 证据要求 |
| --- | --- | --- |
| `schemaVersion` | `god-agent-release-artifact-v1` | 与门禁 schema 完全一致 |
| `candidateRef` | 非空字符串 | 在安装包、四个 receipt、供应链索引中完全相同 |
| `createdAt` | 可解析的 ISO-8601 | 记录候选冻结时间，建议 `Z` 结尾 |
| `installerPath` | 规范化相对路径 | 指向真实安装器普通文件 |
| `installerSha256` | 64 位小写十六进制 | 对 `installerPath` 字节内容计算 SHA-256 |
| `signature` | 对象 | 见 3.1，`evidencePath` 必须独立 |
| `cleanMachine` | 对象 | 见 3.2，执行者和机器身份不可为空 |
| `upgradeRollback` | 对象 | 见 3.3，必须验证回滚和状态完整性 |
| `longStability` | 对象 | 见 3.4，至少 3600 秒且绑定原始证据摘要 |
| `claimBoundary` | `artifact-evidence-only-not-provider-not-production-approval` | 固定声明，不得改写为 READY/production |

### 3.1 签名 receipt：`signature.json`

`schemaVersion` 固定为 `god-agent-release-signature-v1`，至少包含以下字段：

| 字段 | 必须值/格式 | 验收含义 |
| --- | --- | --- |
| `candidateRef` | 与 manifest 相同 | 防止候选漂移 |
| `installerSha256` | 与 manifest 相同 | 签名对象就是本候选安装器 |
| `status` | `verified` | 验签工具返回成功 |
| `format` | `authenticode` | Windows Authenticode，而非自述签名 |
| `certificateSubject` | 非空 | 记录证书主体，需与 manifest 一致 |
| `timestamped` | `true` | 具有可信时间戳 |
| `verificationTool` | 非空字符串 | 记录实际使用的验签工具及版本 |

原始验签输出（例如工具输出、证书链和时间戳信息）放在 `raw/`，并在交付记录中给出定位；禁止写入私钥、口令或完整凭据。

### 3.2 干净 Windows receipt：`clean-machine.json`

`schemaVersion` 固定为 `god-agent-clean-machine-v1`：

| 字段 | 必须值/格式 | 验收含义 |
| --- | --- | --- |
| `candidateRef` | 与 manifest 相同 | 候选绑定 |
| `status` | `passed` | 本轮安装验收完成 |
| `executorId` | 非空、独立执行者标识 | 不得使用构建者自证或空值 |
| `machineId` | 非空、可审计机器标识 | 记录干净 Windows、版本、架构和镜像来源 |
| `installPassed` | `true` | 首次安装完成 |
| `startupPassed` | `true` | 安装后冷启动、关键路径可用 |
| `uninstallPassed` | `true` | 卸载完成且用户状态保留策略已核对 |

提交包另附机器版本/架构、标准权限账户、安装器 SHA、开始/结束 UTC 时间及原始日志定位。开发工作区启动、Electron build 目录或截图不能替代该 receipt。

### 3.3 升级/回滚 receipt：`upgrade-rollback.json`

`schemaVersion` 固定为 `god-agent-upgrade-rollback-v1`：

| 字段 | 必须值/格式 | 验收含义 |
| --- | --- | --- |
| `candidateRef` | 与 manifest 相同 | 候选绑定 |
| `status` | `passed` | 演练完成 |
| `testedFrom` / `testedTo` | 非空版本字符串 | 明确 `N → N+1` 路径 |
| `rollbackVerified` | `true` | `N+1` 失败/中断后恢复 `N` |
| `stateIntegrityVerified` | `true` | 状态摘要、备份恢复和副作用核对通过 |

原始证据必须覆盖成功升级、升级中断、磁盘不足、状态损坏和回滚失败处置；记录备份 SHA、恢复后状态 SHA、停止条件及无静默数据丢失结论。不能只提供“回滚成功”一句话。

### 3.4 3600 秒长稳 receipt：`long-stability.json`

`schemaVersion` 固定为 `god-agent-long-stability-v1`：

| 字段 | 必须值/格式 | 验收含义 |
| --- | --- | --- |
| `candidateRef` | 与 manifest 相同 | 候选绑定 |
| `status` | `passed` | 预注册长稳方案完成 |
| `durationSeconds` | 数字且 `>=3600` | 实际运行时长，不得四舍五入填报 |
| `failureCount` | `0` | 运行期间无未处置失败 |
| `recoveryVerified` | `true` | 崩溃、重启、租约过期、写失败等恢复演练通过 |

manifest 的 `longStability.evidenceSha256` 必须等于该 receipt **UTF-8 字节**的 SHA-256；原始日志和指标（内存、句柄、磁盘、延迟、失败率、恢复时间）放在 `raw/` 并保持只追加。短时容量/混沌测试不能充当 3600 秒证据。

## 4. 供应链索引与 SBOM/安全/数据完整性

`dist/release/release-supply-chain.json` 顶层键必须精确为 `schemaVersion`、`candidateRef`、`createdAt`、`releaseArtifactSha256`、`sbom`、`securityScan`、`dataIntegrity`、`claimBoundary`。三个子对象的固定文件名和字段如下：

| 证据 | 推荐文件名 | 必须字段/值 | 验收映射 |
| --- | --- | --- | --- |
| SBOM | `god-agent.cdx.json` | CycloneDX `1.5`、`components` 数组；索引 `componentCount` 等于数组长度 | `release-supply-chain-evidence` 的 SBOM 分支；另跑 `test:sbom` |
| 安全扫描 | `security-scan.json` | `schemaVersion=god-agent-security-scan-v1`、同一 `candidateRef`、`status=passed`、`findings=[]`、`scannedFiles` 与索引一致 | `release-supply-chain-evidence` 安全分支及 `security` |
| 数据完整性 | `data-integrity.json` | `schemaVersion=god-agent-data-integrity-v1`、同一 `candidateRef`、`status=passed`、`stateDigestVerified=true`、`backupRestoreVerified=true`、`noDataLoss=true` | `release-supply-chain-evidence` 数据完整性分支 |

三个文件的 `path`、小写 64 位 `sha256` 和索引中的 `releaseArtifactSha256` 都必须指向同一候选。SBOM 许可证缺失需人工审查，不能猜测或用说明文字填充。

## 5. 验收命令与结果记录

在候选冻结的干净环境按顺序执行并保存命令、退出码、Node/npm、Windows 版本/架构和 UTC 时间：

```powershell
npm run check
npm run test:release
npm run test:security
npm run test:sbom
npm run release:check
```

`release-artifact-gate` 关键检查 ID 与提交字段的对应关系：

| 检查 ID | 依赖字段/文件 | 失败即 |
| --- | --- | --- |
| `manifest` | 总 manifest schema 和 `claimBoundary` | `BLOCKED` |
| `installer-digest` | 安装器普通文件 + `installerSha256` | `BLOCKED` |
| `signature` | 签名 receipt、Authenticode、时间戳、证书主体 | `BLOCKED` |
| `clean-machine` | 独立 `executorId`/`machineId` 与三项安装结果 | `BLOCKED` |
| `upgrade-rollback` | `testedFrom/To`、回滚和状态完整性 | `BLOCKED` |
| `long-stability` | `durationSeconds>=3600`、0 失败、恢复和摘要 | `BLOCKED` |
| `release-supply-chain-evidence` | SBOM、安全扫描、数据完整性索引与 SHA | `BLOCKED` |

上述本地检查全部通过后，仍需 `dependency-risk` 无官方 high/critical、Electron/Doctor 门禁通过，以及发布负责人签字；否则总体结论保持 `BLOCKED / NO-GO`。

## 6. 非作者复核与交付签字（跨门禁）

非作者复核不由 `release-artifact-gate` 解析，必须在论文/发布审阅包中单独提交：复核者身份、独立性声明、审阅轮次、Claim/证据定位、P0/P1 结论和签字时间，并绑定同一 `candidateRef`/源码 SHA。没有非作者签字，不能把发行物证据门禁 PASS 解释为最终批准。

## 7. 当前阻断与补证责任

截至本轮审计，仓库没有真实签名安装包、干净 Windows receipt、升级/回滚实机 receipt 或 3600 秒长稳原始证据；供应链索引和候选发行 manifest 也未形成真实候选。`release:check` 另受 3 个官方 high 风险和 README evidence drift 阻断。因此当前只能报告“本地结构测试通过、生产发行仍 BLOCKED”，不能创建虚假 receipt。补证时必须由外部责任人按本文件一次性提交完整候选包；任一字段或摘要不符即退回重做并生成新 `candidateRef`。
