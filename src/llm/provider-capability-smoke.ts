import { randomUUID } from "node:crypto";

export type CapabilitySupport =
  | "supported"
  | "unsupported"
  | "unknown"
  | "not-wired";

export interface ProviderCapabilityMatrixEntry {
  provider: string;
  protocol: string;
  idempotencyKey: CapabilitySupport;
  requestStatusQuery: CapabilitySupport;
  cancellation: CapabilitySupport;
  retrySemantics: string;
  clientBehavior: string;
  exactlyOnceClaim: "not-claimed";
  evidence: string;
}

/**
 * 这张表只记录仓库中已经可以被源码或 fixture 证明的事实。
 * unknown/not-wired 是有意保留的结果，不能被 WAL、Abort 或一次成功响应替换成 exactly-once。
 */
export const PROVIDER_CAPABILITY_MATRIX: readonly ProviderCapabilityMatrixEntry[] = [
  {
    provider: "openai-responses",
    protocol: "OpenAI Responses HTTP",
    idempotencyKey: "not-wired",
    requestStatusQuery: "not-wired",
    cancellation: "not-wired",
    retrySemantics: "客户端对网络错误和 408/409/429/5xx 做有上限指数退避；不保证 Provider 端去重。",
    clientBehavior: "OpenAiResponsesProvider 使用 AbortSignal 取消本地 fetch，并默认最多重试 2 次。",
    exactlyOnceClaim: "not-claimed",
    evidence: "src/llm/openai-responses.ts 只发送 POST /responses，未发送 Idempotency-Key，也未实现 GET 状态或 Provider 取消端点。",
  },
  {
    provider: "openai-compatible",
    protocol: "OpenAI-compatible HTTP gateway",
    idempotencyKey: "unknown",
    requestStatusQuery: "unknown",
    cancellation: "unknown",
    retrySemantics: "需按具体网关文档确认；本项目只能安全地执行受上限约束的客户端重试。",
    clientBehavior: "复用 OpenAI Responses 适配器时，行为与 openai-responses 相同；网关差异不会被推断。",
    exactlyOnceClaim: "not-claimed",
    evidence: "兼容网关不是一个统一 Provider；没有针对具体 base URL 的协议证据时保持 unknown。",
  },
] as const;

export type ProviderSmokeMode = "offline" | "live";
export type ProviderSmokeOperation = "create" | "status" | "cancel" | "retry";

export interface ProviderSmokeConfig {
  mode: ProviderSmokeMode;
  /** 由环境变量 PROVIDER_SMOKE_LIVE=1 产生；手工构造 live 配置不能绕过此闸门。 */
  explicitLiveSwitch?: boolean;
  provider: string;
  model: string;
  modelAllowlist: readonly string[];
  apiKey?: string;
  baseUrl?: string;
  maxRequestCostUsd?: number;
  maxTotalCostUsd?: number;
  maxRequests: number;
  timeoutMs: number;
  operations: readonly ProviderSmokeOperation[];
  operationsExplicit?: boolean;
}

export interface ProviderSmokeRequest {
  url: string;
  init: RequestInit;
  estimatedCostUsd: number;
  operation: ProviderSmokeOperation;
}

export interface ProviderSmokeTransport {
  request(request: ProviderSmokeRequest): Promise<Response>;
}

export interface ProviderSmokeObservation {
  operation: ProviderSmokeOperation;
  requestCount: number;
  status: number;
  responseId?: string;
  retryable?: boolean;
  note: string;
}

export interface ProviderSmokeReport {
  generatedAt: string;
  mode: ProviderSmokeMode;
  provider: string;
  model: string;
  status: "completed" | "skipped" | "blocked" | "failed";
  liveCalls: number;
  requests: number;
  estimatedCostUsd: number;
  observations: readonly ProviderSmokeObservation[];
  matrix: ProviderCapabilityMatrixEntry;
  capabilityMatrix: readonly ProviderCapabilityMatrixEntry[];
  logs: readonly string[];
  reason?: string;
}

export interface RunProviderSmokeOptions {
  config: ProviderSmokeConfig;
  transport?: ProviderSmokeTransport;
  now?: () => Date;
}

const DEFAULT_PROVIDER = "openai-responses";
const DEFAULT_MODEL = "gpt-5.6-sol";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_OFFLINE_MAX_REQUESTS = 8;
const DEFAULT_OFFLINE_OPERATIONS: readonly ProviderSmokeOperation[] = [
  "create",
  "status",
  "cancel",
  "retry",
];

