// Gives the page its window buttons. In a normal browser this object does not exist and the buttons stay hidden.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('tiroirWin', {
  min: () => ipcRenderer.send('win', 'min'),
  max: () => ipcRenderer.send('win', 'max'),
  close: () => ipcRenderer.send('win', 'close'),
  openExternal: (url) => ipcRenderer.send('open-external', String(url)),
  onState: (fn) => ipcRenderer.on('win', (_e, s) => fn(s)),
});
