import { app, BrowserWindow, clipboard, ipcMain, Menu, nativeImage, screen, shell, Tray } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Controller } from "./controller";
import { trayIconPng } from "./icons";
import {
  browserURL,
  mrKey,
  pipelineKey,
  isRunning,
  progressState,
  ringSlicesForPipeline,
  refLabel,
  mrBarTone,
  trayCounts,
  isDone,
  type Job,
  type MergeRequest,
  type Pipeline,
  type Prefs,
} from "./logic";
import * as model from "./model";
import * as notifier from "./notifier";
import { discoverPath } from "./shell";
import { Store } from "./store";
import { trayCapsulePng } from "./trayCapsule";

const APP_ID = "com.kris.pipelinetracer";
const isDev = process.env.PIPELINE_TRACER_DEV === "1";
const isMac = process.platform === "darwin";

const INBOX_WIDTH = 430;
const MIN_HEIGHT = 160;
const MAX_HEIGHT = 700;

let tray: Tray | null = null;
let panel: BrowserWindow | null = null;
let store: Store;
let controller: Controller;
let lastTrayKey = "";

let panelAddress = "";

/** Dev server URL from the environment. Only a loopback Vite address is accepted. */
function loopbackDevUrl(raw: string | undefined): string {
  let parsed: URL;
  try {
    parsed = new URL(raw ?? "");
  } catch {
    throw new Error("Dev mode needs the Vite server URL in the environment.");
  }
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
  const web = parsed.protocol === "https:" || parsed.protocol === "http:";
  if (!loopback || !web) throw new Error("The dev panel only loads from the loopback Vite server.");
  return parsed.href;
}

function loadPanel(win: BrowserWindow): void {
  if (isDev) {
    panelAddress = loopbackDevUrl(process.env.PIPELINE_TRACER_DEV_SERVER);
    void win.loadURL(panelAddress);
    return;
  }
  const file = path.join(app.getAppPath(), "dist", "index.html");
  panelAddress = pathToFileURL(file).href;
  void win.loadFile(file);
}

function createPanel(): BrowserWindow {
  const win = new BrowserWindow({
    width: INBOX_WIDTH,
    height: 450,
    show: false,
    frame: false,
    resizable: false,
    useContentSize: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    backgroundColor: "#0e1a29",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  loadPanel(win);
  // Clicking away closes the panel, like the Swift popover.
  win.on("blur", () => {
    if (!isDev) win.hide();
  });
  win.on("hide", () => win.webContents.send("tracer:hidden"));
  // Links inside the panel never navigate the panel itself.
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e, url) => {
    if (url !== panelAddress) e.preventDefault();
  });
  return win;
}

function maxPanelHeight(): number {
  const point = tray ? tray.getBounds() : screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint({ x: point.x, y: point.y });
  return Math.min(MAX_HEIGHT, display.workArea.height - 40);
}

function fitPanel(width: number, height: number): void {
  if (!panel) return;
  const w = Math.round(Math.min(Math.max(width, 320), 720));
  const h = Math.round(Math.min(Math.max(height, MIN_HEIGHT), maxPanelHeight()));
  const [cw, ch] = panel.getContentSize();
  if (cw === w && ch === h) return;
  panel.setContentSize(w, h);
  if (panel.isVisible()) positionPanel(panel);
}

function positionPanel(win: BrowserWindow): void {
  if (!tray) return;
  const trayBounds = tray.getBounds();
  const winBounds = win.getBounds();
  const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });
  const wa = display.workArea;
  let x = Math.round(trayBounds.x + trayBounds.width / 2 - winBounds.width / 2);
  // macOS: under the menu bar. Windows: above the taskbar, or below it when the taskbar is on top.
  const taskbarOnTop = !isMac && trayBounds.y < wa.y + wa.height / 2;
  let y =
    isMac || taskbarOnTop
      ? Math.round(trayBounds.y + trayBounds.height + 4)
      : Math.round(trayBounds.y - winBounds.height - 4);
  x = Math.min(Math.max(x, wa.x + 8), wa.x + wa.width - winBounds.width - 8);
  y = Math.min(Math.max(y, wa.y + 8), wa.y + wa.height - winBounds.height - 8);
  win.setPosition(x, y, false);
}

