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
  DesktopPermissionRequest,
  DesktopThreadSummary,
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
  const draftsRef = useRef(new Map<string, string>());
  const [historyQuery, setHistoryQuery] = useState("");
  const [showHistorySearch, setShowHistorySearch] = useState(false);
  const [agentSwitchOpen, setAgentSwitchOpen] = useState(false);
  const [permissionMenuOpen, setPermissionMenuOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelMenuView, setModelMenuView] = useState<"simple" | "advanced">("simple");
  const [historyMenu, setHistoryMenu] = useState<{ kind: "group" | "thread"; id: string }>();
  const [editingThreadId, setEditingThreadId] = useState<string>();
  const [editingTitle, setEditingTitle] = useState("");
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
  const autoFollowRef = useRef(true);
  const pendingEventsRef = useRef<DesktopEvent[]>([]);
  const eventFrameRef = useRef<number | undefined>(undefined);

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
    if (!agentSwitchOpen && !permissionMenuOpen && !modelMenuOpen && historyMenu === undefined) return;

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setAgentSwitchOpen(false);
        setPermissionMenuOpen(false);
        setModelMenuOpen(false);
        setModelMenuView("simple");
        setHistoryMenu(undefined);
      }
    };

    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [agentSwitchOpen, permissionMenuOpen, modelMenuOpen, historyMenu]);

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
    () => groupThreads(threads),
    [threads],
  );
  const [todayOpen, setTodayOpen] = useStoredBoolean("god-agent:history-today", false);
  const [yesterdayOpen, setYesterdayOpen] = useStoredBoolean("god-agent:history-yesterday", false);
  const [historyOpen, setHistoryOpen] = useStoredBoolean("god-agent:history-older", false);

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
      await window.godAgent.desktop.sendMessage(text);
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
                    onClick={() => void replaceSnapshot(
                      window.godAgent.desktop.selectThread(thread.id),
                    )}
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
                  {thread.id === ui.snapshot?.activeThreadId && ui.snapshot.agentRuns.some((run) => run.parentRunId !== undefined) && (
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

                {(ui.snapshot?.agentRuns.length ?? 0) > 0 && (
                  <AgentRunTree runs={ui.snapshot!.agentRuns} runtime={ui.snapshot!.agentRuntime} selectedId={selectedAgentRunId} select={setSelectedAgentRunId} advance={async (stage) => {
                    dispatch({ type: "clear-error" });
                    try { dispatch({ type: "snapshot", snapshot: await window.godAgent.desktop.advanceFixedProduct(stage) }); }
                    catch (error) { dispatch({ type: "error", message: readError(error) }); }
                  }} />
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
            {ui.error !== undefined && <div className="safe-error">{ui.error}</div>}
            <div className="composer">
              <textarea
                value={input}
                placeholder="输入任务，Shift+Enter 换行"
                disabled={runtime.state !== "connected"}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void sendMessage();
                  }
                }}
              />
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
              <div className="inspector-list">
                <div className="inspector-summary"><Activity />当前 Turn · {formatThreadState(ui.snapshot?.turnState ?? "idle")} · {activeAgentCount} Agents</div>
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

function AgentRunTree({ runs, runtime, selectedId, select, advance }: { runs: import("../desktop-types.js").DesktopAgentRun[]; runtime: import("../desktop-types.js").DesktopAgentRuntimeView | undefined; selectedId: string | undefined; select: (id: string | undefined) => void; advance: (stage: import("../../agents/fixed-software-team-coordinator.js").FixedProductStage) => Promise<void> }) {
  const roots = runs.filter((run) => run.parentRunId === undefined);
  const childRuns = runs.filter((run) => run.parentRunId !== undefined);
  const children = new Map<string, typeof runs>();
  for (const run of runs) {
    if (run.parentRunId === undefined) continue;
    children.set(run.parentRunId, [...(children.get(run.parentRunId) ?? []), run]);
  }
  const renderRun = (run: typeof runs[number]) => {
    const task = runtime?.tasks.find((item) => item.id === run.taskId);
    const evidence = runtime?.evidence.filter((item) => item.taskId === task?.id) ?? [];
    const review = evidence.filter((item) => item.kind === "review").at(-1);
    return <li key={run.id} data-status={run.status}>
      <span className="agent-status-dot" />
      <button type="button" className="agent-node-button" aria-expanded={selectedId === run.id} onClick={() => select(selectedId === run.id ? undefined : run.id)}>
        <span><strong>{formatAgentProfileName(run.agentProfileId)}</strong><small title={run.task}>{run.task}</small></span>
        <span className="agent-node-state">{formatAgentState(run.status)}{review?.verdict === "passed" ? " · 验收通过" : review?.verdict === "failed" ? " · 需返工" : ""}<ChevronRight /></span>
      </button>
      {selectedId === run.id && <AgentNodeDetails run={run} runtime={runtime} />}
      {(children.get(run.id)?.length ?? 0) > 0 && <ul>{children.get(run.id)!.map(renderRun)}</ul>}
    </li>;
  };
  const consumedReturns = runtime?.returns.filter((item) => item.status === "consumed").length ?? 0;
  const passedReviews = runtime?.evidence.filter((item) => item.kind === "review" && item.verdict === "passed").length ?? 0;
  const failedReviews = runtime?.evidence.filter((item) => item.kind === "review" && item.verdict === "failed").length ?? 0;
  const reworkTasks = runtime?.tasks.filter((item) => item.status === "rework").length ?? 0;
  return (
    <details className="agent-run-tree">
      <summary>
        <span className="agent-parent-icon"><Bot /></span>
        <span><strong>God · {formatSupervisorState(runtime?.job?.status)}</strong><small>软件产品演示团队 · {childRuns.filter((item) => item.status === "running").length} 运行 · {childRuns.filter((item) => item.status === "queued").length} 等待</small></span>
        <ChevronRight className="agent-tree-chevron" />
      </summary>
      <div className="agent-supervision-body">
        <section className="agent-acceptance-summary">
          <header><strong>软件产品演示团队</strong><small>God 监工 · Job：{runtime?.job?.status ?? "运行中"} · 当前权限：{formatAccessMode(runtime?.job?.configSnapshot.accessMode)}</small></header>
          <div>
            <span><strong>{consumedReturns}/{runtime?.returns.length ?? 0}</strong><small>已接收 Return</small></span>
            <span><strong>{passedReviews}</strong><small>Review 通过</small></span>
            <span><strong>{Math.max(failedReviews, reworkTasks)}</strong><small>返工 / 未通过</small></span>
            <span><strong>{runtime?.tasks.filter((item) => item.status === "completed").length ?? 0}/{runtime?.tasks.length ?? 0}</strong><small>任务已完成</small></span>
          </div>
          <p>{formatSupervisorMessage(runtime?.job?.status, childRuns)}</p>
          {runtime?.fixedProductStage !== undefined && runtime.fixedProductStage !== "completed" && <button className="fixed-product-advance" type="button" onClick={() => void advance(runtime.fixedProductStage!)}>{formatFixedProductAction(runtime.fixedProductStage)}</button>}
          {runtime?.fixedProductStage === "completed" && <p className="fixed-product-complete">产品、工程和测试已完成，负责人已向 God 单次汇总。</p>}
        </section>
        <ul className="agent-child-list">{roots.flatMap((root) => children.get(root.id) ?? []).map(renderRun)}</ul>
        {childRuns.length === 0 && <p className="agent-empty-children">父 Agent 正在分析需求，尚未派出子 Agent。</p>}
      </div>
    </details>
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

function AgentNodeDetails({ run, runtime }: { run: import("../desktop-types.js").DesktopAgentRun | undefined; runtime: import("../desktop-types.js").DesktopAgentRuntimeView | undefined }) {
  if (run === undefined) return null;
  const task = runtime?.tasks.find((item) => item.id === run.taskId);
  const edges = runtime?.edges.filter((item) => item.fromTaskId === task?.id || item.toTaskId === task?.id) ?? [];
  const evidence = runtime?.evidence.filter((item) => item.taskId === task?.id) ?? [];
  const returns = runtime?.returns.filter((item) => item.childRunId === run.id) ?? [];
  return <section className="agent-node-details">
    <strong>节点详情</strong>
    <dl><dt>身份</dt><dd>{formatAgentProfileName(run.agentProfileId)}</dd><dt>职责</dt><dd>{formatAgentResponsibility(run.agentProfileId)}</dd><dt>任务合同</dt><dd>{task?.objective ?? run.task}</dd><dt>Return 对象</dt><dd>{run.agentProfileId === "software_team_lead" ? "God" : "软件团队负责人"}</dd><dt>直接父节点</dt><dd>{run.parentRunId ?? "无（God）"}</dd><dt>依赖</dt><dd>{edges.length === 0 ? "无" : edges.map((edge) => `${edge.type}: ${edge.fromTaskId} → ${edge.toTaskId}`).join("；")}</dd><dt>角色 / 层级</dt><dd>{run.agentProfileId} / {run.depth}</dd><dt>失败原因</dt><dd>{run.safeError ?? "无"}</dd><dt>访问权限</dt><dd>{formatAccessMode(runtime?.job?.configSnapshot.accessMode)}（继承本次 Job 快照）</dd><dt>父子约束</dt><dd>{runtime?.job?.configSnapshot.permissionMode === "least_privilege" ? "Profile 与 Tool 求交集，子 Agent 不可扩大" : "继承 Chat 后仍受 Profile / Tool 限制"}</dd><dt>Evidence</dt><dd>{evidence.length === 0 ? "暂无" : evidence.map((item) => `${item.kind} · ${item.verdict} · ${item.summary}`).join("；")}</dd><dt>Return</dt><dd>{returns.length === 0 ? "暂无" : returns.map((item) => `${item.status} · 尝试 ${item.attempts}`).join("；")}</dd></dl>
  </section>;
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

function formatSupervisorState(status: import("../../agents/agent-runtime.js").AgentJobStatus | undefined): string {
  if (status === "completed") return "验收完成";
  if (status === "failed" || status === "partial") return "发现问题";
  if (status === "cancelled") return "已停止";
  if (status === "reviewing") return "正在验收";
  if (status === "waiting_returns") return "等待子 Agent";
  return "监工中";
}

function formatSupervisorMessage(status: import("../../agents/agent-runtime.js").AgentJobStatus | undefined, childRuns: import("../desktop-types.js").DesktopAgentRun[]): string {
  if (status === "completed") return "全部子任务已经返回并完成验收，父 Agent 已汇总最终结果。";
  if (status === "failed" || status === "partial") return "存在未通过或未完成的子任务，父 Agent 正在决定返工或降级处理。";
  if (status === "reviewing") return "子 Agent 已返回结果，父 Agent 正在检查证据和验收条件。";
  if (childRuns.some((item) => item.status === "running")) return "子 Agent 正在执行，父 Agent 持续监控进度并等待结构化结果。";
  return "父 Agent 正在拆分需求和安排子任务。";
}

function formatFixedProductAction(stage: import("../../agents/fixed-software-team-coordinator.js").FixedProductStage): string {
  if (stage === "ready_first_return") return "1. 产品生成第一轮 Return";
  if (stage === "first_return_ready") return "2. 负责人验收并驳回";
  if (stage === "rework") return "3. 原产品 Thread 返工（Attempt 2）";
  if (stage === "second_return_ready") return "4. 负责人通过并 Return God";
  if (stage === "engineering_ready") return "5. 工程角色实现项目";
  if (stage === "engineering_return_ready") return "6. 负责人接收工程 Return";
  if (stage === "quality_ready") return "7. 测试角色独立验收";
  if (stage === "quality_return_ready") return "8. 负责人接收测试 Return";
  if (stage === "lead_return_ready") return "9. God 接收并单次汇总";
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

function groupThreads(threads: DesktopThreadSummary[]) {
  const groups = new Map<string, DesktopThreadSummary[]>();
  for (const thread of threads) {
    const label = dateGroup(thread.lastActivityAt);
    groups.set(label, [...(groups.get(label) ?? []), thread]);
  }
  return [...groups.entries()];
}

function dateGroup(value: string): string {
  const date = new Date(value);
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((start - target) / 86_400_000);
  if (days <= 0) return "今天";
  if (days === 1) return "昨天";
  return "历史";
}

function readError(error: unknown): string {
  return error instanceof Error ? error.message : "桌面操作失败，请稍后重试";
}
