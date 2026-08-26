# Research Artifact Manifest v0.1

此入口只归档离线科研产物，不读取环境变量、凭据或真实 Provider。Manifest 必须位于 Artifact 根目录内，自身不会进入哈希列表；验证会拒绝缺失、篡改和任何未登记文件。

从仓库根目录创建：

```powershell
npx tsx research/reproducibility/src/cli.ts create --root research/example-artifact --baseline-commit e65767f960967a21ab2191503363e53280d4ba62 --command "npm run benchmark:gate30" --started-at 2026-08-20T01:00:00.000Z --finished-at 2026-08-20T01:05:00.000Z --provider deterministic-fake
```

验证：

```powershell
npx tsx research/reproducibility/src/cli.ts verify --root research/example-artifact
```

也可用 `--manifest metadata/artifact-manifest.json` 指定根目录内的相对 Manifest 路径。不要在 `--command` 中写绝对路径、环境变量赋值、Token、Key 或其他凭据。`--provider` 只接受 `none` 或 `deterministic-fake`，两者都明确声明没有真实 API 调用且没有读取凭据。

专项测试：

```powershell
npx tsx --test research/reproducibility/tests/manifest-test.ts
```

## 私有源到公开派生包

`src/publishable-sanitizer.ts` 使用显式 allowlist：

- 私有源可以保留 `helper-secret.bin`、凭据文件等受控原件；
- 公开包只复制白名单内、通过文件名与高置信内容检查的文件；
- receipt 只公开私有源整体 tree SHA-256、文件数和字节数，不披露被排除的私有路径；
- 每个公开文件必须与私有源同路径文件的 bytes/SHA-256/content type 完全一致；
- verifier 拒绝私有源漂移、公开文件篡改/删除/额外文件、receipt 摘要漂移、旧 receipt 重放和覆盖已有输出目录；
- `claimBoundary=sanitized-local-derivation-only-not-formal-or-external`，不表示已经发布、已完成隐私审查或能检测所有敏感模式。

该工具不会改写或猜测脱敏文件内容；需要发布的内容必须先由上游确定生成安全版本，再显式加入 allowlist。

## 版本化 Artifact Release

`src/artifact-release.ts` 在普通文件 Manifest 与公开派生 receipt 之上组合一个严格的版本化发布层。每个 Release 必须同时包含且逐字节绑定：

- 源码快照、预注册、数据字典；
- 私有 Raw 整体摘要对应的公开派生 receipt，以及 receipt 登记的公开统计与表格；
- Artifact Manifest、License、Claim Table；
- 至少一个 Claim Table 中真实存在且状态为 `CodeVerified` 的 Claim。

当前实现固定使用 `claimBoundary=local-tooling-only-not-formal-or-external`，并固定保留：预注册 `Draft`、formal Raw `NotIncluded`、formal 实验 `NotRun`、外部复现 `NotVerified`、论文审查 `NotReviewed`。任何把这些状态改为已完成的 Manifest 都会被拒绝。

Creator/Verifier 还会拒绝：输出覆盖或重放、缺失和 extra 文件、摘要或 receipt 漂移、绝对路径和机器路径、高置信 secret、非递增版本或低于调用方最低版本的回退、Claim 越界、未审查/伪造独立审查状态。

本仓库示例：`research/artifact-releases/local-tooling-v0.1.0/release/`。其存在只证明本地工具链可以生成并复验一个边界明确的 Release，不代表 Draft 已冻结、formal Raw 存在、实验已运行或完成外部复现/同行审查。
