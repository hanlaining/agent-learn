import { RuntimeFailure } from "../observability/runtime-failure.js";
import { isStageResult, type StageResult } from "./stage-contract.js";

export function parseStageResult(text: string): StageResult {
  if (text.trim().length === 0) throw new RuntimeFailure("empty_model_output", "Stage returned empty model output", true);
  const normalized = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let value: unknown;
  try {
    value = JSON.parse(normalized);
  } catch {
    throw new RuntimeFailure("invalid_structured_output", "Stage output is not valid JSON", true);
  }
  if (!isStageResult(value)) throw new RuntimeFailure("stage_contract_failed", "Stage output does not satisfy stage-result.v1", true);
  return value;
}

export async function parseStageResultWithRepair(
  text: string,
  repair: (invalidOutput: string) => Promise<string>,
): Promise<{ result: StageResult; repaired: boolean }> {
  try {
    return { result: parseStageResult(text), repaired: false };
  } catch (error) {
    if (!(error instanceof RuntimeFailure) || !["invalid_structured_output", "stage_contract_failed", "empty_model_output"].includes(error.code)) throw error;
  }
  const repairedText = await repair(text);
  try {
    return { result: parseStageResult(repairedText), repaired: true };
  } catch {
    throw new RuntimeFailure("stage_contract_failed", "Stage output remained invalid after one tools=[] repair", true);
  }
}
