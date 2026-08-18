import {
  Activity,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  Bot,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleDashed,
  FileCode2,
  ExternalLink,
  Globe2,
  Menu,
  MoreHorizontal,
  Command,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  RotateCw,
  Search,
  Settings,
  Shield,
  Trash2,
  Sparkles,
  SquarePen,
  TerminalSquare,
  Wrench,
  X,
  Plug,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import type {
  CSSProperties,
  PointerEvent as ReactPointerEvent,
} from "react";

import type {
  RuntimeStatus,
} from "../runtime-status.js";
import type {
  DesktopEvent,
  DesktopOutcomeUnknownResolution,
  DesktopResolveOutcomeUnknownInput,
  DesktopPermissionRequest,
} from "../desktop-types.js";
import type {
  RuntimeCapabilities,
} from "../../app-server/runtime-capabilities.js";
import type { BrowserState } from "./global.js";
import {
  desktopReducer,
  INITIAL_DESKTOP_UI_STATE,
} from "./desktop-reducer.js";
import { RuntimeTimeline } from "./RuntimeTimeline.js";
import {
  coalesceDesktopEvents,
  isNearBottom,
} from "./runtime-ui.js";
import { DESKTOP_COMMAND_REGISTRY } from "../../shortcuts/builtins.js";
import { CommandPalette } from "./CommandPalette.js";
import { ComposerSuggestions } from "./ComposerSuggestions.js";
import {
  findLatestAssistantOutput,
  resolveDesktopShortcut,
  type CommandPaletteItem,
} from "./command-palette.js";
import {
  createComposerMessageInput,
  filterComposerSuggestions,
  findComposerToken,
  moveComposerSelection,
  replaceComposerToken,
  type ComposerSuggestion,
} from "./composer-suggestions.js";
import { groupThreads, shouldAutoOpenToday } from "./history-groups.js";

type InspectorTab = "changes" | "activity" | "terminal" | "browser" | "extensions";

const DEFAULT_LEFT_SIDEBAR_WIDTH = 236;
const MIN_LEFT_SIDEBAR_WIDTH = 108;
const MAX_LEFT_SIDEBAR_WIDTH = 360;
const DEFAULT_RIGHT_INSPECTOR_WIDTH = 520;
const MIN_RIGHT_INSPECTOR_WIDTH = 240;
const MAX_RIGHT_INSPECTOR_WIDTH = 760;
const MIN_WORKSPACE_WIDTH = 280;

const RUNNING_STATES = new Set([
  "starting",
  "thinking",
  "searching",
  "running_tool",
  "answering",
  "cancelling",
]);

const POWER_PRESETS = [
  { model: "gpt-5.6-terra", reasoningEffort: "low" },
  { model: "gpt-5.6-sol", reasoningEffort: "low" },
  { model: "gpt-5.6-sol", reasoningEffort: "medium" },
  { model: "gpt-5.6-sol", reasoningEffort: "high" },
  { model: "gpt-5.6-sol", reasoningEffort: "xhigh" },
] as const satisfies readonly import("../desktop-types.js").DesktopModelSettings[];

export function App() {
  const [runtime, setRuntime] = useState<RuntimeStatus>({
    state: "connecting",
    message: "Runtime 正在连接…",
  });
  const [ui, dispatch] = useReducer(
    desktopReducer,
    INITIAL_DESKTOP_UI_STATE,
  );
  const [input, setInput] = useState("");
  const [composerCursor, setComposerCursor] = useState(0);
  const [composerSelectedIndex, setComposerSelectedIndex] = useState(0);
  const [dismissedComposerToken, setDismissedComposerToken] = useState<string>();
  const [workspacePaths, setWorkspacePaths] = useState<string[]>([]);
  const [workspaceSearchLoading, setWorkspaceSearchLoading] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const draftsRef = useRef(new Map<string, string>());
  const [historyQuery, setHistoryQuery] = useState("");
  const [showHistorySearch, setShowHistorySearch] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [shortcutNotice, setShortcutNotice] = useState<string>();
  const [agentSwitchOpen, setAgentSwitchOpen] = useState(false);
  const [permissionMenuOpen, setPermissionMenuOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelMenuView, setModelMenuView] = useState<"simple" | "advanced">("simple");
  const [historyMenu, setHistoryMenu] = useState<{ kind: "group" | "thread"; id: string }>();
  const [editingThreadId, setEditingThreadId] = useState<string>();
  const [editingTitle, setEditingTitle] = useState("");
  const [collapsedHistoryTreeIds, setCollapsedHistoryTreeIds] = useState<Set<string>>(() => new Set());
  const [trashOpen, setTrashOpen] = useState(false);
  const [olderLimit, setOlderLimit] = useState(50);
  const [selectedAgentRunId, setSelectedAgentRunId] = useState<string>();
  const activeAgentRun = ui.snapshot?.agentRuns.find(
    (run) => run.threadId === ui.snapshot?.activeAgentThreadId,
  );
  const [leftOpen, setLeftOpen] = useStoredBoolean("god-agent:left-open", true);
  const [rightOpen, setRightOpen] = useStoredBoolean("god-agent:right-open", true);
  const [leftSidebarWidth, setLeftSidebarWidth] = useStoredNumber(
    "god-agent:left-sidebar-width",
    DEFAULT_LEFT_SIDEBAR_WIDTH,
  );
  const [rightInspectorWidth, setRightInspectorWidth] = useStoredNumber(
    "god-agent:right-workbench-width",
    DEFAULT_RIGHT_INSPECTOR_WIDTH,
  );
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [inspectorResizing, setInspectorResizing] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("activity");
  const [preview, setPreview] = useState<{ state: "stopped" } | { state: "running"; url: string }>({ state: "stopped" });
  const [previewBusy, setPreviewBusy] = useState(false);
  const [browserState, setBrowserState] = useState<BrowserState>();
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const [permissionRequest, setPermissionRequest] = useState<DesktopPermissionRequest>();
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const timelineRef = useRef<HTMLDivElement>(null);
  const historySearchRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const autoFollowRef = useRef(true);
  const pendingEventsRef = useRef<DesktopEvent[]>([]);
  const eventFrameRef = useRef<number | undefined>(undefined);
  const knownHistoryThreadIdsRef = useRef<Set<string> | undefined>(undefined);

  useEffect(() => {
    const updateViewportWidth = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", updateViewportWidth);
    return () => window.removeEventListener("resize", updateViewportWidth);
  }, []);

  const resizeLeftSidebar = useCallback((clientX: number) => {
    const rightWidth = rightOpen ? clamp(rightInspectorWidth, MIN_RIGHT_INSPECTOR_WIDTH, MAX_RIGHT_INSPECTOR_WIDTH) : 0;
    const maxWidth = Math.max(MIN_LEFT_SIDEBAR_WIDTH, Math.min(
      MAX_LEFT_SIDEBAR_WIDTH,
      window.innerWidth - rightWidth - MIN_WORKSPACE_WIDTH,
    ));
    setLeftSidebarWidth(clamp(clientX, MIN_LEFT_SIDEBAR_WIDTH, maxWidth));
  }, [rightInspectorWidth, rightOpen, setLeftSidebarWidth]);

  const resizeRightInspector = useCallback((clientX: number) => {
    const leftWidth = leftOpen ? clamp(leftSidebarWidth, MIN_LEFT_SIDEBAR_WIDTH, MAX_LEFT_SIDEBAR_WIDTH) : 0;
    const maxWidth = Math.max(MIN_RIGHT_INSPECTOR_WIDTH, Math.min(
      MAX_RIGHT_INSPECTOR_WIDTH,
      window.innerWidth - leftWidth - MIN_WORKSPACE_WIDTH,
    ));
    setRightInspectorWidth(clamp(
      window.innerWidth - clientX,
      MIN_RIGHT_INSPECTOR_WIDTH,
      maxWidth,
    ));
  }, [leftOpen, leftSidebarWidth, setRightInspectorWidth]);

  function startLeftSidebarResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setSidebarResizing(true);
    resizeLeftSidebar(event.clientX);
  }

  function finishLeftSidebarResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setSidebarResizing(false);
  }

  function startRightInspectorResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setInspectorResizing(true);
    resizeRightInspector(event.clientX);
  }

  function finishRightInspectorResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setInspectorResizing(false);
  }

  function resetRightInspectorWidth() {
    setRightInspectorWidth(DEFAULT_RIGHT_INSPECTOR_WIDTH);
  }

  function resetThreePaneWidths() {
    setLeftSidebarWidth(DEFAULT_LEFT_SIDEBAR_WIDTH);
    setRightInspectorWidth(DEFAULT_RIGHT_INSPECTOR_WIDTH);
  }

  useEffect(() => {
    const removeRuntime = window.godAgent.runtime.onStatusChange(setRuntime);
    const flushEvents = () => {
      eventFrameRef.current = undefined;
      const pending = pendingEventsRef.current;
      pendingEventsRef.current = [];
      for (const event of coalesceDesktopEvents(pending)) {
        dispatch({ type: "event", event });
      }
    };
    const removeDesktop = window.godAgent.desktop.onEvent((event) => {
      pendingEventsRef.current.push(event);
      eventFrameRef.current ??= window.requestAnimationFrame(flushEvents);
    });
    const removePermission = window.godAgent.desktop.onPermissionRequest(
      setPermissionRequest,
    );

    void window.godAgent.runtime.getStatus().then(setRuntime);

    return () => {
      removeRuntime();
      removeDesktop();
      removePermission();
      if (eventFrameRef.current !== undefined) {
        window.cancelAnimationFrame(eventFrameRef.current);
      }
    };
  }, []);

  useEffect(() => {
    void window.godAgent.preview.getStatus().then(setPreview).catch(() => setPreview({ state: "stopped" }));
  }, []);

  useEffect(() => {
    const removeBrowser = window.godAgent.browser.onStateChange(setBrowserState);
    void window.godAgent.browser.getState().then(setBrowserState);
    return removeBrowser;
  }, []);

  useEffect(() => {
    if (ui.snapshot?.agentRuntime?.fixedProductStage !== "completed" || preview.state === "running" || previewBusy) return;
    setPreviewBusy(true);
    void window.godAgent.preview.start()
      .then(async (status) => {
        setPreview(status);
        setRightOpen(true);
        setInspectorTab("browser");
        if (status.state === "running") setBrowserState(await window.godAgent.browser.createTab(status.url));
      })
      .catch(() => setPreview({ state: "stopped" }))
      .finally(() => setPreviewBusy(false));
  }, [ui.snapshot?.agentRuntime?.fixedProductStage, preview.state, previewBusy, setRightOpen]);

  async function answerPermission(
    decision: "allow" | "deny",
    scope: "once" | "session" = "once",
  ) {
    const request = permissionRequest;
    if (request === undefined) return;
    setPermissionRequest(undefined);
    try {
      await window.godAgent.desktop.respondPermission(
        request.callId,
        decision,
        scope,
      );
    } catch (error) {
      dispatch({ type: "error", message: readError(error) });
    }
  }

  useEffect(() => {
    if (runtime.state !== "connected") {
      return;
    }

    void window.godAgent.desktop.getSnapshot()
      .then((snapshot) => dispatch({ type: "snapshot", snapshot }))
      .catch((error: unknown) => dispatch({
        type: "error",
        message: readError(error),
      }));
  }, [runtime.state]);

  useEffect(() => {
    if (!autoFollowRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      timelineRef.current?.scrollTo({
        top: timelineRef.current.scrollHeight,
        behavior: "smooth",
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    ui.snapshot?.messages,
    ui.activities,
    ui.reasoning,
    ui.runtimeSession,
  ]);

  useEffect(() => {
    autoFollowRef.current = true;
    setShowJumpToBottom(false);
    setAgentSwitchOpen(false);
    setPermissionMenuOpen(false);
    setModelMenuOpen(false);
    setModelMenuView("simple");
    setHistoryMenu(undefined);
  }, [ui.runtimeSession?.turnId, ui.snapshot?.activeThreadId]);

  useEffect(() => {
    if (!agentSwitchOpen && !permissionMenuOpen && !modelMenuOpen && historyMenu === undefined && !commandPaletteOpen) return;

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setAgentSwitchOpen(false);
        setPermissionMenuOpen(false);
        setModelMenuOpen(false);
        setModelMenuView("simple");
        setHistoryMenu(undefined);
        setCommandPaletteOpen(false);
      }
    };

    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [agentSwitchOpen, permissionMenuOpen, modelMenuOpen, historyMenu, commandPaletteOpen]);

  function jumpToBottom() {
    autoFollowRef.current = true;
    setShowJumpToBottom(false);
    timelineRef.current?.scrollTo({
      top: timelineRef.current.scrollHeight,
      behavior: "smooth",
    });
  }

  const isRunning = RUNNING_STATES.has(
    ui.snapshot?.turnState ?? "idle",
  );
  const threads = useMemo(() => {
    const query = historyQuery.trim().toLocaleLowerCase();
    return (ui.snapshot?.threads ?? []).filter((thread) =>
      query.length === 0 ||
      thread.title.toLocaleLowerCase().includes(query),
    );
  }, [historyQuery, ui.snapshot?.threads]);
  const groupedThreads = useMemo(
    () => groupThreads(threads, ui.snapshot?.activeThreadId),
    [threads, ui.snapshot?.activeThreadId],
  );
  const [todayOpen, setTodayOpen] = useStoredBoolean("god-agent:history-today", false);
  const [yesterdayOpen, setYesterdayOpen] = useStoredBoolean("god-agent:history-yesterday", false);
  const [historyOpen, setHistoryOpen] = useStoredBoolean("god-agent:history-older", false);

  useLayoutEffect(() => {
    if (ui.snapshot === undefined) return;
    const currentIds = new Set(threads.map((thread) => thread.id));
    const previousIds = knownHistoryThreadIdsRef.current;
    knownHistoryThreadIdsRef.current = currentIds;
    if (previousIds === undefined) return;

    if (shouldAutoOpenToday(threads, ui.snapshot.activeThreadId, previousIds)) {
      setTodayOpen(true);
    }
  }, [setTodayOpen, threads, ui.snapshot]);

  async function replaceSnapshot(operation: Promise<NonNullable<typeof ui.snapshot>>) {
    try {
      dispatch({ type: "clear-error" });
      const currentKey = ui.snapshot?.activeThreadId ?? "__new__";
      draftsRef.current.set(currentKey, input);
      const snapshot = await operation;
      dispatch({ type: "snapshot", snapshot });
      setInput(draftsRef.current.get(snapshot.activeThreadId ?? "__new__") ?? "");
    } catch (error) {
      dispatch({ type: "error", message: readError(error) });
    }
  }

  async function sendMessage() {
    const text = input.trim();
    if (text.length === 0 || isRunning || runtime.state !== "connected") {
      return;
    }

    setInput("");
    dispatch({ type: "clear-error" });
    try {
      await window.godAgent.desktop.sendMessage(
        createComposerMessageInput(text, selectedFiles, selectedSkills),
      );
      setSelectedFiles([]);
      setSelectedSkills([]);
    } catch (error) {
      dispatch({ type: "error", message: readError(error) });
    }
  }

  const capabilities = ui.snapshot?.capabilities;
  const activeModelSettings = ui.snapshot?.agentConfig;
  const availablePowerPresets = POWER_PRESETS.filter((preset) => {
    const model = capabilities?.models.find((item) => item.id === preset.model);
    return model !== undefined && (
      model.reasoningEfforts === undefined ||
      model.reasoningEfforts.includes(preset.reasoningEffort)
    );
  });
  const activePowerIndex = availablePowerPresets.findIndex((preset) =>
    preset.model === activeModelSettings?.model &&
    preset.reasoningEffort === activeModelSettings.reasoningEffort
  );
  const activeAgentCount = ui.snapshot?.agentRuns.filter((run) =>
    ["queued", "running", "waiting_children", "resuming"].includes(run.status),
  ).length ?? 0;
  const visibleLeftSidebarWidth = leftOpen
    ? clamp(
        leftSidebarWidth,
        MIN_LEFT_SIDEBAR_WIDTH,
        Math.max(MIN_LEFT_SIDEBAR_WIDTH, Math.min(MAX_LEFT_SIDEBAR_WIDTH, viewportWidth - (rightOpen ? MIN_RIGHT_INSPECTOR_WIDTH : 0) - MIN_WORKSPACE_WIDTH)),
      )
    : 0;
  const rightInspectorMaxWidth = getRightInspectorMaxWidth(
    viewportWidth,
    visibleLeftSidebarWidth,
  );
  const visibleRightInspectorWidth = clamp(
    rightInspectorWidth,
    MIN_RIGHT_INSPECTOR_WIDTH,
    rightInspectorMaxWidth,
  );
  const latestAssistantOutput = findLatestAssistantOutput(
    ui.snapshot?.messages ?? [],
    ui.runtimeSession,
  );
  const commandPaletteItems = useMemo<CommandPaletteItem[]>(() =>
    DESKTOP_COMMAND_REGISTRY.list().map((action) => {
      if (action.id === "settings.keymap") {
        return { action, enabled: false, disabledReason: "阶段 D 开放个性化键位" };
      }
      if (action.id === "output.copyLatest" && latestAssistantOutput === undefined) {
        return { action, enabled: false, disabledReason: "当前还没有可复制的完整回答" };
      }
      if (action.id === "session.model" && (capabilities?.models.length ?? 0) === 0) {
        return { action, enabled: false, disabledReason: "当前没有可用模型" };
      }
      if (action.id === "skill.pick" && (capabilities?.skills.length ?? 0) === 0) {
        return { action, enabled: false, disabledReason: "当前没有已发现的 Skill" };
      }
      if (runtime.state !== "connected" && action.id !== "composer.commandPalette") {
        return { action, enabled: false, disabledReason: "Runtime 尚未连接" };
      }
      return { action, enabled: true };
    }),
  [capabilities?.models.length, capabilities?.skills.length, latestAssistantOutput, runtime.state]);
  const rawComposerToken = useMemo(
    () => findComposerToken(input, composerCursor),
    [composerCursor, input],
  );
  const rawComposerTokenKey = rawComposerToken === undefined
    ? undefined
    : `${rawComposerToken.start}:${rawComposerToken.trigger}:${rawComposerToken.query}`;
  const composerToken = rawComposerTokenKey === dismissedComposerToken
    ? undefined
    : rawComposerToken;
  const composerSuggestions = useMemo<ComposerSuggestion[]>(() => {
    if (composerToken === undefined) return [];
    const source: ComposerSuggestion[] = composerToken.kind === "slash"
      ? commandPaletteItems
        .filter((item) => item.action.slashCommand !== undefined)
        .map((item) => ({
          id: item.action.id, kind: "slash", value: item.action.slashCommand!,
          label: item.action.label, description: item.action.description,
          disabled: !item.enabled, ...(item.disabledReason === undefined ? {} : { disabledReason: item.disabledReason }),
        }))
      : composerToken.kind === "skill"
        ? (capabilities?.skills ?? []).map((skill) => ({
          id: `skill:${skill.name}`, kind: "skill", value: `$${skill.name}`,
          label: skill.name, description: skill.description,
        }))
        : workspacePaths.map((path) => ({
          id: `file:${path}`, kind: "file", value: `@${path}`,
          label: path, description: "当前工作区文件",
        }));
    return filterComposerSuggestions(source, composerToken.query);
  }, [capabilities?.skills, commandPaletteItems, composerToken, workspacePaths]);

  useEffect(() => {
    setComposerSelectedIndex(0);
    if (composerToken?.kind !== "file") {
      setWorkspacePaths([]);
      setWorkspaceSearchLoading(false);
      return;
    }
    let active = true;
    setWorkspaceSearchLoading(true);
    const timer = window.setTimeout(() => {
      void window.godAgent.desktop.searchWorkspaceFiles(composerToken.query)
        .then((result) => { if (active) setWorkspacePaths(result.paths); })
        .catch(() => { if (active) setWorkspacePaths([]); })
        .finally(() => { if (active) setWorkspaceSearchLoading(false); });
    }, 120);
    return () => { active = false; window.clearTimeout(timer); };
  }, [composerToken?.kind, composerToken?.query]);

  function selectComposerSuggestion(item: ComposerSuggestion) {
    if (item.disabled || composerToken === undefined) return;
    if (item.kind === "slash") {
      setInput(`${input.slice(0, composerToken.start)}${input.slice(composerToken.end)}`.trimStart());
      runDesktopAction(item.id);
      return;
    }
    const replacement = replaceComposerToken(input, composerToken, item.value);
    setInput(replacement.text);
    setComposerCursor(replacement.cursor);
    if (item.kind === "file") setSelectedFiles((value) => [...new Set([...value, item.value.slice(1)])]);
    if (item.kind === "skill") setSelectedSkills((value) => [...new Set([...value, item.value.slice(1)])]);
    window.requestAnimationFrame(() => {
      composerRef.current?.focus();
      composerRef.current?.setSelectionRange(replacement.cursor, replacement.cursor);
    });
  }

  function openCommandPalette() {
    setAgentSwitchOpen(false);
    setPermissionMenuOpen(false);
    setModelMenuOpen(false);
    setHistoryMenu(undefined);
    setCommandPaletteOpen(true);
  }

  function openHistorySearch() {
    setCommandPaletteOpen(false);
    setLeftOpen(true);
    setShowHistorySearch(true);
    window.requestAnimationFrame(() => historySearchRef.current?.focus());
  }

  async function copyLatestAssistantOutput() {
    if (latestAssistantOutput === undefined) return;
    try {
      await navigator.clipboard.writeText(latestAssistantOutput);
      setShortcutNotice("已复制最近一次完整回答");
    } catch {
      setShortcutNotice("复制失败，请检查系统剪贴板权限");
    }
  }

  function runDesktopAction(actionId: string) {
    setCommandPaletteOpen(false);
    setShortcutNotice(undefined);
    switch (actionId) {
      case "composer.commandPalette":
      case "app.help":
        openCommandPalette();
        break;
      case "chat.search":
        openHistorySearch();
        break;
      case "chat.new":
        void replaceSnapshot(window.godAgent.desktop.createThread());
        break;
      case "output.copyLatest":
        void copyLatestAssistantOutput();
        break;
      case "session.status":
        setRightOpen(true);
        setInspectorTab("activity");
        break;
      case "session.model":
        setModelMenuView(activePowerIndex < 0 ? "advanced" : "simple");
        setModelMenuOpen(true);
        break;
      case "session.permissions":
        setPermissionMenuOpen(true);
        break;
      case "skill.pick":
        setRightOpen(true);
        setInspectorTab("extensions");
        break;
    }
  }

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      const actionId = resolveDesktopShortcut(event);
      if (actionId === undefined) return;
      event.preventDefault();
      const item = commandPaletteItems.find(
        (candidate) => candidate.action.id === actionId,
      );
      if (item?.enabled !== true) {
        setShortcutNotice(item?.disabledReason ?? "当前无法执行此快捷操作");
        return;
      }
      runDesktopAction(actionId);
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [commandPaletteItems]);

  return (
    <div
      className="desktop-app"
      data-left-open={leftOpen}
      data-right-open={rightOpen}
      data-pane-resizing={sidebarResizing || inspectorResizing}
      style={{
        "--left-sidebar-width": `${visibleLeftSidebarWidth}px`,
        "--right-inspector-width": `${visibleRightInspectorWidth}px`,
      } as CSSProperties}
    >
      <div className="desktop-layout">
        <aside className="left-sidebar" aria-hidden={!leftOpen}>
          <div
            className="left-sidebar-resizer pane-resizer"
            role="separator"
            aria-label="调整任务栏宽度"
            aria-orientation="vertical"
            aria-valuemin={MIN_LEFT_SIDEBAR_WIDTH}
            aria-valuemax={MAX_LEFT_SIDEBAR_WIDTH}
            aria-valuenow={visibleLeftSidebarWidth}
            tabIndex={leftOpen ? 0 : -1}
            title="按住左右拖动，双击恢复三栏默认宽度"
            onPointerDown={startLeftSidebarResize}
            onPointerMove={(event) => {
              if (sidebarResizing && event.currentTarget.hasPointerCapture(event.pointerId)) resizeLeftSidebar(event.clientX);
            }}
            onPointerUp={finishLeftSidebarResize}
            onPointerCancel={finishLeftSidebarResize}
            onDoubleClick={resetThreePaneWidths}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft") { event.preventDefault(); setLeftSidebarWidth(Math.max(visibleLeftSidebarWidth - 12, MIN_LEFT_SIDEBAR_WIDTH)); }
              if (event.key === "ArrowRight") { event.preventDefault(); setLeftSidebarWidth(Math.min(visibleLeftSidebarWidth + 12, MAX_LEFT_SIDEBAR_WIDTH)); }
              if (event.key === "Home") resetThreePaneWidths();
            }}
          />
          <div className="sidebar-actions">
            <button
              className="new-task-button"
              type="button"
              disabled={runtime.state !== "connected"}
              onClick={() => void replaceSnapshot(window.godAgent.desktop.createThread())}
            >
              <SquarePen />
              <span>新建任务</span>
            </button>
            <button
              className="icon-button"
              type="button"
              aria-label="收起左侧栏"
              onClick={() => setLeftOpen(false)}
            >
              <PanelLeftClose />
            </button>
            <button
              className="icon-button"
              type="button"
              aria-label="搜索历史"
              onClick={() => setShowHistorySearch(!showHistorySearch)}
            >
              <Search />
            </button>
          </div>

          {showHistorySearch && (
            <div className="history-search">
              <Search />
              <input
                ref={historySearchRef}
                value={historyQuery}
                placeholder="搜索任务"
                onChange={(event) => setHistoryQuery(event.target.value)}
                autoFocus
              />
              {historyQuery.length > 0 && (
                <button type="button" aria-label="清空搜索" onClick={() => setHistoryQuery("")}>
                  <X />
                </button>
              )}
            </div>
          )}

          <section className="module-section" aria-label="功能模块">
            <div className="section-label">功能</div>
            <div className="module-grid">
              <ModuleButton icon={<MessageSquare />} label="对话" active />
              <ModuleButton
                icon={<Wrench />}
                label="Tools"
                count={capabilities?.tools.length ?? 0}
                onClick={() => { setRightOpen(true); setInspectorTab("extensions"); }}
              />
              <ModuleButton
                icon={<Sparkles />}
                label="Skills"
                count={capabilities?.skills.length ?? 0}
                onClick={() => { setRightOpen(true); setInspectorTab("extensions"); }}
              />
              <ModuleButton
                icon={<Plug />}
                label="MCP"
                count={capabilities?.mcpServers.length ?? 0}
                onClick={() => { setRightOpen(true); setInspectorTab("extensions"); }}
              />
              <ModuleButton
                icon={<Globe2 />}
                label="Search"
                count={capabilities?.webSearch ? 1 : 0}
                onClick={() => { setRightOpen(true); setInspectorTab("extensions"); }}
              />
              <ModuleButton
                icon={<TerminalSquare />}
                label="终端"
                onClick={() => { setRightOpen(true); setInspectorTab("terminal"); }}
              />
            </div>
          </section>

          <nav className="history-list" aria-label="任务历史">
            {groupedThreads.map(([label, items]) => (
              <div className="history-group" key={label}>
                <div className="history-group-header">
                  <button type="button" onClick={() => label === "今天" ? setTodayOpen(!todayOpen) : label === "昨天" ? setYesterdayOpen(!yesterdayOpen) : setHistoryOpen(!historyOpen)}>
                    {(label === "今天" ? todayOpen : label === "昨天" ? yesterdayOpen : historyOpen) ? <ChevronDown /> : <ChevronRight />}{label}
                  </button>
                  <div className="history-menu-wrap">
                    <button type="button" aria-label={`${label}更多操作`} aria-haspopup="menu" aria-expanded={historyMenu?.kind === "group" && historyMenu.id === label} onClick={() => setHistoryMenu(historyMenu?.kind === "group" && historyMenu.id === label ? undefined : { kind: "group", id: label })}><MoreHorizontal /></button>
                    {historyMenu?.kind === "group" && historyMenu.id === label && <div className="history-action-menu history-group-menu" role="menu" aria-label={`${label}操作菜单`}>
                      <button type="button" role="menuitem" className="danger-menu-item" onClick={() => {
                        setHistoryMenu(undefined);
                        const running = items.filter((item) => RUNNING_STATES.has(item.turnState)).length;
                        if (window.confirm(`将删除 ${items.length} 条记录，其中 ${running} 个 Job 正在运行。运行中的 Job 和全部子 Agent 会停止。`)) void replaceSnapshot(window.godAgent.desktop.deleteThreads(items.map((item) => item.id), `batch-${Date.now()}-${label}`));
                      }}><Trash2 />删除本组记录</button>
                    </div>}
                  </div>
                </div>
                {(label === "今天" ? todayOpen : label === "昨天" ? yesterdayOpen : historyOpen) && (label === "历史" ? items.slice(0, olderLimit) : items).map((thread) => (
                  <div className="history-thread" key={thread.id}>
                  <div className="history-item-row">
                  <button
                    type="button"
                    className="history-item"
                    aria-current={thread.id === ui.snapshot?.activeThreadId}
                    aria-expanded={thread.id === ui.snapshot?.activeThreadId && ui.snapshot.agentRuns.some((run) => run.parentRunId !== undefined)
                      ? !collapsedHistoryTreeIds.has(thread.id)
                      : undefined}
                    onClick={() => {
                      const isActiveTree = thread.id === ui.snapshot?.activeThreadId && ui.snapshot.agentRuns.some((run) => run.parentRunId !== undefined);
                      if (isActiveTree) {
                        setCollapsedHistoryTreeIds((current) => {
                          const next = new Set(current);
                          if (next.has(thread.id)) next.delete(thread.id);
                          else next.add(thread.id);
                          return next;
                        });
                        return;
                      }
                      setCollapsedHistoryTreeIds((current) => {
                        if (!current.has(thread.id)) return current;
                        const next = new Set(current);
                        next.delete(thread.id);
                        return next;
                      });
                      void replaceSnapshot(window.godAgent.desktop.selectThread(thread.id));
                    }}
                  >
                    <i className="thread-status-dot" data-state={thread.turnState} />
                    <span>
                      {editingThreadId === thread.id ? <input autoFocus value={editingTitle} onClick={(event) => event.stopPropagation()} onChange={(event) => setEditingTitle(event.target.value)} onKeyDown={(event) => {
                        if (event.key === "Enter" && editingTitle.trim()) { event.stopPropagation(); void replaceSnapshot(window.godAgent.desktop.renameThread(thread.id, editingTitle)); setEditingThreadId(undefined); }
                        if (event.key === "Escape") { event.stopPropagation(); setEditingThreadId(undefined); }
                      }} /> : <strong>{thread.title}</strong>}
                      <small>{thread.model} · {formatThreadState(thread.turnState)}</small>
                    </span>
                    <small>{thread.messageCount}</small>
                  </button>
                  <div className="history-menu-wrap">
                    <button className="history-more" type="button" aria-label={`${thread.title}更多操作`} aria-haspopup="menu" aria-expanded={historyMenu?.kind === "thread" && historyMenu.id === thread.id} onClick={() => setHistoryMenu(historyMenu?.kind === "thread" && historyMenu.id === thread.id ? undefined : { kind: "thread", id: thread.id })}><MoreHorizontal /></button>
                    {historyMenu?.kind === "thread" && historyMenu.id === thread.id && <div className="history-action-menu" role="menu" aria-label={`${thread.title}操作菜单`}>
                      <button type="button" role="menuitem" onClick={() => { setHistoryMenu(undefined); setEditingThreadId(thread.id); setEditingTitle(thread.title); }}><SquarePen />重命名</button>
                      <button type="button" role="menuitem" className="danger-menu-item" onClick={() => {
                        setHistoryMenu(undefined);
                        if (window.confirm(RUNNING_STATES.has(thread.turnState) ? "删除会停止该 Chat 当前 Job 和全部子 Agent。" : "确认将此 Chat 移入回收站？")) void replaceSnapshot(window.godAgent.desktop.deleteThreads([thread.id], `batch-${Date.now()}-${thread.id}`));
                      }}><Trash2 />删除</button>
                    </div>}
                  </div>
                  </div>
                  {thread.id === ui.snapshot?.activeThreadId && !collapsedHistoryTreeIds.has(thread.id) && ui.snapshot.agentRuns.some((run) => run.parentRunId !== undefined) && (
                    <HistoryAgentTree
                      runs={ui.snapshot.agentRuns}
                      requirement={ui.snapshot.requirement}
                      runtime={ui.snapshot.agentRuntime}
                      selectedId={selectedAgentRunId}
                      select={(run) => {
                        setSelectedAgentRunId(run?.id);
                        void replaceSnapshot(window.godAgent.desktop.selectAgentThread(run?.threadId));
                      }}
                    />
                  )}
                  </div>
                ))}
                {label === "历史" && historyOpen && items.length > olderLimit && <button className="history-load-more" type="button" onClick={() => setOlderLimit((value) => value + 50)}>加载更多（剩余 {items.length - olderLimit}）</button>}
              </div>
            ))}
            {threads.length === 0 && (
              <div className="empty-history">没有匹配的任务</div>
            )}
          </nav>

          <section className="trash-section">
            <button type="button" className="footer-action" onClick={() => setTrashOpen(!trashOpen)}><Trash2 /><span>回收站（{ui.snapshot?.trash?.length ?? 0}）</span></button>
            {trashOpen && <div className="trash-list">{(ui.snapshot?.trash ?? []).map((thread) => <div key={thread.id}><span><strong>{thread.title}</strong><small>保留至 {new Date(thread.trashExpiresAt).toLocaleDateString()}</small></span><button type="button" onClick={() => void replaceSnapshot(window.godAgent.desktop.restoreThread(thread.id))}>恢复</button></div>)}{(ui.snapshot?.trash?.length ?? 0) === 0 && <small>回收站为空</small>}</div>}
          </section>

          <div className="sidebar-footer">
            <button type="button" className="footer-action">
              <Settings />
              <span>设置</span>
            </button>
          </div>
        </aside>

        <main className="main-workspace">
          <header className="workspace-header">
            <div className="workspace-title">
              {!leftOpen && (
                <button className="icon-button" type="button" aria-label="展开左侧栏" onClick={() => setLeftOpen(true)}>
                  <PanelLeftOpen />
                </button>
              )}
              <strong>{activeAgentRun === undefined ? "agent-learn / God" : formatAgentProfileName(activeAgentRun.agentProfileId)}</strong>
              <span>{activeAgentRun === undefined ? `${ui.snapshot?.agentConfig.model ?? "Runtime"} · ${ui.snapshot?.agentConfig.reasoningEffort ?? "high"}` : `真实 Agent Thread · Attempt ${activeAgentRun.attempt}`}</span>
            </div>
            <div className="workspace-actions">
              <button className="command-palette-trigger" type="button" onClick={openCommandPalette}>
                <Command /><span>命令</span><kbd>Ctrl + Shift + P</kbd>
              </button>
              <span className="runtime-state" data-state={runtime.state}>
                <i />
                <span>{runtime.message}</span>
              </span>
              {!rightOpen && (
                <button className="icon-button" type="button" aria-label="展开右侧栏" onClick={() => setRightOpen(true)}>
                  <PanelRightOpen />
                </button>
              )}
              <button className="icon-button" type="button" aria-label="更多任务操作"><Menu /></button>
            </div>
          </header>

          <div
            className="conversation-scroll"
            ref={timelineRef}
            onScroll={(event) => {
              const nearBottom = isNearBottom(event.currentTarget);
              autoFollowRef.current = nearBottom;
              setShowJumpToBottom(!nearBottom);
            }}
          >
            {runtime.state !== "connected" ? (
              <RuntimeEmptyState status={runtime} />
            ) : (ui.snapshot?.messages.length ?? 0) === 0 ? (
              <EmptyConversation />
            ) : (
              <div className="conversation">
                {ui.snapshot?.activeAgentThreadId !== undefined && <div className="agent-thread-context"><button className="agent-thread-back" type="button" onClick={() => void replaceSnapshot(window.godAgent.desktop.selectAgentThread())}>← 返回 God</button><span><strong>{formatAgentProfileName(activeAgentRun?.agentProfileId)}</strong><small>{activeAgentRun?.task ?? "真实 Agent 对话"}</small></span></div>}
                {ui.snapshot?.activeAgentThreadId === undefined && ui.snapshot?.requirement !== undefined && (
                  <section className="requirement-card" data-status={ui.snapshot.requirement.status}>
                    <div><strong>{ui.snapshot.requirement.title}</strong><span>需求 v{ui.snapshot.requirement.revision} · {ui.snapshot.requirement.status === "planned" ? "等待确认" : "已确认执行"}</span></div>
                    <p>{ui.snapshot.requirement.objective}</p>
                    <small>测试用例 {ui.snapshot.requirement.testCases.length} 条 · 计划：{ui.snapshot.requirement.planArtifact.path}</small>
                    <div className="requirement-actions"><button type="button" className="secondary" onClick={() => void window.godAgent.desktop.openPlan(ui.snapshot!.requirement!.planArtifact.path)}>打开计划</button>{ui.snapshot.requirement.status === "planned" && <button type="button" onClick={() => {
                      dispatch({ type: "clear-error" });
                      void (async () => {
                        try {
                          await window.godAgent.desktop.confirmRequirement();
                          dispatch({ type: "snapshot", snapshot: await window.godAgent.desktop.getSnapshot() });
                        } catch (error) {
                          dispatch({ type: "error", message: readError(error) });
                        }
                      })();
                    }}>确认执行</button>}</div>
                  </section>
                )}
                {ui.snapshot?.messages
                  .filter((message) =>
                    ui.runtimeSession === undefined ||
                    message.turnId !== ui.runtimeSession.turnId ||
                    message.role !== "assistant"
                  )
                  .map((message) => (
                  <article className={`message message-${message.role}`} key={message.id}>
                    <span className="message-avatar">{message.role === "user" ? "你" : "g"}</span>
                    <div>
                      <strong>{message.role === "user" ? "你" : "Agent"}</strong>
                      <div className="message-copy">{message.text}</div>
                    </div>
                  </article>
                ))}

                {ui.runtimeSession !== undefined && (
                  <RuntimeTimeline session={ui.runtimeSession} />
                )}

                {ui.runtimeSession === undefined &&
                  (ui.reasoning.length > 0 || ui.activities.length > 0) && (
                  <section className="thinking-block">
                    <div className="thinking-title"><ChevronDown /><strong>执行过程</strong></div>
                    {ui.reasoning.length > 0 && <p>{ui.reasoning}</p>}
                    {ui.activities.map((activity) => (
                      <div className="activity-row" key={activity.id}>
                        {activity.status === "completed"
                          ? <CircleCheck className="activity-done" />
                          : <CircleDashed />}
                        <span>{activity.label}</span>
                      </div>
                    ))}
                  </section>
                )}

                {ui.sources.length > 0 && (
                  <section className="sources-block">
                    <strong>Sources</strong>
                    {ui.sources.map((source) => (
                      <a key={source.url} href={source.url} target="_blank" rel="noreferrer">
                        {source.title || source.url}
                      </a>
                    ))}
                  </section>
                )}
              </div>
            )}
            {showJumpToBottom && (
              <button
                className="jump-to-bottom"
                type="button"
                onClick={jumpToBottom}
              >
                <ArrowDown />回到底部
              </button>
            )}
          </div>

          <footer className="composer-area">
            {shortcutNotice !== undefined && <div className="shortcut-notice" role="status">{shortcutNotice}</div>}
            {ui.error !== undefined && <div className="safe-error">{ui.error}</div>}
            <div className="composer">
              <textarea
                ref={composerRef}
                value={input}
                placeholder="输入任务，Shift+Enter 换行"
                disabled={runtime.state !== "connected"}
                onChange={(event) => { setInput(event.target.value); setComposerCursor(event.target.selectionStart); setDismissedComposerToken(undefined); }}
                onClick={(event) => { setComposerCursor(event.currentTarget.selectionStart); setDismissedComposerToken(undefined); }}
                onKeyUp={(event) => setComposerCursor(event.currentTarget.selectionStart)}
                onKeyDown={(event) => {
                  if (!event.nativeEvent.isComposing && composerToken !== undefined) {
                    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                      event.preventDefault();
                      setComposerSelectedIndex((value) => moveComposerSelection(value, event.key === "ArrowDown" ? 1 : -1, composerSuggestions.length));
                      return;
                    }
                    if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
                      const suggestion = composerSuggestions[composerSelectedIndex];
                      if (suggestion !== undefined && !suggestion.disabled) {
                        event.preventDefault();
                        selectComposerSuggestion(suggestion);
                        return;
                      }
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setDismissedComposerToken(rawComposerTokenKey);
                      return;
                    }
                  }
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void sendMessage();
                  }
                }}
              />
              {composerToken !== undefined && (
                <ComposerSuggestions
                  items={composerSuggestions}
                  selectedIndex={composerSelectedIndex}
                  loading={composerToken.kind === "file" && workspaceSearchLoading}
                  onHover={setComposerSelectedIndex}
                  onSelect={selectComposerSuggestion}
                />
              )}
              <div className="composer-toolbar">
                <div>
                  <button className="icon-button" type="button" aria-label="添加上下文" disabled><Plus /></button>
                  <div className="agent-switch-wrap permission-mode-wrap">
                    <button
                      className={`model-select permission-mode-button${ui.snapshot?.agentConfig.agentTeam?.accessMode === "full_access" ? " is-full-access" : ""}`}
                      type="button"
                      aria-label={`权限模式：${formatAccessMode(ui.snapshot?.agentConfig.agentTeam?.accessMode)}`}
                      aria-haspopup="menu"
                      aria-expanded={permissionMenuOpen}
                      onClick={() => { setAgentSwitchOpen(false); setModelMenuOpen(false); setPermissionMenuOpen(!permissionMenuOpen); }}
                    >
                      <Shield /><span className="control-label"><span className="control-label-long">{formatAccessMode(ui.snapshot?.agentConfig.agentTeam?.accessMode)}</span><span className="control-label-short">权限</span></span><ChevronDown />
                    </button>
                    {permissionMenuOpen && <section className="agent-switch-menu permission-mode-menu" role="menu" aria-label="权限模式">
                      <header><strong>权限模式</strong><small>保存到当前 Chat，发送后冻结到本次 Job</small></header>
                      {([
                        ["read_only", "只读", "读取自动允许，执行操作需要确认"],
                        ["workspace", "工作区访问", "当前项目内的受控操作自动允许"],
                        ["full_access", "完全访问", "普通读取和执行自动允许，敏感操作仍确认"],
                      ] as const).map(([mode, title, description]) => (
                        <button key={mode} type="button" role="menuitemradio" aria-checked={(ui.snapshot?.agentConfig.agentTeam?.accessMode ?? "workspace") === mode} data-access-mode={mode} onClick={() => { setPermissionMenuOpen(false); void replaceSnapshot(window.godAgent.desktop.updateAgentTeam({ accessMode: mode })); }}>
                          <i /><span><strong>{title}</strong><small>{description}</small></span>
                        </button>
                      ))}
                      <p><Shield />子 Agent 继承本次 Job 权限，不能扩大；删除、覆盖、凭据和系统级敏感操作仍需确认。</p>
                    </section>}
                  </div>
                  <div className="agent-switch-wrap model-settings-wrap">
                    <button
                      className="model-select model-settings-button"
                      type="button"
                      aria-label={`模型与推理：${formatModelName(activeModelSettings?.model)} · ${formatReasoningEffort(activeModelSettings?.reasoningEffort)}`}
                      aria-haspopup="menu"
                      aria-expanded={modelMenuOpen}
                      disabled={(capabilities?.models.length ?? 0) === 0}
                      onClick={() => {
                        setPermissionMenuOpen(false);
                        setAgentSwitchOpen(false);
                        setModelMenuView(activePowerIndex < 0 ? "advanced" : "simple");
                        setModelMenuOpen(!modelMenuOpen);
                      }}
                    >
                      <span className="control-label"><span className="control-label-long">{formatModelName(activeModelSettings?.model)} · {formatReasoningEffort(activeModelSettings?.reasoningEffort)}</span><span className="control-label-short">模型</span></span><ChevronDown />
                    </button>
                    {modelMenuOpen && <section className="model-settings-menu" role="menu" aria-label="模型与推理">
                      {modelMenuView === "simple" ? <>
                        <header><strong>模型与推理</strong><span>{formatModelName(activeModelSettings?.model)} <b>{formatReasoningEffort(activeModelSettings?.reasoningEffort)}</b></span></header>
                        <div className="power-scale-labels"><span>更高效</span><span>更智能</span></div>
                        <div className="power-scale" role="radiogroup" aria-label="推理强度" onKeyDown={(event) => {
                          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                          event.preventDefault();
                          const current = activePowerIndex < 0 ? 0 : activePowerIndex;
                          const next = Math.max(0, Math.min(availablePowerPresets.length - 1, current + (event.key === "ArrowRight" ? 1 : -1)));
                          const preset = availablePowerPresets[next];
                          if (preset !== undefined) void replaceSnapshot(window.godAgent.desktop.selectModelSettings(preset));
                        }}>
                          {availablePowerPresets.map((preset, index) => <button
                            key={`${preset.model}-${preset.reasoningEffort}`}
                            type="button"
                            role="radio"
                            aria-label={`${formatModelName(preset.model)} · ${formatReasoningEffort(preset.reasoningEffort)}`}
                            aria-checked={index === activePowerIndex}
                            onClick={() => void replaceSnapshot(window.godAgent.desktop.selectModelSettings(preset))}
                          ><i /></button>)}
                        </div>
                        <div className="power-summary"><strong>{formatModelName(activeModelSettings?.model)} · {formatReasoningEffort(activeModelSettings?.reasoningEffort)}</strong><small>{describePower(activeModelSettings?.reasoningEffort)}</small></div>
                        <button className="model-advanced-link" type="button" onClick={() => setModelMenuView("advanced")}><span>高级设置</span><ChevronRight /></button>
                      </> : <>
                        <header className="model-advanced-header"><button type="button" onClick={() => setModelMenuView("simple")}><ChevronRight />返回</button><strong>高级设置</strong></header>
                        <label className="advanced-model-row"><span>模型</span><select value={activeModelSettings?.model ?? ""} onChange={(event) => {
                          const model = capabilities?.models.find((item) => item.id === event.target.value);
                          const currentEffort = activeModelSettings?.reasoningEffort ?? "medium";
                          const efforts = model?.reasoningEfforts ?? [];
                          const reasoningEffort = (efforts.length === 0 || efforts.includes(currentEffort))
                            ? currentEffort
                            : (["medium", "high"].find((effort) => efforts.includes(effort)) ?? efforts[0] ?? "medium") as import("../desktop-types.js").DesktopReasoningEffort;
                          void replaceSnapshot(window.godAgent.desktop.selectModelSettings({ model: event.target.value, reasoningEffort }));
                        }}>{(capabilities?.models ?? []).map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}</select></label>
                        <label className="advanced-model-row"><span>推理强度</span><select value={activeModelSettings?.reasoningEffort ?? "high"} onChange={(event) => void replaceSnapshot(window.godAgent.desktop.selectModelSettings({ model: activeModelSettings?.model ?? "", reasoningEffort: event.target.value as import("../desktop-types.js").DesktopReasoningEffort }))}>{((capabilities?.models.find((model) => model.id === activeModelSettings?.model)?.reasoningEfforts) ?? ["low", "medium", "high", "xhigh"]).map((effort) => <option key={effort} value={effort}>{formatReasoningEffort(effort)}</option>)}</select></label>
                        <button className="model-reset-button" type="button" onClick={() => {
                          const preferred = availablePowerPresets.find((preset) => preset.model === "gpt-5.6-sol" && preset.reasoningEffort === "medium") ?? availablePowerPresets[0];
                          if (preferred !== undefined) void replaceSnapshot(window.godAgent.desktop.selectModelSettings(preferred));
                        }}>重置为默认设置</button>
                      </>}
                    </section>}
                  </div>
                  <div className="agent-switch-wrap">
                    <button
                      className="model-select agent-switch-button"
                      type="button"
                      aria-label={`子 Agent：${ui.snapshot?.agentConfig.agentTeam?.mode === "off" ? "关闭" : "开启"}`}
                      aria-haspopup="menu"
                      aria-expanded={agentSwitchOpen}
                      onClick={() => { setPermissionMenuOpen(false); setModelMenuOpen(false); setAgentSwitchOpen(!agentSwitchOpen); }}
                    >
                      <span className="control-label"><span className="control-label-long">子 Agent：{ui.snapshot?.agentConfig.agentTeam?.mode === "off" ? "关闭" : "开启"}</span><span className="control-label-short">子 Agent</span></span><ChevronDown />
                    </button>
                    {agentSwitchOpen && <section className="agent-switch-menu" role="menu" aria-label="子 Agent 开关">
                      <button type="button" role="menuitemradio" aria-checked={ui.snapshot?.agentConfig.agentTeam?.mode !== "off"} onClick={() => { setAgentSwitchOpen(false); void replaceSnapshot(window.godAgent.desktop.updateAgentTeam({ mode: "auto" })); }}><i /> <span><strong>开启</strong><small>子 Agent 执行，父 Agent 监工验收</small></span></button>
                      <button type="button" role="menuitemradio" aria-checked={ui.snapshot?.agentConfig.agentTeam?.mode === "off"} onClick={() => { setAgentSwitchOpen(false); void replaceSnapshot(window.godAgent.desktop.updateAgentTeam({ mode: "off" })); }}><i /> <span><strong>关闭</strong><small>当前 Chat 只由父 Agent 执行</small></span></button>
                    </section>}
                  </div>
                </div>
                {isRunning ? (
                  <button className="primary-button" type="button" onClick={() => void window.godAgent.desktop.cancelTurn()}>
                    <i className="stop-mark" />停止
                  </button>
                ) : (
                  <button className="primary-button" type="button" disabled={input.trim().length === 0 || runtime.state !== "connected"} onClick={() => void sendMessage()}>
                    发送
                  </button>
                )}
              </div>
            </div>
          </footer>
        </main>

        <aside className="right-inspector" aria-hidden={!rightOpen}>
          <div
            className="right-inspector-resizer pane-resizer"
            role="separator"
            aria-label="调整工作区检查器宽度"
            aria-orientation="vertical"
            aria-valuemin={MIN_RIGHT_INSPECTOR_WIDTH}
            aria-valuemax={rightInspectorMaxWidth}
            aria-valuenow={visibleRightInspectorWidth}
            tabIndex={rightOpen ? 0 : -1}
            title="按住左右拖动，双击恢复默认宽度"
            onPointerDown={startRightInspectorResize}
            onPointerMove={(event) => {
              if (inspectorResizing && event.currentTarget.hasPointerCapture(event.pointerId)) {
                resizeRightInspector(event.clientX);
              }
            }}
            onPointerUp={finishRightInspectorResize}
            onPointerCancel={finishRightInspectorResize}
            onDoubleClick={resetThreePaneWidths}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft") {
                event.preventDefault();
                setRightInspectorWidth(Math.min(visibleRightInspectorWidth + 12, rightInspectorMaxWidth));
              }
              if (event.key === "ArrowRight") {
                event.preventDefault();
                setRightInspectorWidth(Math.max(visibleRightInspectorWidth - 12, MIN_RIGHT_INSPECTOR_WIDTH));
              }
              if (event.key === "Home") resetRightInspectorWidth();
            }}
          />
          <header className="inspector-header">
            <strong>工作区检查器</strong>
            <button className="icon-button" type="button" aria-label="收起右侧栏" onClick={() => setRightOpen(false)}>
              <PanelRightClose />
            </button>
          </header>
          <div className="inspector-tabs">
            <InspectorTabButton id="changes" current={inspectorTab} setCurrent={setInspectorTab}>变更</InspectorTabButton>
            <InspectorTabButton id="activity" current={inspectorTab} setCurrent={setInspectorTab}>活动</InspectorTabButton>
            <InspectorTabButton id="terminal" current={inspectorTab} setCurrent={setInspectorTab}>终端</InspectorTabButton>
            <InspectorTabButton id="browser" current={inspectorTab} setCurrent={setInspectorTab}>浏览器</InspectorTabButton>
            <InspectorTabButton id="extensions" current={inspectorTab} setCurrent={setInspectorTab}>扩展</InspectorTabButton>
          </div>
          <div className="inspector-content">
            {inspectorTab === "changes" && <DeferredPanel icon={<FileCode2 />} title="变更检查尚未接入">遵守本轮 Git 边界，客户端不会偷偷执行 git diff。后续将通过只读 Workspace Adapter 单独实现。</DeferredPanel>}
            {inspectorTab === "terminal" && <DeferredPanel icon={<TerminalSquare />} title="桌面终端尚未接入">Runtime 当前只允许预注册的 check/test 命令；任意终端需要独立安全设计。</DeferredPanel>}
            {inspectorTab === "activity" && (
              <div className="inspector-list inspector-agent-runtime">
                <div className="inspector-summary"><Activity />当前 Turn · {formatThreadState(ui.snapshot?.turnState ?? "idle")} · {activeAgentCount} Agents</div>
                <OutcomeUnknownPanel
                  records={ui.snapshot?.outcomeUnknownInvocations ?? []}
                  resolve={async (input) => {
                    dispatch({ type: "clear-error" });
                    try {
                      const record = await window.godAgent.desktop.resolveOutcomeUnknown(input);
                      dispatch({ type: "outcome-unknown-updated", record });
                    } catch (error) {
                      dispatch({ type: "error", message: readError(error) });
                    }
                  }}
                />
                {(ui.snapshot?.agentRuns.length ?? 0) > 0 && (
                  <AgentFlowProgress
                    runs={ui.snapshot!.agentRuns}
                    runtime={ui.snapshot!.agentRuntime}
                    requirement={ui.snapshot!.requirement}
                    activeAgentThreadId={ui.snapshot!.activeAgentThreadId}
                    openAgent={(run) => {
                      setSelectedAgentRunId(run.id);
                      void replaceSnapshot(window.godAgent.desktop.selectAgentThread(run.threadId));
                    }}
                    advance={async (stage) => {
                    dispatch({ type: "clear-error" });
                    try { dispatch({ type: "snapshot", snapshot: await window.godAgent.desktop.advanceFixedProduct(stage) }); }
                    catch (error) { dispatch({ type: "error", message: readError(error) }); }
                    }}
                  />
                )}
                {ui.activities.length === 0
                  ? <p className="inspector-empty">发送任务后，这里显示真实 Tool、Search 和模型活动。</p>
                  : ui.activities.map((item) => (
                      <div className="inspector-row" key={item.id}>
                        {item.status === "completed" ? <CircleCheck /> : <CircleDashed />}
                        <span>{item.label}</span>
                      </div>
                    ))}
              </div>
            )}
            {inspectorTab === "browser" && (
              <BrowserPanel
                browserState={browserState}
                setBrowserState={setBrowserState}
                preview={preview}
                busy={previewBusy}
                suspended={permissionRequest !== undefined || sidebarResizing || inspectorResizing}
                openLocal={() => {
                  setPreviewBusy(true);
                  const start = preview.state === "running"
                    ? Promise.resolve(preview)
                    : window.godAgent.preview.start();
                  void start
                    .then(async (status) => {
                      setPreview(status);
                      if (status.state === "running") setBrowserState(await window.godAgent.browser.createTab(status.url));
                    })
                    .finally(() => setPreviewBusy(false));
                }}
              />
            )}
            {inspectorTab === "extensions" && (
              <ExtensionsPanel capabilities={capabilities} />
            )}
          </div>
        </aside>
      </div>
      {commandPaletteOpen && (
        <CommandPalette
          items={commandPaletteItems}
          onClose={() => setCommandPaletteOpen(false)}
          onRun={runDesktopAction}
        />
      )}
      {permissionRequest !== undefined && (
        <div className="permission-backdrop" role="presentation">
          <section className="permission-dialog" role="dialog" aria-modal="true" aria-labelledby="permission-title">
            <div className="permission-risk" data-risk={permissionRequest.riskLevel}>
              权限请求 · {permissionRequest.riskLevel === "read" ? "读取" : permissionRequest.riskLevel === "execute" ? "执行" : "敏感操作"}
            </div>
            <h2 id="permission-title">允许 {permissionRequest.agentName ?? "Agent"} 使用 {permissionRequest.toolName}？</h2>
            <div className="permission-context">Chat {permissionRequest.threadId ?? permissionRequest.turnId} · Job {permissionRequest.jobId ?? "当前"}</div>
            <div className="permission-context">Agent {permissionRequest.agentName ?? permissionRequest.agentId ?? "当前 Agent"} · Task {permissionRequest.taskTitle ?? permissionRequest.taskId ?? "当前任务"} · Tool {permissionRequest.toolName}</div>
            <p>{permissionRequest.description ?? "该工具请求执行一项操作。"}</p>
            <small>客户端不会展示或传递原始 Tool 参数。</small>
            <div className="permission-actions">
              <button type="button" onClick={() => void answerPermission("deny")}>拒绝</button>
              <button type="button" onClick={() => void answerPermission("allow", "session")}>本会话允许</button>
              <button className="permission-primary" type="button" onClick={() => void answerPermission("allow", "once")}>允许一次</button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

type AgentFlowStepState = "done" | "active" | "waiting" | "rework";

function OutcomeUnknownPanel({ records, resolve }: {
  records: DesktopOutcomeUnknownResolution[];
  resolve: (input: DesktopResolveOutcomeUnknownInput) => Promise<void>;
}) {
  const [selectedId, setSelectedId] = useState<string>();
  const [reason, setReason] = useState("");
  const [externalSummary, setExternalSummary] = useState("");
  const [externalJson, setExternalJson] = useState("{}");
  const [toolSideEffectConfirmed, setToolSideEffectConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string>();
  if (records.length === 0) return null;

  async function submit(
    record: DesktopOutcomeUnknownResolution,
    action: DesktopResolveOutcomeUnknownInput["resolution"]["action"],
  ) {
    if (reason.trim().length === 0) {
      setFormError("请填写处置原因，便于审计。");
      return;
    }
    let resolution: DesktopResolveOutcomeUnknownInput["resolution"];
    if (action === "record_external_result") {
      if (externalSummary.trim().length === 0) {
        setFormError("请填写外部结果摘要。");
        return;
      }
      try {
        resolution = {
          action,
          reason,
          externalResult: { summary: externalSummary, value: JSON.parse(externalJson) as unknown },
        };
      } catch {
        setFormError("外部结果详情必须是有效 JSON。");
        return;
      }
    } else if (action === "confirm_not_executed_retry") {
      resolution = { action, reason, ...(toolSideEffectConfirmed ? { toolSideEffectConfirmed: true } : {}) };
    } else {
      resolution = { action, reason };
    }
    setFormError(undefined);
    setBusy(true);
    try {
      await resolve({
        resolutionId: record.resolutionId,
        expectedVersion: record.version,
        idempotencyKey: `desktop:${record.resolutionId}:${record.version}:${action}`,
        resolution,
      });
      setSelectedId(undefined);
      setReason("");
      setExternalSummary("");
      setExternalJson("{}");
      setToolSideEffectConfirmed(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="outcome-unknown-panel" aria-label="结果未知调用处置">
      <header>
        <span><Shield />结果未知调用</span>
        <b>{records.filter((record) => record.state === "outcome_unknown" || record.state === "manual_required").length}</b>
      </header>
      <p>默认不会自动重放。身份与请求摘要来自 Runtime，只读且不可修改。</p>
      {records.map((record) => {
        const actionable = record.state === "outcome_unknown" || record.state === "manual_required";
        const expanded = selectedId === record.resolutionId;
        return (
          <article className="outcome-unknown-card" data-state={record.state} key={record.resolutionId}>
            <button type="button" className="outcome-unknown-heading" aria-expanded={expanded} onClick={() => {
              setSelectedId(expanded ? undefined : record.resolutionId);
              setFormError(undefined);
            }}>
              <span><strong>{record.identity.displayName}</strong><small>{record.invocationKind === "tool" ? `Tool · ${record.identity.toolName}` : `Model · ${record.identity.model ?? record.identity.provider ?? "未知模型"}`}</small></span>
              <i>{formatOutcomeUnknownState(record.state)}</i>
              <ChevronRight />
            </button>
            {expanded && (
              <div className="outcome-unknown-details">
                <dl>
                  <div><dt>Invocation</dt><dd>{record.invocationId}</dd></div>
                  <div><dt>请求摘要</dt><dd title={record.requestDigest}>{record.requestDigest.slice(0, 23)}…</dd></div>
                  <div><dt>Chat / Turn</dt><dd>{record.identity.threadId} / {record.identity.turnId}</dd></div>
                  <div><dt>副作用风险</dt><dd>{formatSideEffectRisk(record.sideEffectRisk)}</dd></div>
                  <div><dt>版本</dt><dd>v{record.version}</dd></div>
                </dl>
                {record.externalResult !== undefined && <div className="outcome-external-result"><strong>已录入外部结果</strong><span>{record.externalResult.summary}</span></div>}
                {record.retryTicket !== undefined && <div className="outcome-retry-ticket"><strong>已授权重试</strong><span>票据 {record.retryTicket.id} · 不会自动重放</span></div>}
                {record.audit.length > 0 && (
                  <details className="outcome-audit">
                    <summary>审计记录（{record.audit.length}）</summary>
                    {record.audit.map((audit) => <div key={audit.id}><strong>{formatOutcomeAction(audit.action)}</strong><span>{audit.actorId} · {new Date(audit.occurredAt).toLocaleString()}</span><small>{audit.reason}</small></div>)}
                  </details>
                )}
                {actionable && (
                  <div className="outcome-resolution-form">
                    <label>处置原因<input value={reason} maxLength={2_000} onChange={(event) => setReason(event.target.value)} placeholder="写明外部核对依据" /></label>
                    <label>外部结果摘要<input value={externalSummary} maxLength={2_000} onChange={(event) => setExternalSummary(event.target.value)} placeholder="仅录入结果时填写" /></label>
                    <label>外部结果详情（JSON）<textarea value={externalJson} onChange={(event) => setExternalJson(event.target.value)} rows={3} /></label>
                    {record.invocationKind === "tool" && record.sideEffectRisk !== "none" && (
                      <label className="outcome-side-effect-confirm"><input type="checkbox" checked={toolSideEffectConfirmed} onChange={(event) => setToolSideEffectConfirmed(event.target.checked)} />我已从外部系统确认该 Tool 的副作用没有发生</label>
                    )}
                    {formError !== undefined && <small className="outcome-form-error">{formError}</small>}
                    <div className="outcome-resolution-actions">
                      <button type="button" disabled={busy} onClick={() => void submit(record, "confirm_not_executed_retry")}>确认未执行后重试</button>
                      <button type="button" disabled={busy} onClick={() => void submit(record, "record_external_result")}>录入外部结果并提交</button>
                      <button type="button" disabled={busy || record.state === "manual_required"} onClick={() => void submit(record, "mark_manual_required")}>需人工处理</button>
                      <button type="button" className="danger" disabled={busy} onClick={() => void submit(record, "abandon")}>放弃</button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </article>
        );
      })}
    </section>
  );
}

function formatOutcomeUnknownState(state: DesktopOutcomeUnknownResolution["state"]): string {
  return ({
    outcome_unknown: "等待处置",
    retry_authorized: "已授权重试",
    external_result_recorded: "已录入结果",
    manual_required: "需人工处理",
    abandoned: "已放弃",
  })[state];
}

function formatSideEffectRisk(risk: DesktopOutcomeUnknownResolution["sideEffectRisk"]): string {
  return risk === "none" ? "无" : risk === "known" ? "已知副作用" : "可能有副作用";
}

function formatOutcomeAction(action: DesktopOutcomeUnknownResolution["audit"][number]["action"]): string {
  return ({
    confirm_not_executed_retry: "确认未执行并授权重试",
    record_external_result: "录入外部结果",
    mark_manual_required: "标记人工处理",
    abandon: "放弃",
  })[action];
}

function AgentFlowProgress({ runs, runtime, requirement, activeAgentThreadId, openAgent, advance }: {
  runs: import("../desktop-types.js").DesktopAgentRun[];
  runtime: import("../desktop-types.js").DesktopAgentRuntimeView | undefined;
  requirement: import("../../requirements/requirement.js").Requirement | undefined;
  activeAgentThreadId: string | undefined;
  openAgent: (run: import("../desktop-types.js").DesktopAgentRun) => void;
  advance: (stage: import("../../agents/fixed-software-team-coordinator.js").FixedProductStage) => Promise<void>;
}) {
  const [executionExpanded, setExecutionExpanded] = useState(false);
  const furthestStepByJob = useRef(new Map<string, number>());
  const latestRunByThread = new Map<string, import("../desktop-types.js").DesktopAgentRun>();
  for (const run of runs.filter((item) => item.parentRunId !== undefined)) {
    const previous = latestRunByThread.get(run.threadId);
    if (previous === undefined || run.attempt >= previous.attempt) latestRunByThread.set(run.threadId, run);
  }
  const childRuns = [...latestRunByThread.values()];
  const terminalRunStates = new Set(["completed", "failed", "cancelled", "timed_out"]);
  const finishedRuns = childRuns.filter((run) => terminalRunStates.has(run.status)).length;
  const runningRuns = childRuns.filter((run) => ["queued", "running", "waiting_children", "resuming"].includes(run.status)).length;
  const consumedReturns = runtime?.returns.filter((item) => item.status === "consumed").length ?? 0;
  const latestReviewByTask = new Map<string, import("../../agents/agent-runtime.js").AgentEvidence>();
  for (const review of (runtime?.evidence ?? []).filter((item) => item.kind === "review").sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))) latestReviewByTask.set(review.taskId, review);
  const passedReviews = [...latestReviewByTask.values()].filter((item) => item.verdict === "passed").length;
  const failedReviews = [...latestReviewByTask.values()].filter((item) => item.verdict === "failed").length;
  const reworkTasks = runtime?.tasks.filter((item) => item.status === "rework").length ?? 0;
  const requirementConfirmed = requirement !== undefined && !["clarifying", "planned"].includes(requirement.status);
  const dispatched = childRuns.length > 0 || (runtime?.tasks.length ?? 0) > 0;
  const hasRework = reworkTasks > 0 || failedReviews > 0;
  const jobStatus = runtime?.job?.status;
  const jobCompleted = jobStatus === "completed" || requirement?.status === "completed";
  const executionFinished = childRuns.length > 0 && finishedRuns === childRuns.length;
  const reviewActive = jobStatus === "reviewing" || (runtime?.tasks.some((item) => item.status === "reviewing") ?? false);
  let derivedCurrentStep = 1;
  if (requirementConfirmed) derivedCurrentStep = 2;
  if (dispatched) derivedCurrentStep = 3;
  if (executionFinished && (reviewActive || hasRework || passedReviews > 0)) derivedCurrentStep = 4;
  if (executionFinished && !reviewActive && !hasRework && (passedReviews > 0 || ["waiting_returns", "resuming"].includes(jobStatus ?? ""))) derivedCurrentStep = 5;
  if (jobCompleted) derivedCurrentStep = 6;
  const flowKey = runtime?.job?.id ?? requirement?.id ?? runs[0]?.jobId ?? "current";
  const currentStep = Math.max(derivedCurrentStep, furthestStepByJob.current.get(flowKey) ?? 1);
  furthestStepByJob.current.set(flowKey, currentStep);
  const stateFor = (index: number): AgentFlowStepState => {
    if (index < currentStep || currentStep === 6) return "done";
    if (index > currentStep) return "waiting";
    if ((index === 3 || index === 4) && hasRework) return "rework";
    return "active";
  };
  const completedSteps = currentStep === 6 ? 5 : Math.max(0, currentStep - 1);
  const flowSteps = [
    { label: "确认需求", detail: requirementConfirmed ? `v${requirement?.revision ?? 1} 已确认` : "等待确认" },
    { label: "分派任务", detail: dispatched ? `已分派 ${childRuns.length || runtime?.tasks.length || 0} 个任务` : "等待 God 分派" },
    { label: "Agent 执行", detail: childRuns.length === 0 ? "等待 Agent 启动" : `${finishedRuns}/${childRuns.length} 已结束${runningRuns > 0 ? ` · ${runningRuns} 进行中` : ""}` },
    { label: "Reviewer 验收", detail: hasRework ? `${Math.max(reworkTasks, failedReviews)} 项需返工` : passedReviews > 0 ? `${passedReviews} 项已通过` : "等待验收" },
    { label: "God 汇总", detail: jobCompleted ? "最终结果已完成" : currentStep === 5 ? "正在收口最终结果" : "等待前序完成" },
  ];
  const returnCount = runtime?.returns.length ?? 0;
  const substages: Array<{ label: string; detail: string; state: AgentFlowStepState }> = [
    { label: "子任务分派", detail: dispatched ? "已完成" : "等待分派", state: dispatched ? "done" : currentStep === 2 ? "active" : "waiting" },
    { label: "并行执行", detail: childRuns.length === 0 ? "尚未开始" : `${finishedRuns}/${childRuns.length} 已结束`, state: executionFinished ? "done" : currentStep === 3 && !hasRework ? "active" : "waiting" },
    { label: "返工处理", detail: hasRework ? `${Math.max(reworkTasks, failedReviews)} 项处理中` : "暂无返工", state: hasRework ? "rework" : executionFinished ? "done" : "waiting" },
    { label: "Return 回传", detail: returnCount === 0 ? "等待回传" : `${consumedReturns}/${returnCount} 已接收`, state: returnCount > 0 && consumedReturns === returnCount ? "done" : returnCount > 0 ? "active" : "waiting" },
  ];
  return (
    <section className="agent-flow-progress" aria-label="God Agent 协作流程">
      <header className="agent-flow-header">
        <span><strong>协作流程</strong><small>{currentStep === 6 ? "全部完成" : `正在进行第 ${currentStep} 步`}</small></span>
        <strong>{completedSteps}/5</strong>
      </header>
      <div className="agent-flow-track" aria-hidden="true"><span style={{ width: `${(completedSteps / 5) * 100}%` }} /></div>
      <ol className="agent-flow-steps">
        {flowSteps.map((step, index) => {
          const stepNumber = index + 1;
          const state = stateFor(stepNumber);
          const isExecutionStep = stepNumber === 3;
          return <li key={step.label} className="agent-flow-step" data-state={state}>
            {isExecutionStep ? (
              <button type="button" className="agent-flow-step-button" aria-expanded={executionExpanded} aria-controls="agent-execution-substages" onClick={() => setExecutionExpanded((value) => !value)}>
                <span className="agent-flow-step-marker">{state === "done" ? <CircleCheck /> : stepNumber}</span>
                <span><strong>{step.label}</strong><small>{step.detail}</small></span>
                {executionExpanded ? <ChevronDown /> : <ChevronRight />}
              </button>
            ) : (
              <div className="agent-flow-step-content">
                <span className="agent-flow-step-marker">{state === "done" ? <CircleCheck /> : stepNumber}</span>
                <span><strong>{step.label}</strong><small>{step.detail}</small></span>
              </div>
            )}
            {isExecutionStep && executionExpanded && (
              <ol className="agent-flow-substages" id="agent-execution-substages">
                {substages.map((substage) => <li key={substage.label} data-state={substage.state}><span /><span><strong>{substage.label}</strong><small>{substage.detail}</small></span></li>)}
              </ol>
            )}
          </li>;
        })}
      </ol>
      {runtime?.fixedProductStage !== undefined && runtime.fixedProductStage !== "completed" && <button className="fixed-product-advance agent-flow-next-action" type="button" onClick={() => void advance(runtime.fixedProductStage!)}>{formatFixedProductAction(runtime.fixedProductStage)}</button>}
      <section className="agent-flow-agents" aria-label="子 Agent 最新工作">
        <header><strong>Agent 动态</strong><small>{childRuns.length} 个</small></header>
        {childRuns.length === 0 ? <p className="agent-flow-empty">任务分派后，这里会显示每个 Agent 的最新工作。</p> : (
          <ul>{childRuns.map((run) => {
            const latestWork = formatAgentLatestWork(run, runtime);
            return <li key={run.id} data-status={run.status}>
              <button type="button" className="agent-flow-agent-button" aria-current={activeAgentThreadId === run.threadId} onClick={() => openAgent(run)}>
                <span className="agent-status-dot" />
                <span><span><strong>{formatAgentProfileName(run.agentProfileId)}</strong><small>{formatAgentState(run.status)}</small></span><small className="agent-flow-agent-latest" title={latestWork}>{latestWork}</small></span>
                <ChevronRight />
              </button>
            </li>;
          })}</ul>
        )}
      </section>
    </section>
  );
}

function HistoryAgentTree({ runs, requirement, runtime, selectedId, select }: {
  runs: import("../desktop-types.js").DesktopAgentRun[];
  requirement: import("../../requirements/requirement.js").Requirement | undefined;
  runtime: import("../desktop-types.js").DesktopAgentRuntimeView | undefined;
  selectedId: string | undefined;
  select: (run: import("../desktop-types.js").DesktopAgentRun | undefined) => void;
}) {
  const children = new Map<string, typeof runs>();
  for (const run of runs) {
    if (run.parentRunId === undefined) continue;
    children.set(run.parentRunId, [...(children.get(run.parentRunId) ?? []), run]);
  }
  const renderRun = (run: typeof runs[number]) => <li key={run.id} data-status={run.status}>
    <button type="button" aria-expanded={selectedId === run.id} onClick={() => select(selectedId === run.id ? undefined : run)}>
      <span className="agent-status-dot" />
      <span><strong>{formatAgentProfileName(run.agentProfileId)}</strong><small>{formatAgentState(run.status)} · {formatAgentResponsibility(run.agentProfileId)}</small></span>
      <ChevronRight />
    </button>
    {selectedId === run.id && <small className={`history-agent-detail${run.safeError === undefined ? "" : " is-error"}`}>{run.safeError ?? `打开真实对话：${run.task}`}</small>}
    {(children.get(run.id)?.length ?? 0) > 0 && <ul>{children.get(run.id)!.map(renderRun)}</ul>}
  </li>;
  const roots = runs.filter((run) => run.parentRunId === undefined);
  return <div className="history-workflow-tree">
    <div className="history-god-node"><strong>God</strong><small>{requirement === undefined ? "当前 Chat" : `${requirement.title} · v${requirement.revision}`}</small></div>
    <details className="history-team-node" open>
      <summary><strong>软件产品演示团队</strong><small>{runtime?.job?.status ?? "等待启动"} · 1 位负责人 / 3 个角色</small></summary>
      <p>目标：产品、工程、测试逐级向负责人 Return，负责人验收后再 Return God。</p>
      <ul className="history-agent-tree" aria-label="当前 Chat 固定软件团队树">
        {roots.flatMap((root) => children.get(root.id) ?? []).map(renderRun)}
      </ul>
    </details>
  </div>;
}

function formatAgentLatestWork(run: import("../desktop-types.js").DesktopAgentRun, runtime: import("../desktop-types.js").DesktopAgentRuntimeView | undefined): string {
  const matchesTask = (taskId: string | undefined) => run.taskId !== undefined && taskId === run.taskId;
  const candidates: Array<{ summary: string; createdAt: string }> = [];
  for (const item of runtime?.evidence ?? []) {
    if (item.runId === run.id || matchesTask(item.taskId)) candidates.push({ summary: item.summary, createdAt: item.createdAt });
  }
  for (const item of runtime?.board ?? []) {
    const boardTaskId = "taskId" in item && typeof item.taskId === "string" ? item.taskId : undefined;
    if (item.producerRunId === run.id || matchesTask(boardTaskId)) candidates.push({ summary: item.summary, createdAt: item.createdAt });
  }
  for (const item of runtime?.returns ?? []) {
    if (item.childRunId === run.id || matchesTask(item.taskId)) candidates.push({ summary: item.result.summary, createdAt: item.createdAt });
  }
  const task = runtime?.tasks.find((item) => item.id === run.taskId);
  const latest = candidates.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0]?.summary.trim();
  return latest || run.safeError || (task === undefined ? run.task : `${formatAgentState(run.status)} · ${task.objective || task.title}`);
}

function formatAgentProfileName(profileId: string | undefined): string {
  const names: Record<string, string> = {
    orchestrator: "God", software_team_lead: "软件团队负责人",
    product_role: "产品角色 Agent", engineering_role: "工程角色 Agent", quality_role: "测试角色 Agent",
    investigator: "排查 Agent", researcher: "资料 Agent", coder: "编程 Agent", tester: "测试 Agent", reviewer: "审查 Agent",
  };
  return profileId === undefined ? "Agent" : names[profileId] ?? profileId;
}

function formatAgentResponsibility(profileId: string): string {
  const responsibilities: Record<string, string> = {
    software_team_lead: "拆分、监工、验收，并只把合格结果 Return God",
    product_role: "只负责产品需求、页面结构与产品验收条件",
    engineering_role: "只负责工程方案和获准的实现工作",
    quality_role: "独立检查产品与工程结果，不修改前两者产物",
    reviewer: "独立审查证据和回归风险",
  };
  return responsibilities[profileId] ?? "完成当前任务合同并向直属父级 Return";
}

function formatAccessMode(mode: import("../../agents/agent-runtime.js").AgentAccessMode | undefined): string {
  if (mode === "read_only") return "只读";
  if (mode === "full_access") return "完全访问";
  return "工作区访问";
}

function formatModelName(model: string | undefined): string {
  if (model === undefined || model.length === 0) return "Runtime";
  return model.replace(/^gpt-/i, "").replace(/(^|-)\w/g, (part) => part.replace("-", " ").toUpperCase());
}

function formatReasoningEffort(effort: string | undefined): string {
  if (effort === "xhigh") return "XHigh";
  if (effort === undefined || effort.length === 0) return "High";
  return effort[0]!.toUpperCase() + effort.slice(1);
}

function describePower(effort: string | undefined): string {
  if (effort === "low") return "适合快速处理清晰、直接的日常任务";
  if (effort === "medium") return "在响应速度和深入思考之间保持平衡";
  if (effort === "xhigh" || effort === "max") return "适合高难度、长链路且需要深入推演的任务";
  return "适合复杂、多步骤且需要检查的任务";
}

function formatFixedProductAction(stage: import("../../agents/fixed-software-team-coordinator.js").FixedProductStage): string {
  if (stage === "ready_first_return") return "1. 产品生成第一轮 Return";
  if (stage === "first_return_ready") return "2. 负责人验收并驳回";
  if (stage === "rework") return "3. 原产品 Thread 返工（Attempt 2）";
  if (stage === "second_return_ready") return "4. 负责人通过并 Return God";
  if (stage === "lead_return_ready") return "5. God 接收并单次汇总";
  return "完整项目闭环已完成";
}

function formatThreadState(state: import("../desktop-types.js").DesktopTurnState): string {
  if (["starting", "thinking", "searching", "running_tool", "answering"].includes(state)) return "运行中";
  if (state === "cancelling") return "正在停止";
  if (state === "completed") return "已完成";
  if (state === "failed" || state === "timed_out") return "失败";
  if (state === "cancelled") return "已取消";
  return "空闲";
}

function formatAgentState(state: import("../desktop-types.js").DesktopAgentRun["status"]): string {
  const labels: Record<typeof state, string> = {
    queued: "排队中", running: "运行中", waiting_children: "等待子 Agent",
    resuming: "自动续跑", completed: "已返回", failed: "失败", cancelled: "已取消", timed_out: "超时",
  };
  return labels[state];
}

function ModuleButton(props: {
  icon: React.ReactNode;
  label: string;
  count?: number;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button className="module-button" type="button" aria-pressed={props.active === true} onClick={props.onClick}>
      {props.icon}<span>{props.label}</span>
      {props.count !== undefined && <small>{props.count}</small>}
    </button>
  );
}

function InspectorTabButton(props: {
  id: InspectorTab;
  current: InspectorTab;
  setCurrent: (tab: InspectorTab) => void;
  children: React.ReactNode;
}) {
  return <button type="button" aria-selected={props.current === props.id} onClick={() => props.setCurrent(props.id)}>{props.children}</button>;
}

function DeferredPanel(props: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return <div className="deferred-panel"><span>{props.icon}</span><strong>{props.title}</strong><p>{props.children}</p></div>;
}

function ExtensionsPanel(props: { capabilities: RuntimeCapabilities | undefined }) {
  const capabilities = props.capabilities;
  if (capabilities === undefined) {
    return <p className="inspector-empty">正在读取 Runtime 能力…</p>;
  }
  return (
    <div className="extension-list">
      <ExtensionRow icon={<Bot />} title="模型 Runtime" meta={capabilities.llm ? "已连接" : "未配置"} enabled={capabilities.llm} />
      <ExtensionRow icon={<Wrench />} title="Tools" meta={`${capabilities.tools.length} 个可用工具`} enabled={capabilities.tools.length > 0} />
      <ExtensionRow icon={<Sparkles />} title="Skills" meta={`${capabilities.skills.length} 个已发现`} enabled={capabilities.skills.length > 0} />
      <ExtensionRow icon={<Plug />} title="MCP Servers" meta={`${capabilities.mcpServers.length} 个已连接`} enabled={capabilities.mcpServers.length > 0} />
      <ExtensionRow icon={<Globe2 />} title="Web Search" meta={capabilities.webSearch ? "Sources 与 Citation 可用" : "不可用"} enabled={capabilities.webSearch} />
      {capabilities.mcpServers.map((server) => (
        <ExtensionRow key={server.name} icon={<Plug />} title={server.name} meta={`${server.protocolVersion} · ${server.toolCount} tools`} enabled />
      ))}
    </div>
  );
}

function BrowserPanel(props: {
  browserState: BrowserState | undefined;
  setBrowserState: (state: BrowserState) => void;
  preview: { state: "stopped" } | { state: "running"; url: string };
  busy: boolean;
  suspended: boolean;
  openLocal: () => void;
}) {
  const [address, setAddress] = useState("");
  const [actionError, setActionError] = useState<string>();
  const surfaceRef = useRef<HTMLDivElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const addressFocusedRef = useRef(false);
  const activeTab = props.browserState?.tabs.find((tab) => tab.id === props.browserState?.activeTabId);

  useEffect(() => {
    if (!addressFocusedRef.current) setAddress(activeTab?.url ?? "");
  }, [activeTab?.id, activeTab?.url]);

  useEffect(() => window.godAgent.browser.onCommand(() => {
    window.requestAnimationFrame(() => {
      addressRef.current?.focus();
      addressRef.current?.select();
    });
  }), []);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (surface === null) return;
    let frame: number | undefined;
    const publishBounds = () => {
      frame = undefined;
      const rect = surface.getBoundingClientRect();
      window.godAgent.browser.setBounds({
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        visible: !props.suspended && rect.width > 0 && rect.height > 0,
      });
    };
    const scheduleBounds = () => {
      if (frame === undefined) frame = window.requestAnimationFrame(publishBounds);
    };
    const observer = new ResizeObserver(scheduleBounds);
    observer.observe(surface);
    window.addEventListener("resize", scheduleBounds);
    scheduleBounds();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", scheduleBounds);
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      window.godAgent.browser.setBounds({ x: 0, y: 0, width: 0, height: 0, visible: false });
    };
  }, [activeTab !== undefined, props.suspended]);

  const apply = (operation: Promise<BrowserState>) => {
    setActionError(undefined);
    void operation.then(props.setBrowserState).catch((error: unknown) => setActionError(readError(error)));
  };

  if (props.browserState === undefined || activeTab === undefined) {
    return <div className="browser-workbench"><div className="browser-loading-state"><CircleDashed /><span>正在启动浏览器…</span></div></div>;
  }

  const createTab = () => {
    setActionError(undefined);
    void window.godAgent.browser.createTab()
      .then((state) => {
        props.setBrowserState(state);
        window.requestAnimationFrame(() => addressRef.current?.focus());
      })
      .catch((error: unknown) => setActionError(readError(error)));
  };

  return <div className="browser-workbench">
    <div className="browser-tab-strip">
      <div className="browser-tabs" role="tablist" aria-label="网页标签">
        {props.browserState.tabs.map((tab) => (
          <div
            className={`browser-tab${tab.id === props.browserState?.activeTabId ? " is-active" : ""}`}
            role="tab"
            tabIndex={0}
            aria-selected={tab.id === props.browserState?.activeTabId}
            key={tab.id}
            title={tab.title}
            onClick={() => apply(window.godAgent.browser.activateTab(tab.id))}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                apply(window.godAgent.browser.activateTab(tab.id));
              }
            }}
          >
            {tab.faviconUrl
              ? <img src={tab.faviconUrl} alt="" referrerPolicy="no-referrer" />
              : <Globe2 className={tab.isLoading ? "is-loading" : ""} />}
            <span>{tab.title}</span>
            <span
              className="browser-tab-close"
              role="button"
              tabIndex={0}
              aria-label={`关闭 ${tab.title}`}
              onClick={(event) => { event.stopPropagation(); apply(window.godAgent.browser.closeTab(tab.id)); }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  event.stopPropagation();
                  apply(window.godAgent.browser.closeTab(tab.id));
                }
              }}
            ><X /></span>
          </div>
        ))}
      </div>
      <button className="browser-new-tab-action" type="button" aria-label="新建标签页" onClick={createTab}><Plus /></button>
    </div>
    <div className="browser-navigation">
      <button className="browser-history-action" type="button" disabled={!activeTab.canGoBack} onClick={() => apply(window.godAgent.browser.goBack(activeTab.id))} aria-label="后退"><ArrowLeft /></button>
      <button className="browser-history-action" type="button" disabled={!activeTab.canGoForward} onClick={() => apply(window.godAgent.browser.goForward(activeTab.id))} aria-label="前进"><ArrowRight /></button>
      <button type="button" onClick={() => apply(activeTab.isLoading ? window.godAgent.browser.stop(activeTab.id) : window.godAgent.browser.reload(activeTab.id))} aria-label={activeTab.isLoading ? "停止加载" : "刷新"}>{activeTab.isLoading ? <X /> : <RotateCw />}</button>
      <form className="browser-address" data-error={Boolean(activeTab.error || actionError)} onSubmit={(event) => {
        event.preventDefault();
        apply(window.godAgent.browser.navigate(activeTab.id, address));
        addressRef.current?.blur();
      }}>
        <Globe2 />
        <input
          ref={addressRef}
          value={address}
          aria-label="地址栏"
          placeholder="搜索或输入网址"
          title={activeTab.error ?? actionError ?? activeTab.url}
          onChange={(event) => setAddress(event.target.value)}
          onFocus={(event) => { addressFocusedRef.current = true; event.currentTarget.select(); }}
          onBlur={() => { addressFocusedRef.current = false; setAddress(activeTab.url); }}
          spellCheck={false}
        />
      </form>
      <button className="browser-local-action browser-secondary-action" type="button" disabled={props.busy} onClick={props.openLocal} title="在新标签打开今日运势签"><Sparkles /><span>{props.preview.state === "running" ? "本地" : "启动"}</span></button>
      <button className="browser-secondary-action" type="button" disabled={!activeTab.url} onClick={() => void window.godAgent.browser.openExternal(activeTab.id)} aria-label="外部打开"><ExternalLink /></button>
    </div>
    <div className="browser-surface" ref={surfaceRef} aria-label="网页内容" />
  </div>;
}

