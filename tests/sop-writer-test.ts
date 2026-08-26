import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { writeDistilledSop } from "../src/skills/sop-writer.js";

test("SOP Writer 生成安全 Markdown 并返回可访问路径", async () => {
  const root = await mkdtemp(join(tmpdir(), "god-agent-sop-test-"));
  try {
    const result = await writeDistilledSop(root, {
      name: "release-checklist",
      description: "发布前检查清单",
      instructions: "## 执行流程\n\n1. 运行测试。\n2. 检查产物。",
    });
    assert.equal(result.status, "created");
    assert.match(result.document.path, /release-checklist\.md$/u);
    const text = await readFile(result.document.path, "utf8");
    assert.match(text, /^# 发布前检查清单/u);
    assert.match(text, /## 安全边界/u);
    assert.match(text, /## 来源/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SOP Writer 同内容幂等，冲突自动使用后缀", async () => {
  const root = await mkdtemp(join(tmpdir(), "god-agent-sop-conflict-"));
  const draft = {
    name: "daily-report",
    description: "日报流程",
    instructions: "## 执行流程\n\n整理数据。",
  };
  try {
    const first = await writeDistilledSop(root, draft);
    const same = await writeDistilledSop(root, draft);
    const changed = await writeDistilledSop(root, { ...draft, instructions: "## 执行流程\n\n整理数据并复核。" });
    assert.equal(first.status, "created");
    assert.equal(same.status, "already_exists");
    assert.equal(changed.status, "created");
    assert.match(changed.document.name, /^daily-report-2$/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
