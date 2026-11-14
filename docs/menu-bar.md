# Menu-bar gallery

Every icon and capsule is produced by the app’s real drawing functions. Sample values are fictional. Labeled sheets enlarge the rendered PNGs 2×. No account data, credentials, or live pipeline state is read. The entry point never starts the production backend and blocks network requests.

## Regenerate only menu-bar previews

```bash
npm install
npm run build:electron
npx electron scripts/menu-screenshots.cjs
```

Run on macOS for the same renderer/font environment. `scripts/screenshots/menu.cjs` defines examples and calls production drawing functions; `menu-board.cjs` supplies presentation labels and backdrops. `docs/screenshots/menu-manifest.json` records the generated image dimensions. The regular full screenshot command also includes these menu previews.

## Menu Bar

Production menu-bar icons for passed, running, queued, failed, canceled, and skipped states, plus populated and quiet counter capsules.

![Production menu-bar icons for passed, running, queued, failed, canceled, and skipped states, plus populated and quiet counter capsules.](screenshots/menu-bar.png)
