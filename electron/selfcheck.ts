// `npm run check`: status rules, dates, notification text, GitHub run mapping, and
// pull-request status, without calling GitLab or GitHub. Port of StatusChecks.swift.
import assert from "node:assert/strict";
import {
  applyJobUpdate,
  browserURL,
  combineMergeRequests,
  descriptionSummary,
  githubCanMerge,
  githubMergeMethod,
  githubPullStatus,
  githubJobLog,
  githubRepoName,
  githubStatus,
  groupSameChange,
  groupTitle,
  isActiveStatus,
  isDone,
  isReady,
  makeMergeRequest,
  makePipeline,
  mergeRequestIID,
  mergeStatusIsProvisional,
  mrBarTone,
  mrKey,
  normalizeMergeStatus,
  normalizePipelineStatus,
  notificationContent,
  numberLabel,
  omitHiddenRequests,
  requestJustFinished,
  parseDate,
  parseTrackedRepoKey,
  parseGitHubPull,
  parseGitHubRun,
  parseWorkflowJobNames,
  workflowFilePath,
  withUnstartedWorkflowJobs,
  parseMergeRequest,
  parseMergeRequestGraphQL,
  finishedWithStaleRun,
  pipelineKey,
  progressState,
  projectIDFromGraphQL,
  refLabel,
  ringSlices,
  ringSlicesForPipeline,
  sameChange,
  sanitizePrefs,
  settlePipeline,
  trayCounts,
  unresolvedFailures,
  type Job,
  type Pipeline,
} from "./logic";
import { appIconPng, runningGleam, trayIconPng } from "./icons";
import { merge } from "./model";

const checks: Array<[string, () => void | Promise<void>]> = [];
const check = (name: string, fn: () => void | Promise<void>) => checks.push([name, fn]);

const job = (status: string, id: number): Job => ({ id, name: "job", stage: "test", status, url: "", duration: null });
const pipeline = (status: string, jobs: Job[] = []): Pipeline =>
  makePipeline({ projectID: 1, id: 2, project: "group/repo", ref: "main", status, url: "https://gitlab.com", jobs });

check("failure counts as finished but never passing", () => {
  const [status, fraction] = progressState(pipeline("failed", [job("success", 1), job("failed", 2), job("pending", 3)]));
  assert.equal(status, "failed");
  assert.ok(Math.abs(fraction - 2 / 3) < 0.001);
});

check("finished jobs clear a pipeline the list still calls running", () => {
  const stuck = pipeline("running", [job("success", 1), job("success", 2), job("success", 3), job("success", 4)]);
  assert.equal(settlePipeline(stuck).status, "success");
  const mid = pipeline("running", [job("success", 1), job("created", 2)]);
  assert.equal(settlePipeline(mid).status, "running");
  const broken = pipeline("running", [job("success", 1), job("failed", 2)]);
  assert.equal(settlePipeline(broken).status, "failed");
});

check("a detail view that finds the job finished updates the list immediately", () => {
  const stuck = pipeline("running", [job("running", 1)]);
  const key = pipelineKey(stuck);
  const updated = applyJobUpdate([stuck], key, [job("success", 1)]);
  assert.ok(updated);
  assert.equal(updated![0].status, "success");
  assert.equal(updated![0].jobs[0].status, "success");
  assert.equal(applyJobUpdate(updated!, key, [job("success", 1)]), null);
  const still = applyJobUpdate([stuck], key, [job("running", 1)]);
  assert.equal(still, null);
});

check("a merged request leaves the open list and the panel", () => {
  const mr = makeMergeRequest({
    projectID: 4,
    iid: 30,
    title: "Ship it",
    project: "kkube/recipes",
    url: "https://gitlab.com/kkube/recipes/-/merge_requests/30",
  });
  const now = 5_000_000;
  const hidden = new Map([[mrKey(mr), now + 60_000]]);
  assert.equal(omitHiddenRequests([mr], hidden, now).length, 0);
  assert.equal(omitHiddenRequests([mr], hidden, now + 60_000).length, 1);
  const event = {
    id: "1",
    title: "Merge complete",
    detail: "kkube/recipes !30",
    status: "merged",
    url: mr.url,
    date: now - 1_000,
  };
  assert.equal(requestJustFinished([event], mr, now), true);
  assert.equal(requestJustFinished([{ ...event, date: now - 30_000 }], mr, now), false);
  assert.equal(requestJustFinished([{ ...event, url: "https://example.com" }], mr, now), false);
});

