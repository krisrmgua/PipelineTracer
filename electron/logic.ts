// Pure rules shared by the main process, the panel, and the self-check.
// No Node or Electron imports here, so the renderer can bundle it.

export type Host = "gitlab" | "github";

export interface Job {
  id: number;
  name: string;
  stage: string;
  status: string;
  url: string;
  duration: number | null;
  /** Epoch ms. Lets the ring move while this job is still running. */
  startedAt?: number | null;
}

export interface Pipeline {
  host: Host;
  projectID: number;
  id: number;
  project: string;
  ref: string;
  status: string;
  url: string;
  /** Epoch milliseconds. */
  updated: number | null;
  sha: string;
  jobs: Job[];
  /** Source branch of a merge-request pipeline, when GitLab reported it. */
  sourceBranch: string;
  /** GitHub workflow name. Empty for GitLab. */
  workflow: string;
}

/** An open GitLab merge request or GitHub pull request you created. */
export interface MergeRequest {
  host: Host;
  projectID: number;
  iid: number;
  title: string;
  /** group/project or owner/repo */
  project: string;
  url: string;
  draft: boolean;
  /** GitLab detailed_merge_status, or the same words for a GitHub pull request. */
  mergeStatus: string;
  pipelineStatus: string | null;
  updated: number | null;
  sourceBranch: string;
  targetBranch: string;
  sha: string;
  /** False when the signed-in user lacks permission to merge into the target repository/branch. */
  canMerge: boolean;
  /** Login of the person who opened the request. Empty when the host did not send one. */
  author: string;
}

export interface ActivityEvent {
  id: string;
  title: string;
  detail: string;
  status: string;
  url: string;
  date: number;
}

export interface PipelineGroup {
  id: string;
  pipelines: Pipeline[];
  primary: Pipeline;
}

type Json = Record<string, unknown>;

const ACTIVE = new Set(["running", "pending", "created", "preparing", "waiting_for_resource", "scheduled"]);
const DONE = new Set(["success", "passed", "failed", "canceled", "cancelled", "skipped"]);
const WAITING = new Set(["pending", "created", "preparing", "waiting_for_resource", "scheduled", "manual"]);

export function makePipeline(p: Partial<Pipeline> & Pick<Pipeline, "projectID" | "id" | "status">): Pipeline {
  return {
    host: "gitlab",
    project: "",
    ref: "",
    url: "",
    updated: null,
    sha: "",
    jobs: [],
    sourceBranch: "",
    workflow: "",
    ...p,
  };
}

export function makeMergeRequest(
  m: Partial<MergeRequest> & Pick<MergeRequest, "projectID" | "iid" | "title">,
): MergeRequest {
  return {
    host: "gitlab",
    project: "",
    url: "",
    draft: false,
    mergeStatus: "unknown",
    pipelineStatus: null,
    updated: null,
    sourceBranch: "",
    targetBranch: "",
    sha: "",
    canMerge: true,
    author: "",
    ...m,
  };
}

export const mrKey = (mr: MergeRequest): string =>
  mr.host === "github" ? `github:${mr.projectID}:${mr.iid}` : `${mr.projectID}:${mr.iid}`;

/**
 * Drops requests this app just merged or closed. A stale open list can keep
 * returning them for a few seconds; `hiddenUntil` is the epoch ms to stop hiding.
 */
export function omitHiddenRequests(
  mrs: MergeRequest[],
  hiddenUntil: ReadonlyMap<string, number>,
  now = Date.now(),
): MergeRequest[] {
  return mrs.filter((mr) => {
    const until = hiddenUntil.get(mrKey(mr));
    return until == null || until <= now;
  });
}

/** True when this request was merged or closed moments ago, so the panel can leave its page. */
export function requestJustFinished(events: ActivityEvent[], mr: MergeRequest, now = Date.now()): boolean {
  return events.some(
    (event) =>
      event.url === mr.url &&
      (event.status === "merged" || event.status === "canceled") &&
      now - event.date >= 0 &&
      now - event.date < 20_000,
  );
}
export const numberLabel = (mr: MergeRequest): string => (mr.host === "github" ? `#${mr.iid}` : `!${mr.iid}`);
export const isReady = (mr: MergeRequest): boolean => !mr.draft && mr.mergeStatus === "mergeable";

