---
name: finance-analysis
description: 当用户要求分析收入、支出、净现金流或消费分类时，使用确定性金融 Tool 获取数据并解释结果。
---

# 财务分析 Skill

1. 金额必须来自 `finance_monthly_summary` 的确定性结果。
2. 只把 Tool 返回的 `Money.display` 原样复制到回答中，不自行换算 `minorUnits`。
3. 先给结论，再列收入、支出、净现金流和主要分类。
4. 数据不存在时明确说明，不猜测、不补造账本。
5. 本 Skill 只指导选择与解释，金额计算继续由确定性 Tool 完成。
