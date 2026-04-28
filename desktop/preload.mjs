import { contextBridge, ipcRenderer } from "electron";

const scienceswarmDesktopBridge = Object.freeze({
  shell: "electron",
  getDiagnostics() {
    return ipcRenderer.invoke("scienceswarm:desktop-diagnostics");
  },
});

contextBridge.exposeInMainWorld("scienceswarmDesktop", scienceswarmDesktopBridge);

export { scienceswarmDesktopBridge };
