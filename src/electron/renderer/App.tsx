import {
  Activity,
  ArrowDown,
  Bot,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleDashed,
  FileCode2,
  Globe2,
  Menu,
  MoreHorizontal,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Plus,
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
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
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
import {
  desktopReducer,
  INITIAL_DESKTOP_UI_STATE,
} from "./desktop-reducer.js";
import { RuntimeTimeline } from "./RuntimeTimeline.js";
import {
  coalesceDesktopEvents,
  isNearBottom,
} from "./runtime-ui.js";

type InspectorTab = "changes" | "activity" | "terminal" | "extensions";

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
  const [leftOpen, setLeftOpen] = useStoredBoolean("god-agent:left-open", true);
  const [rightOpen, setRightOpen] = useStoredBoolean("god-agent:right-open", true);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("activity");
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const [permissionRequest, setPermissionRequest] = useState<DesktopPermissionRequest>();
  const timelineRef = useRef<HTMLDivElement>(null);
  const autoFollowRef = useRef(true);
  const pendingEventsRef = useRef<DesktopEvent[]>([]);
  const eventFrameRef = useRef<number | undefined>(undefined);

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

  return (
    <div
      className="desktop-app"
      data-left-open={leftOpen}
      data-right-open={rightOpen}
    >
      <div className="desktop-layout">
        <aside className="left-sidebar" aria-hidden={!leftOpen}>
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
                  <div className="history-item-row" key={thread.id}>
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
              <strong>agent-learn</strong>
              <span>{ui.snapshot?.agentConfig.model ?? "Runtime"} · {ui.snapshot?.agentConfig.reasoningEffort ?? "high"}</span>
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
                  <AgentRunTree runs={ui.snapshot!.agentRuns} runtime={ui.snapshot!.agentRuntime} selectedId={selectedAgentRunId} select={setSelectedAgentRunId} />
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
                      aria-haspopup="menu"
                      aria-expanded={permissionMenuOpen}
                      onClick={() => { setAgentSwitchOpen(false); setModelMenuOpen(false); setPermissionMenuOpen(!permissionMenuOpen); }}
                    >
                      <Shield />{formatAccessMode(ui.snapshot?.agentConfig.agentTeam?.accessMode)}<ChevronDown />
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
                      {formatModelName(activeModelSettings?.model)} · {formatReasoningEffort(activeModelSettings?.reasoningEffort)}<ChevronDown />
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
                      aria-haspopup="menu"
                      aria-expanded={agentSwitchOpen}
                      onClick={() => { setPermissionMenuOpen(false); setModelMenuOpen(false); setAgentSwitchOpen(!agentSwitchOpen); }}
                    >
                      子 Agent：{ui.snapshot?.agentConfig.agentTeam?.mode === "off" ? "关闭" : "开启"}<ChevronDown />
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

function AgentRunTree({ runs, runtime, selectedId, select }: { runs: import("../desktop-types.js").DesktopAgentRun[]; runtime: import("../desktop-types.js").DesktopAgentRuntimeView | undefined; selectedId: string | undefined; select: (id: string | undefined) => void }) {
  const profileNames: Record<string, string> = {
    orchestrator: "父 Agent", investigator: "排查 Agent", researcher: "资料 Agent", coder: "编程 Agent", tester: "测试 Agent", reviewer: "审查 Agent",
  };
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
        <span><strong>{profileNames[run.agentProfileId] ?? run.agentProfileId}</strong><small>{run.task}</small></span>
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
        <span><strong>父 Agent · {formatSupervisorState(runtime?.job?.status)}</strong><small>{childRuns.length} 个子 Agent · {childRuns.filter((item) => item.status === "running").length} 运行 · {childRuns.filter((item) => item.status === "queued").length} 等待</small></span>
        <ChevronRight className="agent-tree-chevron" />
      </summary>
      <div className="agent-supervision-body">
        <section className="agent-acceptance-summary">
          <header><strong>父 Agent 监工与验收</strong><small>Job：{runtime?.job?.status ?? "运行中"} · 当前权限：{formatAccessMode(runtime?.job?.configSnapshot.accessMode)}</small></header>
          <div>
            <span><strong>{consumedReturns}/{runtime?.returns.length ?? 0}</strong><small>已接收 Return</small></span>
            <span><strong>{passedReviews}</strong><small>Review 通过</small></span>
            <span><strong>{failedReviews + reworkTasks}</strong><small>返工 / 未通过</small></span>
            <span><strong>{runtime?.tasks.filter((item) => item.status === "completed").length ?? 0}/{runtime?.tasks.length ?? 0}</strong><small>任务已完成</small></span>
          </div>
          <p>{formatSupervisorMessage(runtime?.job?.status, childRuns)}</p>
        </section>
        <ul className="agent-child-list">{roots.flatMap((root) => children.get(root.id) ?? []).map(renderRun)}</ul>
        {childRuns.length === 0 && <p className="agent-empty-children">父 Agent 正在分析需求，尚未派出子 Agent。</p>}
      </div>
    </details>
  );
}

function AgentNodeDetails({ run, runtime }: { run: import("../desktop-types.js").DesktopAgentRun | undefined; runtime: import("../desktop-types.js").DesktopAgentRuntimeView | undefined }) {
  if (run === undefined) return null;
  const task = runtime?.tasks.find((item) => item.id === run.taskId);
  const edges = runtime?.edges.filter((item) => item.fromTaskId === task?.id || item.toTaskId === task?.id) ?? [];
  const evidence = runtime?.evidence.filter((item) => item.taskId === task?.id) ?? [];
  const returns = runtime?.returns.filter((item) => item.childRunId === run.id) ?? [];
  return <section className="agent-node-details">
    <strong>节点详情</strong>
    <dl><dt>任务合同</dt><dd>{task?.objective ?? run.task}</dd><dt>直接父节点</dt><dd>{run.parentRunId ?? "无（首脑）"}</dd><dt>依赖</dt><dd>{edges.length === 0 ? "无" : edges.map((edge) => `${edge.type}: ${edge.fromTaskId} → ${edge.toTaskId}`).join("；")}</dd><dt>角色 / 层级</dt><dd>{run.agentProfileId} / {run.depth}</dd><dt>访问权限</dt><dd>{formatAccessMode(runtime?.job?.configSnapshot.accessMode)}（继承本次 Job 快照）</dd><dt>父子约束</dt><dd>{runtime?.job?.configSnapshot.permissionMode === "least_privilege" ? "Profile 与 Tool 求交集，子 Agent 不可扩大" : "继承 Chat 后仍受 Profile / Tool 限制"}</dd><dt>Evidence</dt><dd>{evidence.length === 0 ? "暂无" : evidence.map((item) => `${item.kind} · ${item.verdict} · ${item.summary}`).join("；")}</dd><dt>Return</dt><dd>{returns.length === 0 ? "暂无" : returns.map((item) => `${item.status} · 尝试 ${item.attempts}`).join("；")}</dd></dl>
  </section>;
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
  const update = (next: boolean) => {
    localStorage.setItem(key, String(next));
    setValue(next);
  };
  return [value, update] as const;
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
