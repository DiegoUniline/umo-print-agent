const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agent', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (c) => ipcRenderer.invoke('save-config', c),
  getPrinters: () => ipcRenderer.invoke('get-printers'),
  getStatus: () => ipcRenderer.invoke('get-status'),
  getJobs: () => ipcRenderer.invoke('get-jobs'),
  testPrint: (c) => ipcRenderer.invoke('test-print', c),
  onJobs: (cb) => ipcRenderer.on('jobs', (_e, j) => cb(j)),
  onStatus: (cb) => ipcRenderer.on('status', (_e, s) => cb(s)),
});
