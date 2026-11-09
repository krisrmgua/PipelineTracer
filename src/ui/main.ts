import {
  PIPELINE_HOUR_CHOICES,
  REFRESH_CHOICES,
  cleanLog,
  descriptionSummary,
  formatDuration,
  applyJobUpdate,
  groupSameChange,
  groupTitle,
  isDone,
  isFailed,
  isReady,
  isRunning,
  settlePipeline,
  isSuccess,
  mergeRequestIID,
  mrKey,
  mrState,
  mrTone,
  numberLabel,
  pipelineKey,
  progressState,
  requestJustFinished,
  ringSlices,
  refLabel,
  relative,
  serviceName,
  statusTitle,
  unresolvedFailures,
  type ActivityEvent,
  type Job,
  type MergeRequest,
  type MrDetail,
  type Pipeline,
  type PipelineGroup,
  type Prefs,
  type TracerState,
} from "../../electron/logic";

interface TracerAPI {
  getState: () => Promise<TracerState>;
  refresh: () => Promise<void>;
  setPrefs: (prefs: Partial<Prefs>) => Promise<Prefs>;
  jobs: (pipelineKey: string, force: boolean) => Promise<Job[] | null>;
  log: (pipelineKey: string, job: Job) => Promise<string | null>;
  mrDetail: (key: string) => Promise<MrDetail | null>;
  merge: (key: string, sha: string) => Promise<boolean>;
  close: (key: string, sha: string) => Promise<boolean>;
  openExternal: (url: string) => Promise<void>;
  openNotificationSettings: () => Promise<void>;
  testNotification: () => Promise<{ ok: boolean; message: string }>;
  copy: (text: string) => Promise<void>;
  fit: (width: number, height: number) => Promise<void>;
  hide: () => Promise<void>;
  quit: () => Promise<void>;
  onState: (cb: (state: TracerState) => void) => () => void;
  onHidden: (cb: () => void) => () => void;
  onShown: (cb: () => void) => () => void;
}

declare global {
  interface Window {
    tracer: TracerAPI;
  }
}

const tracer = window.tracer;

const INBOX_WIDTH = 430;
const WORKSPACE_WIDTH = 620;
const WORKSPACE_HEIGHT = 540;

const top = document.getElementById("top")!;
const body = document.getElementById("body")!;
const content = document.getElementById("content")!;
const foot = document.getElementById("foot")!;
const overlay = document.getElementById("overlay")!;

/* ---------- icons ---------- */

const GLYPHS: Record<string, string> = {
  success:
    '<circle cx="8" cy="8" r="7" fill="currentColor" stroke="none"/><path d="M4.9 8.2l2 2 4.2-4.4" style="stroke:var(--bg)" stroke-width="1.7"/>',
  failed:
    '<circle cx="8" cy="8" r="7" fill="currentColor" stroke="none"/><path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" style="stroke:var(--bg)" stroke-width="1.7"/>',
  alert:
    '<circle cx="8" cy="8" r="7" fill="currentColor" stroke="none"/><path d="M8 4.3v4.6" style="stroke:var(--bg)" stroke-width="1.8"/><circle cx="8" cy="11.5" r="1.05" style="fill:var(--bg)" stroke="none"/>',
  running: '<circle cx="8" cy="8" r="6.2" stroke-dasharray="1.6 2.2"/><circle cx="8" cy="8" r="2.6" fill="currentColor" stroke="none"/>',
  manual: '<circle cx="8" cy="8" r="6.2"/><path d="M6.5 5.5v5M9.5 5.5v5"/>',
  canceled: '<circle cx="8" cy="8" r="6.2"/><path d="M3.6 12.4l8.8-8.8"/>',
  skipped: '<circle cx="8" cy="8" r="6.2"/><path d="M5 8h6"/>',
  clock: '<circle cx="8" cy="8" r="6.2"/><path d="M8 4.6V8l2.4 1.6"/>',
  xOutline: '<circle cx="8" cy="8" r="6.2"/><path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4"/>',
  branch:
    '<circle cx="4.5" cy="3.5" r="1.6"/><circle cx="4.5" cy="12.5" r="1.6"/><circle cx="11.5" cy="5.5" r="1.6"/><path d="M4.5 5.1v5.8M11.5 7.1c0 2.4-2.2 3-7 3.8"/>',
  merge:
    '<circle cx="4.5" cy="3.5" r="1.6"/><circle cx="4.5" cy="12.5" r="1.6"/><circle cx="11.5" cy="12.5" r="1.6"/><path d="M4.5 5.1v5.8M4.5 5.4c0 3.8 7 3.2 7 5.5"/>',
  pull:
    '<circle cx="4.5" cy="3.5" r="1.6"/><circle cx="4.5" cy="12.5" r="1.6"/><circle cx="11.5" cy="12.5" r="1.6"/><path d="M4.5 5.1v5.8M11.5 10.9V6.5a2 2 0 0 0-2-2H7.5M9 3L7.5 4.5 9 6"/>',
  chevronLeft: '<path d="M10 3.5L5.5 8l4.5 4.5"/>',
  chevronRight: '<path d="M6 3.5L10.5 8 6 12.5"/>',
  chevronDown: '<path d="M3.5 6L8 10.5 12.5 6"/>',
  chevronUp: '<path d="M3.5 10L8 5.5l4.5 4.5"/>',
  refresh: '<path d="M13 8a5 5 0 1 1-1.5-3.6"/><path d="M13 2.5v3h-3"/>',
  bell: '<path d="M4 11.5V7.5a4 4 0 0 1 8 0v4l1 1H3z"/><path d="M6.5 14h3"/>',
  bellBadge: '<path d="M4 11.5V7.5a4 4 0 0 1 6.2-3.3"/><path d="M12 8.5v3l1 1H3l1-1"/><path d="M6.5 14h3"/><circle cx="12.3" cy="4.3" r="1.9" fill="currentColor" stroke="none"/>',
  bellSlash: '<path d="M4 11.5V7.5a4 4 0 0 1 8 0v4l1 1H3z"/><path d="M6.5 14h3M2.5 2.5l11 11"/>',
  gear:
    '<circle cx="8" cy="8" r="2.2"/><circle cx="8" cy="8" r="4.4"/><path d="M8 1.8v1.8M8 12.4v1.8M1.8 8h1.8M12.4 8h1.8M3.6 3.6l1.3 1.3M11.1 11.1l1.3 1.3M3.6 12.4l1.3-1.3M11.1 4.9l1.3-1.3"/>',
  external: '<path d="M9 2.5h4.5V7M13.5 2.5l-6 6"/><path d="M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 3.5V3a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v6.5a1 1 0 0 0 1 1h.5"/>',
  lock: '<rect x="3.5" y="7" width="9" height="7" rx="1.5" fill="currentColor" stroke="none"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>',
  warn: '<path d="M8 2l6.5 11.5h-13z"/><path d="M8 6.5V10M8 11.9v.1"/>',
  terminal: '<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M4.5 6l2 2-2 2M8 10.5h3.5"/>',
};

function icon(name: string, size = 12): string {
  return `<svg class="i" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${GLYPHS[name] ?? ""}</svg>`;
}

function tinted(name: string, color: string, size = 12, extra = ""): string {
  return `<span style="color:${color};display:inline-flex;justify-content:center;flex:0 0 auto;${extra}">${icon(name, size)}</span>`;
}

function statusIcon(status: string): string {
  switch (status) {
    case "success":
    case "passed":
    case "merged":
    case "ready":
      return "success";
    case "failed":
      return "failed";
    case "running":
      return "running";
    case "manual":
      return "manual";
    case "canceled":
    case "cancelled":
      return "canceled";
    case "skipped":
      return "skipped";
    default:
      return "clock";
  }
}

