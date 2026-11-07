// First-frame readiness is best effort: a missing native event must never trap the pet.
function preparePetWindow(window, { ipcMain, platform, onError = () => {} }) {
  let nativeReady = false, contentReady = false, pageReady = false;
  let wanted = true, timeout = null, suppressed = false, forcePending = false;
  function show(force = false) {
    if (!wanted || window.isDestroyed()) return;
    if (force) forcePending = true;
    if (suppressed) return;
    if (!force && (!pageReady || (!nativeReady && !contentReady))) return;
    // Cosmetic repaint failures must not block the visibility escape hatch.
    try {
      if (platform === 'win32') window.setBackgroundColor('#00000000');
    } catch (error) { onError(String(error)); }
    window.showInactive();
    forcePending = true;
    clearTimeout(timeout);
    timeout = null;
    try { window.webContents.invalidate(); } catch (error) { onError(String(error)); }
  }
  function armTimeout() {
    clearTimeout(timeout);
    timeout = setTimeout(() => {
      if (!wanted || window.isDestroyed()) return;
      onError('窗口就绪等待超时，显示桌宠以便打开设置和诊断。');
      show(true);
    }, 10000);
    timeout.unref?.();
  }
  function onReady(event, error) {
    if (event.sender !== window.webContents) return;
    if (error) onError(String(error).slice(0, 500));
    pageReady = true;
    show();
  }
  // Fullscreen suppression is temporary; it must not overwrite explicit hide/show intent.
  window.__showPrepared = () => { wanted = true; show(true); };
  window.__hidePrepared = () => { wanted = false; forcePending = false; clearTimeout(timeout); window.hide(); };
  window.__suppressPrepared = value => {
    if (suppressed === Boolean(value)) return;
    suppressed = Boolean(value);
    if (suppressed) {
      if (window.isVisible()) window.hide();
    } else show(forcePending);
  };
  window.webContents.on('did-start-loading', () => {
    pageReady = false;
    contentReady = false;
    // Do not hide an already-hidden native surface: it can suppress first paint.
    armTimeout();
  });
  window.webContents.on('did-finish-load', () => { contentReady = true; show(); });
  window.once('ready-to-show', () => { nativeReady = true; show(); });
  ipcMain.on('pet:renderer-ready', onReady);
  window.once('closed', () => {
    clearTimeout(timeout);
    ipcMain.removeListener('pet:renderer-ready', onReady);
  });
  armTimeout();
}
function showPreparedPet(window) {
  if (window && !window.isDestroyed()) window.__showPrepared?.();
}
function hidePreparedPet(window) {
  if (window && !window.isDestroyed()) window.__hidePrepared?.();
}
function suppressPreparedPet(window, suppressed) {
  if (window && !window.isDestroyed()) window.__suppressPrepared?.(suppressed);
}
module.exports = { preparePetWindow, showPreparedPet, hidePreparedPet, suppressPreparedPet };
