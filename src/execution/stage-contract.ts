export const STAGE_RESULT_CONTRACT_VERSION = "stage-result.v1" as const;

export type StageResultStatus = "completed" | "failed" | "blocked";
export type NextStageRecommendation = "continue" | "retry" | "block" | "complete";

export interface StageResult {
  status: StageResultStatus;
  summary: string;
  deliverables: string[];
  evidence: string[];
  blockers: string[];
  nextStageRecommendation: NextStageRecommendation;
  contractVersion: typeof STAGE_RESULT_CONTRACT_VERSION;
}

export function isStageResult(value: unknown): value is StageResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const expected = ["status", "summary", "deliverables", "evidence", "blockers", "nextStageRecommendation", "contractVersion"];
  if (Object.keys(record).length !== expected.length || !expected.every((key) => key in record)) return false;
  return ["completed", "failed", "blocked"].includes(String(record.status)) &&
    typeof record.summary === "string" && record.summary.trim().length > 0 &&
    isStringArray(record.deliverables) && isStringArray(record.evidence) && isStringArray(record.blockers) &&
    ["continue", "retry", "block", "complete"].includes(String(record.nextStageRecommendation)) &&
    record.contractVersion === STAGE_RESULT_CONTRACT_VERSION;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