function tone(status: string): string {
  switch (status) {
    case "success":
    case "passed":
    case "merged":
    case "ready":
      return "var(--green)";
    case "failed":
      return "var(--red)";
    case "running":
      return "var(--orange)";
    case "manual":
    case "waiting_for_resource":
      return "var(--yellow)";
    default:
      return "var(--gray)";
  }
}

/* ---------- view state ---------- */

type Screen = "overview" | "history" | "notifications" | "settings" | "pipeline" | "group" | "mr";
type EventFilter = "All" | "Pipelines" | "Merges";

let state: TracerState | null = null;

const ui = {
  screen: "overview" as Screen,
  pipeline: null as Pipeline | null,
  group: [] as Pipeline[],
  groupJobs: new Map<string, Job[]>(),
  jobs: [] as Job[],
  loadingJobs: false,
  loadError: null as string | null,
  logJob: null as Job | null,
  logTab: "logs" as "logs" | "summary",
  logText: "",
  loadingLog: false,
  logScrollToEnd: false,
  search: "",
  repoFilter: "",
  showOther: false,
  eventFilter: "All" as EventFilter,
  expandedHistory: null as string | null,
  historyJobs: new Map<string, Job[]>(),
  historyLoading: null as string | null,
  historyError: null as string | null,
  mr: null as MergeRequest | null,
  mrBody: "",
  mrAuthor: "",
  mrJobs: [] as Job[],
  mrLoading: false,
  mrError: null as string | null,
  mrMissing: false,
  confirming: null as "merge" | "close" | null,
  testNote: null as string | null,
  testNoteOk: true,
};

/** Bumped whenever the screen changes, so a late reply for the old screen is dropped. */
let requestToken = 0;
let logToken = 0;

function returnToOverview(): void {
  requestToken++;
  logToken++;
  Object.assign(ui, {
    screen: "overview",
    pipeline: null,
    group: [],
    groupJobs: new Map(),
    jobs: [],
    loadingJobs: false,
    loadError: null,
    logJob: null,
    logText: "",
    loadingLog: false,
    logScrollToEnd: false,
    search: "",
    expandedHistory: null,
    historyLoading: null,
    historyError: null,
    mr: null,
    mrBody: "",
    mrAuthor: "",
    mrJobs: [],
    mrLoading: false,
    mrError: null,
    mrMissing: false,
    confirming: null,
  });
}

async function call<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise;
  } catch {
    return null;
  }
}

/* ---------- helpers ---------- */

function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const completed = (jobs: Job[]): number => jobs.filter((j) => isDone(j.status)).length;
const duration = (j: Job, fallback: string): string => (j.duration != null ? formatDuration(j.duration) : fallback);
const requestNoun = (mr: MergeRequest): string => (mr.host === "github" ? "pull request" : "merge request");

function derived(s: TracerState) {
  const pipelines = s.pipelines.map((p) => settlePipeline(p));
  const failureGroups = groupSameChange(unresolvedFailures(pipelines));
  const activeGroups = groupSameChange(pipelines.filter((p) => isRunning(p) || p.status === "manual"));
  const finished = pipelines.filter(isSuccess);
  const other = pipelines.filter((p) => ["canceled", "cancelled", "skipped"].includes(p.status));
  const mergedEvents = s.events.filter((e) => e.status === "merged");
  return { failureGroups, activeGroups, finished, other, mergedEvents };
}

function findPipeline(key: string): Pipeline | null {
  const live = state?.pipelines.find((p) => pipelineKey(p) === key);
  if (live) return live;
  if (ui.pipeline && pipelineKey(ui.pipeline) === key) return ui.pipeline;
  return ui.group.find((p) => pipelineKey(p) === key) ?? null;
}

/** First non-empty job list this panel already has for a pipeline. */
function knownJobs(key: string): Job[] {
  const lists = [
    ui.pipeline && pipelineKey(ui.pipeline) === key ? ui.jobs : [],
    ui.groupJobs.get(key) ?? [],
    ui.historyJobs.get(key) ?? [],
    findPipeline(key)?.jobs ?? [],
  ];
  return lists.find((l) => l.length) ?? [];
}

/* ---------- small pieces ---------- */

function countLabel(n: number, color: string): string {
  return `<span class="count" style="color:${color};background:color-mix(in srgb, ${color} 10%, transparent)">${n}</span>`;
}

function badge(text: string, status: string): string {
  const c = tone(status);
  return `<span class="badge" style="color:${c};background:color-mix(in srgb, ${c} 12%, transparent)">${icon(statusIcon(status), 11)}${esc(text)}</span>`;
}

function heading(title: string, count: number, color: string, glyph: string): string {
  return `<div class="heading">${tinted(glyph, color, 12, "width:16px")}<span>${esc(title)}</span>${countLabel(count, color)}</div>`;
}

function panel(rows: string[]): string {
  return `<div class="panel">${rows.join('<div class="divider"></div>')}</div>`;
}

const empty = (text: string): string => `<div class="empty">${esc(text)}</div>`;

function loading(text: string): string {
  return `<div class="note" style="display:flex;align-items:center;gap:6px"><span class="spinner"></span><span>${esc(text)}</span></div>`;
}

function warnLine(text: string): string {
  return `<div class="note" style="display:flex;align-items:flex-start;gap:6px;color:var(--orange)">${icon("warn", 11)}<span>${esc(text)}</span></div>`;
}

function meta(k: string, v: string): string {
  return `<div class="meta"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`;
}

function openButton(url: string, label: string): string {
  return `<button type="button" class="icon-btn" style="color:var(--cyan)" data-act="open" data-url="${esc(url)}" title="${esc(label)}">${icon("external", 14)}</button>`;
}

function ring(p: Pipeline): string {
  const c = tone(p.status);
  const done = completed(p.jobs);
  const slices = ringSlices(p.jobs);
  const r = 11.5;
  const circ = 2 * Math.PI * r;
  const n = slices.length;
  const sliceLen = n > 0 ? circ / n : 0;
  const phase = ((Date.now() % 1100) / 1100) * 1.1;
  const arcs = slices
    .map((slice, i) => {
      if (slice.kind === "wait" || sliceLen <= 0) return "";
      const start = -(i * circ) / n;
      const solid = slice.kind === "done" ? sliceLen : sliceLen * slice.fill;
      const body =
        solid > 0.4
          ? `<circle cx="13" cy="13" r="${r}" fill="none" style="stroke:${c}" stroke-width="3" stroke-linecap="butt" stroke-dasharray="${solid.toFixed(2)} ${circ.toFixed(2)}" stroke-dashoffset="${start.toFixed(2)}"/>`
          : "";
      if (slice.kind !== "running") return body;
      // Stay inside the orange. A longer dash, or a round cap, draws past the fill.
      const shine = Math.min(solid * 0.42, 7);
      if (shine < 0.8) return body;
      const from = start;
      const to = start - Math.max(0, solid - shine);
      return `${body}<circle class="ring-shine" cx="13" cy="13" r="${r}" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="butt" stroke-dasharray="${shine.toFixed(2)} ${circ.toFixed(2)}" style="--shine-from:${from.toFixed(2)}px;--shine-to:${to.toFixed(2)}px;animation-delay:-${phase.toFixed(3)}s"/>`;
    })
    .join("");
  const label = p.jobs.length
    ? `<span class="label" style="color:${c}">${done}/${p.jobs.length}</span>`
    : tinted(statusIcon(p.status), c, 10);
  const aria = p.jobs.length ? `${p.status}, ${done} of ${p.jobs.length} jobs finished` : `${p.status}, job details not loaded`;
  return `<span class="ring" role="img" aria-label="${esc(aria)}"><svg class="r" width="26" height="26" viewBox="0 0 26 26"><circle cx="13" cy="13" r="${r}" fill="none" style="stroke:${c}" stroke-opacity="0.22" stroke-width="3"/>${arcs}</svg>${label}</span>`;
}

