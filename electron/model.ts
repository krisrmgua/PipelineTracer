import {
  combineMergeRequests,
  githubMergeMethod,
  githubRepoName,
  gitlabProjectPath,
  jsonInt,
  makeMergeRequest,
  mergeRequestIID,
  mergeStatusIsProvisional,
  isActiveStatus,
  isRunning,
  parseDate,
  githubJobLog,
  parseGitHubJob,
  parseWorkflowJobNames,
  withUnstartedWorkflowJobs,
  parseGitHubPull,
  parseGitHubRun,
  parseGitLabJob,
  parseInstancePipeline,
  parseMergeRequest,
  parseMergeRequestGraphQL,
  type Job,
  type MergeRequest,
  type MrDetail,
  type Pipeline,
  type TrackedRepo,
} from "./logic";
import { ghGET, ghGraphQL, glabGraphQL, glabJSON, parseObject, run } from "./shell";

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);
const arr = (v: unknown): Json[] | null => (Array.isArray(v) ? (v as Json[]) : null);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export type Outcome = { ok: true } | { ok: false; message: string };
const fail = (message: string): Outcome => ({ ok: false, message });

const USERNAME_TTL = 3_600_000;
const GITHUB_REPO_TTL = 600_000;
const HEX = /^[0-9a-f]+$/i;

let gitlabUser: { name: string; at: number } | null = null;
let githubUser: { name: string; at: number } | null = null;
let githubRepoCache: { repos: GitHubRepo[]; at: number } | null = null;
const archivedCache = new Map<number, boolean>();
/** Jobs keyed by host:project:pipeline, kept while status+sha stay the same. */
const jobCache = new Map<string, { fingerprint: string; jobs: Job[] }>();

interface GitHubRepo {
  id: number;
  name: string;
  pushed: number | null;
}

/** GitLab username, cached for an hour so the timer does not re-hit `/user` every tick. */
export async function currentUser(): Promise<string | null> {
  if (gitlabUser && Date.now() - gitlabUser.at < USERNAME_TTL) return gitlabUser.name;
  const name = str(obj(await glabJSON("user"))?.username);
  if (!name) return null;
  gitlabUser = { name, at: Date.now() };
  return name;
}

export async function githubLogin(): Promise<string | null> {
  if (githubUser && Date.now() - githubUser.at < USERNAME_TTL) return githubUser.name;
  const r = await ghGET("user");
  const name = str(obj(r.json)?.login);
  if (r.status !== 0 || !name) return null;
  githubUser = { name, at: Date.now() };
  return name;
}

const GITLAB_MR_FIELDS =
  "iid title webUrl draft detailedMergeStatus sourceBranch targetBranch diffHeadSha updatedAt author{username} userPermissions{canMerge} project{id fullPath archived} headPipeline{status}";

/** One GraphQL query: open MRs you authored, with the archived flag inlined. REST is the fallback. */
export async function fetchOpenMergeRequests(onFailure: () => void, includeProjects: string[] = []): Promise<MergeRequest[]> {
  const query = `query{currentUser{authoredMergeRequests(state:opened,first:30,sort:UPDATED_DESC){nodes{${GITLAB_MR_FIELDS}}}}}`;
  const data = await glabGraphQL(query);
  const nodes = arr(obj(obj(data?.currentUser)?.authoredMergeRequests)?.nodes);
  const authored = nodes
    ? await Promise.all(nodes.map(parseMergeRequestGraphQL).filter((m): m is MergeRequest => m != null).map(recheckGitLabMergeStatus))
    : await fetchOpenMergeRequestsREST(onFailure);
  const extra = (await Promise.all(includeProjects.map(fetchGitLabProjectMergeRequests))).flat();
  return combineMergeRequests([authored, extra]);
}

/** Open merge requests in one project, whoever opened them. */
async function fetchGitLabProjectMergeRequests(path: string): Promise<MergeRequest[]> {
  const project = gitlabProjectPath(path);
  if (!project) return [];
  const query = `query{project(fullPath:${JSON.stringify(project)}){archived mergeRequests(state:opened,first:20,sort:UPDATED_DESC){nodes{${GITLAB_MR_FIELDS}}}}}`;
  const data = await glabGraphQL(query);
  const projectNode = obj(data?.project);
  if (projectNode && projectNode.archived !== true) {
    const nodes = arr(obj(projectNode.mergeRequests)?.nodes);
    if (nodes) {
      const mrs = nodes.map(parseMergeRequestGraphQL).filter((m): m is MergeRequest => m != null);
      return Promise.all(mrs.map(recheckGitLabMergeStatus));
    }
  }
  const list = arr(
    await glabJSON(
      `projects/${encodeURIComponent(project)}/merge_requests?state=opened&scope=all&per_page=20&order_by=updated_at&sort=desc`,
    ),
  );
  if (!list) return [];
  const mrs = list.map(parseMergeRequest).filter((m): m is MergeRequest => m != null);
  return Promise.all(mrs.map(recheckGitLabMergeStatus));
}