export function loadProviderSmokeConfig(
  env: NodeJS.ProcessEnv = process.env,
): ProviderSmokeConfig {
  const live = env.PROVIDER_SMOKE_LIVE === "1";
  const model = env.PROVIDER_SMOKE_MODEL ?? env.OPENAI_MODEL ?? DEFAULT_MODEL;
  // 离线模式连凭据都不读取；只有显式 live switch 才把 Key 引入进程内存。
  const apiKey = live
    ? env.PROVIDER_SMOKE_API_KEY ?? env.OPENAI_API_KEY
    : undefined;
  const baseUrl = env.PROVIDER_SMOKE_BASE_URL ?? env.OPENAI_BASE_URL;
  const maxRequestCostUsd = parseNumber(env.PROVIDER_SMOKE_MAX_REQUEST_COST_USD);
  const maxTotalCostUsd = parseNumber(env.PROVIDER_SMOKE_MAX_TOTAL_COST_USD);
  const allowlist = (env.PROVIDER_SMOKE_MODEL_ALLOWLIST ?? (live ? "" : model))
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  const operations = parseOperations(
    env.PROVIDER_SMOKE_OPERATIONS,
    live ? [] : DEFAULT_OFFLINE_OPERATIONS,
  );

  return {
    mode: live ? "live" : "offline",
    explicitLiveSwitch: live,
    provider: env.PROVIDER_SMOKE_PROVIDER ?? DEFAULT_PROVIDER,
    model,
    modelAllowlist: allowlist,
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(maxRequestCostUsd === undefined ? {} : { maxRequestCostUsd }),
    ...(maxTotalCostUsd === undefined ? {} : { maxTotalCostUsd }),
    maxRequests:
      parseInteger(env.PROVIDER_SMOKE_MAX_REQUESTS) ??
      (live ? 0 : DEFAULT_OFFLINE_MAX_REQUESTS),
    timeoutMs:
      parseInteger(env.PROVIDER_SMOKE_TIMEOUT_MS) ??
      (live ? 0 : DEFAULT_TIMEOUT_MS),
    operations,
    operationsExplicit: env.PROVIDER_SMOKE_OPERATIONS !== undefined,
  };
}

export function validateLiveProviderSmokeConfig(
  config: ProviderSmokeConfig,
): string[] {
  if (config.mode !== "live") return [];
  const errors: string[] = [];
  if (config.explicitLiveSwitch !== true) {
    errors.push("missing explicit live switch (PROVIDER_SMOKE_LIVE=1)");
  }
  if (config.apiKey === undefined || config.apiKey.trim().length === 0) {
    errors.push("missing API credential (PROVIDER_SMOKE_API_KEY or provider key)");
  }
  if (config.modelAllowlist.length === 0) {
    errors.push("missing model allowlist (PROVIDER_SMOKE_MODEL_ALLOWLIST)");
  } else if (!config.modelAllowlist.includes(config.model)) {
    errors.push("selected model is not in the model allowlist");
  }
  if (!Number.isInteger(config.maxRequests) || config.maxRequests <= 0) {
    errors.push("missing positive max requests (PROVIDER_SMOKE_MAX_REQUESTS)");
  }
  if (config.operations.length === 0) {
    errors.push("missing explicit operations (PROVIDER_SMOKE_OPERATIONS)");
  } else if (config.operationsExplicit !== true) {
    errors.push("operations must be explicitly configured (PROVIDER_SMOKE_OPERATIONS)");
  } else if (config.operations.length > config.maxRequests) {
    errors.push("max requests is lower than requested operations");
  }
  const requiredAttempts = config.operations.length + (config.operations.includes("retry") ? 1 : 0);
  if (config.maxRequests > 0 && config.maxRequests < requiredAttempts) {
    errors.push("max requests is lower than retry worst-case attempts");
  }
  if (
    (config.operations.includes("status") || config.operations.includes("cancel")) &&
    !config.operations.includes("create")
  ) {
    errors.push("status/cancel probes require a preceding create operation");
  } else {
    const createIndex = config.operations.indexOf("create");
    for (const operation of ["status", "cancel"] as const) {
      const operationIndex = config.operations.indexOf(operation);
      if (operationIndex >= 0 && operationIndex < createIndex) {
        errors.push(`${operation} probe must follow create operation`);
      }
    }
  }
  if (config.maxRequestCostUsd === undefined || config.maxRequestCostUsd <= 0) {
    errors.push("missing positive per-request budget (PROVIDER_SMOKE_MAX_REQUEST_COST_USD)");
  }
  if (config.maxTotalCostUsd === undefined || config.maxTotalCostUsd <= 0) {
    errors.push("missing positive total budget (PROVIDER_SMOKE_MAX_TOTAL_COST_USD)");
  }
  if (
    config.maxRequestCostUsd !== undefined &&
    config.maxTotalCostUsd !== undefined &&
    config.maxTotalCostUsd < config.maxRequestCostUsd
  ) {
    errors.push("total budget is lower than per-request budget");
  }
  const paidAttempts = config.operations.filter((operation) => operation === "create" || operation === "retry").length +
    (config.operations.includes("retry") ? 1 : 0);
  if (
    config.maxRequestCostUsd !== undefined &&
    config.maxTotalCostUsd !== undefined &&
    config.maxTotalCostUsd < paidAttempts * config.maxRequestCostUsd
  ) {
    errors.push("total budget is lower than the worst-case paid attempts");
  }
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs <= 0) {
    errors.push("missing positive timeout (PROVIDER_SMOKE_TIMEOUT_MS)");
  }
  if (findProviderMatrix(config.provider) === undefined) {
    errors.push(`provider is not registered: ${config.provider}`);
  }
  return errors;
}

