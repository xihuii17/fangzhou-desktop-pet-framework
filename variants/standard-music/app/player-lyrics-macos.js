function safe(call, fallback) {
  try {
    const value = call();
    return value == null ? fallback : value;
  } catch (_error) { return fallback; }
}

function boundsOf(element) {
  const position = safe(() => element.position(), [0, 0]);
  const size = safe(() => element.size(), [0, 0]);
  return { x: Number(position[0]) || 0, y: Number(position[1]) || 0, width: Number(size[0]) || 0, height: Number(size[1]) || 0 };
}

function attribute(element, name) {
  return safe(() => element.attributes.byName(name).value(), '');
}

function accessError(error, stage) {
  const message = String(error && (error.message || error.description) || error);
  const rawNumber = error && (error.errorNumber == null ? error.number : error.errorNumber);
  const number = Number(rawNumber);
  const automationDenied = number === -1743 || /-1743|not authorized to send apple events|无权发送.*apple.*事件|不允许发送.*apple.*事件/i.test(message);
  // System Events also uses -1719 for invalid indexes, so the number alone
  // cannot establish an Accessibility denial.
  const accessibilityDenied = /not allowed assistive access|not allowed accessibility access|(?:不允许|不允許|无权|無權).*(?:辅助|輔助)|(?:辅助|輔助).*(?:不允许|不允許)/i.test(message);
  return {
    state: automationDenied || accessibilityDenied ? 'permission' : 'error',
    permissionType: automationDenied ? 'automation' : (accessibilityDenied ? 'accessibility' : null),
    stage,
    error: message,
    errorNumber: rawNumber != null && Number.isFinite(number) ? number : null
  };
}

function findProcess(systemEvents, bundleId) {
  // Failure to enumerate is not evidence that a player is closed.
  const processes = systemEvents.applicationProcesses();
  let identityError = null;
  for (const item of processes) {
    try {
      if (String(item.bundleIdentifier() || '').toLowerCase() === bundleId.toLowerCase()) return item;
    } catch (error) { identityError = error; }
  }
  if (identityError) throw identityError;
  return null;
}

function isLyricsRegion(role, name, description, identifier) {
  if (/^AX(Button|CheckBox|MenuItem|Link)$/.test(role)) return false;
  return /lyric|歌词/i.test(identifier) ||
    /^(?:(?:QQ音乐|QQ 音乐|网易云音乐)\s*[-·:]?\s*)?(?:桌面歌词|歌词|歌词面板|歌词窗口|滚动歌词|desktop lyrics?|lyrics?)(?:\s*[-|·].*)?$/i.test(name) ||
    /^(桌面歌词|歌词面板|歌词窗口|desktop lyrics?|lyrics?)$/i.test(description);
}

function run(argv) {
  const bundleId = String(argv[0] || '');
  const player = String(argv[1] || '');
  const diagnostic = argv[2] === 'diagnostic';
  const base = { schemaVersion: 2, player, bundleId, diagnostic };
  let stage = 'find-process';
  if (!bundleId) return JSON.stringify({ state: 'closed', windows: [] });
  try {
    const target = findProcess(Application('System Events'), bundleId);
    if (!target) return JSON.stringify({ ...base, state: 'closed', windows: [] });
    stage = 'read-windows';
    // Keep this call outside safe(): the previous version silently converted
    // permission failures to [], reporting no-region with zero scanned nodes.
    const roots = target.windows();
    const processInfo = {
      name: safe(() => target.name(), ''),
      pid: safe(() => target.unixId(), null),
      visible: safe(() => target.visible(), null),
      frontmost: safe(() => target.frontmost(), null)
    };
    if (!roots.length) return JSON.stringify({
      ...base, state: 'no-windows', stage, processInfo, windowCount: 0,
      windows: [], scannedNodes: 0, truncated: false,
      message: '播放器进程存在，但系统未返回可读取窗口；请检查权限及窗口状态'
    });
    stage = 'read-elements';
    const started = Date.now();
    const windows = [];
    const observedWindows = [];
    const readErrors = [];
    let visited = 0;
    const queue = roots.map((element) => ({ element, region: null, depth: 0 }));
    while (queue.length && visited < 1000 && Date.now() - started < 2400) {
      const entry = queue.shift();
      visited += 1;
      const element = entry.element;
      if (safe(() => element.visible(), true) === false) continue;
      let role;
      try { role = String(element.role() || ''); }
      catch (error) {
        if (readErrors.length < 8) readErrors.push(accessError(error, 'read-element-role'));
        continue;
      }
      const name = String(safe(() => element.name(), ''));
      const description = String(safe(() => element.description(), ''));
      const identifier = String(attribute(element, 'AXIdentifier'));
      if (diagnostic && entry.depth === 0) {
        observedWindows.push({ name, description, identifier, role, subrole: String(safe(() => element.subrole(), '')), bounds: boundsOf(element) });
      }
      let region = entry.region;
      if (!region && isLyricsRegion(role, name, description, identifier)) {
        region = { name, kind: entry.depth === 0 ? 'overlay' : 'lyrics-region', preferred: true, bounds: boundsOf(element), texts: [] };
        windows.push(region);
      }
      if (region && /^AX(StaticText|TextArea|TextField|Row)$/.test(role)) {
        const values = [safe(() => element.value(), ''), name, description];
        const text = values.map((value) => String(value || '').trim()).find(Boolean) || '';
        const bounds = boundsOf(element);
        if (text && text.length <= 4000 && bounds.height > 0 && bounds.width > 0) {
          region.texts.push({
            text,
            selected: Boolean(safe(() => element.selected(), false)),
            current: /(?:current|active|playing)[_-]?lyric|lyric[_-]?(?:current|active|playing)/i.test(identifier),
            bounds
          });
        }
      }
      if (entry.depth < 24) {
        let children;
        try { children = element.uiElements(); }
        catch (error) {
          if (readErrors.length < 8) readErrors.push(accessError(error, 'read-child-elements'));
          continue;
        }
        for (const child of children) {
          if (queue.length >= 1000) break;
          queue.push({ element: child, region, depth: entry.depth + 1 });
        }
      }
    }
    const accessFailure = readErrors.find((error) => error.state === 'permission');
    const readable = windows.some((window) => window.texts.length);
    const result = {
      ...base,
      ...(accessFailure && !readable ? accessFailure : {}),
      state: !readable && accessFailure ? 'permission' : (windows.length ? 'ok' : (readErrors.length ? 'error' : 'no-region')),
      windows, windowCount: roots.length, scannedNodes: visited, truncated: queue.length > 0,
      readErrors
    };
    if (diagnostic) { result.observedWindows = observedWindows; result.processInfo = processInfo; }
    return JSON.stringify(result);
  } catch (error) {
    return JSON.stringify({ ...base, ...accessError(error, stage), windows: [], scannedNodes: 0 });
  }
}
