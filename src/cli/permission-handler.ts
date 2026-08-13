import type {
  JsonRpcConnection,
} from "../protocol/connection.js";
import {
  parseToolPermissionPrompt,
} from "../permissions/json-rpc-permission-gate.js";

export type CliQuestion = (
  prompt: string,
) => Promise<string>;

/**
 * 注册 App Server → CLI 的 Tool 审批入口。
 * y/yes 明确允许；空输入和其他输入全部安全地按拒绝处理。
 */
export function registerCliPermissionHandler(
  connection: JsonRpcConnection,
  question: CliQuestion,
): void {
  connection.onRequest(
    "tool/request-permission",
    async (params) => {
      const request = parseToolPermissionPrompt(params);
      const action =
        request.description ?? `工具 ${request.toolName}`;
      const risk = request.riskLevel ?? "sensitive";
      const answer = await question(
        `\n[Permission:${risk}] ${action} 请求执行，` +
          "允许吗？[y/N/a=本会话允许] ",
      );
      const normalizedAnswer = answer.trim().toLowerCase();

      if (
        normalizedAnswer === "y" ||
        normalizedAnswer === "yes"
      ) {
        return { decision: "allow", scope: "once" };
      }

      if (
        normalizedAnswer === "a" ||
        normalizedAnswer === "always"
      ) {
        return { decision: "allow", scope: "session" };
      }

      return {
        decision: "deny",
        reason: "user denied",
      };
    },
  );
}