function jobRow(j: Job, key: string, small = false): string {
  return `<div class="jobrow${small ? " small" : ""}">
    ${tinted(statusIcon(j.status), tone(j.status), 12, "width:15px")}
    <span class="name" title="${esc(j.name)}">${esc(j.name)}</span>
    <span class="dur">${esc(duration(j, small ? "—" : statusTitle(j.status)))}</span>
    ${j.id < 0 ? "" : `<button type="button" class="inline" data-act="log" data-key="${esc(key)}" data-job="${j.id}">View logs</button>`}
  </div>`;
}

/* ---------- rows ---------- */

function pipelineRow(p: Pipeline, history = false): string {
  const key = pipelineKey(p);
  const failedJob = isFailed(p) ? p.jobs.find((j) => j.status === "failed") : undefined;
  const lead = isFailed(p) ? `<span class="fail-icon" style="color:var(--red)">${icon("alert", 23)}</span>` : ring(p);
  const progress = isRunning(p)
    ? `<span class="progress-count mono">${p.jobs.length ? `${completed(p.jobs)}/${p.jobs.length}` : "—"}</span><span class="vrule"></span>`
    : "";
  const title = isFailed(p) ? "Pipeline failed" : p.workflow || `Pipeline #${p.id}`;
  const tip = `${p.project} #${p.id} · ${refLabel(p)} · ${statusTitle(p.status)}`;
  const chev = history && ui.expandedHistory === key ? "chevronDown" : "chevronRight";
  return `<button type="button" class="row" data-act="${history ? "history-toggle" : "pipeline"}" data-key="${esc(key)}" title="${esc(tip)}">
    ${lead}${progress}
    <span class="main">
      <span class="t">${esc(title)}</span>
      <span class="s">${esc(`${p.project} · ${refLabel(p)}`)}</span>
      ${failedJob ? `<span class="s">${esc(failedJob.name)} failed</span>` : ""}
    </span>
    <span class="when">${esc(relative(p.updated))}</span>
    <span class="chev">${icon(chev, 10)}</span>
  </button>`;
}

function groupRow(g: PipelineGroup): string {
  if (g.pipelines.length === 1) return pipelineRow(g.pipelines[0]);
  const branch = g.pipelines.find((p) => mergeRequestIID(p) == null);
  const mrPipe = g.pipelines.find((p) => mergeRequestIID(p) != null);
  const iid = mrPipe ? mergeRequestIID(mrPipe) : null;
  const times = g.pipelines.map((p) => p.updated).filter((t): t is number => t != null);
  const when = times.length ? Math.max(...times) : null;
  const states = [
    mrPipe ? esc(`MR !${iid} · ${statusTitle(mrPipe.status)}`) : "",
    branch ? esc(`branch · ${statusTitle(branch.status)}`) : "",
  ].filter(Boolean);
  return `<button type="button" class="row" data-act="group" data-keys="${esc(g.pipelines.map(pipelineKey).join(","))}">
    ${ring(g.primary)}
    <span class="main">
      <span class="t">${esc(groupTitle(g.pipelines))}</span>
      <span class="s">${esc(`${g.primary.project} · MR !${iid ?? 0}`)}</span>
      <span class="s">${states.join("&emsp;")}</span>
    </span>
    <span class="when">${esc(relative(when))}</span>
    <span class="chev">${icon("chevronRight", 10)}</span>
  </button>`;
}

function mrRow(mr: MergeRequest): string {
  const c = tone(mrTone(mr));
  const st = mrState(mr);
  const showAuthor = (state?.prefs.showAllRequests ?? []).includes(`${mr.host}:${mr.project}`) && mr.author;
  const subtitle = showAuthor ? `${mr.project} · ${mr.author}` : mr.project;
  return `<button type="button" class="row" data-act="mr" data-key="${esc(mrKey(mr))}" title="${esc(`${numberLabel(mr)} ${mr.title} — ${st}`)}">
    ${tinted("branch", c, 19, "width:22px")}
    <span class="main">
      <span class="t">${esc(numberLabel(mr))}&ensp;${esc(mr.title)}</span>
      <span class="s">${esc(subtitle)}</span>
    </span>
    <span class="when" style="color:${c}">${esc(st)}</span>
    <span class="chev">${icon("chevronRight", 10)}</span>
  </button>`;
}

/* ---------- screens ---------- */

function renderOverview(s: TracerState): string {
  const { failureGroups, activeGroups, finished, other, mergedEvents } = derived(s);
  const firstLoad = s.refreshing && s.updated == null;
  const parts: string[] = [];
  if (s.error) parts.push(`<div class="banner">${icon("warn", 13)}<span>${esc(s.error)}</span></div>`);
  if (s.result) parts.push(`<div class="note">${esc(s.result)}</div>`);

  if (failureGroups.length) {
    parts.push(heading("Attention needed", failureGroups.length, "var(--red)", "pull"));
    parts.push(panel(failureGroups.map(groupRow)));
  }

  parts.push(heading("In progress", activeGroups.length, "var(--cyan)", "branch"));
  parts.push(panel(activeGroups.length ? activeGroups.map(groupRow) : [empty(firstLoad ? "Loading pipelines…" : "No active pipelines")]));

  parts.push(heading("Requests", s.mrs.length, "var(--cyan)", "pull"));
  parts.push(panel(s.mrs.length ? s.mrs.map(mrRow) : [empty(firstLoad ? "Loading requests…" : "No open requests")]));

  parts.push(
    panel([
      `<button type="button" class="row" data-act="history" style="padding:10px">
        ${tinted("success", "var(--green)", 13)}
        <span class="section-label">Recent successes</span>
        ${countLabel(finished.length + mergedEvents.length, "var(--green)")}
        <span style="flex:1"></span>
        <span class="chev">${icon("chevronDown", 11)}</span>
      </button>`,
    ]),
  );

  if (other.length) {
    const rows = [
      `<button type="button" class="row" data-act="toggle-other" style="padding:10px" aria-expanded="${ui.showOther}">
        <span class="section-label">Canceled &amp; skipped</span>
        ${countLabel(other.length, "var(--muted)")}
        <span style="flex:1"></span>
        <span class="chev">${icon(ui.showOther ? "chevronUp" : "chevronDown", 11)}</span>
      </button>`,
    ];
    if (ui.showOther) rows.push(...other.map((p) => pipelineRow(p)));
    parts.push(panel(rows));
  }

  return `<div class="stack">${parts.join("")}</div>`;
}

function renderHistory(s: TracerState): string {
  const { finished, mergedEvents } = derived(s);
  const rows: string[] = [];
  for (const p of finished.slice(0, 30)) {
    const key = pipelineKey(p);
    let row = pipelineRow(p, true);
    if (ui.expandedHistory === key) {
      if (ui.historyLoading === key) row += `<div style="padding:8px 10px">${loading("Loading jobs…")}</div>`;
      if (ui.historyError) row += `<div style="padding:8px 10px">${warnLine(ui.historyError)}</div>`;
      row += (ui.historyJobs.get(key) ?? p.jobs).map((j) => jobRow(j, key, true)).join("");
    }
    rows.push(row);
  }
  for (const e of mergedEvents) {
    rows.push(`<button type="button" class="row" data-act="open" data-url="${esc(e.url)}" style="padding:10px">
      ${tinted("merge", "var(--green)", 14)}
      <span class="main"><span class="t" style="font-weight:500">${esc(e.title)}</span><span class="s">${esc(e.detail)}</span></span>
      <span class="tiny">${esc(relative(e.date))}</span>
    </button>`);
  }
  return `<div class="stack wide">
    ${panel([
      `<button type="button" class="row" data-act="back" style="padding:10px">
        ${tinted("success", "var(--green)", 13)}
        <span class="section-label">Recent successes</span>
        ${countLabel(finished.length + mergedEvents.length, "var(--green)")}
        <span style="flex:1"></span>
        <span class="chev">${icon("chevronUp", 11)}</span>
      </button>`,
    ])}
    <div class="tiny">${s.prefs.pipelineHours}-hour pipeline window · merge events from this session</div>
    ${panel(rows.length ? rows : [empty("No recent completions")])}
  </div>`;
}