check("a running job fills its slice before it finishes", () => {
  const now = 1_000_000;
  const running = job("running", 1);
  running.startedAt = now;
  const [freshStatus, fresh] = progressState(pipeline("running", [running]), now);
  assert.equal(freshStatus, "running");
  assert.ok(fresh > 0.05 && fresh < 0.2);
  running.startedAt = now - 45_000;
  const halfway = progressState(pipeline("running", [running, job("created", 2)]), now)[1];
  assert.ok(halfway > 0.2 && halfway < 0.5);
  const done = progressState(pipeline("success", [job("success", 1)]), now)[1];
  assert.equal(done, 1);
});

check("a finished pipeline does not keep a running ring", () => {
  const stuck = pipeline("success", [job("running", 1)]);
  assert.equal(finishedWithStaleRun(stuck), true);
  assert.equal(finishedWithStaleRun(pipeline("running", [job("running", 1)])), false);
  const [status, fraction] = progressState(stuck);
  assert.equal(status, "passed");
  assert.equal(fraction, 1);
  assert.deepEqual(ringSlicesForPipeline(stuck).map((s) => s.kind), ["done"]);
  assert.equal(progressState(pipeline("failed", [job("running", 1)]))[0], "failed");
});

check("a running job owns the slice that gleams", () => {
  const slices = ringSlices([job("success", 1), job("running", 2), job("created", 3)]);
  assert.deepEqual(slices.map((s) => s.kind), ["done", "running", "wait"]);
  assert.equal(slices[0].fill, 1);
  assert.ok(slices[1].fill > 0 && slices[1].fill < 1);
  assert.equal(slices[2].fill, 0);
});

check("the running gleam stays inside the orange fill", () => {
  const fill = 0.2;
  for (let phase = 0; phase < 1; phase += 0.05) {
    assert.equal(runningGleam(fill + 0.02, fill, phase), 0);
    assert.equal(runningGleam(0.9, fill, phase), 0);
    let brightest = 0;
    for (let local = 0; local <= fill; local += fill / 20) {
      brightest = Math.max(brightest, runningGleam(local, fill, phase));
    }
    assert.ok(brightest > 0.9);
  }
  assert.equal(runningGleam(0.05, 0, 0.2), 0);
});

check("canceled and skipped stay themselves", () => {
  assert.equal(progressState(pipeline("canceled", [job("canceled", 1)]))[0], "canceled");
  assert.equal(progressState(pipeline("skipped", [job("skipped", 1)]))[0], "skipped");
});

check("manual, waiting, and running classification", () => {
  assert.equal(progressState(pipeline("running", [job("manual", 1)]))[0], "pending");
  assert.ok(isActiveStatus("waiting_for_resource"));
  assert.ok(!isDone("manual"));
  assert.ok(isDone("failed"));
});

check("draft cannot be ready", () => {
  const mr = makeMergeRequest({ projectID: 1, iid: 4, title: "Draft", draft: true, mergeStatus: "mergeable", pipelineStatus: "success" });
  assert.ok(!isReady(mr));
});

check("later pipeline for the same commit clears a failure", () => {
  const failed = makePipeline({ projectID: 1, id: 10, project: "example/app", ref: "fix/header", status: "failed", updated: 10_000, sha: "aaaaaaaaaa" });
  const passed = makePipeline({ projectID: 1, id: 11, project: "example/app", ref: "refs/merge-requests/17/head", status: "success", updated: 20_000, sha: "aaaaaaaaaa" });
  const main = makePipeline({ projectID: 1, id: 12, project: "example/app", ref: "main", status: "success", updated: 30_000, sha: "bbbbbbbbbb" });
  assert.equal(unresolvedFailures([main, passed, failed]).length, 0);
  assert.equal(unresolvedFailures([failed]).length, 1);
  assert.equal(unresolvedFailures([failed, main]).length, 1);
  const olderPass = makePipeline({ projectID: 1, id: 9, project: "example/app", ref: "refs/merge-requests/17/head", status: "success", updated: 1_000, sha: "aaaaaaaaaa" });
  assert.equal(unresolvedFailures([failed, olderPass]).length, 1);
});