export function redactProviderSmokeLog(value: unknown): string {
  const redact = (input: unknown): unknown => {
    if (typeof input === "string") {
      return input
        .replace(/Bearer\s+[A-Za-z0-9._~+\-/]+=*/gi, "Bearer [REDACTED]")
        .replace(/\b(sk|sess|key|token)[-_][A-Za-z0-9_-]+\b/gi, "$1_[REDACTED]")
        .replace(/(api[-_]?key|authorization|token|secret)\s*[:=]\s*[^,\s]+/gi, "$1=[REDACTED]");
    }
    if (Array.isArray(input)) return input.map(redact);
    if (input !== null && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input).map(([key, item]) =>
          /authorization|api[-_]?key|token|secret|password/i.test(key)
            ? [key, "[REDACTED]"]
            : [key, redact(item)],
        ),
      );
    }
    return input;
  };
  return JSON.stringify(redact(value));
}

export async function runProviderCapabilitySmoke(
  options: RunProviderSmokeOptions,
): Promise<ProviderSmokeReport> {
  const matrix = findProviderMatrix(options.config.provider);
  const now = options.now ?? (() => new Date());
  if (matrix === undefined) {
    return skippedReport(options.config, now, `provider is not registered: ${options.config.provider}`);
  }
  const validation = validateLiveProviderSmokeConfig(options.config);
  if (validation.length > 0) {
    return {
      ...skippedReport(options.config, now, validation.join("; ")),
      status: options.config.mode === "live" ? "blocked" : "skipped",
    };
  }

  const transport = options.transport ?? createDefaultTransport(options.config);
  const budget = new SmokeBudget(options.config);
  const observations: ProviderSmokeObservation[] = [];
  const logs: string[] = [];
  let responseId = "fixture-response-1";

  try {
    for (const operation of options.config.operations) {
      const request = createSmokeRequest(options.config, operation, responseId);
      let response: Response | undefined;
      let body: Record<string, unknown> = {};
      let attempts = 0;
      do {
        attempts += 1;
        budget.reserve(request.estimatedCostUsd);
        response = await withTimeout(transport.request(request), options.config.timeoutMs);
        body = await readSafeJson(response);
        if (operation !== "retry" || response.ok || attempts >= 2) break;
      } while (true);
      if (response === undefined || !response.ok) {
        throw new Error(`${operation} returned HTTP ${response?.status ?? "unknown"}`);
      }
      if (operation === "retry" && response.status === 200) {
        responseId = typeof body?.id === "string" ? body.id : responseId;
      } else if (typeof body?.id === "string") {
        responseId = body.id;
      }
      observations.push({
        operation,
        requestCount: attempts,
        status: response.status,
        ...(typeof body?.id === "string" ? { responseId: body.id } : {}),
        ...(operation === "retry" ? { retryable: response.status === 200 } : {}),
        note: operation === "retry"
          ? "只证明客户端/fixture 的有限重试路径；不证明 Provider 去重或 exactly-once。"
          : "响应字段和 HTTP 状态已脱敏记录。",
      });
      logs.push(redactProviderSmokeLog({ operation, status: response.status, id: body?.id }));
    }
  } catch (error) {
    return {
      generatedAt: now().toISOString(),
      mode: options.config.mode,
      provider: options.config.provider,
      model: options.config.model,
      status: "failed",
      liveCalls: options.config.mode === "live" ? budget.requests : 0,
      requests: budget.requests,
      estimatedCostUsd: budget.totalCostUsd,
      observations,
      matrix,
      capabilityMatrix: PROVIDER_CAPABILITY_MATRIX,
      logs,
      reason: redactProviderSmokeLog(error instanceof Error ? error.message : error),
    };
  }

  return {
    generatedAt: now().toISOString(),
    mode: options.config.mode,
    provider: options.config.provider,
    model: options.config.model,
    status: "completed",
    liveCalls: options.config.mode === "live" ? budget.requests : 0,
    requests: budget.requests,
    estimatedCostUsd: budget.totalCostUsd,
    observations,
    matrix,
    capabilityMatrix: PROVIDER_CAPABILITY_MATRIX,
    logs,
  };
}