const isMergeEvent = (e: ActivityEvent): boolean =>
  e.url.includes("/merge_requests/") || e.url.includes("/pull/") || e.title.startsWith("Merge");
const eventProject = (e: ActivityEvent): string => e.detail.split(" ")[0] || "Pipeline Tracer";
const isConnectionEvent = (e: ActivityEvent): boolean => e.title.toLowerCase().includes("connection");

function eventLabel(e: ActivityEvent): string {
  if (isConnectionEvent(e)) return "Retry";
  if (e.url.includes("/merge_requests/")) return "View MR";
  if (e.url.includes("/pull/")) return "View PR";
  if (e.url.includes("/jobs/")) return "View logs";
  return "View pipeline";
}

function tabs(items: Array<[string, string]>, selected: string, act: string): string {
  return `<div class="tabs">${items
    .map(
      ([key, label]) =>
        `<button type="button" class="tab${key === selected ? " active" : ""}" data-act="${act}" data-value="${esc(key)}">${esc(label)}</button>`,
    )
    .join("")}</div>`;
}

function renderNotifications(s: TracerState): string {
  const events = s.events.filter(
    (e) => ui.eventFilter === "All" || (ui.eventFilter === "Merges" ? isMergeEvent(e) : !isMergeEvent(e)),
  );
  const parts = [
    tabs(
      [
        ["All", "All"],
        ["Pipelines", "Pipelines"],
        ["Merges", "Merges"],
      ],
      ui.eventFilter,
      "filter",
    ),
  ];
  if (!events.length) parts.push(panel([empty("No notifications this session")]));
  const projects = [...new Set(events.map(eventProject))];
  for (const project of projects) {
    parts.push(`<div class="tiny" style="font-size:10px;font-weight:600">${esc(project)}</div>`);
    parts.push(
      panel(
        events
          .filter((e) => eventProject(e) === project)
          .map(
            (e) => `<div class="event${e.status === "failed" ? " failed" : ""}">
              ${tinted(statusIcon(e.status), tone(e.status), 15, "width:22px")}
              <span style="flex:1;min-width:0;display:flex;flex-direction:column;gap:4px">
                <span class="t">${esc(e.title)}</span>
                <span class="s">${esc(e.detail)}</span>
              </span>
              <span class="side">
                <span class="tiny">${esc(relative(e.date))}</span>
                <button type="button" class="inline" data-act="${isConnectionEvent(e) ? "refresh" : "event"}" data-id="${esc(e.id)}">${eventLabel(e)}</button>
              </span>
            </div>`,
          ),
      ),
    );
  }
  parts.push('<div class="tiny">This session · failures alert with sound; routine successes stay quiet</div>');
  return `<div class="stack wide">${parts.join("")}</div>`;
}

function toggle(key: keyof Prefs, label: string, on: boolean): string {
  return `<label class="pref"><span class="label">${esc(label)}</span><input type="checkbox" class="switch" data-pref="${key}"${on ? " checked" : ""} /></label>`;
}

function choice(key: keyof Prefs, label: string, options: number[], value: number, suffix: string): string {
  const opts = options
    .map((o) => `<option value="${o}"${o === value ? " selected" : ""}>${o} ${esc(suffix)}</option>`)
    .join("");
  return `<label class="pref"><span class="label">${esc(label)}</span><select class="select" data-pref="${key}">${opts}</select></label>`;
}

function repoToggles(s: TracerState): string[] {
  const repos = s.repos ?? [];
  if (!repos.length) return ['<div class="note" style="padding:10px">Repos show up here after a refresh.</div>'];
  const needle = ui.repoFilter.trim().toLowerCase();
  const filtered = needle
    ? repos.filter((repo) => {
        const host = repo.host === "github" ? "github" : "gitlab";
        return repo.name.toLowerCase().includes(needle) || host.includes(needle);
      })
    : repos;
  if (!filtered.length) {
    return ['<div class="note" style="padding:10px">No repos match that filter.</div>'];
  }
  const enabled = new Set(s.prefs.showAllRequests ?? []);
  return filtered.map((repo) => {
    const host = repo.host === "github" ? "GitHub" : "GitLab";
    const on = enabled.has(repo.key);
    return `<label class="pref"><span class="label">${esc(repo.name)} <span class="tiny">${host}</span></span><input type="checkbox" class="switch" data-repo="${esc(repo.key)}"${on ? " checked" : ""} /></label>`;
  });
}

function cliRow(name: string, path: string | null): string {
  return `<div class="cli-row">
    ${tinted("terminal", path ? "var(--green)" : "var(--orange)", 12)}
    <span class="mono" style="width:30px;flex:0 0 30px">${esc(name)}</span>
    <span class="path">${esc(path ?? "Not found on PATH or the usual install folders")}</span>
    <span class="${path ? "ok-text" : "bad-text"}">${path ? "Found" : "Missing"}</span>
  </div>`;
}

function renderSettings(s: TracerState): string {
  const p = s.prefs;
  const mac = s.platform === "darwin";
  const supported = s.notificationsSupported;
  const enabled = p.notifications;
  const banner = !enabled
    ? "Banners are off. Events still show under the bell."
    : mac
      ? "Failures are titled Pipeline Tracer and play a sound. macOS chooses the banner colors. Click a banner to open its page."
      : "Failures are titled Pipeline Tracer, play a sound, and stay until you dismiss them. Click a notification to open its page.";
  return `<div class="stack wide">
    <div class="section-label">Panel</div>
    ${panel([toggle("rememberPlace", "Reopen where I left off", p.rememberPlace)])}
    <div class="section-label">Pipelines</div>
    ${panel([
      choice("refreshSeconds", "Refresh interval", REFRESH_CHOICES, p.refreshSeconds, "seconds"),
      choice("pipelineHours", "Completion history", PIPELINE_HOUR_CHOICES, p.pipelineHours, "hours"),
      toggle("mergeButton", "Show merge actions", p.mergeButton),
      ...(mac ? [toggle("stackMenuBar", "Stack menu bar counters", p.stackMenuBar)] : []),
    ])}
    <div class="section-head">
      <div class="section-label">Show All Merge Requests</div>
      <input id="repo-filter" class="search repo-filter" type="search" placeholder="Filter repos…" spellcheck="false" aria-label="Filter repositories" />
    </div>
    ${panel(repoToggles(s))}
    <div class="tiny">Off lists requests you opened. On lists every open request in that repo. Merge stays hidden when you cannot merge.</div>
    <div class="section-label">Startup</div>
    ${panel([toggle("startAtLogin", "Open at login", p.startAtLogin)])}
    <div class="section-label">Notifications</div>
    ${panel([
      toggle("notifications", "Show notifications", enabled),
      `<div class="stack" style="padding:10px">
        <div style="display:flex;align-items:center;gap:6px;color:var(--cyan)">${icon("bellBadge", 12)}<span>Failures alert · successes stay quiet</span></div>
        <div class="note" style="display:flex;align-items:center;gap:6px;color:${supported ? "var(--green)" : "var(--orange)"}">${icon(supported ? "success" : "bellSlash", 11)}<span>${supported ? "Notifications available on this system" : "Notifications are not supported here"}</span></div>
        <div class="note">${esc(banner)}</div>
        <div style="display:flex;gap:6px">
          <button type="button" class="inline" data-act="notification-settings">Notification settings</button>
          <button type="button" class="inline" data-act="notification-test"${supported && enabled ? "" : " disabled"}>Send test</button>
        </div>
        ${
          ui.testNote
            ? `<div class="note" style="color:${ui.testNoteOk ? "var(--green)" : "var(--orange)"}">${esc(ui.testNote)}</div>`
            : ""
        }
      </div>`,
    ])}
    <div class="section-label">Command-line tools</div>
    ${panel([cliRow("glab", s.cli.glab), cliRow("gh", s.cli.gh)])}
    <div class="tiny">Tracer runs glab and gh directly. They own the GitLab and GitHub tokens; Tracer never stores one.</div>
    <div style="display:flex;justify-content:flex-end"><button type="button" class="inline" data-act="quit">Quit Pipeline Tracer</button></div>
  </div>`;
}

