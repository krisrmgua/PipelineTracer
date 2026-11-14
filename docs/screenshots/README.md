# Screenshot gallery

Screenshots of the current Electron interface on macOS, using fictional projects, accounts, jobs, and values. No personal data or live credentials are used.

These are captures of `dist/index.html` built from the repository’s actual `src/ui` code. The layout, typography, colors, controls, and dialogs come from the app. A separate Electron entry point supplies synthetic state through a mock preload bridge; it never starts the production main process. Network requests are blocked, and application data goes to a temporary directory. Merge, close, refresh, and open-in-browser actions are inert.

No installed app or sign-in is needed, and the capture does not call GitLab or GitHub. Sample projects, accounts, jobs, and values are fictional. There are no AI-generated interface images.

Captured from version **0.3.7**, source revision `0baa5eb`.


## Menu-bar icons and views

[Open the complete menu-bar gallery](../menu-bar.md), including the actual icon artwork and supported display states.


## Recreate

From the repository root, after installing dependencies:

```bash
npm install
npm run build:ui
npm run build:electron
npx electron scripts/screenshots.cjs
```

Run this on macOS with a graphical session for the same fonts and platform controls. The capture window is hidden and uses a 2× device scale. Other platforms can render different fonts and native controls. Dates and relative times are sample data and may differ when recaptured.

`scripts/screenshots/fixture.cjs` defines every sample and the click sequence. `preload.cjs` provides the isolated mock bridge. `manifest.json` lists each image, its purpose, and its pixel size. Do not replace the fixture bridge with the production preload when capturing public documentation.

## Menu-bar sheet

`menu.cjs` calls the production menu-bar renderer with synthetic values and arranges the rendered PNGs on a labeled background. This sheet demonstrates the actual styles without exposing the rest of a desktop.

## Views

### Menu Bar

Actual menu-bar renderer with synthetic values, arranged on a presentation backdrop.

![Actual menu-bar renderer with synthetic values, arranged on a presentation backdrop.](menu-bar.png)

### Overview

Activity inbox with failures, simultaneous pipelines, and requests in different states.

![Activity inbox with failures, simultaneous pipelines, and requests in different states.](overview.png)

### Running Pipeline

Running pipeline with completed, running, and queued jobs.

![Running pipeline with completed, running, and queued jobs.](running-pipeline.png)

### Pipeline

Pipeline detail with per-stage progress and job durations.

![Pipeline detail with per-stage progress and job durations.](pipeline.png)

### Job Logs

Failed-job trace in the actual log viewer.

![Failed-job trace in the actual log viewer.](job-logs.png)

### Job Summary

Job summary and the link to the CI host.

![Job summary and the link to the CI host.](job-summary.png)

### Merge Request

Ready merge request workspace, checks, source/target, and actions.

![Ready merge request workspace, checks, source/target, and actions.](merge-request.png)

### Merge Confirmation

Merge confirmation before the host is rechecked.

![Merge confirmation before the host is rechecked.](merge-confirmation.png)

### Close Confirmation

Separate close-request confirmation.

![Separate close-request confirmation.](close-confirmation.png)

### Running Request

Request with running checks and disabled merge action.

![Request with running checks and disabled merge action.](running-request.png)

### Draft Request

Draft request workspace keeps merge disabled.

![Draft request workspace keeps merge disabled.](draft-request.png)

### History

Recent successes and their expandable job lists.

![Recent successes and their expandable job lists.](history.png)

### Success Jobs

Expanded successful run with individual job results.

![Expanded successful run with individual job results.](success-jobs.png)

### Notifications

Notification inbox with status filters.

![Notification inbox with status filters.](notifications.png)

### Settings

Preferences, notifications, startup, refresh cadence, and tool status.

![Preferences, notifications, startup, refresh cadence, and tool status.](settings.png)
