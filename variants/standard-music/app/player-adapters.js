const path = require('path');
const { execFile } = require('child_process');
const { QQMusicCache } = require('./qqmusic-cache');
const { QQMusicWindowsCache } = require('./qqmusic-cache-windows');
const { NeteaseCache } = require('./netease-cache');
const { chooseWindowsTrack } = require('./windows-track');

const PLAYER_PROFILES = [
  {
    id: 'qqmusic',
    label: 'QQ 音乐',
    matches: ['com.tencent.qqmusicmac', 'qqmusic'],
    macBundleIds: ['com.tencent.QQMusicMac'],
    directLyrics: true
  },
  {
    id: 'netease',
    label: '网易云音乐',
    matches: ['com.netease.163music', 'cloudmusic', 'orpheus', 'netease'],
    macBundleIds: ['com.netease.163music'],
    directLyrics: true
  },
  {
    id: 'spotify',
    label: 'Spotify',
    matches: ['com.spotify.client', 'spotify']
  },
  {
    id: 'apple-music',
    label: 'Apple Music',
    matches: ['com.apple.music', 'applemusic', 'itunes']
  },
  {
    id: 'browser',
    label: '浏览器',
    matches: ['chrome', 'msedge', 'firefox', 'safari']
  }
];

function runFile(command, args, timeout = 4000) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      timeout,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
      encoding: 'utf8'
    }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout || '').replace(/^\uFEFF/, '').trim());
    });
  });
}

function externalFilePath(appDir, filename) {
  const source = path.join(appDir, filename);
  return source.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
}

function normalizeSource(value) {
  return String(value || '').toLocaleLowerCase().replace(/[^a-z0-9.]+/g, '');
}

function playerProfile(sourceId, appName = '') {
  const source = `${normalizeSource(sourceId)}|${normalizeSource(appName)}`;
  return PLAYER_PROFILES.find((profile) => profile.matches.some((match) => source.includes(normalizeSource(match)))) || {
    id: 'other',
    label: String(appName || '系统播放器'),
    matches: []
  };
}

function parseSongDescription(description) {
  const match = String(description || '').match(/^歌曲名：(.*?)\s*-\s*歌手名：(.*)$/);
  if (!match) return null;
  return { title: match[1].trim(), artist: match[2].trim() };
}

function trackFromSystemInfo(info) {
  if (!info?.title) return null;
  const profile = playerProfile(info.bundleId || info.sourceAppId, info.appName);
  const position = info.position ?? info.elapsedTime;
  return {
    title: String(info.title),
    artist: String(info.artist || ''),
    album: String(info.album || ''),
    duration: Number(info.duration) || 0,
    elapsed: position != null && position !== '' && Number.isFinite(Number(position)) && Number(position) >= 0 ? Number(position) : null,
    playing: info.playing === true || Number(info.playbackRate) > 0,
    source: info.source || 'system',
    sourceAppId: String(info.sourceAppId || info.bundleId || ''),
    bundleId: String(info.bundleId || ''),
    appName: String(info.appName || profile.label),
    playerId: profile.id,
    playerName: profile.label
  };
}