function ExtensionRow(props: { icon: React.ReactNode; title: string; meta: string; enabled: boolean }) {
  return <div className="extension-row"><span className="extension-icon">{props.icon}</span><span><strong>{props.title}</strong><small>{props.meta}</small></span><i data-enabled={props.enabled}>{props.enabled ? "在线" : "关闭"}</i></div>;
}

function RuntimeEmptyState({ status }: { status: RuntimeStatus }) {
  return <div className="center-state"><CircleDashed /><strong>{status.message}</strong><p>App Server 完成安全握手后会恢复任务历史。</p></div>;
}

function EmptyConversation() {
  return <div className="center-state"><span className="empty-logo">g</span><strong>今天想构建什么？</strong><p>在下方输入任务，或者从左侧选择历史记录。</p></div>;
}

function useStoredBoolean(key: string, fallback: boolean) {
  const [value, setValue] = useState(() => {
    const stored = localStorage.getItem(key);
    return stored === null ? fallback : stored === "true";
  });
  const update = useCallback((next: boolean) => {
    localStorage.setItem(key, String(next));
    setValue(next);
  }, [key]);
  return [value, update] as const;
}

function useStoredNumber(key: string, fallback: number) {
  const [value, setValue] = useState(() => {
    const stored = Number(localStorage.getItem(key));
    return Number.isFinite(stored) && stored > 0 ? stored : fallback;
  });
  const update = useCallback((next: number) => {
    const rounded = Math.round(next);
    localStorage.setItem(key, String(rounded));
    setValue(rounded);
  }, [key]);
  return [value, update] as const;
}

function getRightInspectorMaxWidth(viewportWidth: number, leftWidth: number) {
  const workspaceSafeWidth = viewportWidth - leftWidth - MIN_WORKSPACE_WIDTH;
  return Math.max(
    MIN_RIGHT_INSPECTOR_WIDTH,
    Math.min(MAX_RIGHT_INSPECTOR_WIDTH, workspaceSafeWidth),
  );
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function readError(error: unknown): string {
  return error instanceof Error ? error.message : "桌面操作失败，请稍后重试";
}
