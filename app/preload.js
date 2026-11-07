const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('companionAPI', {
  platform: process.platform,
  rendererReady: (error = null) => ipcRenderer.send('pet:renderer-ready', error),
  getCharacter: () => ipcRenderer.invoke('character:get'),
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (partial) => ipcRenderer.invoke('config:save', partial),
  getActions: () => ipcRenderer.invoke('actions:get'),
  playAction: (id) => ipcRenderer.invoke('action:play-now', id),
  openActionManager: () => ipcRenderer.invoke('manager:open'),
  replaceActionMedia: (id) => ipcRenderer.invoke('action:replace-media', id),
  restoreActionMedia: (id) => ipcRenderer.invoke('action:restore-media', id),
  saveActionLines: (id, lines) => ipcRenderer.invoke('action:save-lines', { id, lines }),
  restoreActionLines: (id) => ipcRenderer.invoke('action:restore-lines', id),
  saveActionLabel: (id, label) => ipcRenderer.invoke('action:save-label', { id, label }),
  restoreActionLabel: (id) => ipcRenderer.invoke('action:restore-label', id),
  addActions: (mode) => ipcRenderer.invoke('action:add', mode),
  setActionMode: (id, mode, enabled) => ipcRenderer.invoke('action:set-mode', { id, mode, enabled }),
  deleteAction: (id) => ipcRenderer.invoke('action:delete', id),
  pinAction: (id) => ipcRenderer.invoke('action:pin', id),
  setBaseAction: (id) => ipcRenderer.invoke('action:set-base', id),
  setActionInteraction: (id, enabled) => ipcRenderer.invoke('action:set-interaction', { id, enabled }),
  setActionDragRole: (id, role, enabled) => ipcRenderer.invoke('action:set-drag-role', { id, role, enabled }),
  setActionMemberships: (group, ids) => ipcRenderer.invoke('action:set-memberships', { group, ids }),
  openSettings: (section) => ipcRenderer.invoke('settings:open', section),
  showContextMenu: () => ipcRenderer.invoke('menu:show-context'),
  hidePet: () => ipcRenderer.invoke('pet:hide'),
  resetPosition: () => ipcRenderer.invoke('pet:reset-position'),
  quit: () => ipcRenderer.invoke('app:quit'),
  getLyricsStatus: () => ipcRenderer.invoke('lyrics:status-get'),
  requestLyricsPermission: () => ipcRenderer.invoke('lyrics:permission-request'),
  dragStart: () => ipcRenderer.send('drag:start'),
  dragMove: () => ipcRenderer.send('drag:move'),
  dragEnd: () => ipcRenderer.send('drag:end'),
  onConfigChanged: (callback) => {
    const listener = (_event, config) => callback(config);
    ipcRenderer.on('config:changed', listener);
    return () => ipcRenderer.removeListener('config:changed', listener);
  },
  onPlayAction: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('action:play', listener);
    return () => ipcRenderer.removeListener('action:play', listener);
  },
  onActionsChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('actions:changed', listener);
    return () => ipcRenderer.removeListener('actions:changed', listener);
  },
  onLyricsChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('lyrics:changed', listener);
    return () => ipcRenderer.removeListener('lyrics:changed', listener);
  },
  onLyricsStatusChanged: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('lyrics:status-changed', listener);
    return () => ipcRenderer.removeListener('lyrics:status-changed', listener);
  },
  onSettingsNavigate: (callback) => {
    const listener = (_event, section) => callback(section);
    ipcRenderer.on('settings:navigate', listener);
    return () => ipcRenderer.removeListener('settings:navigate', listener);
  }
});
