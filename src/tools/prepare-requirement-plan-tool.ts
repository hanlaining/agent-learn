import type { LifecycleStore } from "../runtime/lifecycle-store.js";
import type { RequirementDraft, RequirementTestCase } from "../requirements/requirement.js";
import { RequirementStore } from "../requirements/requirement-store.js";
import { RequirementPlanWriter } from "../requirements/requirement-plan-writer.js";
import type { AgentTool } from "./tool-registry.js";

export function createPrepareRequirementPlanTool(options: {
  lifecycleStore: LifecycleStore;
  requirementStore: RequirementStore;
  writer: RequirementPlanWriter;
  persist?: () => void | Promise<void>;
}): AgentTool {
  return {
    definition: {
      name: "prepare_requirement_plan",
      description: "Save one consolidated requirement revision, its acceptance tests, and a Markdown execution plan. This prepares a plan only and never confirms or executes it.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["title", "objective", "scope", "nonGoals", "constraints", "deliverables", "acceptanceCriteria", "testCases", "executionSteps"],
        properties: {
          title: { type: "string" }, objective: { type: "string" },
          scope: stringArray(), nonGoals: stringArray(), constraints: stringArray(),
          deliverables: stringArray(), acceptanceCriteria: stringArray(), executionSteps: stringArray(),
          testCases: {
            type: "array",
            items: {
              type: "object", additionalProperties: false,
              required: ["id", "title", "kind", "steps", "expected"],
              properties: {
                id: { type: "string" }, title: { type: "string" },
                kind: { type: "string", enum: ["positive", "negative", "permission", "recovery", "ui", "integration"] },
                steps: stringArray(), expected: { type: "string" },
              },
            },
          },
        },
      },
    },
    requiresPermission: false,
    riskLevel: "read",
    async execute(argumentsJson, context) {
      if (context.turnId === undefined) throw new Error("Requirement planning requires a parent Turn");
      const turn = options.lifecycleStore.getTurn(context.turnId);
      if (turn === undefined) throw new Error("Requirement planning Turn is unavailable");
      if (options.lifecycleStore.getThread(turn.threadId)?.kind === "agent_internal") {
        throw new Error("Only the parent Chat can prepare a requirement plan");
      }
      const draft = parseDraft(argumentsJson);
      const identity = options.requirementStore.nextPlanIdentity(turn.threadId);
      const artifact = await options.writer.write({ ...identity, draft });
      const requirement = options.requirementStore.prepare(turn.threadId, draft, artifact);
      await options.persist?.();
      return {
        result: requirement,
        modelOutput: {
          status: "awaiting_user_confirmation",
          requirementId: requirement.id,
          revision: requirement.revision,
          planPath: artifact.path,
          contentHash: artifact.contentHash,
          testCaseCount: requirement.testCases.length,
          message: "计划已保存。等待用户通过确认按钮确认该版本后再执行。",
        },
      };
    },
  };
}

function parseDraft(text: string): RequirementDraft {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("Invalid requirement plan arguments"); }
  if (!isRecord(value)) throw new Error("Invalid requirement plan arguments");
  const stringFields = ["title", "objective"] as const;
  for (const field of stringFields) if (typeof value[field] !== "string" || value[field].trim().length === 0) throw new Error(`Requirement ${field} is required`);
  const arrayFields = ["scope", "nonGoals", "constraints", "deliverables", "acceptanceCriteria", "executionSteps"] as const;
  for (const field of arrayFields) if (!isStringArray(value[field])) throw new Error(`Requirement ${field} must be a string array`);
  if (!Array.isArray(value.testCases) || value.testCases.length === 0 || !value.testCases.every(isTestCase)) throw new Error("Requirement testCases are required");
  return structuredClone(value) as unknown as RequirementDraft;
}

function stringArray(): Record<string, unknown> { return { type: "array", items: { type: "string" } }; }
function isStringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every((item) => typeof item === "string"); }
function isTestCase(value: unknown): value is RequirementTestCase {
  return isRecord(value) && typeof value.id === "string" && typeof value.title === "string" &&
    ["positive", "negative", "permission", "recovery", "ui", "integration"].includes(String(value.kind)) &&
    isStringArray(value.steps) && typeof value.expected === "string";
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
