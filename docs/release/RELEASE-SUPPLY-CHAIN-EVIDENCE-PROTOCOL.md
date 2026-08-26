# 发行供应链与数据完整性证据协议

该协议补齐 `release-artifact.json` 之外的三类候选级证据：SBOM、安全扫描、数据完整性。它们必须绑定同一个 `candidateRef`，并通过 `scripts/release-readiness.ts` 的 fail-closed 检查。缺文件、摘要漂移、路径越界、候选漂移、扫描发现或数据完整性任一失败，均保持 `BLOCKED`。

完整的候选提交目录、四类发行 receipt（签名、干净 Windows、升级/回滚、3600 秒长稳）字段和验收 ID 对照，见 [`RELEASE-EXTERNAL-EVIDENCE-SUBMISSION-PACKET.zh-CN.md`](RELEASE-EXTERNAL-EVIDENCE-SUBMISSION-PACKET.zh-CN.md)。本文件只补充供应链三类 receipt，不替代真实安装、签名或独立机器证据。

## 证据文件

在真实构建/验收流水线中生成以下普通文件（不得提交密钥、绝对路径或符号链接）：

- `dist/release/god-agent.cdx.json`：CycloneDX 1.5 SBOM，记录组件数量。
- `dist/release/security-scan.json`：`god-agent-security-scan-v1`，记录候选引用、扫描文件数和 findings；发行候选要求 `status=passed` 且 findings 为空。
- `dist/release/data-integrity.json`：`god-agent-data-integrity-v1`，记录状态摘要校验、备份/恢复和无数据丢失结论，三项必须为 `true`。
- `dist/release/release-supply-chain.json`：索引文件，记录上述三个文件的 SHA-256、字段和同一 `candidateRef`。

索引文件的固定格式：

```json
{
  "schemaVersion": "god-agent-release-supply-chain-v1",
  "candidateRef": "<与 release-artifact.json 相同>",
  "createdAt": "<ISO-8601>",
  "releaseArtifactSha256": "<release-artifact.json 的 64 位小写 SHA-256>",
  "sbom": {
    "path": "dist/release/god-agent.cdx.json",
    "sha256": "<64 位小写十六进制>",
    "format": "CycloneDX",
    "specVersion": "1.5",
    "componentCount": 0
  },
  "securityScan": {
    "path": "dist/release/security-scan.json",
    "sha256": "<64 位小写十六进制>",
    "status": "passed",
    "scannedFiles": 0,
    "findingCount": 0
  },
  "dataIntegrity": {
    "path": "dist/release/data-integrity.json",
    "sha256": "<64 位小写十六进制>",
    "status": "passed",
    "stateDigestVerified": true,
    "backupRestoreVerified": true,
    "noDataLoss": true
  },
  "claimBoundary": "supply-chain-evidence-only-not-production-approval"
}
```

## 验收顺序

1. 冻结候选 SHA、版本、Node/npm、Windows 架构和执行者；生成安装包、`release-artifact.json` 与本协议的三类证据。
2. 运行 `npm run sbom:generate`，将输出复制为候选 SBOM，并记录 SHA-256、组件数和许可证缺失数。
3. 运行 `npm run security:scan`，将原始结果转换为候选绑定的 `security-scan.json`；任何 finding 都不能通过。
4. 在真实候选上完成运行状态摘要、备份/恢复、升级失败回滚和无数据丢失演练，生成 `data-integrity.json`。
5. 生成索引文件后运行：

   ```powershell
   npm run check
   npm run test:release
   npm run test:security
   npm run test:sbom
   npm run release:check
   ```

6. 失败后不得编辑旧候选的结果来“修绿”；修复必须生成新的 `candidateRef`、重新计算 `releaseArtifactSha256` 及全部摘要并重跑全套门禁。

## 通过标准与边界

- `release-supply-chain-evidence` 必须为 `PASS`，且 `release-artifact-evidence`、依赖风险、安全扫描、SBOM、Electron、Doctor 等其他门禁同时通过。
- 该检查只证明文件存在、格式、摘要和候选绑定正确，不执行签名、不安装 Windows、不调用 Provider，也不替代独立机器审阅。
- 缺少真实签名安装包、干净 Windows、升级/回滚、长稳或官方依赖风险处置时，整体仍是 `BLOCKED / NO-GO`。
