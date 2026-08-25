const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('expertAgent', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSetting: (key, value) => ipcRenderer.invoke('settings:set', key, value),
  pickFolder: () => ipcRenderer.invoke('settings:pickFolder'),
  getPairing: () => ipcRenderer.invoke('pairing:get'),
  rotatePairing: () => ipcRenderer.invoke('pairing:rotate'),
  getSession: () => ipcRenderer.invoke('auth:getSession'),
  signIn: (email) => ipcRenderer.invoke('auth:signIn', email),
  signOut: () => ipcRenderer.invoke('auth:signOut'),
  getPiServer: () => ipcRenderer.invoke('pi-server:get'),
  restartPiServer: () => ipcRenderer.invoke('pi-server:restart'),
  stopPiServer: () => ipcRenderer.invoke('pi-server:stop'),
  onRelayStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('relay:status', listener);
    return () => ipcRenderer.removeListener('relay:status', listener);
  },
  onPiServerStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('pi-server:status', listener);
    return () => ipcRenderer.removeListener('pi-server:status', listener);
  },
});