async function fetchOpenMergeRequestsREST(onFailure: () => void): Promise<MergeRequest[]> {
  const list = arr(await glabJSON("merge_requests?scope=created_by_me&state=opened&per_page=30&order_by=updated_at&sort=desc"));
  if (!list) {
    onFailure();
    return [];
  }
  const mrs = list.map(parseMergeRequest).filter((m): m is MergeRequest => m != null);
  const archived = await archivedProjects(new Set(mrs.map((m) => m.projectID)));
  return Promise.all(mrs.filter((m) => !archived.has(m.projectID)).map(recheckGitLabMergeStatus));
}

/**
 * The open-list query stays on "checking" or "unchecked" until one MR read
 * asks GitLab to finish, and that result often arrives a few seconds later.
 */
async function recheckGitLabMergeStatus(mr: MergeRequest): Promise<MergeRequest> {
  if (!mergeStatusIsProvisional(mr.mergeStatus)) return mr;
  const read = async (recheck: boolean): Promise<MergeRequest | null> => {
    const detail = obj(
      await glabJSON(
        `projects/${mr.projectID}/merge_requests/${mr.iid}`,
        "GET",
        recheck ? { with_merge_status_recheck: "true" } : undefined,
      ),
    );
    return detail ? parseMergeRequest(detail) : null;
  };
  let latest: MergeRequest | null = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    latest = (await read(attempt === 0)) ?? latest;
    if (latest && !mergeStatusIsProvisional(latest.mergeStatus)) return latest;
    if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 1500 : 2000));
  }
  return latest ?? mr;
}

async function archivedProjects(ids: Set<number>): Promise<Set<number>> {
  const archived = new Set<number>();
  for (const id of ids) {
    let known = archivedCache.get(id);
    if (known === undefined) {
      known = obj(await glabJSON(`projects/${id}?simple=true`))?.archived === true;
      archivedCache.set(id, known);
    }
    if (known) archived.add(id);
  }
  return archived;
}

