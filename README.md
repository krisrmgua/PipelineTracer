# Pipeline Tracer

Pipeline Tracer is a tray app for **macOS** and **Windows** that tracks your CI activity: GitLab.com merge requests and pipelines, GitHub Actions runs on repos you recently pushed, GitHub pull requests you opened, failed jobs, and a merge button that re-checks the host before it merges. Preferences can show every open request in a chosen repo. The merge button stays hidden when you cannot merge.

The panel is a dark activity inbox. Failures stay at the top until a later pipeline for that same commit succeeds. Clicking away closes the panel. The next open returns to the overview unless you turn on **Reopen where I left off**.

The app is built with Electron and TypeScript. The original Swift menu-bar app still lives in `menubar/` (see [Legacy Swift app](#legacy-swift-app)).

Pipeline Tracer reads data through two command-line tools you sign in to yourself:

- [`glab`](https://gitlab.com/gitlab-org/cli), signed in to `gitlab.com`, for GitLab
- [`gh`](https://cli.github.com/), signed in to `github.com`, for GitHub

You only need one of them. If one host isn't signed in, its sections stay empty until you log in.


## Menu-bar previews

Actual status icons for passed, running, queued, failed, canceled, and skipped work, plus populated and quiet counter capsules. Zero counters disappear while the icon remains.

<a href="docs/screenshots/menu-bar.png"><img src="docs/screenshots/menu-bar.png" alt="Actual status icons for passed, running, queued, failed, canceled, and skipped work, plus populated and quiet counter capsules. Zero counters disappear while the icon remains." width="540" /></a>

The labeled sheets enlarge the app’s actual rendered artwork 2× for detail. The neutral backdrops are presentation surfaces, not captures of a personal desktop.

[Full menu-bar gallery and regeneration instructions](docs/menu-bar.md)

## Screenshots

Screenshots of the current Electron interface on macOS, using fictional projects, accounts, jobs, and values. No personal data or live credentials are used.

<a href="docs/screenshots/overview.png"><img src="docs/screenshots/overview.png" alt="PipelineTracer main view with sample data" width="460" /></a>

The gallery includes detail views, settings, and available actions. Click an image for the full-resolution capture.

<details>
<summary>View dashboard screenshots</summary>

| Menu Bar | Overview |
| --- | --- |
| <a href="docs/screenshots/menu-bar.png"><img src="docs/screenshots/menu-bar.png" alt="Actual menu-bar renderer with synthetic values, arranged on a presentation backdrop." width="360" /></a><br>Actual menu-bar renderer with synthetic values, arranged on a presentation backdrop. | <a href="docs/screenshots/overview.png"><img src="docs/screenshots/overview.png" alt="Activity inbox with failures, simultaneous pipelines, and requests in different states." width="360" /></a><br>Activity inbox with failures, simultaneous pipelines, and requests in different states. |

| Running Pipeline | Pipeline |
| --- | --- |
| <a href="docs/screenshots/running-pipeline.png"><img src="docs/screenshots/running-pipeline.png" alt="Running pipeline with completed, running, and queued jobs." width="360" /></a><br>Running pipeline with completed, running, and queued jobs. | <a href="docs/screenshots/pipeline.png"><img src="docs/screenshots/pipeline.png" alt="Pipeline detail with per-stage progress and job durations." width="360" /></a><br>Pipeline detail with per-stage progress and job durations. |

| Job Logs | Job Summary |
| --- | --- |
| <a href="docs/screenshots/job-logs.png"><img src="docs/screenshots/job-logs.png" alt="Failed-job trace in the actual log viewer." width="360" /></a><br>Failed-job trace in the actual log viewer. | <a href="docs/screenshots/job-summary.png"><img src="docs/screenshots/job-summary.png" alt="Job summary and the link to the CI host." width="360" /></a><br>Job summary and the link to the CI host. |

| Merge Request | Merge Confirmation |
| --- | --- |
| <a href="docs/screenshots/merge-request.png"><img src="docs/screenshots/merge-request.png" alt="Ready merge request workspace, checks, source/target, and actions." width="360" /></a><br>Ready merge request workspace, checks, source/target, and actions. | <a href="docs/screenshots/merge-confirmation.png"><img src="docs/screenshots/merge-confirmation.png" alt="Merge confirmation before the host is rechecked." width="360" /></a><br>Merge confirmation before the host is rechecked. |

| Close Confirmation | Running Request |
| --- | --- |
| <a href="docs/screenshots/close-confirmation.png"><img src="docs/screenshots/close-confirmation.png" alt="Separate close-request confirmation." width="360" /></a><br>Separate close-request confirmation. | <a href="docs/screenshots/running-request.png"><img src="docs/screenshots/running-request.png" alt="Request with running checks and disabled merge action." width="360" /></a><br>Request with running checks and disabled merge action. |

| Draft Request | History |
| --- | --- |
| <a href="docs/screenshots/draft-request.png"><img src="docs/screenshots/draft-request.png" alt="Draft request workspace keeps merge disabled." width="360" /></a><br>Draft request workspace keeps merge disabled. | <a href="docs/screenshots/history.png"><img src="docs/screenshots/history.png" alt="Recent successes and their expandable job lists." width="360" /></a><br>Recent successes and their expandable job lists. |

| Success Jobs | Notifications |
| --- | --- |
| <a href="docs/screenshots/success-jobs.png"><img src="docs/screenshots/success-jobs.png" alt="Expanded successful run with individual job results." width="360" /></a><br>Expanded successful run with individual job results. | <a href="docs/screenshots/notifications.png"><img src="docs/screenshots/notifications.png" alt="Notification inbox with status filters." width="360" /></a><br>Notification inbox with status filters. |

| Settings |  |
| --- | --- |
| <a href="docs/screenshots/settings.png"><img src="docs/screenshots/settings.png" alt="Preferences, notifications, startup, refresh cadence, and tool status." width="360" /></a><br>Preferences, notifications, startup, refresh cadence, and tool status. |  |

</details>

The menu-bar sheet uses the app’s actual drawing code with sample values, arranged on a neutral backdrop. It is not a capture of a personal desktop.

[How these screenshots are made](docs/screenshots/README.md)

---

## Requirements

| | macOS | Windows |
|---|---|---|
| OS | macOS 13 (Ventura) or later, Apple silicon or Intel | Windows 10 or 11 |
| Node.js | 20 or newer, to build | 20 or newer, to build |
| CLIs | `glab` and/or `gh` | `glab` and/or `gh` |
| Script | `scripts/install.sh` | `scripts\install.ps1` (PowerShell 5+) |

---

## Install glab and gh

Pipeline Tracer does not ask for a password and does not store a personal access token. `glab` and `gh` own the tokens. The app runs them as child processes, the same way you would in a terminal.

### macOS

```bash
brew install glab gh
glab auth login --hostname gitlab.com
gh auth login --hostname github.com
```

### Windows

Use one of these package managers in PowerShell. winget ships with Windows 10 and 11.

```powershell
# winget
winget install --id glab.glab
winget install --id GitHub.cli

# or Scoop
scoop install glab gh

# or Chocolatey (admin PowerShell)
choco install glab gh
```

Open a **new** PowerShell window so `PATH` picks up the tools, then sign in:

```powershell
glab auth login --hostname gitlab.com
gh auth login --hostname github.com
```

You can also install by hand: the [GitHub CLI MSI](https://github.com/cli/cli/releases/latest), and the [glab Windows release](https://gitlab.com/gitlab-org/cli/-/releases) (put `glab.exe` in a folder on your `PATH`).

### Where the app looks for them

Apps started from Finder, as a login item, or from the Start menu often get a short `PATH`. Pipeline Tracer searches:

- its own `PATH`, plus your login shell's `PATH` on macOS, or your current user and machine `PATH` from the registry on Windows (so a fresh install works without signing out)
- macOS: `/opt/homebrew/bin`, `/usr/local/bin`, `/opt/local/bin`, `~/.local/bin`, `~/bin`
- Windows: `Program Files\GitHub CLI`, `Program Files\glab`, `%LOCALAPPDATA%\Programs\glab`, `%LOCALAPPDATA%\Microsoft\WinGet\Links`, `%USERPROFILE%\scoop\shims`, `%ProgramData%\chocolatey\bin`

**Preferences → Command-line tools** shows the path it found for each one, or "Not found on PATH". If a tool is missing, the app checks again about once a minute, so installing it while the app runs works.

### glab: tokens and scopes

When `glab auth login` asks for a token, create one in GitLab under **Preferences → Access Tokens**, or use the browser login `glab` offers. The app always calls `glab api --hostname gitlab.com`, so the token has to be for `gitlab.com`. A token for a self-managed host is not used.

- `read_api` lists merge requests, pipelines, jobs, and logs
- `api` is needed for the in-app **Merge** and **Close** buttons

You can install with `read_api` only. Turn off **Show merge actions** and merge in the browser.

Check the login before you open the app:

```bash
glab auth status
glab api user
```

`glab api user` should print your GitLab user. If it fails, Tracer has nothing to show for GitLab. `glab` keeps the token in its own config (`~/.config/glab-cli` on macOS, `%APPDATA%\glab-cli` on Windows).

### gh: tokens and scopes

Choose **GitHub.com** when `gh auth login` asks which host. A GitHub Enterprise token is not used. You can sign in through the browser or paste a token from **Settings → Developer settings → Personal access tokens**.

- A classic token with the `repo` scope covers private repos, Actions runs, job logs, pull requests, merge, and close.
- A fine-grained token needs **Actions: Read** and **Pull requests: Read and write** on the repos you want in the panel.
- Read-only access still lists runs and pull requests. Merge and close fail until the token can write pull requests.

```bash
gh auth status
gh api --hostname github.com user
```

`gh` keeps the token in the macOS keychain or Windows Credential Manager (or in its config folder when you paste one). Tracer caches your login name for an hour. If `gh` fails, GitHub stays empty and GitLab still loads.

The app never approves a review, never reruns a workflow, and never deletes a branch.

---

## Install the app on macOS

```bash
node -v   # v20 or newer; brew install node if missing
git clone https://github.com/krisrmgua/GitLabTracer.git
cd GitLabTracer
./scripts/install.sh
```

`install.sh`:

1. runs `npm install` and `npm run pack:mac` (electron-builder writes `release/mac-*/Pipeline Tracer.app`)
2. stops any running copy, including the old Swift build
3. removes a leftover Swift/older Electron LaunchAgent if present
4. copies the app to `~/Applications/Pipeline Tracer.app` and opens it
5. writes a helper, `~/bin/pipeline-tracer start|stop|status` (put `~/bin` on your `PATH` to use it)

Run it again to update. The bundle id is `com.kris.pipelinetracer`.

The build is ad-hoc and not notarized. The script clears the quarantine flag on the copy it installs. If macOS still blocks it, right-click the app in `~/Applications` → **Open** → **Open**.

Login start is **Preferences → Open at login** (Electron login item, default on). Turn it off there.

## Install the app on Windows

```powershell
node -v   # v20 or newer; winget install OpenJS.NodeJS.LTS if missing
git clone https://github.com/krisrmgua/GitLabTracer.git
cd GitLabTracer
.\scripts\install.ps1
```

If PowerShell blocks the script, run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once.

`install.ps1`:

1. warns if `glab` or `gh` is missing, with the winget command for each
2. stops a running copy
3. runs `npm install` and `npm run pack:win` (electron-builder writes an NSIS setup `.exe` under `release\`)
4. starts the setup wizard and waits for it

The installer is not code-signed, so SmartScreen may say "Windows protected your PC". Choose **More info → Run anyway** if you built it yourself.

Windows often hides new tray icons. Click the **^** overflow arrow by the clock and drag Pipeline Tracer onto the taskbar. The app turns on open at login the first time it runs. Change it under **Preferences → Open at login**.

Uninstall from **Settings → Apps → Pipeline Tracer**. Settings in `%APPDATA%\Pipeline Tracer` stay until you delete that folder.

---

## The tray icon

The icon is a ring for the pipeline the status card follows: the newest running pipeline, otherwise the newest one. Its color is that pipeline's state and the arc is how many of its jobs have finished.

| State | Icon |
|---|---|
| Passed | green ring |
| Running | orange ring |
| Waiting, no data | gray ring |
| Any unresolved failure | solid red disc with a white `!` |

On **macOS** the counts sit next to the icon in the menu bar: `MR 3 │ Run 1 │ Fail 2`. A count only shows when it is above zero. **Run** is cyan and **Fail** is bold red.

On **Windows** the tray has no room for text, so the counts are in the tooltip. Hover the icon for `Pipeline Tracer: 3 requests · 1 running · 2 failed` and the status-card pipeline.

Left-click opens or closes the panel. Right-click shows **Open**, **Refresh now**, and **Quit**.

## The panel

The overview groups activity into:

- **Attention needed**: the latest failed pipeline on a branch. A newer successful pipeline for the same commit clears it. A success on a different commit does not. On GitHub, only the same workflow clears it.
- **Active**: pipelines that are running, queued, waiting, or need a manual action.
- **Requests**: GitLab merge requests and GitHub pull requests you opened, with draft, blocked, and ready state. A `#` number is GitHub. A `!` number is GitLab. Preferences can switch a repo to every open request. The author is shown on those rows.
- **Recent successes**: opens a list of passed pipelines in the history window plus merges from this session. Click one to see its jobs.
- **Canceled & skipped**: collapsed until you open it.

A GitLab merge-request pipeline and the branch pipeline for the same change show as one card.

Open a pipeline for its jobs, grouped by stage on a sideways track. GitHub uses each Actions job name as the stage. Open a job for a log snapshot (the newest 250,000 characters). Logs can be filtered and copied. They are not saved to disk. GitHub sometimes sends a log as a zip; the panel tells you to open the job in the browser instead.

Open a request for its description, source and target branches, author, and pipeline or check runs. **Escape** goes back, and on the overview it closes the panel.

### Merge and Close

**Merge** asks you to confirm, then reloads the request and only continues when it is still open, not a draft, and mergeable, and the source SHA still matches what you were looking at. GitLab sends that SHA with `PUT` through `glab`. GitHub sends it with `PUT` through `gh` and uses merge, squash, or rebase depending on what the repo allows. One merge runs at a time. A notification never merges for you. The button follows **Show merge actions**, and it stays hidden when you do not have permission to merge into that repo. Close stays available.

**Close** sits beside Merge. It always asks you to confirm, then closes the merge request or pull request. It does not delete the source branch.

### Notifications

Banners are titled **Pipeline Tracer**. Failures play the default sound. Each unresolved failure notifies once, including failures already there at launch, and the app remembers which ones it has announced across restarts. "Ready to merge", recoveries, and merge results notify too, starting from the second refresh so launch stays quiet. Clicking a banner opens that event's GitLab or GitHub page.

The bell in the panel lists this session's events, filtered by **All**, **Pipelines**, or **Merges**. **Preferences → Show notifications** turns banners on or off; the bell list stays. **Send test** posts a sample banner when notifications are on. **Notification settings** opens the OS settings page so you can allow banners.

### Preferences

| Item | Default |
|---|---|
| Reopen where I left off | Off. Closing the panel returns to the overview. |
| Refresh interval | 60 seconds. Choices: 10, 20, 30, 40, 50, 60. |
| Completion history | 2 hours. Choices: 1, 2, 4, 6, 8, 12, 24. Covers GitLab pipelines and GitHub Actions runs. Open requests are not cut off by it. |
| Show merge actions | On. Covers GitLab merge requests and GitHub pull requests. Hidden on a request you cannot merge. |
| Stack menu bar counters | On. macOS only. Puts MR, Run, and Fail on separate lines beside the ring to save menu bar width. |
| Show All Merge Requests, per repo | Off. Lists requests you opened. On lists every open request in that repo (up to 20). The list is the 100 GitLab projects you belong to with the newest activity, and the 100 GitHub repos you can access that were pushed most recently. |
| Open at login | On. macOS and Windows both use the Electron login item. |
| Show notifications | On. Off stops banners. The bell list still records events. |

Preferences are saved in `pipelinetracer.json` in the app data folder:

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/Pipeline Tracer/data/pipelinetracer.json` |
| Windows | `%APPDATA%\Pipeline Tracer\data\pipelinetracer.json` |

They are not credentials. Delete the file to reset.

## How it works

On each refresh, Tracer asks GitLab.com through `glab` for:

- open merge requests you created (one GraphQL query, up to 30; archived projects dropped). A repo switched on in Preferences adds that project's open merge requests, up to 20, in one more query
- your recent pipelines across projects (`GET /pipelines`, one call instead of one per project)
- jobs only for the status-card pipeline, newly failed pipelines, pipelines that just finished, or when you open one (cached while status and SHA stay the same)

GitHub has no single "all of my workflow runs" endpoint. Tracer asks `gh` for the 30 repos you pushed most recently, keeps that list for 10 minutes, then loads the 20 newest Actions runs on the ones pushed inside the history window (at most 12 repos). If nothing was pushed in that window, it checks the 8 most recently pushed repos instead. A scheduled workflow on a repo outside that set doesn't appear until the repo is pushed again. Open pull requests you created come from one GraphQL call, up to 30. A repo switched on in Preferences adds that repository's open pull requests, up to 20.

Your GitLab username and GitHub login are cached for an hour.

---

## Develop

```bash
npm install
npm run dev      # Vite on 127.0.0.1:5173 + Electron; the panel does not hide on blur
npm run check    # self-check: status rules, dates, notification text, GitHub mapping, icons
npm run build    # typecheck, then build the panel (dist/) and main process (dist-electron/)
npm start        # build, then run Electron against dist/
```

| Script | Purpose |
|---|---|
| `npm run pack:mac` | `release/mac-*/Pipeline Tracer.app` and a zip |
| `npm run pack:win` | `release/Pipeline Tracer Setup <version>.exe` |
| `npm run icons` | Render `assets/icon.png` from `electron/icons.ts` (the pack scripts run this) |

`npm run check` needs no network and does not call `glab` or `gh`.

## Layout

| Path | What |
|---|---|
| `electron/main.ts` | Tray, panel window, IPC |
| `electron/controller.ts` | Refresh timer, change detection, notifications, merge queue |
| `electron/model.ts` | GitLab and GitHub calls through `glab` and `gh` |
| `electron/shell.ts` | Finding `glab` and `gh`, running them without a shell |
| `electron/logic.ts` | Pure rules shared with the panel (status, grouping, parsing) |
| `electron/icons.ts`, `png.ts` | Tray ring and app icon, drawn in code |
| `electron/selfcheck.ts` | `npm run check` |
| `src/ui/` | Panel HTML, CSS, TypeScript |
| `scripts/` | `install.sh`, `install.ps1`, `make-icon.cjs` |
| `menubar/` | Legacy Swift app |

## Legacy Swift app

`menubar/` is the original macOS-only Swift Package Manager app. It still builds:

```bash
cd menubar
swift run PipelineTracer --self-check
./install.sh
```

Both apps install to `~/Applications/Pipeline Tracer.app` with the same bundle id, so whichever installer ran last wins. The Electron installer removes the old LaunchAgent and uses **Open at login** instead. The Electron app does not read the Swift app's UserDefaults, so set your preferences again after switching.

## Version

The shipping version lives in `package.json` → `version`. Electron Builder embeds it, so the panel footer/header (`vX.Y.Z`) matches `app.getVersion()`.

**Do not bump the version in feature PRs.** Every merge to `main` runs [`.github/workflows/bump-version.yml`](.github/workflows/bump-version.yml), which:

1. Bumps the **patch** (for example `0.3.9` → `0.3.10`)
2. Opens a short-lived release PR and squash-merges it as `chore: release X.Y.Z [skip ci]`
3. Tags `vX.Y.Z` on `main`

The `[skip ci]` marker stops the bump job from looping on its own commit.


## License

[MIT](LICENSE). Copyright 2026 Kristopher Simmons.
