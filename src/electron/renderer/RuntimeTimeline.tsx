import {
  Ban,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDashed,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
} from "react";

import type {
  RuntimeActivity,
  RuntimeSession,
} from "../../runtime/runtime-session.js";
import type {
  RuntimeActivityGroup,
} from "./runtime-ui.js";
import { SafeMarkdown } from "./SafeMarkdown.js";
import {
  formatElapsed,
  getActivityGroupStatus,
  groupConsecutiveActivities,
  isRuntimeItemAnimated,
  shouldAutoCollapseProcess,
  splitRuntimeTimelineItems,
  summarizeActivityGroup,
  summarizeActivities,
  summarizeRuntimeStatus,
} from "./runtime-ui.js";

export function RuntimeTimeline({ session }: { session: RuntimeSession }) {
  const [nowMs, setNowMs] = useState(Date.now());
  const [processCollapsed, setProcessCollapsed] = useState(false);
  const manualChoiceRef = useRef(false);
  const { process, outcome } = splitRuntimeTimelineItems(session.items);
  const processDisplayItems = groupConsecutiveActivities(process);
  const activityCount = process.filter((item) => item.kind === "activity").length;

  useEffect(() => {
    setNowMs(Date.now());
    if (session.status !== "running") return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [session.status, session.turnId]);

  useEffect(() => {
    manualChoiceRef.current = false;
    setProcessCollapsed(false);
  }, [session.turnId]);

  useEffect(() => {
    if (!shouldAutoCollapseProcess(session.status) || process.length === 0) return;
    const timer = window.setTimeout(() => {
      if (!manualChoiceRef.current) setProcessCollapsed(true);
    }, 500);
    return () => window.clearTimeout(timer);
  }, [process.length, session.status, session.turnId]);

  const elapsed = formatElapsed(
    session.startedAt,
    session.completedAt,
    nowMs,
  );

  return (
    <section className="runtime-timeline" data-status={session.status}>
      {process.length > 0 && (
        <section className="runtime-process">
          <button
            className="runtime-summary"
            type="button"
            aria-expanded={!processCollapsed}
            onClick={() => {
              manualChoiceRef.current = true;
              setProcessCollapsed((value) => !value);
            }}
          >
            {processCollapsed ? <ChevronRight /> : <ChevronDown />}
            <span>{elapsed}</span>
            <small>
              · {activityCount > 0 && `${summarizeActivities(process)} · `}
              {summarizeRuntimeStatus(session.status)}
            </small>
          </button>

          {!processCollapsed && (
            <div className="runtime-process-items">
              {processDisplayItems.map((item) => {
          if (item.kind === "activity_group") {
            return <RuntimeActivityGroupView key={item.id} group={item} session={session} />;
          }

          if (item.kind === "reasoning_summary") {
            return (
              <details
                className="reasoning-card"
                data-running={isRuntimeItemAnimated(session, item)}
                key={item.id}
                open={item.status === "streaming" ? true : undefined}
              >
                <summary>
                  <span className="runtime-spinner"><CircleDashed /></span>
                  <strong>
                    公开推理摘要 · 第 {item.round + 1} 轮 · 分段 {item.summaryIndex + 1}
                  </strong>
                </summary>
                <SafeMarkdown markdown={item.markdown} />
              </details>
            );
          }

          if (item.kind === "commentary" || item.kind === "pending_output") {
            const animated = isRuntimeItemAnimated(session, item);
            return (
              <section
                className="runtime-commentary"
                data-running={animated}
                key={item.id}
              >
                <SafeMarkdown markdown={item.markdown} />
                {item.kind === "pending_output" && animated && (
                  <span className="streaming-caret" aria-hidden="true" />
                )}
              </section>
            );
          }

          return null;
              })}
            </div>
          )}
        </section>
      )}

      {outcome.length > 0 && (
        <div className="runtime-outcome">
          {outcome.map((item) => {
            if (item.kind === "assistant") {
              return (
                <article className="runtime-final-answer" key={item.id}>
                  <strong>Agent</strong>
                  <SafeMarkdown markdown={item.markdown} />
                </article>
              );
            }

            if (item.kind === "error") {
              return (
                <div className="runtime-error" key={item.id}>
                  <CircleAlert />
                  <span><strong>{item.title}</strong>{item.safeMessage}</span>
                </div>
              );
            }

            return null;
          })}
        </div>
      )}
    </section>
  );
}

function RuntimeActivityGroupView({
  group,
  session,
}: {
  group: RuntimeActivityGroup;
  session: RuntimeSession;
}) {
  const status = getActivityGroupStatus(group);
  const running = status === "running" && session.status === "running";

  return (
    <details
      className="runtime-activity-group"
      data-status={status}
      data-running={running}
      open={running || undefined}
    >
      <summary>
        <ActivityStatusIcon status={status} />
        <span>
          <strong>操作记录 · {group.activities.length} 项</strong>
          <small>{summarizeActivityGroup(group)}</small>
        </span>
      </summary>
      <div className="runtime-activity-group-items">
        {group.activities.map((item) => (
          <RuntimeActivityRow key={item.id} item={item} session={session} />
        ))}
      </div>
    </details>
  );
}

function RuntimeActivityRow({
  item,
  session,
}: {
  item: RuntimeActivity;
  session: RuntimeSession;
}) {
  const running = isRuntimeItemAnimated(session, item);
  return (
    <details
      className="runtime-activity"
      data-status={item.status}
      data-running={running}
      open={running || undefined}
    >
      <summary>
        <ActivityStatusIcon status={item.status} />
        <span><strong>{item.title}</strong>{item.summary}</span>
      </summary>
      {item.safeDetails !== undefined && item.safeDetails.length > 0 && (
        <ul>
          {item.safeDetails.map((detail, index) => (
            <li key={`${item.id}-detail-${index}`}>{detail}</li>
          ))}
        </ul>
      )}
    </details>
  );
}

function ActivityStatusIcon({ status }: { status: RuntimeActivity["status"] }) {
  if (status === "completed") return <CircleCheck className="activity-done" />;
  if (status === "failed") return <CircleAlert className="activity-failed" />;
  if (status === "cancelled") return <Ban className="activity-cancelled" />;
  return <CircleDashed className="runtime-spinner" />;
}
