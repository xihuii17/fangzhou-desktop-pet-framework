const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  powerMonitor,
  net,
  safeStorage,
  screen,
  shell,
  systemPreferences,
  Tray
} = require('electron');
const fs = require('fs');
const { preparePetWindow, showPreparedPet, hidePreparedPet } = require('./pet-window-ready');
const { createFullscreenGuard } = require('./fullscreen-guard');
const { createPetGeometryGuard } = require('./pet-window-geometry');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { LyricsService } = require('./lyrics');
const { AIChatService, AIChatError, publicAIError, aiErrorCode, DEFAULT_MODEL } = require('./ai-chat');

const CHARACTER_DIR = process.env.DESKTOP_PET_CHARACTER_DIR
  ? path.resolve(process.env.DESKTOP_PET_CHARACTER_DIR)
  : path.join(__dirname, 'character');
const CHARACTER = JSON.parse(fs.readFileSync(path.join(CHARACTER_DIR, 'character.json'), 'utf8'));
const DEFAULT_ACTION_ID = CHARACTER.defaultAction || 'idle';
const GREETING_ACTION_ID = CHARACTER.greetingAction || 'wave';
const ASSETS_DIR = path.join(CHARACTER_DIR, 'assets');
const GIFS_DIR = path.join(ASSETS_DIR, 'gifs');
const PREVIEWS_DIR = path.join(ASSETS_DIR, 'previews');
const ACTIONS = JSON.parse(fs.readFileSync(path.join(CHARACTER_DIR, 'actions.json'), 'utf8'));
const APPEARANCES = Array.isArray(CHARACTER.appearances)
  ? CHARACTER.appearances.filter((appearance) => appearance?.id && appearance?.label)
  : [];
const DEFAULT_APPEARANCE_ID = CHARACTER.defaultAppearance || APPEARANCES[0]?.id || 'default';
const HAS_MULTIPLE_APPEARANCES = APPEARANCES.length > 1;
const APP_ICON_PATH = path.join(CHARACTER_DIR, CHARACTER.icon || 'assets/app-icon.png');
const WINDOWS_ICON_PATH = path.join(CHARACTER_DIR, 'build', 'app.ico');
const ICON_PATH = process.platform === 'win32' && fs.existsSync(WINDOWS_ICON_PATH)
  ? WINDOWS_ICON_PATH
  : APP_ICON_PATH;
const TRAY_PATH = path.join(CHARACTER_DIR, CHARACTER.trayIcon || 'assets/tray.png');
const LYRICS_AVAILABLE = ['darwin', 'win32'].includes(process.platform) &&
  Boolean(CHARACTER.features?.lyrics ?? CHARACTER.features?.qqLyrics);

app.setName(CHARACTER.productName);
if (process.platform === 'win32') app.disableHardwareAcceleration();

const ownsSingleInstance = app.requestSingleInstanceLock();
if (!ownsSingleInstance) app.quit();

const CONFIG_PATH = () => path.join(app.getPath('userData'), 'config.json');
const CUSTOM_DIR = () => path.join(app.getPath('userData'), 'custom-actions');
const CUSTOM_MANIFEST_PATH = () => path.join(CUSTOM_DIR(), 'manifest.json');
const DIAGNOSTIC_LOG_PATH = () => path.join(app.getPath('userData'), 'diagnostics.log');
const MAX_DIAGNOSTIC_LOG_SIZE = 2 * 1024 * 1024;

const DEFAULT_CONFIG = {
  scale: 0.55,
  bubbleScale: 1,
  lyricsScale: 1,
  bubbleScalePresetVersion: 2,
  actionLibraryVersion: 3,
  sizePresetVersion: 1,
  alwaysOnTop: true,
  speechEnabled: true,
  lowPowerMode: false,
  aiChatEnabled: false,
  aiMemoryEnabled: true,
  aiLongTermMemoryEnabled: true,
  aiAutoLearnEnabled: false,
  aiDefaultPersonaEnabled: true,
  lyricsEnabled: false,
  autoActionEnabled: true,
  activityMode: 'daily',
  previousActivityMode: 'daily',
  quietMode: false,
  actionFrequency: 'normal',
  openAtLogin: false,
  firstLaunch: true,
  appearanceId: DEFAULT_APPEARANCE_ID,
  appearanceStates: {},
  pinnedAction: null,
  baseAction: DEFAULT_ACTION_ID,
  position: null
};

const WINDOW_BASE = { width: 300, height: 360 };
const WINDOW_MIN_WIDTH = 184;
const TOOLBAR_AREA_HEIGHT = 52;
const WINDOWS_TOPMOST_INTERVAL = 1500;
let petWindow = null;
let appliedPetScale = null;
let settingsWindow = null;
let managerWindow = null;
let chatWindow = null;
let aiChatService = null;
let lastAIReactionId = null;
let tray = null;
let dragState = null;
let dragTimer = null;
let topmostGuardTimer = null;
let fullscreenGuard = null;
let petGeometryGuard = null;
let petAlwaysOnTopEnabled = true;
let quitting = false;
let lyricsService = null;
let lyricsStatus = { state: 'disabled', message: '未开启', permission: false };
let petRendererRecoveries = [];

function safeAppearanceId(id) {
  if (!HAS_MULTIPLE_APPEARANCES) return DEFAULT_APPEARANCE_ID;
  return APPEARANCES.some((appearance) => appearance.id === id) ? id : DEFAULT_APPEARANCE_ID;
}

function actionAppearanceId(action) {
  return action.appearanceId || DEFAULT_APPEARANCE_ID;
}

function actionBehaviorId(action) {
  return action.behaviorId || action.id;
}

function builtInActionsForAppearance(appearanceId) {
  if (!HAS_MULTIPLE_APPEARANCES) return ACTIONS;
  const safeId = safeAppearanceId(appearanceId);
  return ACTIONS.filter((action) => actionAppearanceId(action) === safeId);
}

function defaultActionForAppearance(appearanceId) {
  const candidates = builtInActionsForAppearance(appearanceId);
  return candidates.find((action) => action.id === DEFAULT_ACTION_ID) ||
    candidates.find((action) => actionBehaviorId(action) === DEFAULT_ACTION_ID) ||
    candidates[0] || null;
}

function defaultActionIdForAppearance(appearanceId) {
  return defaultActionForAppearance(appearanceId)?.id || DEFAULT_ACTION_ID;
}

function characterInfo(config = readConfig()) {
  const appearanceId = safeAppearanceId(config.appearanceId);
  const defaultAction = defaultActionForAppearance(appearanceId);
  return {
    id: CHARACTER.id,
    name: CHARACTER.name,
    productName: CHARACTER.productName,
    description: CHARACTER.description,
    version: CHARACTER.version,
    greeting: CHARACTER.greeting || `你好，我是${CHARACTER.name}。`,
    greetingAction: GREETING_ACTION_ID,
    defaultAction: defaultAction?.id || DEFAULT_ACTION_ID,
    defaultAppearance: DEFAULT_APPEARANCE_ID,
    activeAppearanceId: appearanceId,
    appearances: APPEARANCES.map((appearance) => {
      const idleAction = defaultActionForAppearance(appearance.id);
      return {
        ...appearance,
        idleMediaUrl: idleAction
          ? pathToFileURL(path.join(GIFS_DIR, idleAction.file)).href
          : null
      };
    }),
    features: {
      qqLyrics: Boolean(CHARACTER.features?.qqLyrics),
      lyrics: Boolean(CHARACTER.features?.lyrics ?? CHARACTER.features?.qqLyrics),
      aiChat: Boolean(CHARACTER.features?.aiChat)
    },
    idleMediaUrl: defaultAction
      ? pathToFileURL(path.join(GIFS_DIR, defaultAction.file)).href
      : null
  };
}