function cleanCandidate(value) {
  return String(value || '').replace(/[\t\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function comparable(value) {
  return cleanCandidate(value).normalize('NFKC').toLocaleLowerCase().replace(/[\s·・()（）\[\]【】\-_/\\]/g, '');
}

function candidateLooksLikeUi(text) {
  if (!text || text.length > 180) return true;
  if (/^(\d{1,3}:)?\d{1,2}:\d{2}$/.test(text)) return true;
  if (/^(播放|暂停|上一首|下一首|音量|喜欢|收藏|下载|评论|分享|更多|关闭|最小化|最大化|歌词|桌面歌词|歌词面板|歌词窗口|滚动歌词|纯音乐|翻译|音译|原文|设置|锁定|解锁|play|pause|lyrics?|desktop lyrics?)$/i.test(text)) return true;
  if (/^(https?:\/\/|file:\/\/)/i.test(text)) return true;
  return false;
}

function pickDirectLyrics(snapshot, track) {
  const windows = Array.isArray(snapshot?.windows) ? snapshot.windows : [];
  const metadata = new Set([
    comparable(track?.title),
    comparable(track?.artist),
    comparable(track?.album)
  ].filter(Boolean));
  const viableWindows = windows.filter((window) => window.preferred && !window.offscreen).map((window) => {
    const texts = [];
    const seen = new Map();
    for (const item of Array.isArray(window.texts) ? window.texts : []) {
      if (item.offscreen) continue;
      const raw = String(item.text ?? item.name ?? item.value ?? '');
      const parts = raw.split(/\r?\n/).map(cleanCandidate).filter(Boolean);
      // A whole document's value is not a current lyric. Small overlays may
      // expose their original and translation together in one value.
      if (parts.length > 4 || (window.kind === 'lyrics-region' && parts.length > 1)) continue;
      const text = parts.join(' / ');
      const key = comparable(text);
      const current = Boolean(item.current);
      const selected = Boolean(item.selected);
      if (candidateLooksLikeUi(text) || !key || (metadata.has(key) && !current && !selected)) continue;
      const itemBounds = item.bounds || {};
      if (!(Number(itemBounds.height) > 0)) continue;
      const entry = {
        text,
        current,
        selected,
        y: Number(itemBounds.y || 0),
        x: Number(itemBounds.x || 0)
      };
      // Name, Value and Legacy patterns can expose the same line. Keep its
      // strongest marker, but preserve repeated lyrics at different positions.
      const identity = `${text}|${Math.round(entry.y)}`;
      const previous = seen.get(identity);
      if (previous) {
        previous.current ||= current;
        previous.selected ||= selected;
      } else {
        seen.set(identity, entry);
        texts.push(entry);
      }
    }
    return {
      kind: window.kind || 'overlay',
      texts
    };
  }).filter((window) => window.texts.length && (window.texts.some((item) => item.current || item.selected) ||
    (window.kind === 'overlay' && window.texts.length <= 2)));

  const target = viableWindows.sort((left, right) => {
    const currentDifference = Number(right.texts.some((item) => item.current)) - Number(left.texts.some((item) => item.current));
    if (currentDifference) return currentDifference;
    const selectedDifference = Number(right.texts.some((item) => item.selected)) - Number(left.texts.some((item) => item.selected));
    if (selectedDifference) return selectedDifference;
    const overlayDifference = Number(right.kind === 'overlay') - Number(left.kind === 'overlay');
    if (overlayDifference) return overlayDifference;
    return left.texts.length - right.texts.length;
  })[0];
  if (!target) return null;

  const ordered = [...target.texts].sort((left, right) => left.y - right.y || left.x - right.x);
  // With no active marker, mirror a one/two-line overlay in display order.
  // Do not guess the current line from the centre of a larger lyric pane.
  const current = ordered.find((item) => item.current) || ordered.find((item) => item.selected) || ordered[0];
  if (!current) return null;
  const currentIndex = ordered.indexOf(current);
  const next = ordered.slice(currentIndex + 1).find((item) => item.text !== current.text);
  return { current: current.text, next: next?.text || '' };
}

class PlayerAdapters {
  constructor({ platform = process.platform, systemPreferences, appDir = __dirname, command = runFile }) {
    this.platform = platform;
    this.command = command;
    this.windowsDiagnostics = {};
    this.qqMusicCache = platform === 'win32' ? new QQMusicWindowsCache({ platform }) : new QQMusicCache({ platform });
    this.neteaseCache = new NeteaseCache({ platform });
    this.systemPreferences = systemPreferences;
    this.appDir = appDir;
    this.macNowPlayingScript = externalFilePath(appDir, 'now-playing.js');
    this.macQQStatusScript = externalFilePath(appDir, 'qqmusic-status.scpt');
    this.macLyricsScript = externalFilePath(appDir, 'player-lyrics-macos.js');
    this.windowsNowPlayingScript = externalFilePath(appDir, 'now-playing-windows.ps1');
    this.windowsStatusScript = externalFilePath(appDir, 'player-status-windows.ps1');
    this.windowsLyricsScript = externalFilePath(appDir, 'player-lyrics-windows.ps1');
  }

  permission(prompt = false) {
    if (this.platform !== 'darwin') return true;
    return this.systemPreferences?.isTrustedAccessibilityClient(Boolean(prompt)) ?? false;
  }

  async readMacSystemTrack() {
    try {
      const output = await runFile('/usr/bin/osascript', ['-l', 'JavaScript', this.macNowPlayingScript]);
      return trackFromSystemInfo(JSON.parse(output || '{}'));
    } catch (_error) {
      return null;
    }
  }

  async readMacQQFallback() {
    try {
      const output = await runFile('/usr/bin/osascript', [this.macQQStatusScript], 5000);
      const [state, description, playState, progressValue, progressMaximum] = output.split('\t');
      if (state !== 'ok') return { state };
      const song = parseSongDescription(description);
      if (!song) return { state: 'idle' };
      const progress = Number(progressValue);
      const maximum = Number(progressMaximum);
      const hasAbsoluteProgress = Number.isFinite(maximum) && maximum > 1;
      return {
        state: 'ok',
        ...song,
        album: '',
        duration: hasAbsoluteProgress ? maximum : 0,
        elapsed: hasAbsoluteProgress && Number.isFinite(progress) && progress >= 0 ? progress : null,
        progressRatio: !hasAbsoluteProgress && Number.isFinite(progress) && progress >= 0 && maximum > 0
          ? progress / maximum
          : null,
        playing: playState === 'playing',
        source: 'accessibility',
        sourceAppId: 'com.tencent.QQMusicMac',
        bundleId: 'com.tencent.QQMusicMac',
        appName: 'QQ 音乐',
        playerId: 'qqmusic',
        playerName: 'QQ 音乐'
      };
    } catch (error) {
      if (/not allowed assistive access|-1719|不允许辅助访问/i.test(String(error))) return { state: 'permission' };
      return { state: 'idle' };
    }
  }

  async readWindowsTrack() {
    try {
      const output = await this.command('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', this.windowsNowPlayingScript
      ], 6000);
      const snapshot = JSON.parse(output || '{}');
      this.windowsDiagnostics.system = snapshot;
      return trackFromSystemInfo(snapshot);
    } catch (error) {
      this.windowsDiagnostics.system = { state: error.killed ? 'timeout' : 'error', error: String(error.message || error).slice(0, 600) };
      return null;
    }
  }

  async readWindowsFallback(expected) {
    try {
      const output = await this.command('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', this.windowsStatusScript
      ], 7000);
      const snapshot = JSON.parse(output || '{}');
      this.windowsDiagnostics.fallback = snapshot;
      const selected = chooseWindowsTrack(snapshot, expected);
      if (selected?.state === 'ambiguous-players') return selected;
      return trackFromSystemInfo(selected);
    } catch (error) {
      this.windowsDiagnostics.fallback = { state: error.killed ? 'timeout' : 'error', error: String(error.message || error).slice(0, 600) };
      return null;
    }
  }

  async readTrack() {
    if (this.platform === 'win32') {
      const system = await this.readWindowsTrack();
      if (system && Number.isFinite(system.elapsed)) return system;
      const fallback = await this.readWindowsFallback(system);
      if (system) {
        // SMTC may publish metadata and playing status while leaving its whole
        // timeline uninitialized. Supplement only with the same player's song.
        return Number.isFinite(fallback?.elapsed) ? { ...system, elapsed: fallback.elapsed,
          duration: fallback.duration || system.duration, artist: fallback.artist || system.artist,
          source: 'system+accessibility' } : system;
      }
      return fallback || { state: 'idle' };
    }
    if (this.platform !== 'darwin') return { state: 'idle' };
    const systemTrack = await this.readMacSystemTrack();
    return systemTrack || this.readMacQQFallback();
  }

  async readDirectLyrics(track) {
    const profile = playerProfile(track?.sourceAppId || track?.bundleId, track?.appName);
    if (!profile.directLyrics) return null;
    if (profile.id === 'qqmusic' || profile.id === 'netease') {
      const cached = await (profile.id === 'qqmusic' ? this.qqMusicCache : this.neteaseCache).read(track);
      if (cached) return cached;
    }
    try {
      let snapshot;
      if (this.platform === 'darwin') {
        // The actual reader may run under a different macOS permission identity.
        // Use its result instead of blocking it on Electron's preflight status.
        const knownBundle = profile.macBundleIds?.find((candidate) =>
          normalizeSource(candidate) === normalizeSource(track.bundleId)
        );
        const bundleId = knownBundle || profile.macBundleIds?.[0] || track.bundleId || '';
        const output = await runFile('/usr/bin/osascript', [
          '-l', 'JavaScript', this.macLyricsScript, bundleId, profile.id
        ], 4500);
        snapshot = JSON.parse(output || '{}');
      } else if (this.platform === 'win32') {
        const output = await runFile('powershell.exe', [
          '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-File', this.windowsLyricsScript,
          track.sourceAppId || '', profile.id
        ], 6500);
        snapshot = JSON.parse(output || '{}');
      } else {
        return null;
      }
      const identity = { playerId: profile.id, playerName: profile.label };
      if (snapshot.state && snapshot.state !== 'ok') return {
        ...identity, state: snapshot.state, permissionType: snapshot.permissionType || null
      };
      const lines = pickDirectLyrics(snapshot, track);
      return lines ? { ...lines, state: 'ok', ...identity } : {
        ...identity,
        state: snapshot.windows?.some((window) => window.texts?.length) ? 'ambiguous' : 'unreadable'
      };
    } catch (error) {
      return { state: error.killed ? 'timeout' : 'error', playerId: profile.id, playerName: profile.label };
    }
  }
}

module.exports = {
  PLAYER_PROFILES,
  PlayerAdapters,
  externalFilePath,
  parseSongDescription,
  pickDirectLyrics,
  playerProfile,
  runFile,
  trackFromSystemInfo
};
