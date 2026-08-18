import { OpenAiResponsesProvider } from "../src/llm/openai-responses.js";
import { classifyRuntimeFailure } from "../src/observability/runtime-failure.js";
import { parseStageResultWithRepair } from "../src/execution/stage-result-parser.js";
import { STAGE_RESULT_CONTRACT_VERSION, type StageResult } from "../src/execution/stage-contract.js";

const TASKS = [
  "Create a concise documentation-only release checklist.",
  "Design a small FAQ information architecture with acceptance criteria.",
  "Specify an accessible single-page empty state and loading state.",
  "Specify a responsive settings panel with keyboard acceptance checks.",
  "Add a small validation feature to an existing TypeScript module.",
  "Add a deterministic export action with unit-test acceptance criteria.",
  "Define error, empty, loading, and success states for a search page.",
  "Define retry and cancellation behavior for a background operation.",
  "Resolve a request that asks for both no persistence and durable history.",
  "Resolve a request that asks for read-only behavior and file modification.",
] as const;

const CONTRACT = `Return only JSON: {"status":"completed|failed|blocked","summary":"...","deliverables":["..."],"evidence":["..."],"blockers":[],"nextStageRecommendation":"continue|retry|block|complete","contractVersion":"${STAGE_RESULT_CONTRACT_VERSION}"}`;
const stages = ["product", "engineering", "quality", "lead"] as const;

interface JobResult {
  taskIndex: number;
  completed: boolean;
  modelCalls: number;
  formatRepairs: number;
  failedStage?: string;
  failureCode?: string;
}

const args = new Set(process.argv.slice(2));
const smoke = args.has("--smoke");
const authorizedThirty = args.has("--authorized-30");
if (!smoke && !authorizedThirty) {
  console.log(JSON.stringify({ status: "ready", liveCalls: 0, message: "Use --smoke for at most 2 paid Jobs. The 30-Job baseline requires --authorized-30." }));
  process.exit(0);
}

const key = process.env.OPENAI_API_KEY;
if (key === undefined || key.trim().length === 0) {
  console.log(JSON.stringify({ status: "skipped", liveCalls: 0, reason: "No safely configured model key was detected." }));
  process.exit(0);
}

const jobCount = authorizedThirty ? 30 : 2;
const configuredBaseUrl = process.env.OPENAI_BASE_URL;
const provider = new OpenAiResponsesProvider({
  apiKey: key,
  model: "gpt-5.6-sol",
  reasoningEffort: "high",
  maxRetries: 1,
  ...(configuredBaseUrl === undefined ? {} : { baseUrl: configuredBaseUrl }),
});
const results: JobResult[] = [];
for (let index = 0; index < jobCount; index += 1) {
  results.push(await runJob(provider, TASKS[index % TASKS.length]!, index));
}

const completed = results.filter((item) => item.completed).length;
const perStageFailures = Object.fromEntries(stages.map((stage) => [stage, results.filter((item) => item.failedStage === stage).length]));
console.log(JSON.stringify({
  status: "completed",
  jobs: jobCount,
  completed,
  chainSuccessRate: completed / jobCount,
  modelCalls: results.reduce((total, item) => total + item.modelCalls, 0),
  formatRepairs: results.reduce((total, item) => total + item.formatRepairs, 0),
  perStageFailures,
  failuresByCode: Object.fromEntries([...new Set(results.flatMap((item) => item.failureCode ?? []))]
    .map((code) => [code, results.filter((item) => item.failureCode === code).length])),
}));

async function runJob(provider: OpenAiResponsesProvider, task: string, taskIndex: number): Promise<JobResult> {
  let previous: StageResult | undefined; let modelCalls = 0; let formatRepairs = 0;
  for (const stage of stages) {
    try {
      modelCalls += 1;
      const first = await provider.createResponse({ instructions: stageInstructions(stage), input: buildInput(stage, task, previous), tools: [], allowHostedTools: false });
      const parsed = await parseStageResultWithRepair(first.text, async (invalid) => {
        formatRepairs += 1; modelCalls += 1;
        const repair = await provider.createResponse({ instructions: "Repair JSON format only; do not change the business conclusion.", input: `${CONTRACT}\n\n${invalid}`, tools: [], allowHostedTools: false });
        return repair.text;
      });
      previous = parsed.result;
      if (previous.status !== "completed" || previous.blockers.length > 0 || previous.evidence.length === 0) {
        return { taskIndex, completed: false, modelCalls, formatRepairs, failedStage: stage, failureCode: "stage_contract_failed" };
      }
    } catch (error) {
      return { taskIndex, completed: false, modelCalls, formatRepairs, failedStage: stage, failureCode: classifyRuntimeFailure(error) };
    }
  }
  return { taskIndex, completed: true, modelCalls, formatRepairs };
}

function stageInstructions(stage: typeof stages[number]): string {
  return `You are the ${stage} stage in a bounded software-product-delivery workflow. Do not call tools. ${CONTRACT}`;
}

function buildInput(stage: typeof stages[number], task: string, previous: StageResult | undefined): string {
  return `Confirmed task: ${task}\nCurrent stage: ${stage}\nPrior accepted result: ${previous === undefined ? "none" : JSON.stringify(previous)}`;
}