export function createFixtureTransport(): ProviderSmokeTransport & {
  readonly requests: readonly ProviderSmokeRequest[];
} {
  const requests: ProviderSmokeRequest[] = [];
  let retryCount = 0;
  return {
    requests,
    async request(request) {
      requests.push(request);
      if (request.operation === "retry" && retryCount++ === 0) {
        return new Response(JSON.stringify({ error: { message: "fixture temporary" } }), { status: 503 });
      }
      if (request.operation === "status") {
        return new Response(JSON.stringify({ id: "fixture-response-1", status: "completed" }), { status: 200 });
      }
      if (request.operation === "cancel") {
        return new Response(JSON.stringify({ id: "fixture-response-1", status: "cancelled" }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "fixture-response-1", output: [{ type: "message", content: [{ type: "output_text", text: "offline fixture" }] }] }), { status: 200 });
    },
  };
}

function createSmokeRequest(
  config: ProviderSmokeConfig,
  operation: ProviderSmokeOperation,
  responseId: string,
): ProviderSmokeRequest {
  const baseUrl = (config.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const idempotencyKey = `provider-smoke-${randomUUID()}`;
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
    "idempotency-key": idempotencyKey,
  };
  if (config.apiKey !== undefined && config.mode === "live") {
    headers.authorization = `Bearer ${config.apiKey}`;
  }
  if (operation === "status") {
    return { url: `${baseUrl}/responses/${encodeURIComponent(responseId)}`, init: { method: "GET", headers }, estimatedCostUsd: 0, operation };
  }
  if (operation === "cancel") {
    return { url: `${baseUrl}/responses/${encodeURIComponent(responseId)}/cancel`, init: { method: "POST", headers, body: "{}" }, estimatedCostUsd: 0, operation };
  }
  return {
    url: `${baseUrl}/responses`,
    init: {
      method: "POST",
      headers,
      body: JSON.stringify({ model: config.model, instructions: "Return a short smoke acknowledgement.", input: [{ role: "user", content: [{ type: "input_text", text: "provider smoke" }] }], stream: false, store: false }),
    },
    estimatedCostUsd: config.mode === "live" ? config.maxRequestCostUsd ?? 0 : 0,
    operation,
  };
}

function createDefaultTransport(config: ProviderSmokeConfig): ProviderSmokeTransport {
  return {
    async request(request) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error("provider smoke timeout")), config.timeoutMs);
      try {
        return await fetch(request.url, { ...request.init, signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

function findProviderMatrix(provider: string): ProviderCapabilityMatrixEntry | undefined {
  return PROVIDER_CAPABILITY_MATRIX.find((entry) => entry.provider === provider);
}

function skippedReport(config: ProviderSmokeConfig, now: () => Date, reason: string): ProviderSmokeReport {
  const matrix = findProviderMatrix(config.provider) ?? PROVIDER_CAPABILITY_MATRIX[0]!;
  return { generatedAt: now().toISOString(), mode: config.mode, provider: config.provider, model: config.model, status: "skipped", liveCalls: 0, requests: 0, estimatedCostUsd: 0, observations: [], matrix, capabilityMatrix: PROVIDER_CAPABILITY_MATRIX, logs: [], reason };
}

class SmokeBudget {
  requests = 0;
  totalCostUsd = 0;
  constructor(private readonly config: ProviderSmokeConfig) {}
  reserve(costUsd: number): void {
    if (this.requests >= this.config.maxRequests) throw new Error("smoke request budget exhausted");
    if (this.config.maxRequestCostUsd !== undefined && costUsd > this.config.maxRequestCostUsd) throw new Error("single-request budget exceeded");
    const next = this.totalCostUsd + costUsd;
    if (this.config.maxTotalCostUsd !== undefined && next > this.config.maxTotalCostUsd) throw new Error("total smoke budget exceeded");
    this.requests += 1;
    this.totalCostUsd = next;
  }
}

function parseNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseInteger(value: string | undefined): number | undefined {
  const parsed = parseNumber(value);
  return parsed !== undefined && Number.isInteger(parsed) ? parsed : undefined;
}

function parseOperations(value: string | undefined, fallback: readonly ProviderSmokeOperation[]): ProviderSmokeOperation[] {
  if (value === undefined) return [...fallback];
  const allowed = new Set<ProviderSmokeOperation>(["create", "status", "cancel", "retry"]);
  return value.split(",").map((item) => item.trim()).filter((item): item is ProviderSmokeOperation => allowed.has(item as ProviderSmokeOperation));
}

async function readSafeJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error("provider smoke timeout")), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