function errorText(error) {
  if (error instanceof Error) return error.stack || error.message;
  if (typeof error === 'string') return error;
  try { return JSON.stringify(error); } catch (_jsonError) { return String(error); }
}

function writeDiagnosticLog(event, details = {}) {
  try {
    const logPath = DIAGNOSTIC_LOG_PATH();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > MAX_DIAGNOSTIC_LOG_SIZE) {
      fs.writeFileSync(logPath, '', 'utf8');
    }
    const payload = Object.fromEntries(
      Object.entries(details).map(([key, value]) => [key, value instanceof Error ? errorText(value) : value])
    );
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${event} ${JSON.stringify(payload)}\n`, 'utf8');
  } catch (_error) {}
}

function openDiagnosticLog() {
  writeDiagnosticLog('diagnostics-opened');
  shell.showItemInFolder(DIAGNOSTIC_LOG_PATH());
}

function recoverPetRenderer(details) {
  writeDiagnosticLog('pet-renderer-gone', details);
  if (quitting || ['clean-exit', 'killed'].includes(details.reason)) return;

  const now = Date.now();
  petRendererRecoveries = petRendererRecoveries.filter((time) => now - time < 60000);
  if (petRendererRecoveries.length >= 3) {
    writeDiagnosticLog('pet-renderer-recovery-stopped', { reason: 'too-many-restarts' });
    return;
  }
  petRendererRecoveries.push(now);
  setTimeout(() => {
    try {
      if (petWindow && !petWindow.isDestroyed()) petWindow.webContents.reload();
    } catch (error) {
      writeDiagnosticLog('pet-renderer-reload-failed', { error });
    }
  }, 500);
}

process.on('uncaughtException', (error) => {
  writeDiagnosticLog('uncaught-exception', { error });
  app.exit(1);
});
process.on('unhandledRejection', (reason) => {
  writeDiagnosticLog('unhandled-rejection', { reason: errorText(reason) });
});

function readConfig() {
  try {
    const stored = JSON.parse(fs.readFileSync(CONFIG_PATH(), 'utf8'));
    const config = { ...DEFAULT_CONFIG, ...stored };
    config.aiAutoLearnEnabled = typeof stored.aiAutoLearnEnabled === 'boolean' ? stored.aiAutoLearnEnabled : true;
    config.lowPowerMode = Boolean(config.lowPowerMode);
    // Preserve custom choices; migrate only m3's old default idle.
    if (CHARACTER.id === 'm3' && !stored.m3CalmIdleVersion) {
      if (config.baseAction === 'idle') config.baseAction = DEFAULT_ACTION_ID;
      const modes = config.modeIdleActions?.default;
      for (const mode of ['quiet', 'daily']) {
        if (modes?.[mode] === 'idle') modes[mode] = DEFAULT_ACTION_ID;
      }
      config.m3CalmIdleVersion = 1;
      writeConfig(config);
    }
    // Upgrade Miumiu's original default without replacing a custom idle choice.
    if (CHARACTER.id === 'miumiu' && !stored.miumiuDrinkIdleVersion) {
      if (config.baseAction === 'idle') config.baseAction = DEFAULT_ACTION_ID;
      const modes = config.modeIdleActions?.default;
      if (modes) {
        for (const mode of ['quiet', 'daily']) {
          if (modes[mode] === 'idle') modes[mode] = DEFAULT_ACTION_ID;
        }
      }
      config.miumiuDrinkIdleVersion = 1;
      writeConfig(config);
    }
    if (typeof stored.lyricsEnabled !== 'boolean' && typeof stored.qqLyricsEnabled === 'boolean') {
      config.lyricsEnabled = stored.qqLyricsEnabled;
    }
    delete config.qqLyricsEnabled;
    config.appearanceId = safeAppearanceId(config.appearanceId);
    config.appearanceStates = config.appearanceStates && typeof config.appearanceStates === 'object'
      ? { ...config.appearanceStates }
      : {};
    if (HAS_MULTIPLE_APPEARANCES) {
      const appearanceState = config.appearanceStates[config.appearanceId];
      if (appearanceState && typeof appearanceState === 'object') {
        config.baseAction = appearanceState.baseAction || defaultActionIdForAppearance(config.appearanceId);
        config.pinnedAction = appearanceState.pinnedAction || null;
      } else {
        config.baseAction = defaultActionIdForAppearance(config.appearanceId);
        config.pinnedAction = null;
        config.appearanceStates[config.appearanceId] = {
          baseAction: config.baseAction,
          pinnedAction: config.pinnedAction
        };
      }
    }
    if (!ACTION_MODES.has(config.activityMode)) {
      config.activityMode = stored.quietMode ? 'quiet' : 'daily';
    }
    if (!['daily', 'office'].includes(config.previousActivityMode)) {
      config.previousActivityMode = config.activityMode === 'office' ? 'office' : 'daily';
    }
    config.quietMode = config.activityMode === 'quiet';
    if (!LYRICS_AVAILABLE) config.lyricsEnabled = false;
    if (stored.sizePresetVersion !== DEFAULT_CONFIG.sizePresetVersion) {
      config.scale = DEFAULT_CONFIG.scale;
      config.sizePresetVersion = DEFAULT_CONFIG.sizePresetVersion;
      writeConfig(config);
    }
    if (stored.bubbleScalePresetVersion !== DEFAULT_CONFIG.bubbleScalePresetVersion) {
      config.bubbleScale = safeBubbleScale((Number(stored.bubbleScale) || 1) / 1.35);
      config.bubbleScalePresetVersion = DEFAULT_CONFIG.bubbleScalePresetVersion;
      writeConfig(config);
    }
    const previousLibraryVersion = Number(stored.actionLibraryVersion) || 0;
    if (previousLibraryVersion !== DEFAULT_CONFIG.actionLibraryVersion) {
      config.actionLibraryVersion = DEFAULT_CONFIG.actionLibraryVersion;
      try {
        const manifest = JSON.parse(fs.readFileSync(CUSTOM_MANIFEST_PATH(), 'utf8'));
        if (previousLibraryVersion < 2) {
          if (manifest.banana && !manifest.record) manifest.record = { ...manifest.banana };
          delete manifest.banana;
        }
        if (previousLibraryVersion < 3) delete manifest.daydream;
        const builtInIds = new Set(ACTIONS.map((action) => action.id));
        for (const [id, entry] of Object.entries(manifest)) {
          if (entry?.customAdded) continue;
          if (!builtInIds.has(id)) {
            delete manifest[id];
            continue;
          }
          if (previousLibraryVersion < 2) {
            delete entry.mode;
            delete entry.modes;
          }
          removeEmptyManifestEntry(manifest, id);
        }
        writeCustomManifest(manifest);
      } catch (_error) {}
      writeConfig(config);
    }
    return config;
  } catch (_error) {
    const config = { ...DEFAULT_CONFIG, appearanceStates: {} };
    if (HAS_MULTIPLE_APPEARANCES) {
      config.baseAction = defaultActionIdForAppearance(config.appearanceId);
      config.appearanceStates[config.appearanceId] = {
        baseAction: config.baseAction,
        pinnedAction: null
      };
    }
    return config;
  }
}

function writeConfig(config) {
  config.lyricsScale = safeLyricsScale(config.lyricsScale ?? 1);
  fs.mkdirSync(path.dirname(CONFIG_PATH()), { recursive: true });
  fs.writeFileSync(CONFIG_PATH(), JSON.stringify(config, null, 2), 'utf8');
}

function readCustomManifest() {
  try {
    const manifest = JSON.parse(fs.readFileSync(CUSTOM_MANIFEST_PATH(), 'utf8'));
    let changed = false;
    for (const action of ACTIONS) {
      const entry = manifest[action.id];
      if (!entry) continue;
      if (entry.mode && !Array.isArray(entry.modes)) {
        entry.modes = [safeMode(entry.mode)];
        delete entry.mode;
        changed = true;
      }
      if (Array.isArray(entry.modes) && sameModes(entry.modes, defaultModes(action))) {
        delete entry.modes;
        removeEmptyManifestEntry(manifest, action.id);
        changed = true;
      }
    }
    if (changed) writeCustomManifest(manifest);
    return manifest;
  } catch (_error) {
    return {};
  }
}

function writeCustomManifest(manifest) {
  fs.mkdirSync(CUSTOM_DIR(), { recursive: true });
  fs.writeFileSync(CUSTOM_MANIFEST_PATH(), JSON.stringify(manifest, null, 2), 'utf8');
}

const ACTION_MODES = new Set(['quiet', 'daily', 'office']);

function defaultModes(action) {
  return [...new Set((Array.isArray(action.modes) ? action.modes : []).filter((mode) => ACTION_MODES.has(mode)))];
}

function safeMode(mode) {
  return ACTION_MODES.has(mode) ? mode : 'daily';
}

function safeModes(modes, fallback = []) {
  return [...new Set((Array.isArray(modes) ? modes : fallback).map(safeMode))];
}

function sameModes(left, right) {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function removeEmptyManifestEntry(manifest, id) {
  const entry = manifest[id];
  if (!entry) return;
  const hasData = entry.customAdded || entry.fileName || entry.label ||
    Array.isArray(entry.lines) || Array.isArray(entry.modes) || entry.mode ||
    typeof entry.interaction === 'boolean' || typeof entry.dragging === 'boolean' ||
    typeof entry.dropReaction === 'boolean';
  if (!hasData) delete manifest[id];
}

function createPreview(sourcePath, previewPath) {
  try {
    const preview = nativeImage.createFromPath(sourcePath).resize({ width: 220, height: 220, quality: 'best' });
    if (!preview.isEmpty()) {
      fs.writeFileSync(previewPath, preview.toPNG());
      return true;
    }
  } catch (_error) {}
  return false;
}

function actionById(id) {
  const actions = resolvedActions();
  return actions.find((action) => action.id === id) ||
    actions.find((action) => actionBehaviorId(action) === id) ||
    null;
}

function resolvedActions(config = readConfig()) {
  const manifest = readCustomManifest();
  const fallbackActionId = defaultActionIdForAppearance(config.appearanceId);
  const builtInActions = builtInActionsForAppearance(config.appearanceId).map((action) => {
    const custom = manifest[action.id];
    const mediaPath = custom?.fileName ? path.join(CUSTOM_DIR(), custom.fileName) : null;
    const previewPath = custom?.previewName ? path.join(CUSTOM_DIR(), custom.previewName) : null;
    const hasCustom = Boolean(mediaPath && fs.existsSync(mediaPath));
    const hasCustomPreview = Boolean(previewPath && fs.existsSync(previewPath));
    return {
      ...action,
      label: custom?.label || action.label,
      modes: safeModes(custom?.modes, custom?.mode ? [custom.mode] : defaultModes(action)),
      mediaUrl: hasCustom ? pathToFileURL(mediaPath).href : pathToFileURL(path.join(GIFS_DIR, action.file)).href,
      previewUrl: hasCustomPreview
        ? pathToFileURL(previewPath).href
        : (hasCustom ? pathToFileURL(mediaPath).href : pathToFileURL(path.join(PREVIEWS_DIR, `${action.id}.png`)).href),
      custom: hasCustom,
      lines: Array.isArray(custom?.lines) ? custom.lines : action.lines,
      customLines: Array.isArray(custom?.lines),
      customLabel: Boolean(custom?.label),
      interaction: typeof custom?.interaction === 'boolean'
        ? custom.interaction
        : Boolean(action.interaction),
      dragging: typeof custom?.dragging === 'boolean'
        ? custom.dragging
        : Boolean(action.dragging),
      dropReaction: typeof custom?.dropReaction === 'boolean'
        ? custom.dropReaction
        : Boolean(action.dropReaction),
      originalName: hasCustom ? custom.originalName : null,
      pinned: config.pinnedAction === action.id,
      base: (config.baseAction || fallbackActionId) === action.id,
      builtIn: true
    };
  });

  const addedActions = Object.entries(manifest)
    .filter(([, entry]) => (
      entry?.customAdded &&
      entry.fileName &&
      (!HAS_MULTIPLE_APPEARANCES ||
        safeAppearanceId(entry.appearanceId || DEFAULT_APPEARANCE_ID) === config.appearanceId)
    ))
    .map(([id, entry]) => {
      const mediaPath = path.join(CUSTOM_DIR(), entry.fileName);
      const previewPath = entry.previewName ? path.join(CUSTOM_DIR(), entry.previewName) : null;
      if (!fs.existsSync(mediaPath)) return null;
      const hasPreview = Boolean(previewPath && fs.existsSync(previewPath));
      const defaultLabel = entry.defaultLabel || path.parse(entry.originalName || id).name;
      return {
        id,
        appearanceId: entry.appearanceId || DEFAULT_APPEARANCE_ID,
        behaviorId: entry.behaviorId || id,
        file: entry.fileName,
        label: entry.label || defaultLabel,
        group: 'custom',
        auto: true,
        modes: safeModes(entry.modes, entry.mode ? [entry.mode] : []),
        playMs: Number(entry.playMs) || 3000,
        lines: Array.isArray(entry.lines) ? entry.lines : [],
        mediaUrl: pathToFileURL(mediaPath).href,
        previewUrl: hasPreview ? pathToFileURL(previewPath).href : pathToFileURL(mediaPath).href,
        custom: true,
        customLines: Array.isArray(entry.lines) && entry.lines.length > 0,
        customLabel: Boolean(entry.label && entry.label !== defaultLabel),
        interaction: Boolean(entry.interaction),
        dragging: Boolean(entry.dragging),
        dropReaction: Boolean(entry.dropReaction),
        originalName: entry.originalName || entry.fileName,
        pinned: config.pinnedAction === id,
        base: (config.baseAction || fallbackActionId) === id,
        builtIn: false,
        added: true
      };
    })
    .filter(Boolean);

  return [...builtInActions, ...addedActions];
}

function sendActions() {
  for (const window of [petWindow, managerWindow]) {
    if (window && !window.isDestroyed()) window.webContents.send('actions:changed');
  }
}

function safeScale(value) {
  const number = Number(value) || 1;
  return Math.min(1.4, Math.max(0.45, number));
}

function safeBubbleScale(value) {
  const number = Number(value) || 1;
  return Math.min(1.25, Math.max(0.65, number));
}

function safeLyricsScale(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(1.6, Math.max(0.7, number)) : 1;
}

function windowSize(scale, lyricsEnabled = false, lyricsScale = 1) {
  const factor = safeScale(scale);
  return {
    width: Math.max(
      lyricsEnabled ? Math.ceil(280 * safeLyricsScale(lyricsScale)) + 12 : WINDOW_MIN_WIDTH,
      Math.round(WINDOW_BASE.width * factor)
    ),
    height: Math.round(WINDOW_BASE.height * factor) + TOOLBAR_AREA_HEIGHT +
      (lyricsEnabled ? Math.ceil(76 * safeLyricsScale(lyricsScale)) + 10 : 0)
  };
}

function defaultPosition(size) {
  const area = screen.getPrimaryDisplay().workArea;
  return {
    x: Math.round(area.x + area.width - size.width - 28),
    y: Math.round(area.y + area.height - size.height - 24)
  };
}

function visiblePosition(position, size) {
  if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) {
    return defaultPosition(size);
  }
  const displays = screen.getAllDisplays();
  const display = displays.find(({ workArea }) => (
    position.x + size.width > workArea.x &&
    position.x < workArea.x + workArea.width &&
    position.y + size.height > workArea.y &&
    position.y < workArea.y + workArea.height
  ));
  if (!display) return defaultPosition(size);
  const { workArea } = display;
  return {
    x: Math.min(Math.max(position.x, workArea.x), workArea.x + workArea.width - size.width),
    y: Math.min(Math.max(position.y, workArea.y), workArea.y + workArea.height - size.height)
  };
}

function sendConfig(config) {
  for (const window of [petWindow, settingsWindow, managerWindow, chatWindow]) {
    if (window && !window.isDestroyed()) window.webContents.send('config:changed', config);
  }
  refreshMenus();
}

function persistConfig(partial = {}) {
  // Retain old callers while saving only the current settings schema.
  if (typeof partial.qqLyricsEnabled === 'boolean' && typeof partial.lyricsEnabled !== 'boolean') {
    partial = { ...partial, lyricsEnabled: partial.qqLyricsEnabled };
  }
  partial = Object.fromEntries(Object.entries(partial || {}).filter(([key]) => Object.hasOwn(DEFAULT_CONFIG, key)));
  const previous = readConfig();
  const previousAppearanceId = safeAppearanceId(previous.appearanceId);
  const requestedAppearanceId = safeAppearanceId(partial.appearanceId || previousAppearanceId);
  const appearanceStates = previous.appearanceStates && typeof previous.appearanceStates === 'object'
    ? { ...previous.appearanceStates }
    : {};

  if (HAS_MULTIPLE_APPEARANCES) {
    appearanceStates[previousAppearanceId] = {
      baseAction: previous.baseAction || defaultActionIdForAppearance(previousAppearanceId),
      pinnedAction: previous.pinnedAction || null
    };
  }

  const config = {
    ...previous,
    ...partial,
    appearanceId: requestedAppearanceId,
    appearanceStates
  };
  const appearanceChanged = previousAppearanceId !== requestedAppearanceId;
  if (HAS_MULTIPLE_APPEARANCES && appearanceChanged) {
    const targetState = appearanceStates[requestedAppearanceId] || {};
    config.baseAction = targetState.baseAction || defaultActionIdForAppearance(requestedAppearanceId);
    config.pinnedAction = targetState.pinnedAction || null;
  }
  if (HAS_MULTIPLE_APPEARANCES) {
    appearanceStates[requestedAppearanceId] = {
      baseAction: config.baseAction || defaultActionIdForAppearance(requestedAppearanceId),
      pinnedAction: config.pinnedAction || null
    };
  }

  if (typeof partial?.quietMode === 'boolean' && !partial?.activityMode) {
    config.activityMode = partial.quietMode
      ? 'quiet'
      : (previous.previousActivityMode || 'daily');
  }
  config.activityMode = safeMode(config.activityMode);
  if (config.activityMode !== 'quiet') config.previousActivityMode = config.activityMode;
  config.quietMode = config.activityMode === 'quiet';
  config.scale = safeScale(config.scale);
  config.bubbleScale = safeBubbleScale(config.bubbleScale);
  config.lyricsEnabled = LYRICS_AVAILABLE && Boolean(config.lyricsEnabled);
  delete config.qqLyricsEnabled;
  config.lowPowerMode = Boolean(config.lowPowerMode);
  config.aiChatEnabled = Boolean(CHARACTER.features?.aiChat && config.aiChatEnabled);
  config.aiMemoryEnabled = Boolean(config.aiMemoryEnabled);
  config.aiLongTermMemoryEnabled = config.aiLongTermMemoryEnabled !== false;
  config.aiAutoLearnEnabled = config.aiAutoLearnEnabled === true;
  config.aiDefaultPersonaEnabled = config.aiDefaultPersonaEnabled !== false;
  writeConfig(config);
  aiChatService?.configChanged(previous, config);
  applyWindowConfig(config);
  app.setLoginItemSettings({
    openAtLogin: Boolean(config.openAtLogin),
    ...(process.platform === 'win32' ? { path: process.execPath } : {})
  });
  if (appearanceChanged) sendActions();
  sendConfig(config);
  if (previous.lyricsEnabled !== config.lyricsEnabled) {
    configureLyrics(config, config.lyricsEnabled);
  }
  return config;
}

function sendLyrics(payload) {
  if (!readConfig().lyricsEnabled && payload?.visible) return;
  if (petWindow && !petWindow.isDestroyed()) petWindow.webContents.send('lyrics:changed', payload);
}

function sendLyricsStatus(status) {
  lyricsStatus = status;
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('lyrics:status-changed', status);
  }
}

function configureLyrics(config, promptForPermission = false) {
  if (!lyricsService) {
    const message = ['darwin', 'win32'].includes(process.platform) ? '此角色未启用' : '当前系统暂不提供';
    sendLyricsStatus({ state: 'disabled', message, permission: false });
    return;
  }
  if (config.lyricsEnabled) lyricsService.start({ promptForPermission });
  else {
    lyricsService.stop();
    sendLyricsStatus({ state: 'disabled', message: '未开启', permission: lyricsService.permission(false) });
  }
}

function applyWindowConfig(config) {
  if (!petWindow || petWindow.isDestroyed()) return;
  const size = windowSize(config.scale, config.lyricsEnabled, config.lyricsScale);
  const current = petWindow.getBounds();
  const nextScale = safeScale(config.scale);
  const oldScale = appliedPetScale ?? nextScale;
  if (current.width !== size.width || current.height !== size.height) {
    // Anchor the character, not the bottom-right corner of the lyrics window.
    const next = visiblePosition({
      x: Math.round(current.x + (current.width - size.width) / 2),
      y: current.y + Math.round(WINDOW_BASE.height * oldScale) - Math.round(WINDOW_BASE.height * nextScale)
    }, size);
    petWindow.setBounds({ ...next, ...size });
    petGeometryGuard?.remember({ ...next, ...size });
  }
  appliedPetScale = nextScale;
  setPetAlwaysOnTop(config.alwaysOnTop, true);
}

function setPetAlwaysOnTop(enabled, raise = false) {
  petAlwaysOnTopEnabled = Boolean(enabled);
  if (!petWindow || petWindow.isDestroyed()) return;

  const level = process.platform === 'win32' ? 'screen-saver' : 'floating';
  const shouldFloat = petAlwaysOnTopEnabled && (!fullscreenGuard || fullscreenGuard.canRaise());
  petWindow.setAlwaysOnTop(shouldFloat, level);
  if (shouldFloat && raise && process.platform === 'win32' && petWindow.isVisible()) {
    petWindow.moveTop();
  }
}

function stopTopmostGuard() {
  if (topmostGuardTimer) clearInterval(topmostGuardTimer);
  topmostGuardTimer = null;
}

function startTopmostGuard() {
  stopTopmostGuard();
  if (process.platform !== 'win32') return;

  topmostGuardTimer = setInterval(() => {
    if (dragState?.moving) return;
    if (fullscreenGuard && !fullscreenGuard.canRaise()) return;
    if (!petAlwaysOnTopEnabled || !petWindow || petWindow.isDestroyed() || !petWindow.isVisible()) return;
    setPetAlwaysOnTop(true, true);
  }, WINDOWS_TOPMOST_INTERVAL);
  topmostGuardTimer.unref?.();
}

function playAIReaction(emotion) {
  if (!aiChatService || !petWindow || petWindow.isDestroyed()) return null;
  const actions = aiChatService.emotionActionIds(emotion)
    .map((id) => actionById(id))
    .filter(Boolean);
  if (!actions.length) return null;
  const alternatives = actions.filter((action) => action.id !== lastAIReactionId);
  const pool = alternatives.length ? alternatives : actions;
  const selected = pool[Math.floor(Math.random() * pool.length)];
  lastAIReactionId = selected.id;
  playAction(selected.id);
  return { id: selected.id, emotion };
}

function playAction(id, line, options = {}) {
  if (!petWindow || petWindow.isDestroyed()) return;
  if (id === 'random') {
    petWindow.webContents.send('action:play', { id, line, action: null });
    if (!petWindow.isVisible()) showPreparedPet(petWindow);
    return;
  }
  const action = actionById(id);
  if (!action) return;
  petWindow.webContents.send('action:play', { id: action.id, line, action, forceSpeech: Boolean(options.forceSpeech) });
  if (!petWindow.isVisible()) showPreparedPet(petWindow);
}

function savePosition() {
  if (!petWindow || petWindow.isDestroyed()) return;
  const config = readConfig();
  const [x, y] = petWindow.getPosition();
  config.position = { x, y };
  writeConfig(config);
}

function updateDragPosition() {
  if (!dragState?.moving || !petWindow || petWindow.isDestroyed()) return;
  const cursor = screen.getCursorScreenPoint();
  if (cursor.x === dragState.lastCursorX && cursor.y === dragState.lastCursorY) return;

  // Cursor and window origin are both DIP. Keep the original grab anchor:
  // clamping the whole transparent/lyrics window here pushes the pet upward.
  const position = {
    x: Math.round(dragState.windowX + cursor.x - dragState.cursorX),
    y: Math.round(dragState.windowY + cursor.y - dragState.cursorY)
  };
  dragState.lastCursorX = cursor.x;
  dragState.lastCursorY = cursor.y;

  if (position.x !== dragState.lastWindowX || position.y !== dragState.lastWindowY) {
    dragState.lastWindowX = position.x;
    dragState.lastWindowY = position.y;
    petWindow.setPosition(position.x, position.y);
    petGeometryGuard?.remember(position);
  }
}

function stopDragTracking(save = true) {
  if (save) updateDragPosition();
  if (dragTimer) clearInterval(dragTimer);
  dragTimer = null;
  const moved = Boolean(dragState?.moving);
  dragState = null;
  if (save && moved) savePosition();
}

function createPetWindow() {
  const config = readConfig();
  const size = windowSize(config.scale, config.lyricsEnabled, config.lyricsScale);
  const position = visiblePosition(config.position, size);

  petWindow = new BrowserWindow({
    ...size,
    ...position,
    title: CHARACTER.productName,
    icon: ICON_PATH,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: process.platform === 'win32' ? false : config.alwaysOnTop,
    hasShadow: false,
    useContentSize: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  petAlwaysOnTopEnabled = Boolean(config.alwaysOnTop);
  petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  appliedPetScale = safeScale(config.scale);
  petGeometryGuard = createPetGeometryGuard({
    window: petWindow, screen, powerMonitor,
    isDragging: () => Boolean(dragState),
    cancelDrag: () => stopDragTracking(false),
    onRestore: details => writeDiagnosticLog('pet-geometry-restored', details),
    onError: message => writeDiagnosticLog('pet-geometry-error', { message })
  });
  preparePetWindow(petWindow, {
    ipcMain, platform: process.platform,
    onError: message => writeDiagnosticLog('pet-first-frame', { message })
  });
  fullscreenGuard = createFullscreenGuard({
    window: petWindow, screen,
    onSuspend: () => stopDragTracking(false),
    onResume: () => setPetAlwaysOnTop(petAlwaysOnTopEnabled, true),
    onError: message => writeDiagnosticLog('fullscreen-guard', { message })
  });
  setPetAlwaysOnTop(config.alwaysOnTop, true);
  startTopmostGuard();
  petWindow.loadFile('pet.html');
  petWindow.on('show', () => setPetAlwaysOnTop(petAlwaysOnTopEnabled, true));
  petWindow.webContents.on('render-process-gone', (_event, details) => recoverPetRenderer(details));
  petWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      hidePreparedPet(petWindow);
    }
  });
  petWindow.on('closed', () => {
    stopDragTracking(false);
    stopTopmostGuard();
    fullscreenGuard?.stop();
    fullscreenGuard = null;
    petGeometryGuard?.stop();
    petGeometryGuard = null;
    petWindow = null;
  });
}

function createSettingsWindow(section = null) {
  const targetSection = typeof section === 'string' ? section : null;
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    if (targetSection) settingsWindow.webContents.send('settings:navigate', targetSection);
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 720,
    height: 820,
    minWidth: 660,
    minHeight: 700,
    title: `${CHARACTER.productName}设置`,
    icon: ICON_PATH,
    backgroundColor: '#f5f6f8',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  settingsWindow.loadFile('settings.html');
  if (targetSection) {
    settingsWindow.webContents.once('did-finish-load', () => {
      settingsWindow?.webContents.send('settings:navigate', targetSection);
    });
  }
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

function createManagerWindow() {
  if (managerWindow && !managerWindow.isDestroyed()) {
    managerWindow.show();
    managerWindow.focus();
    return;
  }

  managerWindow = new BrowserWindow({
    width: 980,
    height: 740,
    minWidth: 760,
    minHeight: 580,
    title: `${CHARACTER.name}动作管理`,
    icon: ICON_PATH,
    backgroundColor: '#f3f5f6',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  managerWindow.loadFile('manager.html');
  managerWindow.on('closed', () => { managerWindow = null; });
}

function createChatWindow() {
  if (!CHARACTER.features?.aiChat) {
    createSettingsWindow('ai');
    return;
  }
  if (chatWindow && !chatWindow.isDestroyed()) {
    chatWindow.show();
    chatWindow.focus();
    return;
  }

  chatWindow = new BrowserWindow({
    width: 500,
    height: 680,
    minWidth: 400,
    minHeight: 520,
    title: `和${CHARACTER.name}说话`,
    icon: ICON_PATH,
    backgroundColor: '#f4f6f7',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  chatWindow.loadFile('chat.html');
  chatWindow.on('close', () => aiChatService?.cancelAll());
  chatWindow.webContents.on('render-process-gone', () => aiChatService?.cancelAll());
  chatWindow.on('closed', () => { aiChatService?.cancelAll(); chatWindow = null; });
}

function toggleQuietMode() {
  const config = readConfig();
  persistConfig({
    activityMode: config.activityMode === 'quiet'
      ? (config.previousActivityMode || 'daily')
      : 'quiet'
  });
}

function appearanceMenuItem(config) {
  if (!HAS_MULTIPLE_APPEARANCES) return [];
  return [{
    label: '角色形态',
    submenu: APPEARANCES.map((appearance) => ({
      label: appearance.label,
      type: 'radio',
      checked: config.appearanceId === appearance.id,
      click: () => persistConfig({ appearanceId: appearance.id })
    }))
  }];
}

function showPet() {
  if (!petWindow || petWindow.isDestroyed()) createPetWindow();
  showPreparedPet(petWindow);
}

function menuTemplate() {
  const config = readConfig();
  const quickActions = Array.isArray(CHARACTER.quickActions) ? CHARACTER.quickActions : [];
  return [
    { label: `${CHARACTER.productName} ${app.getVersion()}`, enabled: false },
    { type: 'separator' },
    { label: `显示${CHARACTER.name}`, click: showPet },
    ...quickActions.map((item) => ({
      label: item.label,
      click: () => playAction(item.actionId)
    })),
    ...(CHARACTER.features?.aiChat ? [{ label: `和${CHARACTER.name}说话…`, click: createChatWindow }] : []),
    ...appearanceMenuItem(config),
    { type: 'separator' },
    { label: '动作管理…', click: createManagerWindow },
    { label: '安静模式', type: 'checkbox', checked: config.activityMode === 'quiet', click: toggleQuietMode },
    { label: '设置…', click: createSettingsWindow },
    { label: '诊断日志…', click: openDiagnosticLog },
    { label: '隐藏', click: () => hidePreparedPet(petWindow) },
    { type: 'separator' },
    { label: `退出${CHARACTER.productName}`, click: () => { quitting = true; app.quit(); } }
  ];
}

function refreshMenus() {
  if (tray) tray.setContextMenu(Menu.buildFromTemplate(menuTemplate()));
}

function createTray() {
  let image = nativeImage.createFromPath(TRAY_PATH);
  if (image.isEmpty()) image = nativeImage.createFromPath(ICON_PATH);
  image = image.resize({ width: 20, height: 20, quality: 'best' });
  tray = new Tray(image);
  tray.setToolTip(CHARACTER.productName);
  refreshMenus();
  tray.on('click', showPet);
}

function showContextMenu() {
  if (!petWindow || petWindow.isDestroyed()) return;
  const config = readConfig();
  Menu.buildFromTemplate([
    { label: '摸摸', click: () => playAction('pat') },
    { label: '打招呼', click: () => playAction('wave') },
    { label: '随机动作', click: () => playAction('random') },
    ...(CHARACTER.features?.aiChat ? [{ label: `和${CHARACTER.name}说话…`, click: createChatWindow }] : []),
    ...appearanceMenuItem(config),
    { type: 'separator' },
    { label: '动作管理…', click: createManagerWindow },
    { label: '安静模式', type: 'checkbox', checked: config.activityMode === 'quiet', click: toggleQuietMode },
    { label: '设置…', click: createSettingsWindow },
    { label: '诊断日志…', click: openDiagnosticLog },
    { label: '隐藏', click: () => hidePreparedPet(petWindow) },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } }
  ]).popup({ window: petWindow });
}

app.whenReady().then(() => {
  if (!ownsSingleInstance) return;
  Menu.setApplicationMenu(null);
  if (process.platform === 'win32') app.setAppUserModelId(CHARACTER.appId);
  if (app.dock) app.dock.hide();
  if (LYRICS_AVAILABLE) {
    lyricsService = new LyricsService({
      app,
      systemPreferences,
      productName: CHARACTER.productName,
      clientHeader: `${CHARACTER.packageName}/${CHARACTER.version} (desktop companion)`,
      onUpdate: sendLyrics,
      onStatus: sendLyricsStatus
    });
  }
  aiChatService = new AIChatService({
    app,
    net,
    safeStorage,
    character: CHARACTER,
    characterDir: CHARACTER_DIR,
    writeDiagnosticLog,
    getConfig: readConfig,
    onStatusChange: sendAIStatus
  });
  createTray();
  createPetWindow();
  configureLyrics(readConfig());
  writeDiagnosticLog('startup', {
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    hardwareAcceleration: process.platform !== 'win32'
  });
  app.on('activate', showPet);
}).catch((error) => {
  writeDiagnosticLog('startup-failed', { error });
  app.exit(1);
});

if (ownsSingleInstance) {
  app.on('second-instance', () => {
    writeDiagnosticLog('second-instance');
    if (app.isReady()) showPet();
  });
  app.on('child-process-gone', (_event, details) => {
    writeDiagnosticLog('child-process-gone', details);
  });
}

app.on('before-quit', () => {
  quitting = true;
  aiChatService?.cancelAll();
  petGeometryGuard?.stop();
  fullscreenGuard?.stop();
  stopTopmostGuard();
  writeDiagnosticLog('shutdown');
  savePosition();
});

app.on('window-all-closed', () => {});

ipcMain.handle('config:get', () => readConfig());
ipcMain.handle('character:get', () => characterInfo());
ipcMain.handle('actions:get', () => resolvedActions());
ipcMain.handle('config:save', (_event, partial) => persistConfig(partial));
ipcMain.handle('lyrics:status-get', () => lyricsStatus);
ipcMain.handle('lyrics:permission-request', () => {
  const permission = lyricsService?.permission(true) || false;
  if (readConfig().lyricsEnabled) configureLyrics(readConfig());
  return { ...lyricsStatus, permission };
});
function sendAIStatus(status) {
  for (const target of [petWindow, settingsWindow, managerWindow, chatWindow]) {
    if (target && !target.isDestroyed()) {
      try { target.webContents.send('ai:status-changed', status); } catch (_error) {}
    }
  }
}

function requireAIService() {
  if (!aiChatService) throw new AIChatError('NOT_READY', 'AI 对话服务尚未准备好，请稍后重试。');
  return aiChatService;
}

function aiFailure(error, fallback) {
  return { ok: false, ...(aiErrorCode(error) === 'CANCELLED' ? { cancelled: true } : {}), error: publicAIError(error, fallback) };
}

function handleAIMutation(channel, action, fallback) {
  ipcMain.handle(channel, async (_event, payload) => {
    try { return await action(requireAIService(), payload); }
    catch (error) { return aiFailure(error, fallback); }
  });
}

ipcMain.handle('ai:status-get', () => aiChatService?.status() || {
  available: false, configured: false, model: DEFAULT_MODEL, busy: false, characterName: CHARACTER.name
});
ipcMain.handle('ai:connection-get', () => requireAIService().getConnectionSettings());
ipcMain.handle('ai:connection-save', (_event, payload) => {
  try {
    const service = requireAIService();
    return { ok: true, settings: service.saveConnectionSettings(payload), status: service.status() };
  } catch (error) {
    let settings = null;
    try { settings = aiChatService?.getConnectionSettings() || null; } catch (_error) {}
    return { ...aiFailure(error, '连接设置保存失败，请检查文件权限后重试。'), settings, status: aiChatService?.status() || { configured: false, busy: false, model: DEFAULT_MODEL } };
  }
});
handleAIMutation('ai:cancel', service => service.cancelAll(), '停止失败，请稍后重试。');
handleAIMutation('ai:key-save', (service, value) => ({ ok: true, status: service.saveApiKey(value) }), '密钥保存失败，请检查系统安全存储后重试。');
handleAIMutation('ai:key-clear', service => ({ ok: true, status: service.clearApiKey() }), '密钥移除失败，请检查文件权限后重试。');
handleAIMutation('ai:memory-clear', service => ({ ok: service.clearMemory() }), '最近对话清空失败，原记录已保留。');
// Read APIs retain the existing array contract; damaged files reject with a safe
// actionable error instead of masquerading as empty arrays.
ipcMain.handle('ai:history-get', () => requireAIService().readMemory());
ipcMain.handle('ai:long-memory-get', () => requireAIService().readLongTermMemories());
handleAIMutation('ai:long-memory-add', (service, content) => {
  const item = service.addLongTermMemory(content);
  return { ok: true, item, items: service.readLongTermMemories() };
}, '无法添加记忆，请检查本地文件权限后重试。');
handleAIMutation('ai:long-memory-update', (service, payload) => {
  const item = service.updateLongTermMemory(payload?.id, payload?.content);
  return { ok: true, item, items: service.readLongTermMemories() };
}, '无法修改记忆，请检查本地文件权限后重试。');
handleAIMutation('ai:long-memory-delete', (service, id) => ({ ok: service.deleteLongTermMemory(id), items: service.readLongTermMemories() }), '记忆删除失败，请稍后重试。');
handleAIMutation('ai:long-memory-clear', service => ({ ok: service.clearLongTermMemories(), items: [] }), '长期记忆清空失败，原文件已保留。');
ipcMain.handle('ai:persona-get', () => requireAIService().personaSettings());
handleAIMutation('ai:persona-default-save', (service, payload) => {
  service.writeDefaultPersona(payload); return { ok: true, persona: service.personaSettings() };
}, '默认设定保存失败，请检查文件权限后重试。');
handleAIMutation('ai:persona-default-reset', service => {
  service.clearDefaultPersonaOverride(); return { ok: true, persona: service.personaSettings() };
}, '恢复默认设定失败，请检查文件权限后重试。');
handleAIMutation('ai:persona-save', (service, payload) => {
  service.writeCustomPersona(payload); return { ok: true, persona: service.personaSettings() };
}, '角色设定保存失败，请检查文件权限后重试。');
handleAIMutation('ai:persona-reset', service => {
  service.clearCustomPersona(); return { ok: true, persona: service.personaSettings() };
}, '恢复角色设定失败，请检查文件权限后重试。');
ipcMain.handle('ai:test', async () => {
  try { return await requireAIService().testConnection(); }
  catch (error) {
    writeDiagnosticLog('ai-test-failed', { code: aiErrorCode(error) });
    return aiFailure(error, '连接测试失败，请检查网络和连接设置后重试。');
  }
});
ipcMain.handle('ai:chat', async (event, input) => {
  try {
    const service = requireAIService(), config = readConfig();
    if (!config.aiChatEnabled) return { ok: false, error: '请先在设置里开启 AI 对话。' };
    const generation = service.generation;
    const result = await service.chat(input, {
      rememberHistory: config.aiMemoryEnabled,
      useLongTermMemory: config.aiLongTermMemoryEnabled,
      useDefaultPersona: config.aiDefaultPersonaEnabled
    });
    // A close/clear/disable IPC can arrive after the service resolved but before
    // this continuation. Do not play a reaction or start inference for that turn.
    if (generation !== service.generation || !readConfig().aiChatEnabled || event.sender?.isDestroyed()) {
      return { ok: false, cancelled: true, error: '已停止回复' };
    }
    const replyReaction = playAIReaction(result.emotion);
    if (service.canInfer()) {
      service.inferPreferences(input).then(items => {
        if (generation !== service.generation || !service.canInfer() || !items.length || !chatWindow || chatWindow.isDestroyed()) return;
        chatWindow.webContents.send('ai:memories-learned', items);
      }).catch(error => {
        writeDiagnosticLog('ai-preference-inference-failed', { code: aiErrorCode(error) });
        sendAIStatus({ ...service.status(), error: publicAIError(error, '偏好整理失败，本次未新增记忆。') });
      });
    }
    return { ok: true, ...result, replyReaction };
  } catch (error) {
    writeDiagnosticLog('ai-chat-failed', { code: aiErrorCode(error) });
    return aiFailure(error, '暂时无法回复，请检查网络和本地资料后重试。');
  }
});
ipcMain.handle('chat:open', () => { createChatWindow(); return true; });
ipcMain.handle('settings:open', (_event, section) => { createSettingsWindow(section); return true; });
ipcMain.handle('manager:open', () => { createManagerWindow(); return true; });
ipcMain.handle('action:play-now', (_event, id) => {
  if (!actionById(id)) return false;
  playAction(id);
  return true;
});
ipcMain.handle('action:pin', (_event, id) => {
  const action = id ? actionById(id) : null;
  const config = persistConfig({ pinnedAction: action?.id || null });
  sendActions();
  return config;
});
ipcMain.handle('action:set-base', (_event, id) => {
  const action = id ? actionById(id) : null;
  const current = readConfig();
  const config = persistConfig({
    baseAction: action?.id || defaultActionIdForAppearance(current.appearanceId)
  });
  sendActions();
  return config;
});
ipcMain.handle('action:add', async (_event, requestedMode) => {
  const initialModes = ACTION_MODES.has(requestedMode) ? [requestedMode] : [];
  const parent = managerWindow && !managerWindow.isDestroyed() ? managerWindow : undefined;
  const result = await dialog.showOpenDialog(parent, {
    title: '添加 GIF 动作',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'GIF 动画', extensions: ['gif'] }]
  });
  if (result.canceled || !result.filePaths.length) return { changed: false, ids: [] };

  fs.mkdirSync(CUSTOM_DIR(), { recursive: true });
  const manifest = readCustomManifest();
  const stamp = Date.now();
  const ids = [];
  result.filePaths.forEach((sourcePath, index) => {
    const id = `user-${stamp}-${index}`;
    const fileName = `${id}.gif`;
    const previewName = `${id}-preview.png`;
    const originalName = path.basename(sourcePath);
    fs.copyFileSync(sourcePath, path.join(CUSTOM_DIR(), fileName));
    const hasPreview = createPreview(sourcePath, path.join(CUSTOM_DIR(), previewName));
    manifest[id] = {
      customAdded: true,
      appearanceId: readConfig().appearanceId,
      behaviorId: id,
      fileName,
      previewName: hasPreview ? previewName : null,
      originalName,
      defaultLabel: path.parse(originalName).name.slice(0, 24) || '新动作',
      modes: initialModes,
      lines: [],
      playMs: 3000,
      updatedAt: stamp
    };
    ids.push(id);
  });
  writeCustomManifest(manifest);
  sendActions();
  return { changed: true, ids };
});
ipcMain.handle('action:set-mode', (_event, payload) => {
  const action = actionById(payload?.id);
  if (!action) return { changed: false };
  const mode = safeMode(payload?.mode);
  const modes = new Set(action.modes || []);
  if (payload?.enabled) modes.add(mode);
  else modes.delete(mode);
  const manifest = readCustomManifest();
  manifest[action.id] = {
    ...(manifest[action.id] || {}),
    modes: [...modes]
  };
  delete manifest[action.id].mode;
  const builtIn = ACTIONS.find((item) => item.id === action.id);
  if (builtIn && sameModes(manifest[action.id].modes, defaultModes(builtIn))) {
    delete manifest[action.id].modes;
    removeEmptyManifestEntry(manifest, action.id);
  }
  writeCustomManifest(manifest);
  sendActions();
  return { changed: true, modes: manifest[action.id].modes };
});
ipcMain.handle('action:set-interaction', (_event, payload) => {
  const action = actionById(payload?.id);
  if (!action) return { changed: false };
  const enabled = Boolean(payload?.enabled);
  const manifest = readCustomManifest();
  manifest[action.id] = {
    ...(manifest[action.id] || {}),
    interaction: enabled
  };
  const builtIn = ACTIONS.find((item) => item.id === action.id);
  if (builtIn && enabled === Boolean(builtIn.interaction)) {
    delete manifest[action.id].interaction;
    removeEmptyManifestEntry(manifest, action.id);
  }
  writeCustomManifest(manifest);
  sendActions();
  return { changed: true, interaction: enabled };
});
ipcMain.handle('action:set-drag-role', (_event, payload) => {
  const action = actionById(payload?.id);
  const field = payload?.role === 'dragging'
    ? 'dragging'
    : (payload?.role === 'drop' ? 'dropReaction' : null);
  if (!action || !field) return { changed: false };
  const enabled = Boolean(payload?.enabled);
  const manifest = readCustomManifest();
  manifest[action.id] = { ...(manifest[action.id] || {}), [field]: enabled };
  const builtIn = ACTIONS.find((item) => item.id === action.id);
  if (builtIn && enabled === Boolean(builtIn[field])) {
    delete manifest[action.id][field];
    removeEmptyManifestEntry(manifest, action.id);
  }
  writeCustomManifest(manifest);
  sendActions();
  return { changed: true, [field]: enabled };
});
ipcMain.handle('action:set-memberships', (_event, payload) => {
  const group = payload?.group;
  const membershipFields = {
    interaction: 'interaction',
    dragging: 'dragging',
    drop: 'dropReaction'
  };
  if (![...ACTION_MODES, ...Object.keys(membershipFields)].includes(group)) return { changed: false };
  const selected = new Set(Array.isArray(payload?.ids) ? payload.ids : []);
  const allActions = resolvedActions();
  const manifest = readCustomManifest();
  let changed = false;

  for (const action of allActions) {
    const enabled = selected.has(action.id);
    const membershipField = membershipFields[group];
    if (membershipField) {
      if (Boolean(action[membershipField]) === enabled) continue;
      manifest[action.id] = { ...(manifest[action.id] || {}), [membershipField]: enabled };
      const builtIn = ACTIONS.find((item) => item.id === action.id);
      if (builtIn && enabled === Boolean(builtIn[membershipField])) {
        delete manifest[action.id][membershipField];
        removeEmptyManifestEntry(manifest, action.id);
      }
      changed = true;
      continue;
    }

    const modes = new Set(action.modes || []);
    if (modes.has(group) === enabled) continue;
    if (enabled) modes.add(group);
    else modes.delete(group);
    manifest[action.id] = { ...(manifest[action.id] || {}), modes: [...modes] };
    delete manifest[action.id].mode;
    const builtIn = ACTIONS.find((item) => item.id === action.id);
    if (builtIn && sameModes(manifest[action.id].modes, defaultModes(builtIn))) {
      delete manifest[action.id].modes;
      removeEmptyManifestEntry(manifest, action.id);
    }
    changed = true;
  }

  if (changed) {
    writeCustomManifest(manifest);
    sendActions();
  }
  return { changed };
});
ipcMain.handle('action:delete', (_event, id) => {
  const action = actionById(id);
  const manifest = readCustomManifest();
  const entry = manifest[id];
  if (!action || action.builtIn || !entry?.customAdded) return { changed: false };
  for (const name of [entry.fileName, entry.previewName]) {
    if (!name) continue;
    try { fs.unlinkSync(path.join(CUSTOM_DIR(), name)); } catch (_error) {}
  }
  delete manifest[id];
  writeCustomManifest(manifest);
  const config = readConfig();
  const partial = {};
  if (config.pinnedAction === id) partial.pinnedAction = null;
  if (config.baseAction === id) {
    partial.baseAction = defaultActionIdForAppearance(config.appearanceId);
  }
  if (Object.keys(partial).length) persistConfig(partial);
  sendActions();
  return { changed: true };
});
ipcMain.handle('action:replace-media', async (_event, id) => {
  const action = actionById(id);
  if (!action) return { changed: false };
  const parent = managerWindow && !managerWindow.isDestroyed() ? managerWindow : undefined;
  const result = await dialog.showOpenDialog(parent, {
    title: `替换“${action.label}”素材`,
    properties: ['openFile'],
    filters: [
      { name: '动画与图片', extensions: ['gif', 'png', 'webp'] }
    ]
  });
  if (result.canceled || !result.filePaths[0]) return { changed: false };

  const sourcePath = result.filePaths[0];
  const extension = path.extname(sourcePath).toLowerCase();
  const stamp = Date.now();
  const fileName = `${id}-${stamp}${extension}`;
  const previewName = `${id}-${stamp}-preview.png`;
  fs.mkdirSync(CUSTOM_DIR(), { recursive: true });
  fs.copyFileSync(sourcePath, path.join(CUSTOM_DIR(), fileName));

  createPreview(sourcePath, path.join(CUSTOM_DIR(), previewName));

  const manifest = readCustomManifest();
  const previous = manifest[id];
  manifest[id] = {
    ...(previous || {}),
    fileName,
    previewName: fs.existsSync(path.join(CUSTOM_DIR(), previewName)) ? previewName : null,
    originalName: path.basename(sourcePath),
    updatedAt: stamp
  };
  writeCustomManifest(manifest);

  for (const name of [previous?.fileName, previous?.previewName]) {
    if (!name || name === fileName || name === previewName) continue;
    try { fs.unlinkSync(path.join(CUSTOM_DIR(), name)); } catch (_error) {}
  }
  sendActions();
  playAction(id);
  return { changed: true };
});
ipcMain.handle('action:restore-media', (_event, id) => {
  const action = actionById(id);
  if (!action || !action.builtIn) return { changed: false };
  const manifest = readCustomManifest();
  const previous = manifest[id];
  if (!previous) return { changed: false };
  const next = { ...previous };
  delete next.fileName;
  delete next.previewName;
  delete next.originalName;
  delete next.updatedAt;
  manifest[id] = next;
  removeEmptyManifestEntry(manifest, id);
  writeCustomManifest(manifest);
  for (const name of [previous.fileName, previous.previewName]) {
    if (!name) continue;
    try { fs.unlinkSync(path.join(CUSTOM_DIR(), name)); } catch (_error) {}
  }
  sendActions();
  playAction(id);
  return { changed: true };
});
ipcMain.handle('action:save-lines', (_event, payload) => {
  const action = actionById(payload?.id);
  if (!action || !Array.isArray(payload?.lines)) return { changed: false };
  const lines = payload.lines
    .map((line) => String(line).trim())
    .filter(Boolean)
    .slice(0, 20)
    .map((line) => line.slice(0, 80));
  const manifest = readCustomManifest();
  manifest[action.id] = { ...(manifest[action.id] || {}), lines };
  writeCustomManifest(manifest);
  sendActions();
  return { changed: true, lines };
});
ipcMain.handle('action:restore-lines', (_event, id) => {
  if (!actionById(id)) return { changed: false };
  const manifest = readCustomManifest();
  if (!manifest[id] || !Array.isArray(manifest[id].lines)) return { changed: false };
  delete manifest[id].lines;
  removeEmptyManifestEntry(manifest, id);
  writeCustomManifest(manifest);
  sendActions();
  return { changed: true };
});
ipcMain.handle('action:save-label', (_event, payload) => {
  const action = actionById(payload?.id);
  const label = String(payload?.label || '').trim().slice(0, 24);
  if (!action || !label) return { changed: false };
  const manifest = readCustomManifest();
  manifest[action.id] = { ...(manifest[action.id] || {}), label };
  writeCustomManifest(manifest);
  sendActions();
  return { changed: true, label };
});
ipcMain.handle('action:restore-label', (_event, id) => {
  if (!actionById(id)) return { changed: false };
  const manifest = readCustomManifest();
  if (!manifest[id]?.label) return { changed: false };
  delete manifest[id].label;
  removeEmptyManifestEntry(manifest, id);
  writeCustomManifest(manifest);
  sendActions();
  return { changed: true };
});
ipcMain.handle('menu:show-context', () => { showContextMenu(); return true; });
ipcMain.handle('pet:hide', () => { hidePreparedPet(petWindow); return true; });
ipcMain.handle('pet:reset-position', () => {
  if (!petWindow || petWindow.isDestroyed()) return false;
  const config = readConfig();
  const size = windowSize(config.scale, config.lyricsEnabled, config.lyricsScale);
  const position = defaultPosition(size);
  petWindow.setPosition(position.x, position.y);
  petGeometryGuard?.remember(position);
  savePosition();
  return true;
});
ipcMain.handle('app:quit', () => { quitting = true; app.quit(); });

ipcMain.on('drag:start', () => {
  if (!petWindow || petWindow.isDestroyed()) return;
  stopDragTracking(false);
  const { x, y } = petWindow.getBounds();
  const cursor = screen.getCursorScreenPoint();
  dragState = {
    cursorX: cursor.x,
    cursorY: cursor.y,
    windowX: x,
    windowY: y,
    lastCursorX: cursor.x,
    lastCursorY: cursor.y,
    lastWindowX: x,
    lastWindowY: y,
    moving: false
  };
});
ipcMain.on('drag:move', () => {
  if (!dragState || !petWindow || petWindow.isDestroyed()) return;
  dragState.moving = true;
  if (process.platform !== 'win32') {
    updateDragPosition();
    return;
  }
  if (dragTimer) return;
  updateDragPosition();
  dragTimer = setInterval(updateDragPosition, 16);
});
ipcMain.on('drag:end', () => {
  stopDragTracking(true);
});