check("branch and merge-request pipelines group", () => {
  const mr = makePipeline({ projectID: 1, id: 20, project: "example/app", ref: "refs/merge-requests/15/head", status: "running", updated: 20_000, sha: "different-sha", sourceBranch: "feature/header" });
  const branch = makePipeline({ projectID: 1, id: 19, project: "example/app", ref: "feature/header", status: "running", updated: 19_000, sha: "branch-sha" });
  const main = makePipeline({ projectID: 1, id: 21, project: "example/app", ref: "main", status: "running", updated: 21_000, sha: "main-sha" });
  const groups = groupSameChange([main, mr, branch]);
  assert.equal(groups.length, 2);
  assert.ok(groups.some((g) => g.pipelines.map((p) => p.id).sort().join() === "19,20"));
  assert.ok(groups.some((g) => g.pipelines.map((p) => p.id).join() === "21"));
  assert.equal(groupTitle([mr, branch]), "feature/header");
  assert.equal(mergeRequestIID(makePipeline({ projectID: 1, id: 1, ref: "refs/merge-requests/15/head", status: "running" })), 15);
  assert.equal(mergeRequestIID(main), null);
  const sameSha = makePipeline({ projectID: 1, id: 30, ref: "refs/merge-requests/8/head", status: "running", sha: "abc" });
  const twin = makePipeline({ projectID: 1, id: 31, ref: "feature/other", status: "running", sha: "abc" });
  assert.equal(groupSameChange([sameSha, twin, main]).length, 2);
  assert.ok(!sameChange(sameSha, main));
});

check("dates parse with and without fractional seconds", () => {
  assert.notEqual(parseDate("2026-10-31T22:10:12.123Z"), null);
  assert.notEqual(parseDate("2026-10-31T22:10:12Z"), null);
  assert.equal(parseDate("nope"), null);
});

check("notification content", () => {
  const body = "Fix e2e: " + "calendar ".repeat(30);
  const content = notificationContent("Merge complete", "example/app · !347", body, "mr-347", false, "https://gitlab.com/group/repo/-/merge_requests/347", "mergeRequest");
  assert.equal(content.title, "Pipeline Tracer");
  assert.equal(content.subtitle, "Merge complete");
  assert.ok(content.body.startsWith("example/app · !347"));
  assert.equal([...content.body].length, 90);
  assert.ok(content.body.endsWith("…"));
  assert.ok(!content.sound && content.kind === "mergeRequest" && content.thread === "mr-347");
  const failed = notificationContent("Job failed", "group/repo · #12", "test:integration\n failed", "1:12", true, "https://gitlab.com/group/repo/-/jobs/42", "logs");
  assert.equal(failed.subtitle, "Job failed");
  assert.equal(failed.body, "group/repo · #12 · test:integration failed");
  assert.ok(failed.sound && failed.urgent && failed.kind === "logs");
  assert.equal(failed.url, "https://gitlab.com/group/repo/-/jobs/42");
});

check("preferences fall back to defaults", () => {
  const prefs = sanitizePrefs({ refreshSeconds: 7, pipelineHours: 4, rememberPlace: true } as never);
  assert.equal(prefs.refreshSeconds, 60);
  assert.equal(prefs.pipelineHours, 4);
  assert.equal(prefs.rememberPlace, true);
  assert.equal(sanitizePrefs(null).rememberPlace, false);
  assert.equal(sanitizePrefs(null).mergeButton, true);
  assert.equal(sanitizePrefs(null).stackMenuBar, true);
  assert.equal(sanitizePrefs(null).notifications, true);
  assert.equal(sanitizePrefs({ notifications: false } as never).notifications, false);
  assert.equal(sanitizePrefs({ notifications: 0 } as never).notifications, true);
  assert.equal(sanitizePrefs({ stackMenuBar: true } as never).stackMenuBar, true);
  assert.equal(sanitizePrefs({ stackMenuBar: 1 } as never).stackMenuBar, true);
  assert.deepEqual(sanitizePrefs(null).showAllRequests, []);
  const scoped = sanitizePrefs({
    showAllRequests: ["github:example/app", "gitlab:group/sub/repo", "github:example/app", "nope", "github:../x"],
  });
  assert.deepEqual(scoped.showAllRequests, ["github:example/app", "gitlab:group/sub/repo"]);
  assert.equal(parseTrackedRepoKey("gitlab:group/sub/repo")?.name, "group/sub/repo");
  assert.equal(parseTrackedRepoKey('github:owner/name";injection'), null);
  const mine = makeMergeRequest({ projectID: 1, iid: 2, title: "Mine", project: "example/app", host: "github" });
  const theirs = makeMergeRequest({
    projectID: 1,
    iid: 2,
    title: "Mine",
    project: "example/app",
    host: "github",
    author: "ada",
  });
  const other = makeMergeRequest({ projectID: 1, iid: 9, title: "Other", project: "example/app", host: "github", author: "ada" });
  const combined = combineMergeRequests([[mine], [theirs, other]]);
  assert.equal(combined.length, 2);
  assert.equal(combined.find((mr) => mr.iid === 2)?.author, "ada");
});