function togglePanel(): void {
  if (!panel) panel = createPanel();
  if (panel.isVisible()) {
    panel.hide();
    return;
  }
  positionPanel(panel);
  panel.show();
  panel.focus();
  panel.webContents.send("tracer:shown");
  void controller.refresh();
}

function broadcast(): void {
  void updateTray();
  panel?.webContents.send("tracer:state", controller.snapshot());
}

/** Swift MenuBarCapsule on Mac; bare ring on Windows (taskbar icon slot is square). */
async function trayImage(
  requests: number,
  running: number,
  failed: number,
  tone: ReturnType<typeof mrBarTone> = "none",
  stacked = false,
): Promise<Electron.NativeImage> {
  const [status, progress] = progressState(controller.cardPipeline);
  const slices = ringSlicesForPipeline(controller.cardPipeline);
  if (isMac) {
    const { png, width, height } = await trayCapsulePng(status, progress, false, {
      mergeRequests: requests,
      running,
      failed,
      mrTone: tone,
    }, slices, stacked);
    return nativeImage.createFromBuffer(png, { scaleFactor: 2, width, height });
  }
  const size = 16;
  const failing = failed > 0;
  const image = nativeImage.createEmpty();
  image.addRepresentation({
    scaleFactor: 1,
    width: size,
    height: size,
    buffer: trayIconPng(status, progress, failing, size, slices),
  });
  image.addRepresentation({
    scaleFactor: 2,
    width: size * 2,
    height: size * 2,
    buffer: trayIconPng(status, progress, failing, size * 2, slices),
  });
  return image;
}

async function updateTray(): Promise<void> {
  if (!tray || !controller) return;
  const { requests, running, failed } = trayCounts(controller.pipelines, controller.mrs);
  const tone = mrBarTone(controller.mrs);
  const [status, progress] = progressState(controller.cardPipeline);
  const card = controller.cardPipeline;
  const shining = card != null && isRunning(card) && card.jobs.some((j) => j.status === "running");
  const stacked = isMac && store.prefs.stackMenuBar;
  const key = `${status}|${progress.toFixed(2)}|${requests}|${running}|${failed}|${tone}|${stacked}|${shining ? Math.floor(Date.now() / 180) : 0}`;
  if (key !== lastTrayKey) {
    lastTrayKey = key;
    tray.setImage(await trayImage(requests, running, failed, tone, stacked));
  }
  // Counters live inside the capsule image on Mac (Swift parity). Clear any title.
  if (isMac) tray.setTitle("");

  const lines = [`Pipeline Tracer: ${requests} requests · ${running} running · ${failed} failed`];
  const p = controller.cardPipeline;
  if (p) {
    const done = p.jobs.filter((j) => isDone(j.status)).length;
    lines.push(`${p.project} #${p.id} · ${refLabel(p)}`, p.jobs.length ? `${p.status} · ${done}/${p.jobs.length} jobs finished` : p.status);
  } else {
    lines.push("No recent pipelines");
  }
  // Windows caps tray tooltips at 127 characters.
  const tip = lines.join("\n");
  tray.setToolTip(isMac ? tip : tip.slice(0, 127));
}