function stageStatus(jobs: Job[]): string {
  const statuses = jobs.map((j) => j.status);
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("running")) return "running";
  if (statuses.includes("manual")) return "manual";
  if (statuses.every((s) => s === "success" || s === "passed")) return "success";
  if (statuses.every((s) => s === "skipped")) return "skipped";
  if (statuses.every((s) => s === "canceled" || s === "cancelled")) return "canceled";
  return "pending";
}

function stageTrack(jobs: Job[]): string {
  const stages = [...new Set(jobs.map((j) => j.stage))];
  const pieces = stages.map((stage) => {
    const list = jobs.filter((j) => j.stage === stage);
    const status = stageStatus(list);
    return `<div class="stage">
      ${tinted(statusIcon(status), tone(status), 24)}
      <span class="name">${esc(stage)}</span>
      <span class="jobs">${completed(list)}/${list.length} jobs</span>
    </div>`;
  });
  return `<div class="stage-track" data-scroll="stages"><div class="inner">${pieces.join('<span class="link"></span>')}</div></div>`;
}

function visibleLines(): string[] {
  const lines = ui.logText.split("\n");
  if (!ui.search) return lines;
  const q = ui.search.toLowerCase();
  return lines.filter((l) => l.toLowerCase().includes(q));
}

function logHtml(lines: string[]): string {
  return lines
    .map((line) => {
      const lower = line.toLowerCase();
      return lower.includes("error") || lower.includes("fail") ? `<span class="bad">${esc(line)}</span>` : esc(line);
    })
    .join("\n");
}

const logCount = (n: number): string => `Log snapshot · latest 250,000 characters · ${n} visible lines`;

function renderLog(p: Pipeline, job: Job): string {
  const service = serviceName(p);
  const jobURL = job.url || p.url;
  const head = panel([
    `<div class="jobrow">
      ${tinted(statusIcon(job.status), tone(job.status), 12, "width:15px")}
      <span class="name" style="font-weight:600">${esc(job.name)}</span>
      <span class="dur">${esc(duration(job, ""))}</span>
      <button type="button" class="inline" data-act="all-jobs">All jobs</button>
    </div>`,
  ]);
  const tabBar = tabs(
    [
      ["logs", "Logs"],
      ["summary", "Job summary"],
    ],
    ui.logTab,
    "log-tab",
  );
  if (ui.logTab === "summary") {
    return `${head}${tabBar}
      ${panel([
        `<div class="stack wide" style="padding:12px">
          ${meta("Job", job.name)}
          ${meta("Stage", job.stage)}
          ${meta("Status", statusTitle(job.status))}
          ${meta("Duration", duration(job, "Not reported"))}
        </div>`,
      ])}
      <div style="display:flex"><button type="button" class="action" data-act="open" data-url="${esc(jobURL)}">Open job on ${service}</button></div>`;
  }
  const lines = visibleLines();
  const copyOff = ui.loadingLog || !ui.logText ? " disabled" : "";
  return `${head}${tabBar}
    <div class="log-tools">
      <input id="log-search" class="search" type="search" placeholder="Search logs…" spellcheck="false" />
      <button type="button" class="inline" data-act="copy-log"${copyOff}>${icon("copy", 10)}Copy</button>
      <button type="button" class="inline" data-act="open" data-url="${esc(jobURL)}">${icon("external", 10)}${service}</button>
    </div>
    ${ui.loadingLog ? loading("Loading log…") : ""}
    <pre class="log" id="log-text" data-scroll="log">${logHtml(lines)}</pre>
    <div class="tiny" id="log-count">${logCount(lines.length)}</div>`;
}

function renderPipeline(p: Pipeline): string {
  const key = pipelineKey(p);
  const service = serviceName(p);
  const shown = settlePipeline({ ...p, jobs: ui.jobs.length ? ui.jobs : p.jobs });
  const parts = [
    `<div class="detail-head">
      <div class="main">
        <span class="t">#${p.id}&ensp;${esc(p.project)}</span>
        <span class="s">${esc(`${refLabel(p)} · ${relative(p.updated)}`)}</span>
      </div>
      ${badge(statusTitle(shown.status), shown.status)}
      ${openButton(p.url, `Open pipeline on ${service}`)}
    </div>`,
  ];
  if (ui.loadError) parts.push(warnLine(ui.loadError));
  if (ui.loadingJobs && !ui.logJob) parts.push(loading("Loading jobs…"));
  if (ui.logJob) {
    parts.push(renderLog(p, ui.logJob));
  } else if (ui.jobs.length) {
    parts.push(stageTrack(ui.jobs));
    parts.push(`<div style="display:flex;align-items:center;gap:8px">
      <span class="section-label" style="font-size:11px">Jobs (${ui.jobs.length})</span>
      <span style="flex:1"></span>
      <span class="note">${completed(ui.jobs)} finished</span>
    </div>`);
    parts.push(panel(ui.jobs.map((j) => jobRow(j, key))));
  } else if (!ui.loadingJobs && !ui.loadError) {
    parts.push(panel([empty(`No jobs available · Open ${service} for details`)]));
  }
  return `<div class="stack wide">${parts.join("")}</div>`;
}

function renderGroup(): string {
  const ps = ui.group;
  const sections = ps.map((p) => {
    const key = pipelineKey(p);
    const jobs = ui.groupJobs.get(key) ?? p.jobs;
    const shown = settlePipeline({ ...p, jobs });
    const iid = mergeRequestIID(p);
    return `<div class="stack">
      <div style="display:flex;align-items:center;gap:8px">
        <span class="section-label" style="font-size:11px">${iid == null ? "Branch" : `MR !${iid}`}</span>
        <span class="mono note">#${p.id}</span>
        <span style="flex:1"></span>
        ${badge(statusTitle(shown.status), shown.status)}
        ${openButton(p.url, `Open pipeline on ${serviceName(p)}`)}
      </div>
      <div class="s">${esc(iid == null ? p.ref : `refs/merge-requests/${iid}/head`)}</div>
      ${ui.loadingJobs && !jobs.length ? loading("Loading jobs…") : ""}
      ${jobs.length ? panel(jobs.map((j) => jobRow(j, key))) : ""}
    </div>`;
  });
  return `<div class="stack wide">
    <div class="detail-head"><div class="main">
      <span class="t">${esc(groupTitle(ps))}</span>
      <span class="s">${esc(ps[0]?.project ?? "")} · one change, two GitLab pipelines</span>
    </div></div>
    ${ui.loadError ? warnLine(ui.loadError) : ""}
    ${sections.join("")}
  </div>`;
}

