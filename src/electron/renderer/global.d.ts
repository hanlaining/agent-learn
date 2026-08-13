import type {
  RuntimeStatus,
} from "../runtime-status.js";
import type {
  DesktopEvent,
  DesktopPermissionDecision,
  DesktopPermissionRequest,
  DesktopModelSettings,
  DesktopSendResult,
  DesktopSnapshot,
  DesktopReasoningEffort,
} from "../desktop-types.js";

declare module "*.css";

declare global {
  interface Window {
    godAgent: {
      runtime: {
        getStatus(): Promise<RuntimeStatus>;
        onStatusChange(
          listener: (status: RuntimeStatus) => void,
        ): () => void;
      };
      desktop: {
        getSnapshot(): Promise<DesktopSnapshot>;
        createThread(): Promise<DesktopSnapshot>;
        selectThread(threadId: string): Promise<DesktopSnapshot>;
        selectAgentThread(threadId?: string): Promise<DesktopSnapshot>;
        confirmRequirement(): Promise<DesktopSendResult>;
        advanceFixedProduct(expectedStage: import("../../agents/fixed-software-team-coordinator.js").FixedProductStage): Promise<DesktopSnapshot>;
        openPlan(path: string): Promise<boolean>;
        sendMessage(text: string): Promise<DesktopSendResult>;
        cancelTurn(): Promise<boolean>;
        selectModel(model: string): Promise<DesktopSnapshot>;
        selectReasoningEffort(effort: DesktopReasoningEffort): Promise<DesktopSnapshot>;
        selectModelSettings(settings: DesktopModelSettings): Promise<DesktopSnapshot>;
        updateAgentTeam(config: Partial<import("../../agents/agent-runtime.js").AgentTeamConfig>): Promise<DesktopSnapshot>;
        renameThread(threadId: string, title: string): Promise<DesktopSnapshot>;
        deleteThreads(threadIds: string[], batchDeleteId: string): Promise<DesktopSnapshot>;
        restoreThread(threadId: string): Promise<DesktopSnapshot>;
        respondPermission(
          callId: string,
          decision: DesktopPermissionDecision["decision"],
          scope?: "once" | "session",
        ): Promise<boolean>;
        onPermissionRequest(
          listener: (request: DesktopPermissionRequest) => void,
        ): () => void;
        onEvent(
          listener: (event: DesktopEvent) => void,
        ): () => void;
      };
    };
  }
}

export {};
