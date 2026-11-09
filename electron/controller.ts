import { randomUUID } from "node:crypto";
import { app } from "electron";
import {
  applyJobUpdate,
  isActiveStatus,
  omitHiddenRequests,
  isFailed,
  isReady,
  isRunning,
  settlePipeline,
  isSuccess,
  mrKey,
  numberLabel,
  parseTrackedRepoKey,
  pipelineKey,
  refLabel,
  sameStrings,
  unresolvedFailures,
  type ActivityEvent,
  type Job,
  type MergeRequest,
  type NotificationKind,
  type Pipeline,
  type Prefs,
  type TrackedRepo,
  type TracerState,
} from "./logic";
import * as model from "./model";
import * as notifier from "./notifier";
import { refreshToolsIfMissing, toolPath } from "./shell";
import type { Store } from "./store";

/**
 * Owns the refresh timer, the last snapshot, and the change detection that drives
 * notifications. A port of the Swift MenuController without the AppKit parts.
 */
export class Controller {
  pipelines: Pipeline[] = [];
  mrs: MergeRequest[] = [];
  cardPipeline: Pipeline | null = null;
  private events: ActivityEvent[] = [];
  private refreshing = false;
  private error: string | null = null;
  private updated: number | null = null;
  private result: string | null = null;
  private merging: string | null = null;
  private closing: string | null = null;

  // What the last refresh saw, so only changes produce notifications.
  private seenPipelineIDs = new Set<string>();
  private lastPipelineStatus = new Map<string, string>();
  private lastJobStatus = new Map<string, string>();
  private baselineDone = false;

  private timer: NodeJS.Timeout | null = null;
  /** Merges and closes run one at a time. */
  private work: Promise<void> = Promise.resolve();
  /** Set when a refresh is already running, so the follow-up poll is not dropped. */
  private refreshQueued = false;
  /** Requests just merged or closed, kept out of the open list until this epoch ms. */
  private hiddenRequests = new Map<string, number>();
  private gitlabRepos: TrackedRepo[] = [];
  private githubRepos: TrackedRepo[] = [];
  private gitlabLogin: string | null = null;
  private githubLogin: string | null = null;

  constructor(
    private store: Store,
    private onChange: () => void,
  ) {}

  snapshot(): TracerState {
    return {
      pipelines: this.pipelines,
      mrs: this.mrs,
      events: this.events,
      refreshing: this.refreshing,
      error: this.error,
      updated: this.updated,
      result: this.result,
      merging: this.merging,
      closing: this.closing,
      prefs: this.store.prefs,
      repos: [...this.gitlabRepos, ...this.githubRepos].sort(
        (a, b) => a.name.localeCompare(b.name) || a.host.localeCompare(b.host),
      ),
      platform: process.platform,
      version: app.getVersion(),
      cli: { glab: toolPath("glab"), gh: toolPath("gh") },
      notificationsSupported: notifier.notificationsSupported(),
    };
  }

