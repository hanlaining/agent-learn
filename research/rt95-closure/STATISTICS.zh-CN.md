# RT95 统计分析与 Raw QA v1

## 1. 目标与边界

该切片只做可确定复现的描述性统计。CLI 只能读取逐条 Raw JSON，不能接受人工填写的成功数、失败数、平均值或汇总率。

报告固定写入 `significanceClaimed=false`。Wilson 区间、零失败上界或配对效应都不构成“统计显著”“证明优于”或因果结论。

## 2. Raw 合同

输入根对象：

```json
{
  "schemaVersion": "rt95-raw-results-v1",
  "experimentId": "EXP-001",
  "baselineArmId": "ARM-BASELINE",
  "records": []
}
```

每条 record 必须且只能包含：

- `runId`：全局唯一；
- `armId`：实验 arm；
- `seed`：无符号 32 位整数；
- `faultWindowId`：冻结故障窗口；
- `outcome`：只允许 `success | failure`；
- `latencyMs`：有限、非负数。

Raw QA 要求至少一个 baseline 和一个 comparator。每个 arm 必须拥有完全相同的 `seed + faultWindowId` 配对集合；同一 arm 内同一 pair 只能出现一次。

以下情况 fail closed：

- 重复 `runId`；
- 缺少或多出 record 字段；
- 缺 arm、seed、window 或 outcome；
- baseline 不存在；
- 任一 arm 的 seed/fault 配对缺失或多出；
- 同一 arm/pair 重复；
- latency 为 `NaN`、无穷、负数或非数值。

## 3. 冻结统计定义

### 3.1 Wilson 双侧 95% 区间

固定 `z = 1.959963984540054`，使用 Wilson score interval。输出原始 successes、total、点估计、lower 和 upper。分母为 0 时拒绝，不输出伪造的 0 或 100%。

### 3.2 零失败 95% 上界

仅在 `failures=0` 时输出一侧精确上界：

```text
upper = 1 - 0.05^(1/n)
```

例如 4 次运行零失败，上界为 `0.527129195498`。这表示小样本仍允许较高真实失败率，不能用“观察到 0 失败”声称系统无失败。

### 3.3 绝对率差

```text
baseline success rate - comparator success rate
```

正数表示 baseline 的观测成功率较高，负数表示较低。它只是描述值。

### 3.4 配对二元效应

同一 `seed + faultWindowId` 的 baseline/comparator 形成一对。报告：

- 两者都成功；
- 仅 baseline 成功；
- 仅 comparator 成功；
- 两者都失败；
- 配对绝对率差 `(baselineOnly - comparatorOnly) / pairCount`；
- discordant odds ratio；分母为 0 时记 `null`，不记无穷。

不计算 p-value，不执行 McNemar 显著性声明。

### 3.5 确定性成对 Bootstrap 95% Percentile CI

对每个 `seed + faultWindowId` 配对先计算 `baseline success indicator - comparator success indicator`，再以 pair 为单位有放回重采样，不能拆散 pair：

- PRNG：`xorshift32-v1`；
- 默认 seed：`20260824`，禁止 0；
- 默认重复：`10000`，允许范围 100～1000000；
- 每次 replicate 抽取与原始 pair 数相同的 pair；
- 下界/上界：排序后 nearest-rank 2.5% / 97.5%；
- 输出固定 `descriptiveOnly=true`。

相同 Raw、seed 和 iterations 必须得到字节一致结果。该区间只是描述当前配对样本在冻结重采样规则下的不确定性，不是预注册显著性检验。

### 3.6 Rate Ratio 与零分母

`rate ratio = baseline success rate / comparator success rate`。

- comparator rate > 0：`status=finite`，输出有限 estimate；
- comparator rate = 0、baseline rate > 0：`status=positive-over-zero`，`estimate=null`；
- 两者都为 0：`status=undefined-both-zero`，`estimate=null`。

JSON 中禁止用 `Infinity`、任意大数或 0 代替不可定义比值。

### 3.7 Holm-Bonferroni

`holmBonferroni()` 对已预注册的 p-value family：按 raw p-value 升序、平局按 analysis ID 排序；乘以剩余比较数；使用 running maximum 保证单调；上限截断为 1；最终按 analysis ID 稳定排序。

空 family、重复 analysis ID、非有限或超出 `[0,1]` 的 p-value 均拒绝。Raw v1 不接受人工 p-value 字段，因此普通描述性 CLI 报告明确写 `applied=false`、`adjustedPValues=[]`。

### 3.8 从 Raw 到 Draft 确认性输出

`confirmatory-analysis-plan.draft.json` 固定：

- pair unit：`seed+faultWindowId`；
- 双侧 exact McNemar；
- discordant baseline-win probability 的 Wilson 95% 区间；
- 由该区间变换的 matched odds ratio 95% 区间；
- 三个预注册消融比较组成的 Holm family；
- alpha 0.05。

`analyzeConfirmatoryRaw()` 必须直接接收逐条 Raw 与 Draft plan，自动计算原始 p-value、Holm 校正值和区间；plan 不能携带人工 p-value，family 必须精确覆盖 Raw 的每个 comparator。输出固定：

- `claimBoundary=pipeline-validation-only-not-formal-result`；
- `formalVerified=false`；
- `significanceClaimed=false`；
- Raw/plan canonical SHA-256；
- `rejectedUnderDraftPlan` 只表示代码按 Draft 阈值执行的结果。

该入口证明确认性计算链存在，不证明 Draft 已冻结、Raw 真实、样本量充分、聚类处理正确或正式显著性成立。

### 3.8 Median 与 P95

- Median：升序排序；奇数取中间项，偶数取中间两项算术均值；
- P95：nearest-rank，取 `sorted[ceil(0.95*n)-1]`；
- 空数组、非有限值和负值均拒绝。

## 4. CLI

```powershell
npx tsx scripts/analyze-rt95-results.ts --input path/to/raw-results.json
```

可选写文件：

```powershell
npx tsx scripts/analyze-rt95-results.ts --input path/to/raw-results.json --output path/to/statistics-report.json
```

CLI 只接受 `--input` 和 `--output`。诸如 `--successes 99`、`--rate 1` 等人工汇总参数会被拒绝。输出不含当前时间，arm 和 pair 使用稳定排序，bootstrap 使用报告中固定 seed 和 iterations，因此同一 Raw 内容即使 record 顺序不同也产生字节一致报告。

## 5. 能证明与不能证明

通过该门禁能证明：Raw 字段完整、runId 唯一、实验 arm 配对闭合、输入数值合法、固定公式被确定计算。

不能证明：Raw 来源真实、Oracle 正确、实验没有选择性报告、预注册已冻结、样本量充分、窗口/seed 聚类已经解决、差异正式显著、机制具有因果优势、Research-95 或 E4 完成。Draft 确认性入口应用 Holm 只证明流水线行为；后续仍需 Artifact Manifest、Oracle、Frozen digest、独立 Reviewer 和正式样本量共同闭环。