/** Your recent pipelines in one instance-level call instead of one per project. */
export async function fetchPipelines(hours: number, onFailure: () => void): Promise<Pipeline[]> {
  if (!(await currentUser())) {
    onFailure();
    return [];
  }
  const since = Date.now() - hours * 3_600_000;
  // The instance endpoint filters by created_at; keep some slack, then filter by updated_at.
  const createdAfter = new Date(since - 6 * 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const list = arr(await glabJSON(`pipelines?per_page=100&order_by=created_at&sort=desc&created_after=${createdAfter}`));
  if (!list) {
    onFailure();
    return [];
  }
  return list
    .map(parseInstancePipeline)
    .filter((p): p is Pipeline => p != null && (p.updated == null || p.updated >= since))
    .sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
}

/** Prefer source branches already loaded with open MRs; only hit the API for the rest. */
export async function annotateSourceBranches(pipelines: Pipeline[], openMRs: MergeRequest[]): Promise<Pipeline[]> {
  const branches = new Map<string, string>();
  for (const mr of openMRs) {
    if (mr.host === "gitlab" && mr.sourceBranch) branches.set(`${mr.projectID}:${mr.iid}`, mr.sourceBranch);
  }
  for (const p of pipelines) {
    if (p.host !== "gitlab" || !isRunning(p)) continue;
    const iid = mergeRequestIID(p);
    if (iid == null) continue;
    const key = `${p.projectID}:${iid}`;
    if (branches.has(key)) continue;
    const branch = str(obj(await glabJSON(`projects/${p.projectID}/merge_requests/${iid}`))?.source_branch);
    if (branch) branches.set(key, branch);
  }
  return pipelines.map((p) => {
    const iid = mergeRequestIID(p);
    const branch = iid == null ? undefined : branches.get(`${p.projectID}:${iid}`);
    return branch ? { ...p, sourceBranch: branch } : p;
  });
}

const cacheKey = (p: Pipeline) => `${p.host}:${p.projectID}:${p.id}`;

export function cachedJobs(p: Pipeline): Job[] | null {
  const hit = jobCache.get(cacheKey(p));
  return hit && hit.fingerprint === `${p.status}|${p.sha}` ? hit.jobs : null;
}

/** Reuses jobs while the pipeline status and SHA are unchanged. */
export async function jobsForPipeline(p: Pipeline, force = false): Promise<Job[] | null> {
  if (!force) {
    const cached = cachedJobs(p);
    if (cached) return cached;
  }
  const jobs = await loadJobs(p);
  if (jobs) jobCache.set(cacheKey(p), { fingerprint: `${p.status}|${p.sha}`, jobs });
  return jobs;
}

async function loadJobs(p: Pipeline): Promise<Job[] | null> {
  if (p.host === "github") return loadGitHubJobs(p);
  return loadGitLabJobs(p.projectID, p.id);
}

async function loadGitLabJobs(projectID: number, pipelineID: number): Promise<Job[] | null> {
  const list = arr(await glabJSON(`projects/${projectID}/pipelines/${pipelineID}/jobs?per_page=100`));
  if (!list) return null;
  // GitLab lists jobs newest first. Sort by id (creation order) so stages read top to bottom.
  return list
    .map(parseGitLabJob)
    .filter((j): j is Job => j != null)
    .sort((a, b) => a.id - b.id);
}

/** Recently pushed repos, cached for 10 minutes. There is no single "my workflow runs" API. */
async function githubRepos(): Promise<GitHubRepo[] | null> {
  if (githubRepoCache && Date.now() - githubRepoCache.at < GITHUB_REPO_TTL) return githubRepoCache.repos;
  const r = await ghGET("user/repos?per_page=30&sort=pushed&direction=desc&affiliation=owner,collaborator,organization_member");
  const list = arr(r.json);
  if (r.status !== 0 || !list) return null;
  const repos: GitHubRepo[] = [];
  for (const item of list) {
    if (item.archived === true) continue;
    const id = jsonInt(item.id);
    const name = githubRepoName(str(item.full_name));
    if (id == null || !name) continue;
    repos.push({ id, name, pushed: parseDate(item.pushed_at) });
  }
  githubRepoCache = { repos, at: Date.now() };
  return repos;
}

/** Membership projects, newest activity first. One page, so a very long membership list is truncated. */
export async function listGitLabRepos(): Promise<TrackedRepo[] | null> {
  const list = arr(
    await glabJSON(
      "projects?membership=true&simple=true&archived=false&order_by=last_activity_at&sort=desc&per_page=100",
    ),
  );
  if (!list) return null;
  const repos: TrackedRepo[] = [];
  for (const item of list) {
    const name = gitlabProjectPath(str(item.path_with_namespace));
    if (!name) continue;
    repos.push({ host: "gitlab", key: `gitlab:${name}`, name });
  }
  return repos;
}

/** Repos you can access, most recently pushed first. Separate from the smaller pipeline poll. */
export async function listGitHubRepos(): Promise<TrackedRepo[] | null> {
  const r = await ghGET(
    "user/repos?per_page=100&sort=pushed&direction=desc&affiliation=owner,collaborator,organization_member",
  );
  const list = arr(r.json);
  if (r.status !== 0 || !list) return null;
  const repos: TrackedRepo[] = [];
  for (const item of list) {
    if (item.archived === true) continue;
    const name = githubRepoName(str(item.full_name));
    if (!name) continue;
    repos.push({ host: "github", key: `github:${name}`, name });
  }
  return repos;
}

/** Repos pushed inside the window, capped at 12. If none were, the 8 most recently pushed. */
async function githubReposForWindow(hours: number): Promise<GitHubRepo[] | null> {
  const all = await githubRepos();
  if (!all) return null;
  const cutoff = Date.now() - hours * 3_600_000;
  const recent = all.filter((r) => (r.pushed ?? 0) >= cutoff);
  return recent.length ? recent.slice(0, 12) : all.slice(0, 8);
}

export async function fetchGitHubPipelines(hours: number): Promise<Pipeline[] | null> {
  if (!(await githubLogin())) return null;
  const repos = await githubReposForWindow(hours);
  if (!repos) return null;
  const since = Date.now() - hours * 3_600_000;
  let sawRuns = false;
  let sawFailure = false;
  const results = await Promise.all(
    repos.map(async (repo) => {
      const r = await ghGET(`repos/${repo.name}/actions/runs?per_page=20`);
      if (r.status === 404) {
        sawRuns = true;
        return [];
      }
      const runs = arr(obj(r.json)?.workflow_runs);
      if (r.status !== 0 || !runs) {
        sawFailure = true;
        return [];
      }
      sawRuns = true;
      return runs
        .map((run) => parseGitHubRun(run, repo.id, repo.name))
        .filter((p): p is Pipeline => p != null && (p.updated == null || p.updated >= since));
    }),
  );
  if (!sawRuns && sawFailure) return null;
  return results.flat().sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
}

async function loadGitHubJobs(p: Pipeline): Promise<Job[] | null> {
  const repo = githubRepoName(p.project);
  if (!repo) return null;
  const r = await ghGET(`repos/${repo}/actions/runs/${p.id}/jobs?per_page=100`);
  const list = arr(obj(r.json)?.jobs);
  if (r.status !== 0 || !list) return null;
  const started = list
    .map(parseGitHubJob)
    .filter((j): j is Job => j != null)
    .sort((a, b) => a.id - b.id);
  if (!isActiveStatus(p.status) || !p.workflowPath || !HEX.test(p.sha)) return started;
  return withUnstartedWorkflowJobs(started, await githubWorkflowJobs(repo, p.workflowPath, p.sha), p.url);
}

/** Jobs declared in the workflow file. The jobs API hides one until it starts. */
async function githubWorkflowJobs(repo: string, file: string, sha: string) {
  const r = await ghGET(`repos/${repo}/contents/${file}?ref=${sha}`);
  const item = obj(r.json);
  const content = str(item?.content);
  if (r.status !== 0 || str(item?.encoding) !== "base64" || !content) return [];
  try {
    const text = Buffer.from(content.replace(/\s/g, ""), "base64").toString("utf8");
    return parseWorkflowJobNames(text);
  } catch {
    return [];
  }
}

const GITHUB_PR_FIELDS =
  "number title url isDraft mergeable reviewDecision updatedAt headRefName baseRefName headRefOid author{login} repository{databaseId nameWithOwner isArchived viewerPermission}statusCheckRollup{state}";

/** Open pull requests you created, plus every open pull in repos you opted into. */
export async function fetchOpenPullRequests(includeRepos: string[] = []): Promise<MergeRequest[] | null> {
  if (!(await githubLogin())) return null;
  const query = `query{viewer{pullRequests(states:OPEN,first:30,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{${GITHUB_PR_FIELDS}}}}}`;
  const data = await ghGraphQL(query);
  const nodes = arr(obj(obj(data?.viewer)?.pullRequests)?.nodes);
  if (!nodes) return null;
  const mine = nodes.map(parseGitHubPull).filter((m): m is MergeRequest => m != null);
  const extra = (await Promise.all(includeRepos.map(fetchGitHubRepoPulls))).flat();
  return Promise.all(combineMergeRequests([mine, extra]).map(recheckGitHubMergeStatus));
}

/** Open pull requests in one repository, whoever opened them. */
async function fetchGitHubRepoPulls(name: string): Promise<MergeRequest[]> {
  const repo = githubRepoName(name);
  if (!repo) return [];
  const [owner, repoName] = repo.split("/");
  const query = `query{repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(repoName)}){pullRequests(states:OPEN,first:20,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{${GITHUB_PR_FIELDS}}}}}`;
  const data = await ghGraphQL(query);
  const nodes = arr(obj(obj(data?.repository)?.pullRequests)?.nodes);
  if (!nodes) return [];
  return nodes.map(parseGitHubPull).filter((m): m is MergeRequest => m != null);
}

/** GitHub often returns mergeable=null until a second read of the same pull. */
async function recheckGitHubMergeStatus(mr: MergeRequest): Promise<MergeRequest> {
  if (!mergeStatusIsProvisional(mr.mergeStatus)) return mr;
  const once = async (): Promise<MergeRequest | null> => {
    const detail = await githubPullDetail(mr);
    return detail?.request ?? null;
  };
  const first = await once();
  if (first && !mergeStatusIsProvisional(first.mergeStatus)) return first;
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const second = await once();
  if (second && !mergeStatusIsProvisional(second.mergeStatus)) return second;
  return first ?? mr;
}

async function githubCheckJobs(repo: string, sha: string): Promise<Job[]> {
  if (!githubRepoName(repo) || !sha || !HEX.test(sha)) return [];
  const r = await ghGET(`repos/${repo}/commits/${sha}/check-runs?per_page=100`);
  const list = arr(obj(r.json)?.check_runs);
  if (r.status !== 0 || !list) return [];
  return list
    .map(parseGitHubJob)
    .filter((j): j is Job => j != null)
    .sort((a, b) => a.id - b.id);
}

/** Reloads one pull request and its check runs. Does not merge or close it. */
async function githubPullDetail(mr: MergeRequest): Promise<MrDetail | null> {
  const repo = githubRepoName(mr.project);
  if (mr.host !== "github" || !repo) return null;
  const r = await ghGET(`repos/${repo}/pulls/${mr.iid}`);
  const item = obj(r.json);
  const title = str(item?.title);
  const url = str(item?.html_url);
  if (r.status !== 0 || !item || !title || !url.startsWith("https://github.com/")) return null;
  const head = obj(item.head);
  const base = obj(item.base);
  const sha = str(head?.sha);
  const jobs = await githubCheckJobs(repo, sha);
  const draft = item.draft === true;
  const mergeable = typeof item.mergeable === "boolean" ? item.mergeable : null;
  const state = str(item.mergeable_state);
  const failed = jobs.some((j) => j.status === "failed");
  const running = jobs.some((j) => ["running", "pending", "manual"].includes(j.status));
  let mergeStatus: string;
  if (draft) mergeStatus = "draft_status";
  else if (mergeable == null) mergeStatus = "checking";
  else if (!mergeable) mergeStatus = state === "dirty" ? "conflict" : "blocked_status";
  else if (state === "behind") mergeStatus = "behind";
  else if (failed) mergeStatus = "ci_must_pass";
  else if (running || state === "unstable") mergeStatus = "ci_still_running";
  else mergeStatus = "mergeable";
  const request = makeMergeRequest({
    host: "github",
    projectID: mr.projectID,
    iid: mr.iid,
    title,
    project: repo,
    url,
    draft,
    mergeStatus,
    pipelineStatus: failed ? "failed" : running ? "running" : jobs.length ? "success" : null,
    updated: parseDate(item.updated_at),
    sourceBranch: str(head?.ref),
    targetBranch: str(base?.ref),
    sha,
    canMerge: mr.canMerge,
  });
  return { request, body: str(item.body), author: str(obj(item.user)?.login), jobs };
}

async function gitlabMRDetail(mr: MergeRequest): Promise<MrDetail | null> {
  const detail = obj(await glabJSON(`projects/${mr.projectID}/merge_requests/${mr.iid}`));
  const fresh = detail ? parseMergeRequest(detail) : null;
  if (!detail || !fresh) return null;
  const pipelineID = jsonInt(obj(detail.head_pipeline)?.id);
  const jobs = pipelineID == null ? [] : ((await loadGitLabJobs(mr.projectID, pipelineID)) ?? []);
  return { request: fresh, body: str(detail.description), author: str(obj(detail.author)?.username), jobs };
}

export function mrDetail(mr: MergeRequest): Promise<MrDetail | null> {
  return mr.host === "github" ? githubPullDetail(mr) : gitlabMRDetail(mr);
}

/** Merges only if the host still reports the request as ready (never trusts the list's stale state). */
export async function merge(mr: MergeRequest): Promise<Outcome> {
  if (!mr.canMerge) return fail("no write access to merge");
  if (mr.host === "github") return mergeGitHub(mr);
  const fresh = obj(await glabJSON(`projects/${mr.projectID}/merge_requests/${mr.iid}`));
  if (!fresh) return fail("couldn't load MR");
  if (obj(fresh.user)?.can_merge === false) return fail("no write access to merge");
  const status = str(fresh.detailed_merge_status) || "unknown";
  if (fresh.state !== "opened" || fresh.draft === true || status !== "mergeable") return fail(`not ready: ${status}`);
  const sha = str(fresh.sha);
  if (!sha) return fail("couldn't verify source revision");
  if (mr.sha && mr.sha !== sha) return fail("source changed since review; refresh and review again");
  const r = await run(
    "glab",
    ["api", "--hostname", "gitlab.com", "-X", "PUT", `projects/${mr.projectID}/merge_requests/${mr.iid}/merge`, "-f", `sha=${sha}`],
    120_000,
  );
  if (r.status !== 0 || parseObject(r.out)?.state !== "merged") return fail("merge failed");
  return { ok: true };
}

/** Closes an open request after re-checking the host. Does not delete the source branch. */
export async function close(mr: MergeRequest): Promise<Outcome> {
  if (mr.host === "github") return closeGitHub(mr);
  const fresh = obj(await glabJSON(`projects/${mr.projectID}/merge_requests/${mr.iid}`));
  if (!fresh) return fail("couldn't load MR");
  if (fresh.state !== "opened") return fail(`already ${str(fresh.state) || "unavailable"}`);
  const r = await run("glab", [
    "api",
    "--hostname",
    "gitlab.com",
    "-X",
    "PUT",
    `projects/${mr.projectID}/merge_requests/${mr.iid}`,
    "-f",
    "state_event=close",
  ]);
  if (r.status !== 0 || parseObject(r.out)?.state !== "closed") return fail("close failed");
  return { ok: true };
}

/** Merges only when GitHub still says open, not a draft, clean, and the head SHA is unchanged. */
async function mergeGitHub(mr: MergeRequest): Promise<Outcome> {
  const repo = githubRepoName(mr.project);
  if (!repo) return fail("couldn't load pull request");
  const r = await ghGET(`repos/${repo}/pulls/${mr.iid}`);
  const fresh = obj(r.json);
  if (r.status !== 0 || !fresh) return fail("couldn't load pull request");
  const mergeableState = str(fresh.mergeable_state) || "unknown";
  if (fresh.state !== "open" || fresh.draft === true || fresh.mergeable !== true || mergeableState !== "clean") {
    return fail(`not ready: ${mergeableState}`);
  }
  const sha = str(obj(fresh.head)?.sha);
  if (!sha || !HEX.test(sha)) return fail("couldn't verify source revision");
  if (mr.sha && mr.sha !== sha) return fail("source changed since review; refresh and review again");
  const settings = obj(obj(fresh.base)?.repo);
  const method = githubMergeMethod(
    typeof settings?.allow_merge_commit === "boolean" ? settings.allow_merge_commit : true,
    settings?.allow_squash_merge === true,
    settings?.allow_rebase_merge === true,
  );
  if (!method) return fail("this repo does not allow merges");
  const result = await run(
    "gh",
    [
      "api",
      "--hostname",
      "github.com",
      "--method",
      "PUT",
      `repos/${repo}/pulls/${mr.iid}/merge`,
      "-f",
      `sha=${sha}`,
      "-f",
      `merge_method=${method}`,
    ],
    120_000,
  );
  if (result.status !== 0 || parseObject(result.out)?.merged !== true) return fail("merge failed");
  return { ok: true };
}

/** Closes an open pull request. Does not delete the source branch. */
async function closeGitHub(mr: MergeRequest): Promise<Outcome> {
  const repo = githubRepoName(mr.project);
  if (!repo) return fail("couldn't load pull request");
  const r = await ghGET(`repos/${repo}/pulls/${mr.iid}`);
  const fresh = obj(r.json);
  if (r.status !== 0 || !fresh) return fail("couldn't load pull request");
  if (fresh.state !== "open") return fail(`already ${str(fresh.state) || "unavailable"}`);
  const result = await run("gh", [
    "api",
    "--hostname",
    "github.com",
    "--method",
    "PATCH",
    `repos/${repo}/pulls/${mr.iid}`,
    "-f",
    "state=closed",
  ]);
  if (result.status !== 0 || parseObject(result.out)?.state !== "closed") return fail("close failed");
  return { ok: true };
}

/** GitLab returns a text trace. GitHub logs come from `gh run view <run> --log`. */
export async function jobTrace(job: Job, p: Pipeline): Promise<string | null> {
  if (p.host === "gitlab") {
    const r = await run("glab", ["api", "--hostname", "gitlab.com", `projects/${p.projectID}/jobs/${job.id}/trace`]);
    return r.status === 0 ? r.out : null;
  }
  const repo = githubRepoName(p.project);
  if (!repo || !Number.isInteger(p.id) || p.id <= 0) return null;
  const r = await run("gh", ["run", "view", String(p.id), "--log", "--repo", repo], 120_000);
  if (r.status !== 0 || !r.out.trim()) return null;
  return githubJobLog(r.out, job.name);
}