check("GraphQL helpers", () => {
  assert.equal(projectIDFromGraphQL("gid://gitlab/Project/81197701"), 81197701);
  assert.equal(projectIDFromGraphQL(42), 42);
  assert.equal(normalizeMergeStatus("DRAFT_STATUS"), "draft_status");
  assert.equal(normalizeMergeStatus("NOT_APPROVED"), "not_approved");
  assert.equal(normalizePipelineStatus("SUCCESS"), "success");
});

check("GitHub runs stay separate from GitLab", () => {
  assert.equal(githubRepoName("krisrmgua/PipelineTracer"), "krisrmgua/PipelineTracer");
  assert.equal(githubRepoName("owner/repo name"), null);
  assert.equal(githubRepoName("owner/repo/extra"), null);
  assert.equal(githubRepoName("https://github.com/owner/repo"), null);
  assert.equal(githubStatus("in_progress", null), "running");
  assert.equal(githubStatus("queued", null), "pending");
  assert.equal(githubStatus("completed", "success"), "success");
  assert.equal(githubStatus("completed", "failure"), "failed");
  assert.equal(githubStatus("completed", "cancelled"), "canceled");
  assert.equal(githubStatus("completed", "action_required"), "manual");
  assert.equal(new URL(browserURL("https://github.com/owner/repo/actions/runs/1") ?? "").hostname, "github.com");
  assert.equal(new URL(browserURL("https://gitlab.com/group/repo/-/pipelines/1") ?? "").hostname, "gitlab.com");
  assert.equal(descriptionSummary("Visible\n<!-- secret -->"), "Visible");
  assert.equal(descriptionSummary("Before\n<!<!-- hidden -->-- hidden -->\nAfter"), "Before\n\nAfter");
  assert.equal(browserURL("http://github.com/owner/repo"), null);
  assert.equal(browserURL("https://evil.github.com.example/owner/repo"), null);
  assert.equal(browserURL("https://user@github.com/owner/repo"), null);
  const run = {
    id: 42,
    name: "CI",
    head_branch: "main",
    head_sha: "abc",
    status: "completed",
    conclusion: "failure",
    html_url: "https://github.com/example/app/actions/runs/42",
    path: ".github/workflows/ci.yml",
    updated_at: "2026-11-03T12:00:00Z",
  };
  const parsed = parseGitHubRun(run, 7, "example/app");
  assert.ok(parsed);
  assert.equal(parsed.host, "github");
  assert.equal(parsed.status, "failed");
  assert.equal(parsed.workflow, "CI");
  assert.equal(parsed.workflowPath, ".github/workflows/ci.yml");
  assert.equal(workflowFilePath(".github/workflows/../secret.yml"), null);
  assert.equal(refLabel(parsed), "CI · main");
  assert.equal(pipelineKey(parsed), "github:7:42");
  const failed = makePipeline({ host: "gitlab", projectID: 7, id: 10, project: "example/app", ref: "main", status: "failed", sha: "abc" });
  const passed = makePipeline({ host: "github", projectID: 7, id: 99, project: "example/app", ref: "main", status: "success", sha: "abc", workflow: "CI" });
  assert.equal(unresolvedFailures([failed, passed]).length, 1);
  assert.ok(!sameChange(failed, passed));
  const docs = makePipeline({ host: "github", projectID: 7, id: 100, project: "example/app", ref: "main", status: "success", updated: 30_000, sha: "abc", workflow: "Docs" });
  const ci = makePipeline({ host: "github", projectID: 7, id: 98, project: "example/app", ref: "main", status: "failed", updated: 20_000, sha: "abc", workflow: "CI" });
  assert.deepEqual(unresolvedFailures([docs, ci]).map((p) => p.workflow), ["CI"]);
});

