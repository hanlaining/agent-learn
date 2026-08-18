import type { RuntimeFailureCode } from "./runtime-failure.js";

export interface RuntimeStageMetric {
  jobId: string;
  jobAttempt: number;
  workflowVersion: string;
  stageId: string;
  stageAttempt: number;
  model?: string;
  reasoningEffort?: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  modelCalls: number;
  toolCalls: number;
  retries: number;
  primaryFailureCode?: RuntimeFailureCode;
  terminalStates?: Partial<Record<"job" | "requirement" | "task" | "agentRun" | "return", string>>;
}

const SENSITIVE_KEY = /(api.?key|token|cookie|secret|password|authorization|environment|reasoning|chain.?of.?thought|file.?content)/i;

export function sanitizeRuntimeDiagnostic(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeRuntimeDiagnostic);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !SENSITIVE_KEY.test(key))
      .map(([key, item]) => [key, sanitizeRuntimeDiagnostic(item)]));
  }
  if (typeof value !== "string") return value;
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "[REDACTED]")
    .replace(/\b(sk|key|token)-[A-Za-z0-9_-]{8,}\b/gi, "[REDACTED]");
}

export class RuntimeMetricsLedger {
  private readonly metrics = new Map<string, RuntimeStageMetric>();

  constructor(private readonly onChange?: (metric: RuntimeStageMetric) => void) {}

  start(metric: Omit<RuntimeStageMetric, "startedAt" | "modelCalls" | "toolCalls" | "retries">): RuntimeStageMetric {
    const key = metricKey(metric);
    const existing = this.metrics.get(key);
    if (existing !== undefined) return structuredClone(existing);
    const created: RuntimeStageMetric = {
      ...metric, startedAt: new Date().toISOString(), modelCalls: 0, toolCalls: 0, retries: Math.max(0, metric.stageAttempt - 1),
    };
    this.metrics.set(key, created);
    this.onChange?.(structuredClone(created));
    return structuredClone(created);
  }

  increment(keyParts: Pick<RuntimeStageMetric, "jobId" | "jobAttempt" | "workflowVersion" | "stageId" | "stageAttempt">, field: "modelCalls" | "toolCalls"): void {
    const metric = this.metrics.get(metricKey(keyParts));
    if (metric !== undefined) { metric[field] += 1; this.onChange?.(structuredClone(metric)); }
  }

  finish(keyParts: Pick<RuntimeStageMetric, "jobId" | "jobAttempt" | "workflowVersion" | "stageId" | "stageAttempt">, update: Partial<Pick<RuntimeStageMetric, "primaryFailureCode" | "terminalStates">> = {}): RuntimeStageMetric | undefined {
    const metric = this.metrics.get(metricKey(keyParts));
    if (metric === undefined) return undefined;
    metric.endedAt = new Date().toISOString();
    metric.durationMs = Math.max(0, Date.parse(metric.endedAt) - Date.parse(metric.startedAt));
    Object.assign(metric, update);
    this.onChange?.(structuredClone(metric));
    return structuredClone(metric);
  }

  list(jobId?: string): RuntimeStageMetric[] {
    return [...this.metrics.values()].filter((item) => jobId === undefined || item.jobId === jobId).map((item) => structuredClone(item));
  }

  serialize(jobId?: string): string {
    return JSON.stringify(sanitizeRuntimeDiagnostic(this.list(jobId)));
  }
}

function metricKey(value: Pick<RuntimeStageMetric, "jobId" | "jobAttempt" | "workflowVersion" | "stageId" | "stageAttempt">): string {
  return [value.jobId, value.jobAttempt, value.workflowVersion, value.stageId, value.stageAttempt].join(":");
}
