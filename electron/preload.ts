import { contextBridge, ipcRenderer } from "electron";

function on(channel: string, cb: (...args: unknown[]) => void): () => void {
  const handler = (_e: unknown, ...args: unknown[]) => cb(...args);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld("tracer", {
  getState: () => ipcRenderer.invoke("tracer:getState"),
  refresh: () => ipcRenderer.invoke("tracer:refresh"),
  setPrefs: (prefs: unknown) => ipcRenderer.invoke("tracer:setPrefs", prefs),
  jobs: (pipelineKey: string, force: boolean) => ipcRenderer.invoke("tracer:jobs", pipelineKey, force),
  merged: (pipelineKey: string) => ipcRenderer.invoke("tracer:merged", pipelineKey),
  log: (pipelineKey: string, job: unknown) => ipcRenderer.invoke("tracer:log", pipelineKey, job),
  mrDetail: (key: string) => ipcRenderer.invoke("tracer:mrDetail", key),
  merge: (key: string, sha: string) => ipcRenderer.invoke("tracer:merge", key, sha),
  close: (key: string, sha: string) => ipcRenderer.invoke("tracer:close", key, sha),
  openExternal: (url: string) => ipcRenderer.invoke("tracer:openExternal", url),
  openNotificationSettings: () => ipcRenderer.invoke("tracer:openNotificationSettings"),
  testNotification: (): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke("tracer:testNotification"),
  copy: (text: string) => ipcRenderer.invoke("tracer:copy", text),
  fit: (width: number, height: number) => ipcRenderer.invoke("tracer:fit", width, height),
  hide: () => ipcRenderer.invoke("tracer:hide"),
  quit: () => ipcRenderer.invoke("tracer:quit"),
  onState: (cb: (state: unknown) => void) => on("tracer:state", (s) => cb(s)),
  onHidden: (cb: () => void) => on("tracer:hidden", () => cb()),
  onShown: (cb: () => void) => on("tracer:shown", () => cb()),
});