check("github keeps a job that has not started", () => {
  const yaml = [
    "name: Build and deploy",
    "on: push",
    "jobs:",
    "  build-push:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - name: Build",
    "  deploy:",
    "    needs: build-push",
    '    name: "Deploy"',
  ].join("\n");
  const defined = parseWorkflowJobNames(yaml);
  assert.deepEqual(defined.map((job) => job.name), ["build-push", "Deploy"]);
  const started: Job[] = [
    { id: 5, name: "build-push", stage: "build-push", status: "running", url: "https://github.com/example/app/actions/runs/1/job/5", duration: null, startedAt: 1 },
  ];
  const url = "https://github.com/example/app/actions/runs/1";
  const waiting = withUnstartedWorkflowJobs(started, defined, url);
  assert.deepEqual(
    waiting.map((job) => [job.name, job.status]),
    [
      ["build-push", "running"],
      ["Deploy", "pending"],
    ],
  );
  assert.ok(waiting[1].id < 0);
  assert.equal(waiting[1].url, url);
  const both = withUnstartedWorkflowJobs(
    [
      ...started,
      { id: 9, name: "test (node)", stage: "test (node)", status: "pending", url: "https://github.com/example/app/actions/runs/1/job/9", duration: null, startedAt: null },
      { id: 6, name: "Deploy", stage: "Deploy", status: "running", url: "https://github.com/example/app/actions/runs/1/job/6", duration: null, startedAt: 2 },
    ],
    [...defined, { id: "test", name: "test" }],
    url,
  );
  assert.deepEqual(both.map((job) => job.id), [5, 6, 9]);
});

check("github job log keeps one job", () => {
  const raw = [
    "build-push\tSet up job\tCurrent runner version",
    "deploy\tCheckout\tfetching",
    "build-push\tBuild and push\tPushed image",
  ].join("\n");
  assert.equal(
    githubJobLog(raw, "build-push"),
    "Set up job  Current runner version\nBuild and push  Pushed image",
  );
  assert.equal(githubJobLog(raw, "missing"), raw);
});

check("menu bar MR color follows the request", async () => {
  assert.equal(mergeStatusIsProvisional("checking"), true);
  assert.equal(mergeStatusIsProvisional("unchecked"), true);
  assert.equal(mergeStatusIsProvisional("mergeable"), false);
  const waiting = makeMergeRequest({ projectID: 1, iid: 2, title: "Wait", mergeStatus: "checking" });
  const ready = makeMergeRequest({ projectID: 1, iid: 3, title: "Ready", mergeStatus: "mergeable", pipelineStatus: "success" });
  const blocked = makeMergeRequest({ projectID: 1, iid: 4, title: "Blocked", mergeStatus: "conflict" });
  assert.equal(mrBarTone([waiting]), "running");
  assert.equal(mrBarTone([ready]), "ready");
  assert.equal(mrBarTone([ready, blocked]), "failed");
  assert.equal(mrBarTone([]), "none");
});