/** GitLab/GitHub have not finished computing mergeability yet. */
export function mergeStatusIsProvisional(status: string): boolean {
  return status === "checking" || status === "unchecked";
}

export type MrBarTone = "none" | "ready" | "running" | "failed" | "pending";

/** Menu-bar MR label. One waiting request should not stay white. */
export function mrBarTone(mrs: MergeRequest[]): MrBarTone {
  if (mrs.length === 0) return "none";
  const tones = mrs.map(mrTone);
  if (tones.includes("failed")) return "failed";
  if (tones.includes("running")) return "running";
  if (tones.every((t) => t === "ready")) return "ready";
  return "pending";
}

export const pipelineKey = (p: Pipeline): string => `${p.host}:${p.projectID}:${p.id}`;
export function refLabel(p: Pipeline): string {
  if (p.host !== "github" || !p.workflow) return p.ref;
  return p.ref ? `${p.workflow} · ${p.ref}` : p.workflow;
}
export const serviceName = (p: { host: Host }): string => (p.host === "github" ? "GitHub" : "GitLab");
export const isRunning = (p: Pipeline): boolean => ACTIVE.has(p.status);
export const isFailed = (p: Pipeline): boolean => p.status === "failed";
export const isSuccess = (p: Pipeline): boolean => p.status === "success" || p.status === "passed";
export const isActiveStatus = (s: string): boolean => ACTIVE.has(s);
export const isDone = (s: string): boolean => DONE.has(s);

/**
 * The pipeline list keeps saying "running" after every job has finished.
 * Trust the jobs once none of them are still waiting or running.
 */
export function settlePipeline<T extends Pipeline>(p: T): T {
  if (!isActiveStatus(p.status) || p.jobs.length === 0) return p;
  const statuses = p.jobs.map((j) => j.status);
  if (statuses.some((s) => !DONE.has(s))) return p;
  if (statuses.includes("failed")) return { ...p, status: "failed" };
  if (statuses.every((s) => s === "canceled" || s === "cancelled")) return { ...p, status: "canceled" };
  if (statuses.every((s) => s === "skipped")) return { ...p, status: "skipped" };
  return { ...p, status: "success" };
}

/** Job statuses only. A duration tick is not a new result. */
export function jobStatusKey(jobs: Job[]): string {
  return jobs.map((j) => `${j.id}:${j.status}`).join(",");
}

/**
 * Jobs just loaded for one pipeline. Returns a new list when that changes the
 * settled status or any job status, so the overview can leave "in progress"
 * without waiting for the next poll. Null when the list would look the same.
 */
export function applyJobUpdate(pipelines: Pipeline[], key: string, jobs: Job[]): Pipeline[] | null {
  const index = pipelines.findIndex((p) => pipelineKey(p) === key);
  if (index < 0) return null;
  const prev = pipelines[index];
  const next = settlePipeline({ ...prev, jobs });
  if (prev.status === next.status && jobStatusKey(prev.jobs) === jobStatusKey(next.jobs)) return null;
  const copy = pipelines.slice();
  copy[index] = next;
  return copy;
}

/** `refs/merge-requests/15/head` -> 15. Branch and main pipelines are null. */
export function mergeRequestIID(p: Pipeline): number | null {
  const m = /^refs\/merge-requests\/(\d+)\/head$/.exec(p.ref);
  return m ? Number(m[1]) : null;
}

/** Newest pipeline for each project and ref (and workflow on GitHub). */
export function latestPerRef(list: Pipeline[]): Pipeline[] {
  const newest = new Map<string, Pipeline>();
  for (const p of list) {
    const key = p.host === "github" ? `github|${p.projectID}|${p.workflow}|${p.ref}` : `gitlab|${p.projectID}|${p.ref}`;
    const current = newest.get(key);
    if (current && (current.updated ?? -Infinity) >= (p.updated ?? -Infinity)) continue;
    newest.set(key, p);
  }
  return [...newest.values()];
}

/**
 * Failures that are still the latest result for their ref. A later pipeline for the same
 * commit, such as a merge-request pipeline after the branch push failed, means that commit
 * is already fixed. On GitHub only the same workflow clears it.
 */
