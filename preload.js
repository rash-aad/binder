const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  list: () => ipcRenderer.invoke('lib:list'),
  add: () => ipcRenderer.invoke('lib:add'),
  remove: id => ipcRenderer.invoke('lib:remove', id),
  purge: id => ipcRenderer.invoke('lib:purge', id),
  update: (id, patch) => ipcRenderer.invoke('lib:update', id, patch),
  rename: (id, title) => ipcRenderer.invoke('lib:rename', id, title),
  readPdf: id => ipcRenderer.invoke('pdf:read', id),
  loadData: id => ipcRenderer.invoke('data:load', id),
  saveData: (id, data) => ipcRenderer.invoke('data:save', id, data),
});
