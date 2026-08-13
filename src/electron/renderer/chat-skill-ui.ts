export type ChatSkillUiState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "success"; skillName: string }
  | { phase: "error"; message: string };

export type ChatSkillUiAction =
  | { type: "start" }
  | { type: "succeed"; skillName: string }
  | { type: "fail"; message: string }
  | { type: "reset" };

export const INITIAL_CHAT_SKILL_UI_STATE: ChatSkillUiState = {
  phase: "idle",
};

export function chatSkillUiReducer(
  state: ChatSkillUiState,
  action: ChatSkillUiAction,
): ChatSkillUiState {
  if (action.type === "reset") {
    return INITIAL_CHAT_SKILL_UI_STATE;
  }

  if (action.type === "start") {
    return state.phase === "loading" ? state : { phase: "loading" };
  }

  if (action.type === "succeed") {
    return { phase: "success", skillName: action.skillName };
  }

  return { phase: "error", message: action.message };
}

export function canDistillCurrentChat(options: {
  connected: boolean;
  hasActiveThread: boolean;
  messageCount: number;
  jobRunning: boolean;
  phase: ChatSkillUiState["phase"];
}): boolean {
  return (
    options.connected &&
    options.hasActiveThread &&
    options.messageCount > 0 &&
    !options.jobRunning &&
    (options.phase === "idle" || options.phase === "error")
  );
}