export function unresolvedFailures(list: Pipeline[]): Pipeline[] {
  return latestPerRef(list).filter((failed) => {
    if (!isFailed(failed)) return false;
    const fixed = list.some(
      (other) =>
        other.host === failed.host &&
        other.projectID === failed.projectID &&
        other.id > failed.id &&
        failed.sha !== "" &&
        other.sha === failed.sha &&
        isSuccess(other) &&
        (failed.host !== "github" || other.workflow === failed.workflow),
    );
    return !fixed;
  });
}

export function sameChange(lhs: Pipeline, rhs: Pipeline): boolean {
  if (lhs.host !== rhs.host || lhs.projectID !== rhs.projectID || lhs.id === rhs.id) return false;
  const mr = mergeRequestIID(lhs) != null ? lhs : rhs;
  const branch = mergeRequestIID(lhs) != null ? rhs : lhs;
  if (mergeRequestIID(mr) == null || mergeRequestIID(branch) != null) return false;
  if (mr.sourceBranch) return branch.ref === mr.sourceBranch;
  if (branch.ref === "main" || branch.ref === "master") return false;
  return mr.sha !== "" && mr.sha === branch.sha;
}

function group(pipelines: Pipeline[]): PipelineGroup {
  return {
    id: pipelines.map(pipelineKey).sort().join("|"),
    pipelines,
    primary: pipelines.find((p) => mergeRequestIID(p) != null) ?? pipelines[0],
  };
}

/**
 * Collapse a merge-request pipeline and the branch pipeline for that same change into one
 * group. A `main` or `master` pipeline stays separate unless it is the MR's source branch.
 */
export function groupSameChange(list: Pipeline[]): PipelineGroup[] {
  const remaining = [...list];
  const groups: PipelineGroup[] = [];
  while (remaining.length) {
    const p = remaining.shift()!;
    const match = remaining.findIndex((other) => sameChange(p, other));
    if (match >= 0) {
      const other = remaining.splice(match, 1)[0];
      const mr = mergeRequestIID(p) != null ? p : other;
      const branch = mergeRequestIID(p) != null ? other : p;
      groups.push(group([mr, branch]));
    } else {
      groups.push(group([p]));
    }
  }
  return groups;
}

export function groupTitle(pipelines: Pipeline[]): string {
  const branch = pipelines.find((p) => mergeRequestIID(p) == null);
  if (branch) return branch.ref;
  const iid = pipelines[0] ? mergeRequestIID(pipelines[0]) : null;
  if (iid != null) return `MR !${iid}`;
  return pipelines[0]?.ref ?? "";
}

export type RingStatus = "passed" | "running" | "failed" | "pending" | "canceled" | "skipped";

/** A running job fills most of its slice, then waits for the real finish. */
const RUN_FILL = 0.85;
const RUN_TAU_SEC = 45;

export type RingSliceKind = "done" | "running" | "wait";

/** One job's sector of the ring. `fill` is how much of that sector is complete. */
export interface RingSlice {
  kind: RingSliceKind;
  fill: number;
}

/** Each job owns an equal slice. A running job is the slice that should gleam. */
export function ringSlices(jobs: Job[], now = Date.now()): RingSlice[] {
  return jobs.map((job) => {
    if (DONE.has(job.status)) return { kind: "done", fill: 1 };
    if (job.status === "running") return { kind: "running", fill: jobRingShare(job, now) };
    return { kind: "wait", fill: 0 };
  });
}

/** Finished jobs are a full share. A running job grows with elapsed time and stops short of done. */
export function jobRingShare(job: Job, now = Date.now()): number {
  if (DONE.has(job.status)) return 1;
  if (job.status !== "running") return 0;
  const started = job.startedAt ?? (typeof job.duration === "number" ? now - job.duration * 1000 : null);
  const elapsed = started == null ? 0 : Math.max(0, (now - started) / 1000);
  const grown = 1 - Math.exp(-elapsed / RUN_TAU_SEC);
  return 0.08 + (RUN_FILL - 0.08) * grown;
}