function renderWorkspace(s: TracerState, mr: MergeRequest): string {
  const key = mrKey(mr);
  const gh = mr.host === "github";
  const busy = s.merging != null || s.closing != null;
  const error =
    ui.mrError ??
    (ui.mrMissing
      ? `This ${requestNoun(mr)} is no longer in the open list. Refresh or open ${gh ? "GitHub" : "GitLab"}.`
      : null);
  const pipe = mr.pipelineStatus ?? "pending";
  const checks = [
    `<div class="jobrow">
      ${tinted(statusIcon(pipe), tone(pipe), 12, "width:15px")}
      <span class="name" style="font-weight:500">${gh ? "Checks" : "Pipeline"}: ${esc(statusTitle(mr.pipelineStatus ?? "not reported"))}</span>
    </div>`,
    ...ui.mrJobs.map(
      (j) => `<div class="jobrow" style="padding:7px 10px">
        ${tinted(statusIcon(j.status), tone(j.status), 11, "width:15px")}
        <span class="name" style="font-size:10px" title="${esc(j.name)}">${esc(j.name)}</span>
        <span class="dur">${esc(duration(j, "—"))}</span>
      </div>`,
    ),
  ];
  const showMerge = s.prefs.mergeButton && mr.canMerge;
  const mergeOff = !isReady(mr) || busy || ui.mrLoading || error != null;
  const closeOff = busy || ui.mrLoading;
  const mergeButton = showMerge
    ? `<button type="button" class="action primary" data-act="merge-ask"${mergeOff ? " disabled" : ""}>${isReady(mr) ? "" : icon("lock", 10)}${s.merging === key ? "Merging…" : "Merge"}</button>`
    : "";
  const closeLabel = s.closing === key ? "Closing…" : gh ? "Close PR" : "Close MR";

  // Full-width detail only — the overview already listed open requests.
  return `<div class="stack wide" data-scroll="mr-detail">
    <div class="detail-head">
      ${tinted("branch", "var(--cyan)", 14, "padding-top:1px")}
      <div class="main">
        <span class="t" style="font-size:13px">${esc(numberLabel(mr))}&ensp;${esc(mr.title)}</span>
        <span class="s">${esc(mr.project)}</span>
      </div>
      ${openButton(mr.url, gh ? "Open pull request on GitHub" : "Open merge request in GitLab")}
    </div>
    ${badge(mrState(mr), mrTone(mr))}
    ${ui.mrLoading ? loading(gh ? "Loading pull request…" : "Loading merge request…") : ""}
    ${error ? warnLine(error) : ""}
    ${ui.mrBody ? `<div class="description">${esc(descriptionSummary(ui.mrBody))}</div>` : ""}
    <div class="stack">
      ${meta("Source", mr.sourceBranch || "Not reported")}
      ${meta("Target", mr.targetBranch || "Not reported")}
      ${ui.mrAuthor ? meta("Author", ui.mrAuthor) : ""}
    </div>
    ${panel(checks)}
    <div style="display:flex;gap:8px">
      ${mergeButton}
      <button type="button" class="action${showMerge ? " fit" : ""}" data-act="close-ask"${closeOff ? " disabled" : ""}>${closeLabel}</button>
    </div>
    ${
      showMerge
        ? `<div class="note ${isReady(mr) ? "ok-text" : "bad-text"}" style="font-weight:500">${esc(
            isReady(mr) ? "Ready to merge." : `Merge unavailable: ${mrState(mr)}.`,
          )}</div>`
        : ""
    }
  </div>`;
}

function renderScreen(s: TracerState): string {
  switch (ui.screen) {
    case "settings":
      return renderSettings(s);
    case "notifications":
      return renderNotifications(s);
    case "history":
      return renderHistory(s);
    case "group":
      return ui.group.length ? renderGroup() : renderOverview(s);
    case "pipeline":
      return ui.pipeline ? renderPipeline(ui.pipeline) : renderOverview(s);
    case "mr":
      return ui.mr ? renderWorkspace(s, ui.mr) : renderOverview(s);
    default:
      return renderOverview(s);
  }
}

function screenTitle(): string {
  switch (ui.screen) {
    case "pipeline":
      return ui.logJob ? "Job logs" : "Pipeline";
    case "group":
      return groupTitle(ui.group);
    case "mr":
      return ui.mr?.host === "github" ? "Pull request" : "Merge request";
    case "settings":
      return "Preferences";
    case "notifications":
      return "Notifications";
    case "history":
      return "Recent successes";
    default:
      return "Pipeline Tracer";
  }
}

function renderTop(s: TracerState | null): string {
  const title = screenTitle();
  const lead =
    ui.screen === "overview"
      ? `<span class="title">${esc(title)}</span>`
      : `<button type="button" class="back" data-act="back" title="Back">${icon("chevronLeft", 12)}<span style="overflow:hidden;text-overflow:ellipsis">${esc(title)}</span></button>`;
  return `${lead}
    <span class="spacer"></span>
    ${s?.refreshing ? '<span class="spinner" role="status" aria-label="Refreshing"></span>' : ""}
    <button type="button" class="icon-btn" data-act="refresh" title="Refresh">${icon("refresh", 14)}</button>
    <button type="button" class="icon-btn" data-act="notifications" title="Notifications">${icon("bell", 14)}</button>
    <button type="button" class="icon-btn" data-act="settings" title="Preferences">${icon("gear", 14)}</button>`;
}

