import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { DigitalEmployeeAvatar } from "@aiteam/shared";
import { ApiError } from "@aiteam/shared/api-client";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { useApp } from "../../lib/app-context";
import { WorkInsights } from "../workspace/WorkInsights";
import { getFeed, getScene } from "./useOfficeApi";
import { ScheduledJobs } from "./ScheduledJobs";
import type { OfficeEmployee, OfficeFeed, OfficeScene } from "./types";
import "./office.css";

/** Keep the local projection fresh without turning the office view into a busy loop. */
export const OFFICE_POLL_INTERVAL_MS = 15_000;

interface StationPosition {
  x: number;
  y: number;
  depth: number;
}

const STATION_POSITIONS: readonly StationPosition[] = [
  { x: 18, y: 28, depth: 1 },
  { x: 50, y: 29, depth: 2 },
  { x: 82, y: 28, depth: 1 },
  { x: 33, y: 59, depth: 3 },
  { x: 67, y: 59, depth: 3 },
  { x: 18, y: 79, depth: 4 },
  { x: 50, y: 80, depth: 5 },
  { x: 82, y: 79, depth: 4 },
];

interface StatusMeta {
  raw: string;
  label: string;
  tone: "working" | "busy" | "ready" | "offline" | "attention";
  motion: "working" | "idle";
}

function statusMeta(status: string): StatusMeta {
  const raw = status.trim().toLowerCase() || "unknown";
  switch (raw) {
    case "working":
      return { raw, label: "工作中", tone: "working", motion: "working" };
    case "busy":
      return { raw, label: "繁忙", tone: "busy", motion: "working" };
    case "ready":
      return { raw, label: "就绪", tone: "ready", motion: "idle" };
    case "idle":
      return { raw, label: "空闲", tone: "ready", motion: "idle" };
    case "offline":
      return { raw, label: "离线", tone: "offline", motion: "idle" };
    case "completed":
      return { raw, label: "最近完成", tone: "ready", motion: "idle" };
    case "waiting":
      return { raw, label: "等待回复", tone: "busy", motion: "idle" };
    case "error":
    case "failed":
      return { raw, label: "异常", tone: "attention", motion: "idle" };
    default:
      return { raw, label: status.trim() || "状态未知", tone: "attention", motion: "idle" };
  }
}

function stationPosition(index: number, total: number): StationPosition {
  const fixed = STATION_POSITIONS[index];
  if (fixed && total <= STATION_POSITIONS.length) return fixed;

  const columns = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(total))));
  const rows = Math.ceil(total / columns);
  const column = index % columns;
  const row = Math.floor(index / columns);
  const x = columns === 1 ? 50 : 13 + (74 * column) / (columns - 1);
  const y = rows === 1 ? 46 : 25 + (54 * row) / (rows - 1);
  return { x, y, depth: row + 1 };
}