/** Overall state and ring fill. Failure beats running, which beats waiting. */
export function progressState(p: Pipeline | null | undefined, now = Date.now()): [RingStatus, number] {
  if (!p) return ["pending", 0];
  if (p.status === "canceled" || p.status === "cancelled") return ["canceled", 1];
  if (p.status === "skipped") return ["skipped", 1];
  if (!p.jobs.length) {
    switch (p.status) {
      case "success":
      case "passed":
        return ["passed", 1];
      case "failed":
        return ["failed", 1];
      case "running":
        return ["running", 0];
      default:
        return ["pending", 0];
    }
  }
  const statuses = p.jobs.map((j) => j.status);
  const progress = p.jobs.reduce((sum, job) => sum + jobRingShare(job, now), 0) / p.jobs.length;
  if (statuses.includes("failed")) return ["failed", progress];
  if (statuses.includes("running")) return ["running", progress];
  if (statuses.some((s) => WAITING.has(s))) return ["pending", progress];
  return ["passed", progress];
}

export interface TrayCounts {
  requests: number;
  running: number;
  failed: number;
}

export function trayCounts(pipelines: Pipeline[], mrs: MergeRequest[]): TrayCounts {
  return {
    requests: mrs.length,
    running: groupSameChange(pipelines.filter(isRunning)).length,
    failed: groupSameChange(unresolvedFailures(pipelines)).length,
  };
}

export function normalizeMergeStatus(raw: unknown): string {
  return (typeof raw === "string" ? raw : "unknown").replaceAll(" ", "_").toLowerCase();
}

export function normalizePipelineStatus(raw: string): string {
  return raw.replaceAll(" ", "_").toLowerCase();
}