function renderFoot(s: TracerState | null): string {
  const updated = s?.updated
    ? `Updated ${new Date(s.updated).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
    : "Connecting…";
  const ver = s?.version ? `v${s.version} · ` : "";
  const counts = s ? `${s.mrs.length} MRs · ${derived(s).activeGroups.length} active` : "";
  return `<span>${esc(ver + updated)}</span><span>${esc(counts)}</span>`;
}

function renderOverlay(): void {
  const mr = ui.mr;
  if (!ui.confirming || !mr || ui.screen !== "mr") {
    overlay.classList.add("hidden");
    setHTML(overlay, "");
    return;
  }
  const gh = mr.host === "github";
  const where = `${numberLabel(mr)} in ${mr.project}`;
  const html =
    ui.confirming === "merge"
      ? `<div class="confirm" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
          ${tinted("merge", "var(--cyan)", 25)}
          <h2 id="confirm-title">${gh ? "Merge pull request?" : "Merge request?"}</h2>
          <p>Merge ${esc(where)}</p>
          <div class="sub mono">${esc(`${mr.sourceBranch} → ${mr.targetBranch}`)}</div>
          <div class="buttons">
            <button type="button" class="action" id="confirm-cancel" data-act="confirm-cancel">Cancel</button>
            <button type="button" class="action primary" data-act="confirm-merge">Merge</button>
          </div>
        </div>`
      : `<div class="confirm warn" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
          ${tinted("xOutline", "var(--orange)", 25)}
          <h2 id="confirm-title">${gh ? "Close pull request?" : "Close merge request?"}</h2>
          <p>Close ${esc(where)}</p>
          <div class="sub">Leaves the source branch as-is. This does not delete anything.</div>
          <div class="buttons">
            <button type="button" class="action" id="confirm-cancel" data-act="confirm-cancel">Cancel</button>
            <button type="button" class="action primary" data-act="confirm-close">${gh ? "Close PR" : "Close MR"}</button>
          </div>
        </div>`;
  const opening = overlay.classList.contains("hidden");
  setHTML(overlay, html);
  overlay.classList.remove("hidden");
  if (opening) document.getElementById("confirm-cancel")?.focus();
}

/* ---------- render loop ---------- */

const rendered = new WeakMap<HTMLElement, string>();

/** Skips identical markup so a refresh tick does not reset scroll, focus, or a pressed button. */
function setHTML(el: HTMLElement, html: string): boolean {
  if (rendered.get(el) === html) return false;
  el.innerHTML = html;
  rendered.set(el, html);
  return true;
}

function screenKey(): string {
  return [ui.screen, ui.pipeline ? pipelineKey(ui.pipeline) : "", ui.logJob?.id ?? "", ui.mr ? mrKey(ui.mr) : ""].join("|");
}

let lastScreenKey = "";

function render(): void {
  const s = state;
  setHTML(top, renderTop(s));
  setHTML(foot, renderFoot(s));

  const key = screenKey();
  const same = key === lastScreenKey;
  lastScreenKey = key;
  // MR detail uses the same padded content area as other screens.
  content.classList.remove("workspace");

  const scrolls = new Map<string, [number, number]>();
  content.querySelectorAll<HTMLElement>("[data-scroll]").forEach((el) => {
    scrolls.set(el.dataset.scroll!, [el.scrollTop, el.scrollLeft]);
  });
  const focused = document.activeElement as HTMLInputElement | null;
  const focusId = focused && content.contains(focused) && focused.id ? focused.id : null;
  const selection = focusId && focused?.type === "search" ? [focused.selectionStart, focused.selectionEnd] : null;
  const bodyTop = body.scrollTop;

  const changed = setHTML(content, s ? renderScreen(s) : empty("Connecting…"));
  if (changed) {
    const search = document.getElementById("log-search");
    if (search instanceof HTMLInputElement) search.value = ui.search;
    const repoFilter = document.getElementById("repo-filter");
    if (repoFilter instanceof HTMLInputElement) repoFilter.value = ui.repoFilter;
    content.querySelectorAll<HTMLElement>("[data-scroll]").forEach((el) => {
      const saved = scrolls.get(el.dataset.scroll!);
      if (saved && (same || el.hasAttribute("data-sticky"))) [el.scrollTop, el.scrollLeft] = saved;
    });
    body.scrollTop = same ? bodyTop : 0;
    if (focusId) {
      const el = document.getElementById(focusId) as HTMLInputElement | null;
      el?.focus();
      if (el && selection) el.setSelectionRange(selection[0], selection[1]);
    }
  } else if (!same) {
    body.scrollTop = 0;
  }

  if (ui.logScrollToEnd && !ui.loadingLog) {
    const pre = document.getElementById("log-text");
    if (pre) pre.scrollTop = pre.scrollHeight;
    ui.logScrollToEnd = false;
  }

  renderOverlay();
  requestFit();
  armRingTick();
}

let ringTimer = 0;

/** Redraw while a job is running so a single job can fill the ring before it finishes. */
function armRingTick(): void {
  window.clearTimeout(ringTimer);
  const jobs = [
    ...(state?.pipelines.flatMap((p) => p.jobs) ?? []),
    ...ui.jobs,
  ];
  if (!jobs.some((j) => j.status === "running")) return;
  ringTimer = window.setTimeout(() => render(), 1000);
}

let fitFrame = 0;

function requestFit(): void {
  cancelAnimationFrame(fitFrame);
  fitFrame = requestAnimationFrame(() => {
    if (ui.screen === "mr" && ui.mr) {
      void call(tracer.fit(WORKSPACE_WIDTH, WORKSPACE_HEIGHT));
      return;
    }
    const height = top.offsetHeight + content.offsetHeight + foot.offsetHeight + 2;
    void call(tracer.fit(INBOX_WIDTH, Math.ceil(height)));
  });
}

/* ---------- loading ---------- */

async function loadJobs(p: Pipeline, quiet: boolean): Promise<void> {
  const token = ++requestToken;
  if (!quiet) {
    ui.loadingJobs = true;
    render();
  }
  // A running pipeline keeps its status while its jobs move, so its cache is skipped.
  const jobs = await call(tracer.jobs(pipelineKey(p), quiet || isRunning(p)));
  if (token !== requestToken) return;
  ui.loadingJobs = false;
  if (jobs) {
    ui.jobs = jobs;
    rememberJobs(p, jobs);
  } else if (!quiet) ui.loadError = `Couldn’t load jobs. Check ${serviceName(p)} access or open in browser.`;
  render();
}

/** Keeps a just-loaded result on the shared list, so Back is already up to date. */
function rememberJobs(p: Pipeline, jobs: Job[]): void {
  if (!state) return;
  const key = pipelineKey(p);
  const next = applyJobUpdate(state.pipelines, key, jobs);
  if (!next) return;
  state = { ...state, pipelines: next };
  const settled = next.find((item) => pipelineKey(item) === key);
  if (!settled) return;
  if (ui.pipeline && pipelineKey(ui.pipeline) === key) ui.pipeline = settled;
  ui.group = ui.group.map((item) => (pipelineKey(item) === key ? settled : item));
}

function selectPipeline(p: Pipeline): void {
  returnToOverview();
  ui.screen = "pipeline";
  ui.pipeline = p;
  ui.jobs = p.jobs;
  void loadJobs(p, false);
}

async function selectGroup(pipelines: Pipeline[]): Promise<void> {
  if (pipelines.length === 1) return selectPipeline(pipelines[0]);
  returnToOverview();
  ui.screen = "group";
  ui.group = pipelines;
  for (const p of pipelines) ui.groupJobs.set(pipelineKey(p), p.jobs);
  ui.loadingJobs = true;
  const token = ++requestToken;
  render();
  const results = await Promise.all(pipelines.map((p) => call(tracer.jobs(pipelineKey(p), isRunning(p)))));
  if (token !== requestToken) return;
  ui.loadingJobs = false;
  results.forEach((jobs, i) => {
    if (!jobs) return;
    ui.groupJobs.set(pipelineKey(pipelines[i]), jobs);
    rememberJobs(pipelines[i], jobs);
  });
  if (results.some((r) => r == null)) ui.loadError = "Couldn’t load every pipeline. Open the missing one in the browser.";
  render();
}

async function loadLog(job: Job, p: Pipeline): Promise<void> {
  ui.logJob = job;
  ui.logTab = "logs";
  ui.search = "";
  ui.logText = "";
  ui.loadingLog = true;
  ui.loadError = null;
  const token = ++logToken;
  render();
  const text = await call(tracer.log(pipelineKey(p), job));
  if (token !== logToken) return;
  ui.loadingLog = false;
  if (text == null) {
    ui.loadError = `Couldn’t load log. Open this job on ${serviceName(p)}.`;
  } else {
    ui.logText = cleanLog(text);
    if (!ui.logText.trim()) ui.logText = "No log output yet.";
    ui.logScrollToEnd = true;
  }
  render();
}

/** Opens a job log from any screen; the pipeline detail becomes the screen behind it. */
function openLog(key: string, jobID: number): void {
  const p = findPipeline(key);
  const jobs = knownJobs(key);
  const job = jobs.find((j) => j.id === jobID);
  if (!p || !job) return;
  if (ui.screen !== "pipeline" || !ui.pipeline || pipelineKey(ui.pipeline) !== key) {
    returnToOverview();
    ui.screen = "pipeline";
    ui.pipeline = p;
    ui.jobs = jobs;
  }
  void loadLog(job, p);
}

async function toggleHistory(key: string): Promise<void> {
  const p = findPipeline(key);
  if (!p) return;
  if (ui.expandedHistory === key) {
    ui.expandedHistory = null;
    render();
    return;
  }
  ui.expandedHistory = key;
  ui.historyError = null;
  ui.historyLoading = key;
  render();
  const jobs = await call(tracer.jobs(key, false));
  if (ui.expandedHistory !== key) return;
  ui.historyLoading = null;
  if (jobs) {
    ui.historyJobs.set(key, jobs);
    rememberJobs(p, jobs);
  } else ui.historyError = `Couldn’t load completed jobs. Open the pipeline in ${serviceName(p)}.`;
  render();
}

async function showMR(mr: MergeRequest): Promise<void> {
  returnToOverview();
  ui.screen = "mr";
  ui.mr = mr;
  ui.mrLoading = true;
  const token = ++requestToken;
  render();
  const detail = await call(tracer.mrDetail(mrKey(mr)));
  if (token !== requestToken) return;
  ui.mrLoading = false;
  if (detail) {
    ui.mr = detail.request;
    ui.mrBody = detail.body;
    ui.mrAuthor = detail.author;
    ui.mrJobs = detail.jobs;
  } else {
    ui.mrError =
      mr.host === "github"
        ? "Couldn’t refresh pull request details. Open GitHub or try again."
        : "Couldn’t refresh merge details. Open GitLab or try again.";
  }
  render();
}

async function finishConfirm(kind: "merge" | "close"): Promise<void> {
  const mr = ui.mr;
  ui.confirming = null;
  render();
  if (!mr) return;
  // The SHA shown in this view goes along, so a push since then blocks the merge.
  const ok = await call(kind === "merge" ? tracer.merge(mrKey(mr), mr.sha) : tracer.close(mrKey(mr), mr.sha));
  if (ok) return;
  if (ui.mr && mrKey(ui.mr) === mrKey(mr)) {
    ui.mrError =
      kind === "merge" && state && !state.prefs.mergeButton
        ? "Merge actions are off in Preferences."
        : `Couldn’t start that. This ${requestNoun(mr)} is no longer in the open list; refresh and try again.`;
    render();
  }
}

function activateEvent(id: string): void {
  const event = state?.events.find((e) => e.id === id);
  if (!event) return;
  const p = state?.pipelines.find((x) => x.url === event.url || x.jobs.some((j) => j.url === event.url));
  if (!p) {
    void call(tracer.openExternal(event.url));
    return;
  }
  selectPipeline(p);
  const failed = event.status === "failed" ? p.jobs.find((j) => j.status === "failed") : undefined;
  if (failed) void loadLog(failed, p);
  else render();
}

/** Follows the main process's latest snapshot into whatever the panel has open. */
function sync(fresh: boolean): void {
  const s = state;
  if (!s) return;
  const byKey = new Map(s.pipelines.map((p) => [pipelineKey(p), p]));
  if (ui.pipeline) {
    const live = byKey.get(pipelineKey(ui.pipeline));
    if (live) {
      const changed = live.status !== ui.pipeline.status;
      ui.pipeline = live;
      if (!ui.jobs.length && live.jobs.length) ui.jobs = live.jobs;
      if (fresh && ui.screen === "pipeline" && !ui.loadingJobs && (changed || isRunning(live))) void loadJobs(live, true);
    }
  }
  if (ui.group.length) ui.group = ui.group.map((p) => byKey.get(pipelineKey(p)) ?? p);
  if (ui.mr && !ui.mrLoading && !ui.confirming) {
    const current = ui.mr;
    const live = s.mrs.find((m) => mrKey(m) === mrKey(current));
    ui.mrMissing = !live;
    if (live) ui.mr = { ...live, pipelineStatus: live.pipelineStatus ?? current.pipelineStatus };
    else if (ui.screen === "mr" && requestJustFinished(s.events, current)) returnToOverview();
  }
}

/* ---------- events ---------- */

async function act(name: string, el: HTMLElement): Promise<void> {
  const key = el.dataset.key ?? "";
  switch (name) {
    case "back":
      returnToOverview();
      break;
    case "refresh":
      void call(tracer.refresh());
      return;
    case "notifications":
      returnToOverview();
      ui.screen = "notifications";
      break;
    case "settings":
      returnToOverview();
      ui.screen = "settings";
      break;
    case "history":
      returnToOverview();
      ui.screen = "history";
      break;
    case "toggle-other":
      ui.showOther = !ui.showOther;
      break;
    case "pipeline": {
      const p = findPipeline(key);
      if (p) selectPipeline(p);
      return;
    }
    case "group": {
      const list = (el.dataset.keys ?? "")
        .split(",")
        .map(findPipeline)
        .filter((p): p is Pipeline => p != null);
      if (list.length) void selectGroup(list);
      return;
    }
    case "history-toggle":
      void toggleHistory(key);
      return;
    case "log":
      openLog(key, Number(el.dataset.job));
      return;
    case "all-jobs":
      logToken++;
      ui.logJob = null;
      ui.loadError = null;
      ui.loadingLog = false;
      break;
    case "log-tab":
      ui.logTab = el.dataset.value === "summary" ? "summary" : "logs";
      break;
    case "filter":
      ui.eventFilter = (el.dataset.value as EventFilter) ?? "All";
      break;
    case "event":
      activateEvent(el.dataset.id ?? "");
      return;
    case "mr": {
      const mr = state?.mrs.find((m) => mrKey(m) === key);
      if (mr) void showMR(mr);
      return;
    }
    case "merge-ask":
      ui.confirming = "merge";
      break;
    case "close-ask":
      ui.confirming = "close";
      break;
    case "confirm-cancel":
      ui.confirming = null;
      break;
    case "confirm-merge":
      void finishConfirm("merge");
      return;
    case "confirm-close":
      void finishConfirm("close");
      return;
    case "open":
      if (el.dataset.url) void call(tracer.openExternal(el.dataset.url));
      return;
    case "copy-log":
      void call(tracer.copy(ui.logText));
      return;
    case "notification-settings":
      void call(tracer.openNotificationSettings());
      return;
    case "notification-test": {
      const result = await call(tracer.testNotification());
      if (result) {
        ui.testNote = result.message;
        ui.testNoteOk = result.ok;
        render();
      }
      return;
    }
    case "quit":
      void call(tracer.quit());
      return;
    default:
      return;
  }
  render();
}

document.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  if (target === overlay) {
    ui.confirming = null;
    render();
    return;
  }
  const el = target.closest<HTMLElement>("[data-act]");
  if (el) void act(el.dataset.act!, el);
});

document.addEventListener("change", async (e) => {
  const el = e.target as HTMLInputElement | HTMLSelectElement;
  const repoKey = el.dataset.repo;
  if (repoKey && el instanceof HTMLInputElement && state) {
    const current = state.prefs.showAllRequests ?? [];
    const showAllRequests = el.checked ? [...current, repoKey] : current.filter((key) => key !== repoKey);
    const prefs = await call(tracer.setPrefs({ showAllRequests }));
    if (prefs) state = { ...state, prefs };
    render();
    return;
  }
  const key = el.dataset.pref as keyof Prefs | undefined;
  if (!key) return;
  const value = el instanceof HTMLInputElement && el.type === "checkbox" ? el.checked : Number(el.value);
  const prefs = await call(tracer.setPrefs({ [key]: value } as Partial<Prefs>));
  if (prefs && state) state = { ...state, prefs };
  render();
});

document.addEventListener("input", (e) => {
  const el = e.target as HTMLInputElement;
  if (el.id === "repo-filter") {
    ui.repoFilter = el.value;
    render();
    return;
  }
  if (el.id !== "log-search") return;
  ui.search = el.value;
  const lines = visibleLines();
  const pre = document.getElementById("log-text");
  const count = document.getElementById("log-count");
  if (pre) pre.innerHTML = logHtml(lines);
  if (count) count.textContent = logCount(lines.length);
});

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "q") {
    e.preventDefault();
    void call(tracer.quit());
    return;
  }
  if (e.key !== "Escape") return;
  e.preventDefault();
  if (ui.confirming) {
    ui.confirming = null;
    render();
  } else if (ui.screen !== "overview") {
    returnToOverview();
    render();
  } else {
    void call(tracer.hide());
  }
});

new ResizeObserver(() => requestFit()).observe(content);

tracer.onState((next) => {
  const fresh = next.updated !== state?.updated;
  state = next;
  sync(fresh);
  render();
});

tracer.onHidden(() => {
  ui.confirming = null;
  if (!state?.prefs.rememberPlace) {
    returnToOverview();
    ui.showOther = false;
  }
  render();
});

tracer.onShown(() => render());

void call(tracer.getState()).then((s) => {
  if (s) {
    state = s;
    sync(false);
  }
  render();
});
