import type {
  RuntimeStatus,
} from "../runtime-status.js";
import type {
  DesktopEvent,
  DesktopMessageInput,
  DesktopOutcomeUnknownResolution,
  DesktopPermissionDecision,
  DesktopPermissionRequest,
  DesktopModelSettings,
  DesktopSendResult,
  DesktopSnapshot,
  DesktopReasoningEffort,
  DesktopWorkspaceSearchResult,
  DesktopResolveOutcomeUnknownInput,
  DesktopKnowledgeDistillResult,
} from "../desktop-types.js";

declare module "*.css";

export interface BrowserTabState {
  id: string;
  title: string;
  url: string;
  faviconUrl?: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error?: string;
}

export interface BrowserState {
  tabs: readonly BrowserTabState[];
  activeTabId: string;
}

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
        resolveOutcomeUnknown(input: DesktopResolveOutcomeUnknownInput): Promise<DesktopOutcomeUnknownResolution>;
        createThread(): Promise<DesktopSnapshot>;
        selectThread(threadId: string): Promise<DesktopSnapshot>;
        selectAgentThread(threadId?: string): Promise<DesktopSnapshot>;
        confirmRequirement(): Promise<DesktopSendResult>;
        confirmDesign(): Promise<DesktopSnapshot>;
        submitDesignFeedback(feedback: string): Promise<DesktopSnapshot>;
        reworkEngineeringChat(taskId: string, reason: string): Promise<DesktopSnapshot>;
        advanceFixedProduct(expectedStage: import("../../agents/fixed-software-team-coordinator.js").FixedProductStage): Promise<DesktopSnapshot>;
        openPlan(path: string): Promise<boolean>;
        distillThreadToKnowledge(kind: "skill" | "sop"): Promise<DesktopKnowledgeDistillResult>;
        openGeneratedPath(path: string): Promise<boolean>;
        sendMessage(input: DesktopMessageInput): Promise<DesktopSendResult>;
        searchWorkspaceFiles(query: string): Promise<DesktopWorkspaceSearchResult>;
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
      preview: {
        getStatus(): Promise<{ state: "stopped" } | { state: "running"; url: string }>;
        start(): Promise<{ state: "stopped" } | { state: "running"; url: string }>;
        stop(): Promise<{ state: "stopped" } | { state: "running"; url: string }>;
        openExternal(): Promise<boolean>;
      };
      browser: {
        getState(): Promise<BrowserState>;
        createTab(url?: string): Promise<BrowserState>;
        closeTab(id: string): Promise<BrowserState>;
        activateTab(id: string): Promise<BrowserState>;
        navigate(id: string, url: string): Promise<BrowserState>;
        goBack(id: string): Promise<BrowserState>;
        goForward(id: string): Promise<BrowserState>;
        reload(id: string): Promise<BrowserState>;
        stop(id: string): Promise<BrowserState>;
        openExternal(id: string): Promise<boolean>;
        setBounds(bounds: { x: number; y: number; width: number; height: number; visible: boolean }): void;
        onStateChange(listener: (state: BrowserState) => void): () => void;
        onCommand(listener: (command: "focus_address") => void): () => void;
      };
    };
  }
}

export {};
