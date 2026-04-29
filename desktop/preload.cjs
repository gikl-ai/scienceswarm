/* eslint-disable @typescript-eslint/no-require-imports */

const { contextBridge, ipcRenderer } = require("electron");

const scienceswarmDesktopBridge = Object.freeze({
  shell: "electron",
  getDiagnostics() {
    return ipcRenderer.invoke("scienceswarm:desktop-diagnostics");
  },
});

contextBridge.exposeInMainWorld("scienceswarmDesktop", scienceswarmDesktopBridge);