/** "https://gitlab.com/group/proj/-/merge_requests/3" -> "group/proj" */
export function projectPath(webURL: string): string {
  try {
    const path = new URL(webURL).pathname.replace(/^\//, "");
    return path.split("/-/")[0];
  } catch {
    return "";
  }
}

export function parseDate(s: unknown): number | null {
  if (typeof s !== "string" || !s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

export function jsonInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const obj = (v: unknown): Json | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);

/** `gid://gitlab/Project/123` -> 123 */
export function projectIDFromGraphQL(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value !== "string") return null;
  if (/^\d+$/.test(value)) return Number(value);
  const last = value.split("/").pop() ?? "";
  return /^\d+$/.test(last) ? Number(last) : null;
}

/** GitLab REST merge request. */
export function parseMergeRequest(m: Json): MergeRequest | null {
  const pid = jsonInt(m.project_id);
  const iid = jsonInt(m.iid);
  const title = str(m.title);
  const url = str(m.web_url);
  if (pid == null || iid == null || !title || !url) return null;
  const pipe = obj(m.head_pipeline)?.status;
  const user = obj(m.user);
  return makeMergeRequest({
    projectID: pid,
    iid,
    title,
    project: projectPath(url),
    url,
    draft: m.draft === true,
    mergeStatus: normalizeMergeStatus(m.detailed_merge_status),
    pipelineStatus: typeof pipe === "string" ? normalizePipelineStatus(pipe) : null,
    updated: parseDate(m.updated_at),
    sourceBranch: str(m.source_branch),
    targetBranch: str(m.target_branch),
    sha: str(m.sha),
    canMerge: user?.can_merge !== false,
    author: str(obj(m.author)?.username),
  });
}

/** GitLab GraphQL merge request node. Archived projects are dropped. */
export function parseMergeRequestGraphQL(node: Json): MergeRequest | null {
  const project = obj(node.project);
  if (!project || project.archived === true) return null;
  const pid = projectIDFromGraphQL(project.id);
  const path = str(project.fullPath);
  const iid = node.iid != null && /^\d+$/.test(String(node.iid)) ? Number(node.iid) : null;
  const title = str(node.title);
  const url = str(node.webUrl);
  if (pid == null || !path || iid == null || !title || !url) return null;
  const pipe = obj(node.headPipeline)?.status;
  const perms = obj(node.userPermissions);
  return makeMergeRequest({
    projectID: pid,
    iid,
    title,
    project: path,
    url,
    draft: node.draft === true,
    mergeStatus: normalizeMergeStatus(node.detailedMergeStatus),
    pipelineStatus: typeof pipe === "string" ? normalizePipelineStatus(pipe) : null,
    updated: parseDate(node.updatedAt),
    sourceBranch: str(node.sourceBranch),
    targetBranch: str(node.targetBranch),
    sha: str(node.diffHeadSha),
    canMerge: perms?.canMerge !== false,
    author: str(obj(node.author)?.username),
  });
}

/** GitLab `GET /pipelines` row. */
export function parseInstancePipeline(d: Json): Pipeline | null {
  const id = jsonInt(d.id);
  const status = str(d.status);
  const url = str(d.web_url);
  if (id == null || !status || !url) return null;
  const project = obj(d.project);
  const pid = jsonInt(d.project_id) ?? jsonInt(project?.id);
  if (pid == null) return null;
  return makePipeline({
    projectID: pid,
    id,
    project: str(project?.path_with_namespace) || projectPath(url),
    ref: str(d.ref),
    status,
    url,
    updated: parseDate(d.updated_at) ?? parseDate(d.created_at),
    sha: str(d.sha),
  });
}

/** `owner/repo` with the characters GitHub allows. Anything else is rejected before it reaches `gh`. */
const repoPart = (part: string) => part !== "." && part !== ".." && /^[\p{L}\p{N}._-]+$/u.test(part);

export function githubRepoName(name: string): string | null {
  const parts = name.split("/");
  if (parts.length !== 2) return null;
  return repoPart(parts[0]) && repoPart(parts[1]) ? name : null;
}

/** GitLab group/project path, including subgroups. Rejects anything that could change a query. */
export function gitlabProjectPath(path: string): string | null {
  const parts = path.split("/");
  if (parts.length < 2 || parts.length > 20) return null;
  return parts.every(repoPart) ? path : null;
}

export interface TrackedRepo {
  host: "gitlab" | "github";
  /** `gitlab:group/project` or `github:owner/name` */
  key: string;
  name: string;
}

export function parseTrackedRepoKey(key: string): { host: "gitlab" | "github"; name: string } | null {
  if (key.startsWith("gitlab:")) {
    const name = gitlabProjectPath(key.slice("gitlab:".length));
    return name ? { host: "gitlab", name } : null;
  }
  if (key.startsWith("github:")) {
    const name = githubRepoName(key.slice("github:".length));
    return name ? { host: "github", name } : null;
  }
  return null;
}

/** Keeps the first copy of each request. Later copies fill in a missing author. */
export function combineMergeRequests(lists: MergeRequest[][]): MergeRequest[] {
  const byKey = new Map<string, MergeRequest>();
  for (const list of lists) {
    for (const mr of list) {
      const key = mrKey(mr);
      const prev = byKey.get(key);
      if (!prev) byKey.set(key, mr);
      else if (!prev.author && mr.author) byKey.set(key, { ...prev, author: mr.author });
    }
  }
  return [...byKey.values()].sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
}

export function sameStrings(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = new Set(a);
  return b.every((item) => left.has(item));
}

/** Maps a workflow run or check onto the statuses the panel already uses. */
export function githubStatus(status: string, conclusion: string | null | undefined): string {
  switch (status) {
    case "queued":
    case "requested":
    case "pending":
      return "pending";
    case "in_progress":
      return "running";
    case "waiting":
      return "manual";
    case "completed":
      switch (conclusion ?? "") {
        case "success":
        case "neutral":
          return "success";
        case "failure":
        case "timed_out":
        case "startup_failure":
          return "failed";
        case "cancelled":
          return "canceled";
        case "skipped":
        case "stale":
          return "skipped";
        case "action_required":
          return "manual";
        default:
          return "failed";
      }
    default:
      return "pending";
  }
}

export function parseGitHubRun(run: Json, repoID: number, repoName: string): Pipeline | null {
  if (!githubRepoName(repoName)) return null;
  const id = jsonInt(run.id);
  const url = str(run.html_url);
  const status = str(run.status);
  if (id == null || !url.startsWith("https://github.com/") || !status) return null;
  return makePipeline({
    host: "github",
    projectID: repoID,
    id,
    project: repoName,
    ref: str(run.head_branch),
    status: githubStatus(status, typeof run.conclusion === "string" ? run.conclusion : null),
    url,
    updated: parseDate(run.updated_at) ?? parseDate(run.created_at),
    sha: str(run.head_sha),
    workflow: str(run.name),
  });
}

/** A GitHub Actions job or check run. The job name doubles as the stage. */
export function parseGitHubJob(item: Json): Job | null {
  const id = jsonInt(item.id);
  const name = str(item.name);
  if (id == null || !name) return null;
  const start = parseDate(item.started_at);
  const end = parseDate(item.completed_at);
  const url = str(item.html_url);
  return {
    id,
    name,
    stage: name,
    status: githubStatus(str(item.status), typeof item.conclusion === "string" ? item.conclusion : null),
    url: url.startsWith("https://github.com/") ? url : "",
    duration: start != null && end != null && end >= start ? (end - start) / 1000 : null,
    startedAt: start,
  };
}

export function parseGitLabJob(d: Json): Job | null {
  const id = jsonInt(d.id);
  const name = str(d.name);
  const status = str(d.status);
  if (id == null || !name || !status) return null;
  return {
    id,
    name,
    stage: str(d.stage),
    status,
    url: str(d.web_url),
    duration: typeof d.duration === "number" ? d.duration : null,
    startedAt: parseDate(d.started_at),
  };
}

/** First method the repo allows, in GitHub's API order: merge, squash, rebase. */
export function githubMergeMethod(allowMerge: boolean, allowSquash: boolean, allowRebase: boolean): string | null {
  if (allowMerge) return "merge";
  if (allowSquash) return "squash";
  if (allowRebase) return "rebase";
  return null;
}

/** True when GitHub viewerPermission grants write/merge access on the target repository. */
export function githubCanMerge(permission: unknown): boolean {
  if (typeof permission !== "string" || !permission) return true;
  return permission === "ADMIN" || permission === "MAINTAIN" || permission === "WRITE";
}

export interface GitHubPullStatus {
  draft: boolean;
  mergeStatus: string;
  pipeline: string | null;
}

/** Maps GitHub's mergeable, review, and check rollup onto the words the request row uses. */
export function githubPullStatus(
  isDraft: boolean,
  mergeable: string | null | undefined,
  reviewDecision: string | null | undefined,
  checks: string | null | undefined,
): GitHubPullStatus {
  let pipeline: string | null = null;
  if (checks === "SUCCESS") pipeline = "success";
  else if (checks === "FAILURE" || checks === "ERROR") pipeline = "failed";
  else if (checks === "PENDING" || checks === "EXPECTED") pipeline = "running";
  if (isDraft) return { draft: true, mergeStatus: "draft_status", pipeline };
  switch (mergeable) {
    case "CONFLICTING":
      return { draft: false, mergeStatus: "conflict", pipeline };
    case "MERGEABLE":
      if (reviewDecision === "CHANGES_REQUESTED") return { draft: false, mergeStatus: "requested_changes", pipeline };
      if (reviewDecision === "REVIEW_REQUIRED") return { draft: false, mergeStatus: "not_approved", pipeline };
      if (pipeline === "failed") return { draft: false, mergeStatus: "ci_must_pass", pipeline };
      if (pipeline === "running") return { draft: false, mergeStatus: "ci_still_running", pipeline };
      return { draft: false, mergeStatus: "mergeable", pipeline: pipeline ?? "success" };
    default:
      return { draft: false, mergeStatus: "checking", pipeline };
  }
}

export function parseGitHubPull(node: Json): MergeRequest | null {
  const repo = obj(node.repository);
  if (!repo || repo.isArchived === true) return null;
  const name = githubRepoName(str(repo.nameWithOwner));
  const pid = jsonInt(repo.databaseId);
  const iid = jsonInt(node.number);
  const title = str(node.title);
  const url = str(node.url);
  if (!name || pid == null || iid == null || !title || !url.startsWith("https://github.com/")) return null;
  const checks = obj(node.statusCheckRollup)?.state;
  const mapped = githubPullStatus(
    node.isDraft === true,
    typeof node.mergeable === "string" ? node.mergeable : null,
    typeof node.reviewDecision === "string" ? node.reviewDecision : null,
    typeof checks === "string" ? checks : null,
  );
  return makeMergeRequest({
    host: "github",
    projectID: pid,
    iid,
    title,
    project: name,
    url,
    draft: mapped.draft,
    mergeStatus: mapped.mergeStatus,
    pipelineStatus: mapped.pipeline,
    updated: parseDate(node.updatedAt),
    sourceBranch: str(node.headRefName),
    targetBranch: str(node.baseRefName),
    sha: str(node.headRefOid),
    canMerge: githubCanMerge(repo.viewerPermission),
    author: str(obj(node.author)?.login),
  });
}

/** Opens only https://gitlab.com and https://github.com links that came back from the API. */
export function browserURL(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if (url.hostname !== "gitlab.com" && url.hostname !== "github.com") return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Collapse whitespace and bound banner copy; full details remain in the inbox. */
export function compact(text: string, limit = 90): string {
  const line = text.split(/\s+/).filter(Boolean).join(" ");
  return [...line].length > limit ? [...line].slice(0, Math.max(0, limit - 1)).join("") + "…" : line;
}

export type NotificationKind = "pipeline" | "logs" | "mergeRequest" | "readyMergeRequest";

export interface NotificationContent {
  title: string;
  subtitle: string;
  body: string;
  thread: string;
  kind: NotificationKind;
  sound: boolean;
  urgent: boolean;
  url: string;
}

export function notificationContent(
  title: string,
  subtitle: string,
  body: string,
  thread: string,
  important: boolean,
  url: string,
  kind: NotificationKind,
): NotificationContent {
  const detail = [subtitle, body]
    .map((s) => compact(s, 180))
    .filter(Boolean)
    .join(" · ");
  return {
    title: "Pipeline Tracer",
    subtitle: compact(title, 80),
    body: compact(detail),
    thread,
    kind,
    sound: important,
    urgent: important,
    url,
  };
}

export function statusTitle(status: string): string {
  switch (status) {
    case "success":
    case "passed":
      return "Passed";
    case "ci_still_running":
      return "Checks running";
    case "ci_must_pass":
      return "Checks required";
    case "unchecked":
    case "checking":
      return "Checking readiness";
    case "waiting_for_resource":
      return "Waiting for resource";
    case "manual":
      return "Action required";
    case "created":
    case "pending":
    case "preparing":
    case "scheduled":
      return "Queued";
    case "draft_status":
      return "Draft";
    case "not_approved":
      return "Approval needed";
    case "conflict":
      return "Merge conflict";
    case "blocked_status":
      return "Blocked";
    case "behind":
      return "Branch is behind";
    default:
      return status
        .replaceAll("_", " ")
        .split(" ")
        .map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
        .join(" ");
  }
}

/** Green ready, orange waiting (approval/CI), red blocked, gray draft/other. */
export function mrTone(mr: MergeRequest): string {
  if (isReady(mr)) return "ready";
  if (mr.draft) return "pending";
  switch (mr.mergeStatus) {
    case "conflict":
    case "broken_status":
    case "blocked_status":
    case "policies_denied":
      return "failed";
    case "ci_still_running":
    case "ci_must_pass":
    case "not_approved":
    case "approvals_syncing":
    case "discussions_not_resolved":
    case "requested_changes":
    case "checking":
    case "unchecked":
    case "external_status_checks":
    case "preparing":
    case "prepared":
    case "behind":
      return "running";
  }
  if (mr.pipelineStatus === "failed") return "failed";
  if (mr.pipelineStatus === "running") return "running";
  return "pending";
}

export function mrState(mr: MergeRequest): string {
  return mr.draft ? "Draft" : isReady(mr) ? "Ready to merge" : statusTitle(mr.mergeStatus);
}

/** Strip ANSI, GitLab section markers, and carriage returns; keep the newest 250k chars. */
export function cleanLog(text: string): string {
  return text
    .slice(-250_000)
    .replace(/\u001B\[[0-9;]*[A-Za-z]/g, "")
    .replace(/section_(?:start|end):[0-9]+:[^\r\n]*/g, "")
    .replace(/\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

/** Drops HTML comments, including ones that only appear after an earlier comment is removed. */
function stripHtmlComments(text: string): string {
  let current = text;
  let previous = "";
  while (current !== previous) {
    previous = current;
    current = current.replace(/<!--[\s\S]*?-->/g, "");
  }
  return current;
}

/** First few lines of a description, with HTML comments and table rules dropped. */
export function descriptionSummary(text: string): string {
  const clean = stripHtmlComments(text);
  const lines: string[] = [];
  for (const line of clean.split("\n")) {
    const value = line.trim();
    if (value.startsWith("|")) {
      const cells = value
        .split("|")
        .map((c) => c.trim())
        .filter(Boolean);
      if (cells.every((c) => /^[-: ]*$/.test(c)) || cells[0] === "Package") continue;
      lines.push(cells.join(" · "));
    } else if (value && value !== "---") {
      lines.push(value);
    }
    if (lines.join("\n").length > 350 || lines.length >= 4) break;
  }
  return lines.join("\n\n").slice(0, 500);
}

export function formatDuration(seconds: number): string {
  const value = Math.floor(seconds);
  return value < 60 ? `${value}s` : `${Math.floor(value / 60)}m ${value % 60}s`;
}

export function relative(date: number | null, now = Date.now()): string {
  if (date == null) return "";
  const minutes = Math.max(0, Math.floor((now - date) / 60_000));
  if (minutes === 0) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}

export const REFRESH_CHOICES = [10, 20, 30, 40, 50, 60];
export const PIPELINE_HOUR_CHOICES = [1, 2, 4, 6, 8, 12, 24];

export interface Prefs {
  /** Seconds between refreshes. */
  refreshSeconds: number;
  /** How far back finished pipelines and runs are listed, in hours. */
  pipelineHours: number;
  /** Shows Merge on ready requests (asks to confirm). */
  mergeButton: boolean;
  /** Mac menu bar: one counter per line (MR, Run, Fail) instead of side by side. */
  stackMenuBar: boolean;
  /** Off returns the panel to the overview each time it opens. */
  rememberPlace: boolean;
  /** Opens the app when you sign in (macOS login item / Windows Startup). */
  startAtLogin: boolean;
  /** Posts banners for pipeline and merge events. The bell list stays either way. */
  notifications: boolean;
  /**
   * Repo keys (`gitlab:group/project` or `github:owner/name`) that list every
   * open request. Missing keys stay on requests you opened.
   */
  showAllRequests: string[];
}

export const DEFAULT_PREFS: Prefs = {
  refreshSeconds: 60,
  pipelineHours: 2,
  mergeButton: true,
  stackMenuBar: true,
  rememberPlace: false,
  startAtLogin: true,
  notifications: true,
  showAllRequests: [],
};

export function sanitizePrefs(input: Partial<Prefs> | null | undefined, base: Prefs = DEFAULT_PREFS): Prefs {
  const p = input ?? {};
  return {
    refreshSeconds: REFRESH_CHOICES.includes(p.refreshSeconds as number) ? (p.refreshSeconds as number) : base.refreshSeconds,
    pipelineHours: PIPELINE_HOUR_CHOICES.includes(p.pipelineHours as number) ? (p.pipelineHours as number) : base.pipelineHours,
    mergeButton: typeof p.mergeButton === "boolean" ? p.mergeButton : base.mergeButton,
    stackMenuBar: typeof p.stackMenuBar === "boolean" ? p.stackMenuBar : base.stackMenuBar,
    rememberPlace: typeof p.rememberPlace === "boolean" ? p.rememberPlace : base.rememberPlace,
    startAtLogin: typeof p.startAtLogin === "boolean" ? p.startAtLogin : base.startAtLogin,
    notifications: typeof p.notifications === "boolean" ? p.notifications : base.notifications,
    showAllRequests: Array.isArray(p.showAllRequests) ? sanitizeShowAll(p.showAllRequests) : base.showAllRequests,
  };
}

function sanitizeShowAll(input: unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    if (typeof item !== "string") continue;
    const repo = parseTrackedRepoKey(item);
    if (!repo) continue;
    const key = `${repo.host}:${repo.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= 40) break;
  }
  return out;
}

export interface CliStatus {
  glab: string | null;
  gh: string | null;
}

/** Everything the panel renders, pushed from the main process on each change. */
export interface TracerState {
  pipelines: Pipeline[];
  mrs: MergeRequest[];
  events: ActivityEvent[];
  refreshing: boolean;
  error: string | null;
  updated: number | null;
  result: string | null;
  merging: string | null;
  closing: string | null;
  prefs: Prefs;
  /** Repos you belong to, so Preferences can offer a per-repo request toggle. */
  repos: TrackedRepo[];
  platform: string;
  /** From package.json via Electron app.getVersion(). */
  version: string;
  cli: CliStatus;
  notificationsSupported: boolean;
}

export interface MrDetail {
  request: MergeRequest;
  body: string;
  author: string;
  jobs: Job[];
}
