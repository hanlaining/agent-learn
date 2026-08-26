# RT95 论文结果流水线

本目录把合规的 `rt95-statistics-report-v1` 机器报告转换为可嵌入论文的 Markdown 和 CSV 表格，并集中记录允许与禁止的论文主张。它不直接接收成功数、成功率、P95 或 p-value，避免人工数字绕开 Raw 分析链。

## 一键生成

先从 Raw 生成统计报告，再从该报告生成论文表格：

```powershell
npx --no-install tsx scripts/analyze-rt95-results.ts --input research/rt95-closure/<raw-results.json> --output research/rt95-closure/<statistics-report.json>
npx --no-install tsx scripts/render-rt95-paper-tables.ts --input research/rt95-closure/<statistics-report.json> --output-dir research/paper/generated/<experiment-id>
```

第二条命令固定写出：

- `results.md`：arm 与配对比较的论文可读表；
- `arms.csv`：成功数、失败数、样本数、成功率、Wilson 95% CI、零失败上界、延迟 median/P95；
- `comparisons.csv`：绝对率差、率比及状态、配对计数、配对率差和固定 seed bootstrap 区间。

输出不含当前时间，arm 和 comparison 按机器 ID 稳定排序；同一合规报告会产生字节一致的三个文件。

## 输入与失败关闭

生成器只接受：

```text
--input <statistics-report.json> --output-dir <workspace-relative-directory>
```

未知参数（包括人工 `--successes`、`--rate`、`--p95`）会被拒绝。生成前会检查完整嵌套 schema、固定方法常量、`methodology.significanceClaimed=false`、`multiplicity.significanceClaimed=false`、有限数值、arm/Raw QA/comparison 的交叉一致性和全量比较覆盖。输入或输出通过 `..`、绝对路径或符号链接离开工作区时失败。

当前校验器与 `statistics.schema.json` 的 v1 合同绑定。统计报告升级 schema 时必须同步评审生成器，不能静默兼容未知字段。

## 验证

```powershell
npx --no-install tsx --test tests/rt95-paper-tables-test.ts
npx --no-install tsc --noEmit
```

专项测试覆盖确定性、固定输出、错误 schema、额外字段、显著性声明、NaN/Infinity、内部数字不一致、人工数字参数和路径逃逸。仓库类型检查必须同时通过，才能把流水线标记为本地代码验证通过。

## 论文边界

- [MANUSCRIPT-DRAFT.zh-CN.md](./MANUSCRIPT-DRAFT.zh-CN.md) 是 IMRaD 结构草案；所有没有正式 Raw 支持的结果保持 `TODO/NotVerified`。
- [CLAIM-TABLE.json](./CLAIM-TABLE.json) 是机器可读的 allowed/forbidden claim 清单。
- 逐 Claim 事实核验、Artifact/图表一致性和非作者审阅的执行包见 [PAPER-CLAIM-AUDIT-PACK.zh-CN.md](../../docs/reviews/PAPER-CLAIM-AUDIT-PACK.zh-CN.md)。记录模板见 [CLAIM-AUDIT-RECORD.template.json](./CLAIM-AUDIT-RECORD.template.json)，机器校验合同见 [CLAIM-AUDIT-RECORD.schema.json](./CLAIM-AUDIT-RECORD.schema.json)。
- 非作者审阅交接、签字真实性声明和 R0/R1/R2 退出条件见 [PAPER-NONAUTHOR-HANDOFF-CHECKLIST.zh-CN.md](../../docs/reviews/PAPER-NONAUTHOR-HANDOFF-CHECKLIST.zh-CN.md)。
- 逐 Claim 文件收齐后，使用 [PAPER-AUDIT-INDEX.template.json](./PAPER-AUDIT-INDEX.template.json) 建立候选级总账；总账只引用记录文件，不复制结果数字。每个 `recordPath` 必须是仓库相对路径，并且所有记录的 candidate、预注册和 evidence bundle digest 必须一致。
- 论文 90+ 的阶段门、评分口径和 Claim→Evidence→Artifact→Locator→Reviewer→Status 总账见 [PAPER-READINESS-90-EXECUTION-PLAN.zh-CN.md](../../docs/reviews/PAPER-READINESS-90-EXECUTION-PLAN.zh-CN.md)；非作者审阅填写 [PAPER-NONAUTHOR-REVIEW-TEMPLATE.zh-CN.md](../../docs/reviews/PAPER-NONAUTHOR-REVIEW-TEMPLATE.zh-CN.md)。这两份材料只记录执行要求，不会把缺失证据升级为 `Verified`。
- 生成表中的 bootstrap CI 是描述性区间，`significanceClaimed=false`；不得表述为显著性或因果证据。
- 本地代码测试不证明 Raw 真实性、Oracle 正确、预注册冻结、外部复现或论文可投稿。
- 负结果、零差异、方向相反、失败运行和按冻结规则排除的记录必须保留，不得选择性报告。

## 推荐执行顺序（证据到位后的最短闭环）

1. 锁定候选：记录 source、Frozen preregistration 和 evidence bundle 的 SHA-256；候选变更必须新建目录，不覆盖旧记录。
2. 复制 Claim Table：摘要、结果、讨论和结论中的每个事实句都映射到唯一 Claim ID，并写明章节、行或表格单元格。
3. 收集证据：按 Claim 的 `requiredEvidence` 收齐正式 Raw、Oracle、统计报告、图表、外部 baseline、独立执行日志和一手引用；每项保留路径、SHA、生成命令和采样时间。
4. 生成单 Claim 记录：从 `CLAIM-AUDIT-RECORD.template.json` 复制为候选目录下的实际记录，并按 `CLAIM-AUDIT-RECORD.schema.json` 校验；缺一项就保持 `NotVerified`。
5. 运行重建：从同一 Raw digest 重新生成 Markdown/CSV/图表，填写 Artifact/figure locator 和一致性结果，禁止手工改数字。
6. 非作者审阅：按 R0（盘点）、R1（方法/统计）、R2（引用/伦理/全文）顺序填写审阅模板；P0/P1 必须有处置和复验，不得用新 Reviewer ID 代替真人审阅。
7. 更新候选总账：将所有实际记录路径写入 `PAPER-AUDIT-INDEX`，核对 digest、一致性、P0/P1 和作者批准状态。
8. 请求复评：仅在所有结果 Claim 为 `Verified`（或已从结论中删除并明确 `NotVerified`）、P0/P1=0、R2=`Accepted`、作者批准且四项外部门均通过时，提交论文 90+ 复评。

### 状态升级规则

`NotVerified → Collected → Reviewed → Verified` 只能按证据和审阅顺序升级；`CodeVerified` 只表示本地工具合同通过，不能直接升级为 `Verified`。任何候选、Raw、Artifact 或引用漂移都将状态回退至 `NotVerified`，并在总账中记录新的 Issue ID。
