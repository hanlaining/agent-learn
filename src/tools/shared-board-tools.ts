import type { AgentRunStore } from "../agents/agent-run-store.js";
import type { AgentRuntimeStore } from "../agents/agent-runtime-store.js";
import { strictObjectSchema } from "../llm/tool-schema.js";
import type { AgentTool } from "./tool-registry.js";

export function createSharedBoardTools(runtime: AgentRuntimeStore, runs: AgentRunStore): AgentTool[] {
  const resolveRun = (turnId: string | undefined) => {
    if (turnId === undefined) throw new Error("Shared Board requires an active Agent Turn");
    const run = runs.getByTurn(turnId);
    if (run === undefined) throw new Error("Agent Run is unavailable");
    const job = runtime.getJob(run.jobId);
    if (job === undefined || !job.configSnapshot.shareBoard) throw new Error("Shared Board is disabled for this Job");
    return run;
  };
  return [{
    definition: { name: "read_shared_board", description: "读取当前 Job 已过滤的共享事实、来源、产物、测试和决策。", parameters: strictObjectSchema({}) },
    requiresPermission: false, riskLevel: "read",
    execute(_argumentsJson, context) {
      const run = resolveRun(context.turnId);
      const entries = runtime.listBoard(run.jobId).filter((item) => item.visibility === "job" || item.producerRunId === run.parentRunId);
      return { result: entries, modelOutput: entries };
    },
  }, {
    definition: { name: "publish_shared_result", description: "向当前 Job 共享经过过滤的事实、来源、产物、测试、决策或精炼摘要；禁止密钥、Token、Cookie、环境变量和隐藏推理。", parameters: strictObjectSchema({
      kind: { type: "string", enum: ["fact", "artifact", "source", "decision", "test_result", "file_claim", "warning", "summary"] },
      title: { type: "string", minLength: 1, maxLength: 200 }, summary: { type: "string", minLength: 1, maxLength: 4000 },
      confidence: { type: "string", enum: ["unverified", "supported", "confirmed"] }, visibility: { type: "string", enum: ["job", "parent_only"] },
    }) },
    requiresPermission: false, riskLevel: "read",
    execute(argumentsJson, context) {
      const run = resolveRun(context.turnId); const value = JSON.parse(argumentsJson) as unknown;
      if (!isBoardInput(value)) throw new Error("Invalid publish_shared_result arguments");
      const entry = runtime.publishBoard({ jobId: run.jobId, producerRunId: run.id, ...value });
      return { result: entry, modelOutput: entry };
    },
  }];
}

function isBoardInput(value: unknown): value is { kind: "fact" | "artifact" | "source" | "decision" | "test_result" | "file_claim" | "warning" | "summary"; title: string; summary: string; confidence: "unverified" | "supported" | "confirmed"; visibility: "job" | "parent_only" } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return ["fact", "artifact", "source", "decision", "test_result", "file_claim", "warning", "summary"].includes(String(item.kind)) &&
    typeof item.title === "string" && item.title.trim().length > 0 && typeof item.summary === "string" && item.summary.trim().length > 0 &&
    ["unverified", "supported", "confirmed"].includes(String(item.confidence)) && ["job", "parent_only"].includes(String(item.visibility));
}