  /** (Re)starts the refresh timer from the current setting. */
  schedule(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => void this.refresh(), this.store.prefs.refreshSeconds * 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * The panel loaded jobs ahead of the poll. Keep that result, so leaving the
   * detail does not put a finished pipeline back under In progress.
   */
  noteJobs(key: string, jobs: Job[]): void {
    const next = applyJobUpdate(this.pipelines, key, jobs);
    if (!next) return;
    const prev = this.pipelines.find((p) => pipelineKey(p) === key);
    const settled = next.find((p) => pipelineKey(p) === key);
    this.pipelines = next;
    if (settled && this.cardPipeline && pipelineKey(this.cardPipeline) === key) {
      this.cardPipeline = isRunning(settled) ? settled : (next.find(isRunning) ?? next[0] ?? null);
    }
    if (prev && settled && isFailed(settled) && !isFailed(prev)) this.announceFailures(next);
    this.onChange();
  }

  prefsChanged(before: Prefs, after: Prefs): void {
    if (before.refreshSeconds !== after.refreshSeconds) this.schedule();
    if (
      before.refreshSeconds !== after.refreshSeconds ||
      before.pipelineHours !== after.pipelineHours ||
      !sameStrings(before.showAllRequests, after.showAllRequests)
    ) {
      void this.refresh();
    }
    this.onChange();
  }

  async refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshQueued = true;
      return;
    }
    this.refreshing = true;
    this.onChange();
    try {
      await this.doRefresh();
    } finally {
      this.refreshing = false;
      this.onChange();
      if (this.refreshQueued) {
        this.refreshQueued = false;
        void this.refresh();
      }
    }
  }

  private async doRefresh(): Promise<void> {
    await refreshToolsIfMissing();
    const hours = this.store.prefs.pipelineHours;
    // Pipelines still going last time: reload jobs only when they finish, so a failure
    // notification can name the bad job without fetching every active pipeline.
    const wasActive = new Set([...this.lastPipelineStatus].filter(([, s]) => isActiveStatus(s)).map(([k]) => k));
    const knownPipes = new Set(this.seenPipelineIDs);
    const previousPipes = new Map(this.pipelines.map((p) => [pipelineKey(p), p]));
    const previousGitLab = this.pipelines.filter((p) => p.host === "gitlab");
    const previousGitHub = this.pipelines.filter((p) => p.host === "github");
    const previousGitLabMRs = this.mrs.filter((m) => m.host === "gitlab");
    const previousGitHubMRs = this.mrs.filter((m) => m.host === "github");

    const glab = toolPath("glab");
    const gh = toolPath("gh");
    if (!glab && !gh) {
      this.error = "Couldn’t find glab or gh. Install one, sign in, then press Refresh. Preferences lists where Tracer looked.";
      return;
    }

    const [gitlabUser, githubUser] = await Promise.all([
      glab ? model.currentUser() : Promise.resolve(null),
      gh ? model.githubLogin() : Promise.resolve(null),
    ]);
    this.gitlabLogin = gitlabUser;
    this.githubLogin = githubUser;
    if (!gitlabUser && !githubUser) {
      this.error = "Can’t reach GitLab or GitHub. Check your connection and glab or gh sign-in. Showing last received activity.";
      return;
    }

    let gitlabFailedFlag = false;
    const markFailed = () => {
      gitlabFailedFlag = true;
    };
    const showAll = this.store.prefs.showAllRequests
      .map((key) => parseTrackedRepoKey(key))
      .filter((repo): repo is { host: "gitlab" | "github"; name: string } => repo != null);
    const gitlabProjects = showAll.filter((repo) => repo.host === "gitlab").map((repo) => repo.name);
    const githubNames = showAll.filter((repo) => repo.host === "github").map((repo) => repo.name);
    const gitlabWork = gitlabUser
      ? Promise.all([
          model.fetchOpenMergeRequests(markFailed, gitlabProjects),
          model.fetchPipelines(hours, markFailed),
          model.listGitLabRepos(),
        ])
      : Promise.resolve([[], [], null] as [MergeRequest[], Pipeline[], TrackedRepo[] | null]);
    const githubWork = githubUser
      ? Promise.all([model.fetchGitHubPipelines(hours), model.fetchOpenPullRequests(githubNames), model.listGitHubRepos()])
      : Promise.resolve([null, null, null] as [Pipeline[] | null, MergeRequest[] | null, TrackedRepo[] | null]);
    const [[glMRs, glPipes, glRepos], [ghPipes, ghPulls, ghRepos]] = await Promise.all([gitlabWork, githubWork]);
    if (glRepos) this.gitlabRepos = glRepos;
    if (ghRepos) this.githubRepos = ghRepos;

    let mrs = glMRs;
    let gitlabPipes = glPipes;
    const gitlabOK = gitlabUser != null && !gitlabFailedFlag;
    if (gitlabOK) gitlabPipes = await model.annotateSourceBranches(gitlabPipes, mrs);

    let githubPipes = ghPipes ?? [];
    const githubOK = ghPipes != null;
    let githubMRs = ghPulls ?? [];
    const pullsOK = githubUser ? ghPulls != null : previousGitHubMRs.length === 0;

    const gitlabFailed =
      (gitlabUser != null && !gitlabOK) || (gitlabUser == null && (previousGitLab.length > 0 || previousGitLabMRs.length > 0));
    const githubFailed = (githubUser != null && !githubOK) || (githubUser == null && previousGitHub.length > 0);
    if (gitlabFailed && githubFailed && !pullsOK) {
      this.error = "Refresh incomplete. Showing last received activity; try Refresh again.";
      return;
    }
    if (gitlabFailed) {
      gitlabPipes = previousGitLab;
      mrs = previousGitLabMRs;
    }
    if (githubFailed) githubPipes = previousGitHub;
    if (!pullsOK) githubMRs = previousGitHubMRs;
    mrs = [...mrs, ...githubMRs].sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
    const pipes = [...gitlabPipes, ...githubPipes].sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));

    const notes: string[] = [];
    if (gitlabFailed) notes.push("GitLab refresh incomplete. Showing the last GitLab activity.");
    if (githubFailed) notes.push("GitHub Actions refresh incomplete. Showing the last GitHub activity.");
    if (!pullsOK && (githubUser != null || previousGitHubMRs.length > 0)) {
      notes.push("GitHub pull requests refresh incomplete. Showing the last pull requests.");
    }

    // Reuse jobs while status+sha are unchanged. A live pipeline is the exception:
    // its jobs move while the list still says "running".
    for (let i = 0; i < pipes.length; i++) {
      if (isRunning(pipes[i])) continue;
      const old = previousPipes.get(pipelineKey(pipes[i]));
      if (old && old.status === pipes[i].status && old.sha === pipes[i].sha && old.jobs.length) {
        pipes[i] = { ...pipes[i], jobs: old.jobs };
      } else {
        const cached = model.cachedJobs(pipes[i]);
        if (cached) pipes[i] = { ...pipes[i], jobs: cached };
      }
    }
    // Fetch jobs for live pipelines, the status card, and pipelines that just finished or newly failed.
    const runningIndex = pipes.findIndex(isRunning);
    const cardIndex = runningIndex >= 0 ? runningIndex : pipes.length ? 0 : -1;
    const toLoad = new Set<number>();
    if (cardIndex >= 0 && !pipes[cardIndex].jobs.length) toLoad.add(cardIndex);
    pipes.forEach((p, i) => {
      if (isRunning(p)) {
        toLoad.add(i);
        return;
      }
      if (p.jobs.length) return;
      const key = pipelineKey(p);
      const leftActive = wasActive.has(key) && !isRunning(p);
      if (leftActive || (isFailed(p) && !knownPipes.has(key))) toLoad.add(i);
    });
    await Promise.all(
      [...toLoad].map(async (i) => {
        const jobs = await model.jobsForPipeline(pipes[i], isRunning(pipes[i]));
        if (jobs) pipes[i] = settlePipeline({ ...pipes[i], jobs });
      }),
    );

    const now = Date.now();
    for (const [key, until] of this.hiddenRequests) if (until <= now) this.hiddenRequests.delete(key);
    mrs = omitHiddenRequests(mrs, this.hiddenRequests, now);
    this.notifyMergeChanges(mrs);
    this.notifyChanges(pipes);
    this.mrs = mrs;
    this.pipelines = pipes;
    this.cardPipeline = cardIndex >= 0 ? pipes[cardIndex] : null;
    this.error = notes.length ? notes.join(" ") : null;
    this.updated = Date.now();
  }

  /**
   * Compares this refresh with the last one and posts a notification for each change.
   * Ordinary updates wait until the second refresh so launch is quiet. A failure notifies
   * immediately, once, even if it was already waiting.
   */
  private notifyChanges(pipes: Pipeline[]): void {
    if (this.baselineDone) {
      for (const p of pipes) {
        const key = pipelineKey(p);
        const before = this.lastPipelineStatus.get(key);
        const changed = !this.seenPipelineIDs.has(key) || (before != null && before !== p.status);
        if (changed && !isFailed(p)) {
          const recovered =
            isSuccess(p) &&
            (before === "failed" ||
              this.pipelines.some(
                (old) =>
                  old.host === p.host &&
                  old.projectID === p.projectID &&
                  isFailed(old) &&
                  old.id !== p.id &&
                  (p.host !== "github" || old.workflow === p.workflow) &&
                  ((old.ref === p.ref && (p.updated ?? 0) > (old.updated ?? 0)) ||
                    (old.sha !== "" && old.sha === p.sha && p.id > old.id)),
              ));
          const title = recovered ? "Pipeline recovered" : `Pipeline ${p.status.replaceAll("_", " ")}`;
          this.publish(title, `${p.project} #${p.id} · ${refLabel(p)}`, p.status, p.url, key, `${p.project} · #${p.id}`, `Branch: ${refLabel(p)}`, "pipeline");
        }
        for (const j of p.jobs) {
          if (j.status !== "manual") continue;
          const previous = this.lastJobStatus.get(`${key}:${j.id}`);
          if (previous == null || previous === j.status) continue;
          this.publish(
            "Action required",
            `${p.project} #${p.id} · ${j.name}: ${j.status} · ${p.ref}`,
            j.status,
            j.url,
            key,
            `${p.project} · #${p.id}`,
            `${j.name} · ${p.ref}`,
            "logs",
          );
        }
      }
    } else {
      this.baselineDone = true;
    }
    this.announceFailures(pipes);
    for (const p of pipes) {
      const key = pipelineKey(p);
      this.seenPipelineIDs.add(key);
      this.lastPipelineStatus.set(key, p.status);
      for (const j of p.jobs) this.lastJobStatus.set(`${key}:${j.id}`, j.status);
    }
  }

  /** One banner per unresolved pipeline or failed job. Remembered across launches. */
  private announceFailures(pipes: Pipeline[]): void {
    for (const p of unresolvedFailures(pipes)) {
      const key = pipelineKey(p);
      if (!this.store.claimFailure(key)) continue;
      const failedJob = p.jobs.find((j) => j.status === "failed");
      this.publish(
        "Pipeline failed",
        `${p.project} #${p.id} · ${refLabel(p)}`,
        "failed",
        failedJob?.url || p.url,
        key,
        `${p.project} · #${p.id}`,
        failedJob ? `${failedJob.name} failed · ${refLabel(p)}` : `Branch: ${refLabel(p)}`,
        failedJob ? "logs" : "pipeline",
      );
      for (const j of p.jobs) if (j.status === "failed") this.store.claimFailure(`${key}:job:${j.id}`);
    }
    for (const p of pipes) {
      if (isFailed(p)) continue;
      const key = pipelineKey(p);
      for (const j of p.jobs) {
        if (j.status !== "failed" || !this.store.claimFailure(`${key}:job:${j.id}`)) continue;
        this.publish(
          "Job failed",
          `${p.project} #${p.id} · ${j.name}: failed · ${p.ref}`,
          "failed",
          j.url,
          `${p.projectID}:${p.id}`,
          `${p.project} · #${p.id}`,
          `${j.name} · ${p.ref}`,
          "logs",
        );
      }
    }
  }

  private notifyMergeChanges(mrs: MergeRequest[]): void {
    if (!this.baselineDone) return;
    for (const mr of mrs) {
      if (!isReady(mr)) continue;
      const login = mr.host === "github" ? this.githubLogin : this.gitlabLogin;
      if (mr.author && login && mr.author.toLowerCase() !== login.toLowerCase()) continue;
      if (this.mrs.some((old) => mrKey(old) === mrKey(mr) && isReady(old))) continue;
      this.publish(
        "Ready to merge",
        `${mr.project} ${numberLabel(mr)} · ${mr.title}`,
        "success",
        mr.url,
        `mr-${mrKey(mr)}`,
        `${mr.project} · ${numberLabel(mr)}`,
        mr.title,
        "readyMergeRequest",
      );
    }
  }

  private publish(
    title: string,
    detail: string,
    status: string,
    url: string,
    thread: string,
    subtitle: string,
    bannerBody: string,
    kind: NotificationKind,
  ): void {
    this.events = [{ id: randomUUID(), title, detail, status, url, date: Date.now() }, ...this.events].slice(0, 60);
    if (!this.store.prefs.notifications) return;
    notifier.post(title, subtitle, bannerBody, thread, status === "failed", url, kind);
  }

  merge(mr: MergeRequest): void {
    if (this.merging || this.closing) return;
    this.merging = mrKey(mr);
    this.onChange();
    this.enqueue(`Merge ${numberLabel(mr)}`, "Merge complete", "Merge failed", "merged", mr, () => model.merge(mr));
  }

  close(mr: MergeRequest): void {
    if (this.merging || this.closing) return;
    this.closing = mrKey(mr);
    this.onChange();
    this.enqueue(
      `Close ${numberLabel(mr)}`,
      mr.host === "github" ? "PR closed" : "MR closed",
      "Close failed",
      "canceled",
      mr,
      () => model.close(mr),
    );
  }

  private enqueue(
    label: string,
    successTitle: string,
    failureTitle: string,
    successStatus: string,
    mr: MergeRequest,
    job: () => Promise<model.Outcome>,
  ): void {
    this.work = this.work.then(async () => {
      let outcome: model.Outcome;
      try {
        outcome = await job();
      } catch (err) {
        outcome = { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
      const err = outcome.ok ? null : outcome.message;
      this.result = err ? `Failed: ${label} — ${err}` : `Done: ${label}`;
      this.merging = null;
      this.closing = null;
      const subtitle = `${mr.project} · ${numberLabel(mr)}`;
      this.publish(
        err ? failureTitle : successTitle,
        `${subtitle} · ${mr.title}${err ? ` · ${err}` : ""}`,
        err ? "failed" : successStatus,
        mr.url,
        mr.url,
        subtitle,
        err ?? mr.title,
        "mergeRequest",
      );
      if (outcome.ok) {
        // Drop it before the host's open list catches up, and keep a stale response from putting it back.
        this.hiddenRequests.set(mrKey(mr), Date.now() + 60_000);
        this.mrs = this.mrs.filter((item) => mrKey(item) !== mrKey(mr));
      }
      this.onChange();
      await this.refresh();
      // The branch pipeline usually appears a few seconds after the merge API returns.
      if (outcome.ok && successStatus === "merged") {
        setTimeout(() => void this.refresh(), 3_000);
        setTimeout(() => void this.refresh(), 8_000);
      }
    });
  }
}
