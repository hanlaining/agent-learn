import type {
  LlmProvider,
} from "../llm/types.js";

const MAX_DISTILL_INPUT_CHARACTERS = 32_000;
const MAX_DESCRIPTION_CHARACTERS = 500;
const MAX_INSTRUCTION_CHARACTERS = 32_000;
const MIN_REUSABLE_INPUT_CHARACTERS = 40;
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const HIGH_RISK_SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/iu,
  /\bAuthorization\s*:\s*Bearer\s+[^\s]+/iu,
  /\bBearer\s+[a-z0-9._~+/=-]{16,}/iu,
  /\bsk-[a-z0-9_-]{16,}\b/iu,
  /(?:api[ _-]?key|access[ _-]?token|refresh[ _-]?token|password|passwd|cookie|secret)\s*[:=：]\s*["']?[^\s"']{8,}/iu,
];

const PERSONAL_INFORMATION_PATTERNS: readonly RegExp[] = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu,
  /(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/u,
  /(?:账号|用户名|user(?:name)?|account)\s*[:=：]\s*[^\s,，;；]{2,}/iu,
];

const MACHINE_PATH_PATTERNS: readonly RegExp[] = [
  /\b[A-Z]:\\[^\r\n<>|"?*]+/giu,
  /(?:\/Users\/|\/home\/|\/tmp\/|\/var\/tmp\/)[^\s`'"<>]+/gu,
];

export interface DistilledSkillDraft {
  name: string;
  description: string;
  instructions: string;
}

export interface DistillableChatMessage {
  role: "user" | "assistant";
  text: string;
}

export interface ChatSkillDistillerOptions {
  llm: LlmProvider;
  messages: readonly DistillableChatMessage[];
}

export class SkillDistillationError extends Error {
  constructor(
    public readonly code:
      | "insufficient_knowledge"
      | "sensitive_content"
      | "invalid_model_output",
    message: string,
  ) {
    super(message);
    this.name = "SkillDistillationError";
  }
}

export async function distillChatToSkill(
  options: ChatSkillDistillerOptions,
): Promise<DistilledSkillDraft> {
  const input = prepareDistillationInput(options.messages);
  const response = await options.llm.createResponse({
    instructions: createDistillationInstructions(),
    input,
    tools: [],
    allowHostedTools: false,
  });

  if (response.functionCalls.length > 0) {
    throw invalidModelOutput();
  }

  const draft = parseDistilledSkillDraft(response.text);
  assertNotMechanicalChatCopy(draft.instructions, options.messages);
  return draft;
}

export function prepareDistillationInput(
  messages: readonly DistillableChatMessage[],
): string {
  const originalText = messages.map((message) => message.text).join("\n");
  assertNoHighRiskSecrets(originalText);

  const preparedMessages = messages
    .map((message) => ({
      role: message.role,
      text: sanitizeMessageText(message.text, message.role),
    }))
    .filter((message) => message.text.length > 0);

  const reusableLength = preparedMessages.reduce(
    (total, message) => total + [...message.text].length,
    0,
  );

  if (reusableLength < MIN_REUSABLE_INPUT_CHARACTERS) {
    throw new SkillDistillationError(
      "insufficient_knowledge",
      "当前 Chat 中没有足够的可复用知识",
    );
  }

  const transcript = preparedMessages
    .map((message) => `${message.role === "user" ? "用户" : "助手"}：\n${message.text}`)
    .join("\n\n");

  return transcript.length <= MAX_DISTILL_INPUT_CHARACTERS
    ? transcript
    : transcript.slice(-MAX_DISTILL_INPUT_CHARACTERS);
}

export function parseDistilledSkillDraft(
  text: string,
): DistilledSkillDraft {
  let value: unknown;

  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw invalidModelOutput();
  }

  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) => !["name", "description", "instructions"].includes(key),
    ) ||
    typeof value.name !== "string" ||
    typeof value.description !== "string" ||
    typeof value.instructions !== "string"
  ) {
    throw invalidModelOutput();
  }

  return validateDistilledSkillDraft({
    name: value.name,
    description: value.description,
    instructions: value.instructions,
  });
}

export function validateDistilledSkillDraft(
  value: DistilledSkillDraft,
): DistilledSkillDraft {
  const rawName = value.name.trim();

  if (
    rawName.length === 0 ||
    rawName.includes("..") ||
    /[\\/]/u.test(rawName) ||
    /^[A-Z]:/iu.test(rawName)
  ) {
    throw invalidModelOutput();
  }

  const name = normalizeSkillName(rawName);
  const description = normalizeSingleLine(value.description);
  const instructions = value.instructions.replace(/\r\n?/gu, "\n").trim();

  if (
    !SKILL_NAME_PATTERN.test(name) ||
    name.length > 64 ||
    description.length === 0 ||
    [...description].length > MAX_DESCRIPTION_CHARACTERS ||
    instructions.length === 0 ||
    [...instructions].length > MAX_INSTRUCTION_CHARACTERS ||
    instructions.startsWith("---\n")
  ) {
    throw invalidModelOutput();
  }

  assertNoSensitiveOutput(`${description}\n${instructions}`);
  return { name, description, instructions };
}

function createDistillationInstructions(): string {
  return [
    "你负责把一段真实 Chat 提炼为供未来 Agent 复用的 Skill。",
    "只保留已确认或已验证的流程、规则、经验、安全边界与完成标准。",
    "删除寒暄、思考过程、工具日志、临时尝试、进度汇报、冲突且未确认的方案。",
    "不得复制整段聊天，不得输出秘密、账号、个人信息或机器专属绝对路径，不得编造事实。",
    "instructions 是精简、命令式的 Markdown 正文，不含 YAML frontmatter。",
    "name 使用不超过 64 字符的小写英文、数字和连字符；description 同时说明能力与触发场景。",
    "只输出严格 JSON，不要 Markdown 代码围栏，不要额外字段或解释：",
    '{"name":"skill-name","description":"能力及触发场景","instructions":"# 标题\\n\\n## 执行流程\\n..."}',
  ].join("\n");
}

function sanitizeMessageText(
  text: string,
  role: "user" | "assistant",
): string {
  let sanitized = text.replace(/\r\n?/gu, "\n");

  for (const pattern of PERSONAL_INFORMATION_PATTERNS) {
    sanitized = sanitized.replace(new RegExp(pattern.source, pattern.flags + (pattern.global ? "" : "g")), "[已移除的个人信息]");
  }

  for (const pattern of MACHINE_PATH_PATTERNS) {
    sanitized = sanitized.replace(pattern, "[已移除的机器路径]");
  }

  const lines = sanitized
    .split("\n")
    .filter((line) => !isDisposableProgressLine(line, role));

  return lines.join("\n").trim();
}

function isDisposableProgressLine(
  line: string,
  role: "user" | "assistant",
): boolean {
  if (role !== "assistant") {
    return false;
  }

  return /^(?:我(?:会|先|正在|接下来)|进度(?:更新)?[:：]|工具(?:调用|输出)[:：]|执行命令[:：]|已读取|正在检查)/u.test(
    line.trim(),
  );
}

function normalizeSkillName(value: string): string {
  return value
    .toLocaleLowerCase("en-US")
    .replace(/[_\s]+/gu, "-")
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "");
}

function normalizeSingleLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function assertNoHighRiskSecrets(text: string): void {
  if (HIGH_RISK_SECRET_PATTERNS.some((pattern) => pattern.test(text))) {
    throw new SkillDistillationError(
      "sensitive_content",
      "当前 Chat 含有敏感信息，无法安全沉淀",
    );
  }
}

function assertNoSensitiveOutput(text: string): void {
  const containsSensitiveContent = [
    ...HIGH_RISK_SECRET_PATTERNS,
    ...PERSONAL_INFORMATION_PATTERNS,
    ...MACHINE_PATH_PATTERNS,
  ].some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });

  if (containsSensitiveContent) {
    throw new SkillDistillationError(
      "sensitive_content",
      "生成内容未通过安全检查",
    );
  }
}

function assertNotMechanicalChatCopy(
  instructions: string,
  messages: readonly DistillableChatMessage[],
): void {
  const normalizedInstructions = normalizeForCopyCheck(instructions);
  const normalizedChat = normalizeForCopyCheck(
    messages.map((message) => message.text).join("\n"),
  );

  if (
    normalizedInstructions.length >= 120 &&
    (normalizedInstructions === normalizedChat ||
      normalizedChat.includes(normalizedInstructions))
  ) {
    throw invalidModelOutput();
  }
}

function normalizeForCopyCheck(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function invalidModelOutput(): SkillDistillationError {
  return new SkillDistillationError(
    "invalid_model_output",
    "模型未能生成合规的 Skill",
  );
}

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