check("GitHub pull request status", async () => {
  const ready = githubPullStatus(false, "MERGEABLE", null, "SUCCESS");
  assert.ok(!ready.draft && ready.mergeStatus === "mergeable");
  assert.equal(githubPullStatus(false, "MERGEABLE", "REVIEW_REQUIRED", "SUCCESS").mergeStatus, "not_approved");
  assert.equal(githubPullStatus(false, "CONFLICTING", null, null).mergeStatus, "conflict");
  const draft = githubPullStatus(true, "MERGEABLE", null, null);
  assert.ok(draft.draft && draft.mergeStatus === "draft_status");
  const node = {
    number: 8,
    title: "Add login",
    url: "https://github.com/example/app/pull/8",
    isDraft: false,
    mergeable: "MERGEABLE",
    updatedAt: "2026-11-03T12:00:00Z",
    headRefName: "feature/login",
    baseRefName: "main",
    headRefOid: "abc",
    repository: { databaseId: 7, nameWithOwner: "example/app", isArchived: false },
    statusCheckRollup: { state: "SUCCESS" },
  };
  const parsed = parseGitHubPull(node);
  assert.ok(parsed);
  assert.equal(parsed.host, "github");
  assert.equal(numberLabel(parsed), "#8");
  assert.equal(mrKey(parsed), "github:7:8");
  assert.ok(isReady(parsed));
  assert.equal(parsed.canMerge, true);
  assert.equal(parsed.project, "example/app");
  assert.equal(
    parseGitHubPull({ ...node, repository: { databaseId: 7, nameWithOwner: "example/app", isArchived: false, viewerPermission: "READ" } })?.canMerge,
    false,
  );
  assert.equal(
    parseGitHubPull({ ...node, repository: { databaseId: 7, nameWithOwner: "example/app", isArchived: false, viewerPermission: "WRITE" } })?.canMerge,
    true,
  );
  assert.equal(githubCanMerge("ADMIN"), true);
  assert.equal(githubCanMerge("MAINTAIN"), true);
  assert.equal(githubCanMerge("WRITE"), true);
  assert.equal(githubCanMerge("TRIAGE"), false);
  assert.equal(githubCanMerge("READ"), false);
  assert.equal(
    parseMergeRequestGraphQL({
      iid: "12",
      title: "Fix",
      webUrl: "https://gitlab.com/group/repo/-/merge_requests/12",
      draft: false,
      detailedMergeStatus: "MERGEABLE",
      userPermissions: { canMerge: false },
      project: { id: "gid://gitlab/Project/9", fullPath: "group/repo", archived: false },
    })?.canMerge,
    false,
  );
  assert.equal(
    parseMergeRequest({
      project_id: 9,
      iid: 12,
      title: "Fix",
      web_url: "https://gitlab.com/group/repo/-/merge_requests/12",
      detailed_merge_status: "mergeable",
      user: { can_merge: false },
    })?.canMerge,
    false,
  );
  assert.equal(parseGitHubPull({ ...node, url: "https://example.com/pull/8" }), null);
  assert.equal(parseGitHubPull({ ...node, repository: { databaseId: 7, nameWithOwner: "example/app", isArchived: true } }), null);
  assert.equal(githubMergeMethod(true, true, true), "merge");
  assert.equal(githubMergeMethod(false, true, true), "squash");
  assert.equal(githubMergeMethod(false, false, true), "rebase");
  assert.equal(githubMergeMethod(false, false, false), null);
  const readOnlyOutcome = await merge(
    makeMergeRequest({ host: "github", projectID: 7, iid: 8, title: "Add login", project: "example/app", url: "https://github.com/example/app/pull/8", mergeStatus: "mergeable", pipelineStatus: "success", canMerge: false }),
  );
  assert.deepEqual(readOnlyOutcome, { ok: false, message: "no write access to merge" });
  const outcome = await merge(
    makeMergeRequest({ host: "github", projectID: 7, iid: 8, title: "Add login", project: "not a repo", url: "https://github.com/example/app/pull/8", mergeStatus: "mergeable", pipelineStatus: "success" }),
  );
  assert.deepEqual(outcome, { ok: false, message: "couldn't load pull request" });
});

check("tray counts and icons", () => {
  const failing = makePipeline({ projectID: 1, id: 5, ref: "main", status: "failed", sha: "x" });
  const running = makePipeline({ projectID: 1, id: 6, ref: "dev", status: "running", sha: "y" });
  const counts = trayCounts([failing, running], [makeMergeRequest({ projectID: 1, iid: 1, title: "a" })]);
  assert.deepEqual(counts, { requests: 1, running: 1, failed: 1 });
  const png = trayIconPng("running", 0.5, false, 36);
  assert.equal(png.subarray(1, 4).toString("ascii"), "PNG");
  assert.equal(trayIconPng("failed", 1, true, 32).readUInt32BE(16), 32);
  assert.equal(appIconPng(64).readUInt32BE(16), 64);
});

void (async () => {
  for (const [name, fn] of checks) {
    try {
      await fn();
    } catch (err) {
      console.error(`FAIL ${name}`);
      throw err;
    }
  }
  console.log(`${checks.length} status/date/notification checks passed`);
})();