function documentIsHidden(): boolean {
  return typeof document !== "undefined" && (document.hidden || document.visibilityState === "hidden");
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

function summaryValue(scene: OfficeScene, key: string, fallback: number): number {
  const value = scene.summary[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function summaryItems(scene: OfficeScene) {
  const metas = scene.employees.map((employee) => statusMeta(employee.status));
  return [
    { key: "total", label: "总员工", value: summaryValue(scene, "total", scene.employees.length), hint: "已授权本地投影", tone: "neutral" },
    { key: "working", label: "工作中", value: summaryValue(scene, "working", metas.filter((meta) => meta.tone === "working" || meta.tone === "busy").length), hint: "正在执行", tone: "working" },
    { key: "ready", label: "就绪", value: summaryValue(scene, "ready", metas.filter((meta) => meta.tone === "ready").length), hint: "等待新任务", tone: "ready" },
    { key: "offline", label: "离线", value: summaryValue(scene, "offline", metas.filter((meta) => meta.tone === "offline").length), hint: "暂不可用", tone: "offline" },
  ] as const;
}

function formatUpdatedAt(updatedAt: Date | null): string {
  if (!updatedAt) return "等待首次同步";
  return `更新于 ${updatedAt.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
}

function formatActivityTime(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : value;
}

function OfficeBackdrop(): ReactNode {
  return (
    <svg
      className={"office-floor-art"}
      viewBox="0 0 960 560"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id="office-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--office-sky-start)" />
          <stop offset="1" stopColor="var(--office-sky-end)" />
        </linearGradient>
        <linearGradient id="office-floor" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--office-floor-start)" />
          <stop offset="1" stopColor="var(--office-floor-end)" />
        </linearGradient>
        <pattern id="office-mosaic" width="48" height="48" patternUnits="userSpaceOnUse">
          <path d="M0 0H48V48H0Z" fill="none" stroke="var(--office-grid)" strokeWidth="1" />
          <path d="M0 24H48M24 0V48" stroke="var(--office-grid-soft)" strokeWidth="1" />
        </pattern>
        <pattern id="office-pixels" width="32" height="32" patternUnits="userSpaceOnUse">
          <rect x="2" y="2" width="3" height="3" fill="var(--office-pixel)" />
          <rect x="19" y="13" width="2" height="2" fill="var(--office-pixel)" />
          <rect x="9" y="26" width="2" height="2" fill="var(--office-pixel)" />
        </pattern>
      </defs>
      <rect className={"office-floor__sky"} width="960" height="560" fill="url(#office-sky)" />
      <path className={"office-floor__window"} d="M84 92h148v118H84zM254 92h148v118H254zM424 92h148v118H424zM594 92h148v118H594z" />
      <path className={"office-floor__window-glow"} d="M97 105h122v92H97zM267 105h122v92H267zM437 105h122v92H437zM607 105h122v92H607z" />
      <path className={"office-floor__shelf"} d="M52 218h856v20H52zM70 238h18v78H70zM872 238h18v78H872z" />
      <path className={"office-floor__floor"} d="M56 300 480 178 904 300 480 548Z" fill="url(#office-floor)" />
      <path className={"office-floor__mosaic"} d="M56 300 480 178 904 300 480 548Z" fill="url(#office-mosaic)" />
      <path className={"office-floor__floor-grid"} d="M56 300 480 420 904 300M56 300 480 548M904 300 480 548M162 270 480 360 798 270M266 240 480 300 694 240" fill="none" />
      <path className={"office-floor__desk-shadow"} d="M108 365 224 331l86 25-113 39ZM378 447l115-35 90 27-118 37ZM665 356l108-33 82 24-111 37Z" />
      <rect width="960" height="560" fill="url(#office-pixels)" opacity="0.32" />
      <g className={"office-floor__decor"}>
        <path d="M106 264v-34M98 250h16M94 242h24" />
        <path d="M854 264v-34M846 250h16M842 242h24" />
        <rect x="438" y="220" width="84" height="20" rx="4" />
        <path d="M451 230h13m8 0h13m8 0h13" />
      </g>
    </svg>
  );
}

function StatusMark({ tone }: { tone: StatusMeta["tone"] }): ReactNode {
  return <span className={`office-status-mark office-status-mark--${tone}`} aria-hidden="true" />;
}

interface WorkstationProps {
  employee: OfficeEmployee;
  position: StationPosition;
  selected: boolean;
  onSelect: (employeeId: string) => void;
}

function Workstation({ employee, position, selected, onSelect }: WorkstationProps): ReactNode {
  const meta = statusMeta(employee.status);
  const task = employee.task?.trim() || null;
  const recentTask = employee.last_task?.trim() || null;
  const label = `${employee.display_name}工位，${meta.label}${task ? `，当前任务：${task}` : recentTask ? `，最近任务：${recentTask}` : "，当前无任务"}`;
  const stationStyle = {
    left: `${position.x}%`,
    top: `${position.y}%`,
    zIndex: 10 + position.depth,
  } satisfies CSSProperties;

  return (
    <div className={"office-station-item"} role="listitem" style={stationStyle}>
      <Button
        type="button"
        label={label}
        variant="ghost"
        className={`office-workstation office-workstation--${meta.tone}`}
        data-testid="office-employee"
        data-office-workstation="true"
        data-status={meta.raw}
        data-motion={meta.motion}
        aria-pressed={selected}
        onClick={() => onSelect(employee.employee_id)}
      >
        <span className={"office-workstation__inner"}>
          {task ? <span className={"office-workstation__bubble"}>{task}</span> : null}
          <span className={"office-workstation__visual"} aria-hidden="true">
            <span className={"office-monitor"}>
              <span className={"office-monitor__screen"}>
                <span className={"office-screen-pixels"}><i /><i /><i /></span>
                <span className={"office-screen-line"} />
              </span>
              <span className={"office-monitor__stand"} />
            </span>
            <span className={"office-desk"} />
            <span className={"office-chair"} />
            <span className={"office-agent-avatar"}>
              <DigitalEmployeeAvatar name={employee.display_name} seed={employee.employee_id} src={employee.avatar_url} size={48} />
            </span>
            <span className={"office-status-light"}><StatusMark tone={meta.tone} /></span>
          </span>
          <span className={"office-workstation__label"}>
            <span className={"office-workstation__name"}>{employee.display_name}</span>
            <span className={"office-workstation__status"}>
              <StatusMark tone={meta.tone} />
              <span>{meta.label}</span>
              <span className={"office-status-code"} aria-hidden="true">{meta.raw}</span>
            </span>
            <span className={"office-workstation__task"}>{task ? `当前任务：${task}` : recentTask ? `最近：${recentTask}` : "当前无任务"}</span>
          </span>
        </span>
      </Button>
    </div>
  );
}

interface OfficeSceneViewProps {
  scene: OfficeScene;
  selectedEmployeeId: string | null;
  onSelectEmployee: (employeeId: string) => void;
  sceneRef: RefObject<HTMLElement | null>;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
}

function OfficeSceneView({
  scene,
  selectedEmployeeId,
  onSelectEmployee,
  sceneRef,
  isFullscreen,
  onToggleFullscreen,
}: OfficeSceneViewProps): ReactNode {
  const items = summaryItems(scene);
  const working = items.find((item) => item.key === "working")?.value ?? 0;

  return (
    <section className={"office-scene-card"} ref={sceneRef} aria-labelledby="office-scene-heading" data-testid="office-scene-card">
      <header className={"office-scene-header"}>
        <div>
          <span className={"office-kicker"}>LOCAL FLOOR PLAN</span>
          <Heading level={2} id="office-scene-heading">数字员工工位</Heading>
          <Text type="supporting">每位员工一个工位 · 状态来自本机实时投影</Text>
        </div>
        <HStack gap={2} align="center" wrap="wrap">
          <span className={"office-scene-count"} data-testid="office-scene-count">
            <span className={"office-scene-count__dot"} aria-hidden="true" />
            {scene.employees.length} 位员工 · {working} 位工作中
          </span>
          <Button
            label={isFullscreen ? "退出全屏" : "全屏视图"}
            variant="ghost"
            size="sm"
            aria-pressed={isFullscreen}
            onClick={onToggleFullscreen}
            data-testid="office-fullscreen"
          />
        </HStack>
      </header>

      <div className={"office-scene-viewport"} data-testid="office-scene" aria-label="办公室工位地图">
        <OfficeBackdrop />
        <div className={"office-scene-grid"} role="list" aria-label="数字员工工位列表">
          {scene.employees.map((employee, index) => (
            <Workstation
              key={employee.employee_id}
              employee={employee}
              position={stationPosition(index, scene.employees.length)}
              selected={selectedEmployeeId === employee.employee_id}
              onSelect={onSelectEmployee}
            />
          ))}
        </div>
        {scene.employees.length === 0 ? (
          <div className={"office-scene-empty"} data-testid="office-employees-empty">
            <span className={"office-empty-pixel"} aria-hidden="true" />
            <EmptyState title="暂无员工" description="同步授权员工后，工位会出现在办公室地图中。" headingLevel={3} isCompact />
          </div>
        ) : null}
        <span className={"office-scene-sign"} aria-hidden="true">AI TEAM / 07</span>
      </div>

      <footer className={"office-scene-legend"} aria-label="状态图例">
        {[
          ["working", "工作中"],
          ["ready", "就绪"],
          ["offline", "离线"],
          ["attention", "异常"],
        ].map(([tone, label]) => (
          <span className={"office-legend-item"} key={tone}>
            <StatusMark tone={tone as StatusMeta["tone"]} />
            {label}
          </span>
        ))}
        <span className={"office-legend-note"}>点击工位查看详情</span>
      </footer>
    </section>
  );
}

function SummaryCards({ scene }: { scene: OfficeScene }): ReactNode {
  return (
    <section className={"office-summary"} aria-label="办公室实时总览" data-testid="office-summary">
      {summaryItems(scene).map((item) => (
        <article className={`office-metric office-metric--${item.tone}`} key={item.key} data-testid={`office-metric-${item.key}`} data-metric-key={item.key}>
          <span className={"office-metric-code"} aria-hidden="true">{item.key}</span>
          <span className={"office-metric-label"}>{item.label}</span>
          <strong className={"office-metric-value"}>{item.value}</strong>
          <span className={"office-metric-hint"}>{item.hint}</span>
        </article>
      ))}
    </section>
  );
}

interface ActivityPanelProps {
  employees: OfficeEmployee[];
  selectedEmployeeId: string | null;
  onSelectEmployee: (employeeId: string) => void;
  onClearSelection: () => void;
}

function ActivityPanel({ employees, selectedEmployeeId, onSelectEmployee, onClearSelection }: ActivityPanelProps): ReactNode {
  const selected = employees.find((employee) => employee.employee_id === selectedEmployeeId) ?? null;

  if (selected) {
    const meta = statusMeta(selected.status);
    return (
      <section className={"office-panel office-detail-panel"} aria-labelledby="office-detail-heading" data-testid="office-employee-detail" aria-live="polite">
        <header className={"office-panel-header"}>
          <div>
            <span className={"office-kicker"}>SELECTED STATION</span>
            <Heading level={2} id="office-detail-heading">员工详情</Heading>
          </div>
          <Button label="返回最近状态" variant="ghost" size="sm" onClick={onClearSelection} />
        </header>
        <div className={"office-detail-identity"}>
          <DigitalEmployeeAvatar name={selected.display_name} seed={selected.employee_id} src={selected.avatar_url} size={56} />
          <div>
            <Heading level={3}>{selected.display_name}</Heading>
            <div className={"office-detail-status"}><StatusMark tone={meta.tone} /> <span>{meta.label}</span><span className={"office-status-code"} aria-hidden="true">{meta.raw}</span></div>
          </div>
        </div>
        <dl className={"office-detail-list"}>
          <div><dt>当前任务</dt><dd>{selected.task?.trim() ? `当前任务：${selected.task.trim()}` : "当前无任务"}</dd></div>
          <div><dt>最近状态</dt><dd>{statusMeta(selected.last_status || selected.status).label}{selected.last_activity_at ? ` · ${formatActivityTime(selected.last_activity_at)}` : ""}</dd></div>
          <div><dt>最近任务</dt><dd>{selected.last_task?.trim() ? selected.last_task.trim() : "暂无已完成任务"}</dd></div>
          <div><dt>数据来源</dt><dd>本机 Agent 实时投影</dd></div>
        </dl>
        <Text type="supporting">执行内容留在本机，办公室只展示状态与任务摘要。</Text>
      </section>
    );
  }

  const recentEmployees = [...employees].sort((left, right) => {
    const leftTime = left.last_activity_at ? Date.parse(left.last_activity_at) : -1;
    const rightTime = right.last_activity_at ? Date.parse(right.last_activity_at) : -1;
    return rightTime - leftTime || left.display_name.localeCompare(right.display_name);
  });

  return (
    <section className={"office-panel"} aria-labelledby="office-recent-heading" data-testid="office-recent">
      <header className={"office-panel-header"}>
        <div>
          <span className={"office-kicker"}>RECENT SNAPSHOT</span>
          <Heading level={2} id="office-recent-heading">最近状态与任务</Heading>
        </div>
        <span className={"office-panel-count"}>{employees.length}</span>
      </header>
      {employees.length === 0 ? (
        <EmptyState title="暂无状态" description="员工出现在办公室后，这里会显示最近一次本地投影。" headingLevel={3} isCompact />
      ) : (
        <ul className={"office-activity-list"}>
          {recentEmployees.slice(0, 6).map((employee) => {
            const meta = statusMeta(employee.last_status || employee.status);
            return (
              <li className={"office-activity-item"} key={employee.employee_id} data-testid="office-recent-item">
                <Button
                  label={`查看${employee.display_name}详情`}
                  variant="ghost"
                  className={"office-activity-button"}
                  onClick={() => onSelectEmployee(employee.employee_id)}
                >
                  <span className={"office-activity-button__inner"}>
                    <DigitalEmployeeAvatar name={employee.display_name} seed={employee.employee_id} src={employee.avatar_url} size={36} />
                    <span className={"office-activity-copy"}>
                      <span className={"office-activity-name"}><StatusMark tone={meta.tone} /> {employee.display_name} · {meta.label}</span>
                      <span className={"office-activity-task"}>{employee.task?.trim() ? `当前任务：${employee.task.trim()}` : employee.last_task?.trim() ? `最近任务：${employee.last_task.trim()}` : "当前无任务"}{employee.last_activity_at ? ` · ${formatActivityTime(employee.last_activity_at)}` : ""}</span>
                    </span>
                  </span>
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

interface FeedPanelProps {
  feed: OfficeFeed | null;
  feedLoaded: boolean;
  loading: boolean;
  error: string | null;
}

function FeedPanel({ feed, feedLoaded, loading, error }: FeedPanelProps): ReactNode {
  const scheduledJobs = feed?.events.filter((event) => event.type === "conversation_schedule") ?? [];
  return (
    <section className={"office-panel office-feed-panel"} aria-labelledby="office-feed-heading" data-testid="office-feed-panel">
      <header className={"office-panel-header"}>
        <div>
          <span className={"office-kicker"}>SCHEDULED PLANS</span>
          <Heading level={2} id="office-feed-heading">定时计划</Heading>
        </div>
        <span className={"office-panel-count"}>{feedLoaded && feed ? scheduledJobs.length : "—"}</span>
      </header>
      {error ? <Banner status="error" title={error} data-testid="office-feed-error" /> : null}
      {loading && !feedLoaded ? <div className={"office-inline-status"} role="status">同步动态…</div> : null}
      {feedLoaded && !error && feed ? (
        <ScheduledJobs jobs={scheduledJobs} />
      ) : feedLoaded && !error ? (
        <EmptyState title="办公室动态不可用" description="Agent 当前没有可用的动态 Feed。" data-testid="office-feed-unavailable" headingLevel={3} isCompact />
      ) : null}
    </section>
  );
}

export function OfficePage(): ReactNode {
  const { client } = useApp();
  const [scene, setScene] = useState<OfficeScene | null>(null);
  const [feed, setFeed] = useState<OfficeFeed | null>(null);
  const [feedLoaded, setFeedLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sceneError, setSceneError] = useState<string | null>(null);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [paused, setPaused] = useState(documentIsHidden);
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const mountedRef = useRef(false);
  const activeRequestRef = useRef<AbortController | null>(null);
  const sceneRef = useRef<HTMLElement | null>(null);

  const refresh = useCallback(async (initial: boolean) => {
    if (!mountedRef.current || activeRequestRef.current) return;
    const controller = new AbortController();
    activeRequestRef.current = controller;
    if (initial) setLoading(true);
    else setRefreshing(true);

    try {
      const [sceneResult, feedResult] = await Promise.allSettled([
        getScene(client, controller.signal),
        getFeed(client, controller.signal),
      ]);
      if (controller.signal.aborted || !mountedRef.current) return;

      let receivedData = false;
      if (sceneResult.status === "fulfilled") {
        setScene(sceneResult.value);
        setSceneError(null);
        receivedData = true;
      } else {
        setSceneError(errorMessage(sceneResult.reason, "办公室场景加载失败"));
      }

      if (feedResult.status === "fulfilled") {
        setFeed(feedResult.value);
        setFeedLoaded(true);
        setFeedError(null);
        receivedData = true;
      } else {
        setFeedLoaded(true);
        setFeedError(errorMessage(feedResult.reason, "动态加载失败"));
      }

      if (receivedData) setLastUpdated(new Date());
    } finally {
      if (activeRequestRef.current === controller) activeRequestRef.current = null;
      if (mountedRef.current && !controller.signal.aborted) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [client]);

  useEffect(() => {
    mountedRef.current = true;
    const handleVisibilityChange = () => {
      const hidden = documentIsHidden();
      setPaused(hidden);
      if (hidden) {
        activeRequestRef.current?.abort();
        activeRequestRef.current = null;
      } else {
        void refresh(false);
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    void refresh(true);

    return () => {
      mountedRef.current = false;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      activeRequestRef.current?.abort();
      activeRequestRef.current = null;
    };
  }, [refresh]);

  useEffect(() => {
    if (paused) return undefined;
    const intervalId = window.setInterval(() => {
      if (!documentIsHidden()) void refresh(false);
    }, OFFICE_POLL_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, [paused, refresh]);

  const handleToggleFullscreen = useCallback(async () => {
    const element = sceneRef.current;
    if (!element) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (element.requestFullscreen) await element.requestFullscreen();
    } catch {
      // Fullscreen is a progressive enhancement; the scene remains fully usable without it.
    }
  }, []);

  useEffect(() => {
    const handleFullscreenChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (event.key.toLowerCase() !== "f" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (target instanceof HTMLElement && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      event.preventDefault();
      void handleToggleFullscreen();
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [handleToggleFullscreen]);

  const pageStatus = paused ? "已暂停" : refreshing ? "同步中" : "实时";
  const summary = useMemo(() => (scene ? summaryItems(scene) : []), [scene]);

  return (
    <VStack gap={4} className={"office-page"} role="region" aria-labelledby="office-page-heading" data-testid="office-page">
      <HStack className={"office-page-header"} justify="between" align="center" wrap="wrap">
        <VStack gap={1}>
          <span className={"office-kicker"}>AI TEAM / OFFICE 07</span>
          <Heading level={1} id="office-page-heading">办公室动态</Heading>
          <Text as="p" type="supporting">本地员工状态与任务总览；页面不可见时自动暂停刷新。</Text>
        </VStack>
        <HStack gap={2} align="center" wrap="wrap">
          <span className={`office-live-pill office-live-pill--${paused ? "paused" : "live"}`} role="status" aria-live="polite" data-testid="office-poll-state">
            <span className={"office-live-pill__dot"} aria-hidden="true" />
            {pageStatus}
          </span>
          <span className={"office-updated"} data-testid="office-last-updated">{formatUpdatedAt(lastUpdated)}</span>
          <Button label="刷新" variant="secondary" isLoading={loading || refreshing} onClick={() => void refresh(false)} data-testid="office-refresh" />
        </HStack>
      </HStack>

      {sceneError && scene ? <Banner status="error" title={sceneError} data-testid="office-scene-refresh-error" /> : null}
      {loading && !scene && !sceneError ? <Banner status="info" title="办公室加载中…" data-testid="office-loading" /> : null}
      {!loading && sceneError && !scene ? <Banner status="error" title={sceneError} data-testid="office-scene-error" /> : null}
      {!loading && !scene && !sceneError ? <EmptyState title="办公室投影不可用" description="Agent 当前没有可用的办公室数据。" data-testid="office-empty" /> : null}

      {scene ? (
        <>
          <SummaryCards scene={scene} />
          <div className={"office-main-grid"}>
            <OfficeSceneView
              scene={scene}
              selectedEmployeeId={selectedEmployeeId}
              onSelectEmployee={setSelectedEmployeeId}
              sceneRef={sceneRef}
              isFullscreen={isFullscreen}
              onToggleFullscreen={() => void handleToggleFullscreen()}
            />
            <aside className={"office-side-column"} aria-label="办公室状态与动态">
              <ActivityPanel
                employees={scene.employees}
                selectedEmployeeId={selectedEmployeeId}
                onSelectEmployee={setSelectedEmployeeId}
                onClearSelection={() => setSelectedEmployeeId(null)}
              />
              <FeedPanel feed={feed} feedLoaded={feedLoaded} loading={loading} error={feedError} />
            </aside>
          </div>
          <WorkInsights client={client} />
          <span className={"office-data-caption"} aria-live="polite">
            {summary.map((item) => `${item.label} ${item.value}`).join(" · ")}
          </span>
        </>
      ) : null}
    </VStack>
  );
}