function applyLoginItem(prefs: Prefs): void {
  if (!app.isPackaged) return;
  if (process.platform !== "darwin" && process.platform !== "win32") return;
  app.setLoginItemSettings({ openAtLogin: prefs.startAtLogin });
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

function findPipeline(key: unknown): Pipeline | null {
  if (typeof key !== "string") return null;
  return controller.pipelines.find((p) => pipelineKey(p) === key) ?? null;
}

/** The panel sends keys, never raw API paths; requests come from the main process's own snapshot. */
function findRequest(key: unknown, sha: unknown): MergeRequest | null {
  if (typeof key !== "string") return null;
  const mr = controller.mrs.find((m) => mrKey(m) === key);
  if (!mr) return null;
  // The SHA the user reviewed in the detail view wins, so a push since then blocks the merge.
  return typeof sha === "string" && /^[0-9a-f]{7,64}$/i.test(sha) ? { ...mr, sha } : mr;
}

function wireIpc(): void {
  ipcMain.handle("tracer:getState", () => controller.snapshot());

  ipcMain.handle("tracer:refresh", () => {
    controller.schedule();
    void controller.refresh();
  });

  ipcMain.handle("tracer:setPrefs", (_e, input: Partial<Prefs>) => {
    const before = store.prefs;
    const after = store.setPrefs(input ?? {});
    applyLoginItem(after);
    controller.prefsChanged(before, after);
    return after;
  });

  ipcMain.handle("tracer:jobs", async (_e, key: unknown, force: unknown) => {
    const p = findPipeline(key);
    if (!p) return null;
    const jobs = await model.jobsForPipeline(p, force === true);
    if (jobs && typeof key === "string") controller.noteJobs(key, jobs);
    return jobs;
  });

  ipcMain.handle("tracer:log", async (_e, key: unknown, job: Job) => {
    const p = findPipeline(key);
    if (!p || !job || !isInt(job.id)) return null;
    return model.jobTrace(job, p);
  });

  ipcMain.handle("tracer:mrDetail", async (_e, key: unknown) => {
    const mr = findRequest(key, null);
    return mr ? model.mrDetail(mr) : null;
  });

  ipcMain.handle("tracer:merge", (_e, key: unknown, sha: unknown) => {
    const mr = findRequest(key, sha);
    if (!mr || !mr.canMerge || !store.prefs.mergeButton) return false;
    controller.merge(mr);
    return true;
  });

  ipcMain.handle("tracer:close", (_e, key: unknown, sha: unknown) => {
    const mr = findRequest(key, sha);
    if (!mr) return false;
    controller.close(mr);
    return true;
  });

  ipcMain.handle("tracer:openExternal", (_e, url: unknown) => {
    const target = typeof url === "string" ? browserURL(url) : null;
    if (target) void shell.openExternal(target);
  });

  ipcMain.handle("tracer:openNotificationSettings", () => {
    void shell.openExternal(
      isMac ? "x-apple.systempreferences:com.apple.Notifications-Settings.extension" : "ms-settings:notifications",
    );
  });

  ipcMain.handle("tracer:testNotification", async () => {
    if (!store.prefs.notifications) return { ok: false, message: "Notifications are off." };
    // macOS suppresses banners for the frontmost app — drop the panel first.
    if (panel && !panel.isDestroyed() && panel.isVisible()) {
      panel.hide();
      await new Promise((r) => setTimeout(r, 400));
    }
    return notifier.preview();
  });

  ipcMain.handle("tracer:copy", (_e, text: unknown) => {
    if (typeof text === "string") clipboard.writeText(text);
  });

  ipcMain.handle("tracer:fit", (_e, width: unknown, height: unknown) => {
    if (typeof width === "number" && typeof height === "number" && Number.isFinite(width) && Number.isFinite(height)) {
      fitPanel(width, height);
    }
  });

  ipcMain.handle("tracer:hide", () => panel?.hide());
  ipcMain.handle("tracer:quit", () => app.quit());
}

async function boot(): Promise<void> {
  if (isMac) app.dock?.hide();
  store = new Store();
  controller = new Controller(store, broadcast);
  applyLoginItem(store.prefs);

  tray = new Tray(await trayImage(0, 0, 0));
  // The ring fill depends on how long the current job has been running.
  setInterval(() => {
    const live = controller?.pipelines.some((p) => isRunning(p) && p.jobs.some((j) => j.status === "running"));
    if (live) void updateTray();
  }, 180);
  tray.setToolTip("Pipeline Tracer");
  if (isMac) tray.setTitle("");
  tray.on("click", () => togglePanel());
  tray.on("right-click", () => {
    const menu = Menu.buildFromTemplate([
      { label: "Open Pipeline Tracer", click: () => togglePanel() },
      { label: "Refresh now", click: () => void controller.refresh() },
      { type: "separator" },
      { label: "Quit Pipeline Tracer", click: () => app.quit() },
    ]);
    tray?.popUpContextMenu(menu);
  });

  wireIpc();
  panel = createPanel();

  await discoverPath();
  controller.schedule();
  void controller.refresh();
}

app.setName("Pipeline Tracer");
if (process.platform === "win32") app.setAppUserModelId(APP_ID);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(() => void boot());
  app.on("second-instance", () => togglePanel());
  app.on("before-quit", () => controller?.stop());
  // Tray app: stay alive with no windows.
  app.on("window-all-closed", () => {});
}
