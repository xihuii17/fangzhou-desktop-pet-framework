const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { PlayerAdapters, externalFilePath, parseSongDescription } = require('./player-adapters');

const DEFAULT_CLIENT_HEADER = 'DesktopCompanion/1.0 (cross-platform desktop companion)';
const CACHE_VERSION = 2;
const NEGATIVE_CACHE_TTL = 10 * 60 * 1000;
const SEARCH_DELAY = 320;

function runFile(command, args, timeout = 3500) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout || '').trim());
    });
  });
}

function requestJson(url, clientHeader = DEFAULT_CLIENT_HEADER) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      timeout: 9000,
      headers: { 'User-Agent': clientHeader, Accept: 'application/json' }
    }, (response) => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => {
        if (response.statusCode === 429) {
          const error = new Error('歌词服务请求过于频繁');
          error.retryAfter = Number(response.headers['retry-after']) || 60;
          reject(error);
          return;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`歌词服务返回 ${response.statusCode}`));
          return;
        }
        try { resolve(JSON.parse(data)); } catch (error) { reject(error); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('歌词服务连接超时')));
    request.on('error', reject);
  });
}

function normalize(value) {
  return String(value || '').toLocaleLowerCase().replace(/[\s·・()（）\[\]【】\-_/\\]/g, '');
}

function uniqueText(values) {
  return [...new Set(values.map((value) => String(value || '').replace(/\s+/g, ' ').trim()).filter(Boolean))];
}

function titleVariants(value) {
  const original = String(value || '').replace(/\s+/g, ' ').trim();
  const versionWords = '(?:live|现场|伴奏|纯音乐|instrumental|karaoke|翻唱|cover|remaster(?:ed)?|version|ver\\.?|edit|mix|录音室版|重制版)';
  const withoutVersion = original
    .replace(new RegExp(`[\\[(（【][^\\])）】]*${versionWords}[^\\])）】]*[\\])）】]`, 'gi'), ' ')
    .replace(new RegExp(`\\s*[-–—]\\s*[^-–—]*${versionWords}[^-–—]*$`, 'i'), ' ')
    .replace(new RegExp(`\\s+${versionWords}\\s*$`, 'i'), ' ');
  const withoutAttribution = withoutVersion
    .replace(/\s*[（(【[]?《[^》]+》[^）)】\]]*(?:主题曲|片尾曲|插曲|印象曲|宣传曲)[）)】\]]?\s*/g, ' ')
    .replace(/\s*[（(【[][^）)】\]]*(?:主题曲|片尾曲|插曲|印象曲|宣传曲)[）)】\]]\s*/g, ' ');
  const withoutTrailingBrackets = withoutAttribution.replace(/\s*[（(【[][^）)】\]]+[）)】\]]\s*$/g, ' ');
  return uniqueText([original, withoutVersion, withoutAttribution, withoutTrailingBrackets]);
}

function artistVariants(value) {
  const original = String(value || '').replace(/\s+/g, ' ').trim();
  const withoutFeaturing = original.replace(/\s+(?:feat\.?|ft\.?)\s+.*$/i, '').trim();
  const primary = withoutFeaturing.split(/\s*(?:\/|、|,|，|;|；|&|＆)\s*/)[0];
  return uniqueText([original, withoutFeaturing, primary]);
}

function normalizedVariants(values) {
  return uniqueText(values.map(normalize));
}

function bestTitleScore(item, track) {
  const wanted = normalizedVariants(titleVariants(track.title));
  const candidates = normalizedVariants(titleVariants(item.trackName));
  let score = 0;
  for (const title of wanted) {
    for (const candidate of candidates) {
      if (candidate === title) score = Math.max(score, 100);
      else if (Math.min(candidate.length, title.length) >= 2 &&
        (candidate.includes(title) || title.includes(candidate))) score = Math.max(score, 55);
    }
  }
  return score;
}

function bestArtistScore(item, track) {
  const wanted = normalizedVariants(artistVariants(track.artist));
  if (!wanted.length) return 0;
  const candidates = normalizedVariants(artistVariants(item.artistName));
  let score = 0;
  for (const artist of wanted) {
    for (const candidate of candidates) {
      if (candidate === artist) score = Math.max(score, 50);
      else if (Math.min(candidate.length, artist.length) >= 2 &&
        (candidate.includes(artist) || artist.includes(candidate))) score = Math.max(score, 30);
    }
  }
  return score;
}

function resultScore(item, track) {
  let score = bestTitleScore(item, track) + bestArtistScore(item, track);
  if (track.duration && item.duration) {
    const difference = Math.abs(track.duration - item.duration);
    if (difference <= 2) score += 25;
    else if (difference <= 8) score += 15;
  }
  if (item.syncedLyrics) score += 20;
  return score;
}

function isConfidentResult(item, track) {
  const titleScore = bestTitleScore(item, track);
  const artistScore = bestArtistScore(item, track);
  const durationDifference = track.duration && item.duration
    ? Math.abs(track.duration - item.duration)
    : Infinity;
  const supportingMatch = !track.artist || artistScore >= 30 || durationDifference <= 8;
  return item?.syncedLyrics && supportingMatch && (
    titleScore >= 100 || (titleScore >= 55 && artistScore >= 50)
  );
}

function selectBestResult(results, track) {
  const best = results
    .filter((item) => isConfidentResult(item, track))
    .sort((left, right) => resultScore(right, track) - resultScore(left, track))[0];
  return best || null;
}

function searchQueries(track) {
  const titles = titleVariants(track.title);
  const artists = artistVariants(track.artist);
  const primaryTitle = titles[titles.length - 1] || track.title;
  const primaryArtist = artists[artists.length - 1] || track.artist;
  const queries = [];
  const add = (parameters) => {
    const query = new URLSearchParams(parameters).toString();
    if (query && !queries.includes(query)) queries.push(query);
  };
  add({ track_name: track.title, artist_name: track.artist || '' });
  add({ track_name: primaryTitle, artist_name: primaryArtist || '' });
  if (primaryArtist) add({ q: `${primaryTitle} ${primaryArtist}` });
  add({ track_name: primaryTitle });
  return queries;
}

function parseSyncedLyrics(source) {
  const timed = [];
  for (const rawLine of String(source || '').split(/\r?\n/)) {
    const stamps = [...rawLine.matchAll(/\[(\d{1,3}):(\d{2}(?:\.\d{1,3})?)\]/g)];
    const text = rawLine.replace(/\[[^\]]+\]/g, '').trim();
    if (!text) continue;
    for (const stamp of stamps) {
      timed.push({ time: Number(stamp[1]) * 60 + Number(stamp[2]), text });
    }
  }
  timed.sort((left, right) => left.time - right.time);
  const merged = [];
  for (const line of timed) {
    const previous = merged[merged.length - 1];
    if (previous && Math.abs(previous.time - line.time) < 0.05) previous.text += ` / ${line.text}`;
    else merged.push(line);
  }
  return merged;
}

class LyricsService {
  constructor({ app, systemPreferences, productName, clientHeader, onUpdate, onStatus, platform = process.platform }) {
    this.app = app;
    this.systemPreferences = systemPreferences;
    this.onUpdate = onUpdate;
    this.onStatus = onStatus;
    this.productName = productName || app.getName();
    this.platform = platform;
    this.clientHeader = clientHeader || DEFAULT_CLIENT_HEADER;
    this.playerAdapters = new PlayerAdapters({ platform, systemPreferences, appDir: __dirname });
    this.simplifyScript = externalFilePath(__dirname, 'simplify-chinese.js');
    this.windowsSimplifyScript = externalFilePath(__dirname, 'simplify-chinese-windows.ps1');
    this.cacheDir = path.join(app.getPath('userData'), 'lyrics-cache');
    this.timer = null;
    this.running = false;
    this.lastTrackKey = '';
    this.track = null;
    this.lines = [];
    this.lastElapsed = 0;
    this.lastTick = Date.now();
    this.lastPlaying = false;
    this.permissionRequested = false;
    this.retryAt = 0;
    this.lyricsLoadedKey = '';
    this.directLyrics = null;
    this.lastDirectProbeAt = 0;
    this.directStatus = null;
    this.lastPlayerKey = '';
    this.generation = 0;
    this.lookup = null;
    this.lookupRetryAt = 0;
    this.lookupFailures = 0;
    this.lookupError = '';
  }

  permission(prompt = false) {
    return this.playerAdapters.permission(prompt);
  }

  status(state, message) {
    this.onStatus({ state, message, permission: this.permission(false) });
  }

  start({ promptForPermission = false } = {}) {
    this.stop(false);
    if (promptForPermission && !this.permission(false)) {
      this.permissionRequested = true;
      this.permission(true);
    }
    this.running = true;
    this.tick();
    this.timer = setInterval(() => this.tick(), 1200);
  }

  stop(clear = true) {
    this.running = false;
    this.generation += 1;
    this.lookup = null;
    this.directLyrics = null;
    this.lastDirectProbeAt = 0;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (clear) this.onUpdate({ visible: false });
  }

  trackKey(track) {
    return `${normalize(track.title)}|${normalize(track.artist)}|${Math.round(track.duration || 0)}`;
  }

  async readTrack() {
    return this.playerAdapters.readTrack();
  }

  cachePath(key, version = CACHE_VERSION) {
    const hash = crypto.createHash('sha256').update(`${version}|${key}`).digest('hex');
    return path.join(this.cacheDir, `${hash}.json`);
  }

  readCache(key) {
    try {
      const cached = JSON.parse(fs.readFileSync(this.cachePath(key), 'utf8'));
      const negativeExpired = !cached.lines?.length &&
        Date.now() - Number(cached.fetchedAt || 0) >= NEGATIVE_CACHE_TTL;
      return negativeExpired ? null : cached;
    }
    catch (_error) {
      try {
        const legacyPath = path.join(this.cacheDir, `${crypto.createHash('sha256').update(key).digest('hex')}.json`);
        const legacy = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
        if (!legacy.lines?.length) return null;
        this.writeCache(key, legacy);
        return legacy;
      } catch (_legacyError) { return null; }
    }
  }

  writeCache(key, payload) {
    fs.mkdirSync(this.cacheDir, { recursive: true });
    fs.writeFileSync(this.cachePath(key), JSON.stringify(payload), 'utf8');
  }

  async simplifyLines(lines) {
    if (!Array.isArray(lines) || !lines.length) return [];
    try {
      const source = JSON.stringify(lines.map((line) => line.text));
      let output;
      if (this.platform === 'darwin') {
        output = await runFile('/usr/bin/osascript', [
          '-l', 'JavaScript', this.simplifyScript, source
        ], 5000);
      } else if (this.platform === 'win32') {
        output = await runFile('powershell.exe', [
          '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-File', this.windowsSimplifyScript,
          Buffer.from(source, 'utf8').toString('base64')
        ], 5000);
      } else {
        return lines;
      }
      const simplified = JSON.parse(output || '[]');
      if (!Array.isArray(simplified) || simplified.length !== lines.length) return lines;
      return lines.map((line, index) => ({ ...line, text: simplified[index] || line.text }));
    } catch (_error) {
      return lines;
    }
  }

  async probeDirectLyrics(track, force = false) {
    const now = Date.now();
    const interval = this.directLyrics ? 800 : 1800;
    if (!force && now - this.lastDirectProbeAt < interval) {
      return this.directLyrics?.expiresAt > now ? this.directLyrics : null;
    }
    this.lastDirectProbeAt = now;
    const generation = this.generation;
    const result = await this.playerAdapters.readDirectLyrics(track);
    if (generation !== this.generation || !this.running) return null;
    this.directStatus = result;
    if (result?.state === 'ok' && result.current) {
      // Mirror the player's text verbatim, including Japanese kanji/translation.
      this.directLyrics = {
        ...result,
        expiresAt: Date.now() + 1800
      };
    } else {
      this.directLyrics = null;
    }
    return this.directLyrics;
  }

  renderDirect(track, direct) {
    this.status('active', `${direct.playerName}${direct.sourceKind === 'local-cache' ? '本地缓存' : '原生'}歌词已连接`);
    this.onUpdate({
      visible: true,
      title: track.artist ? `${track.title} · ${track.artist}` : track.title,
      current: direct.current,
      next: direct.next || '',
      playing: track.playing,
      source: 'player',
      playerName: direct.playerName
    });
  }

  async fetchLyrics(track, key) {
    const cached = this.readCache(key);
    if (cached) return { ...cached, lines: await this.simplifyLines(cached.lines) };
    if (Date.now() < this.retryAt) throw new Error('歌词服务稍后重试');
    const collected = new Map();
    let best = null;
    const queries = searchQueries(track);
    for (let index = 0; index < queries.length; index += 1) {
      const results = await requestJson(
        `https://lrclib.net/api/search?${queries[index]}`,
        this.clientHeader
      );
      for (const item of Array.isArray(results) ? results : []) {
        collected.set(item.id ?? `${item.trackName}|${item.artistName}|${item.duration}`, item);
      }
      best = selectBestResult([...collected.values()], track);
      if (best || index === queries.length - 1) break;
      await new Promise((resolve) => setTimeout(resolve, SEARCH_DELAY));
    }
    const payload = best
      ? {
          lines: await this.simplifyLines(parseSyncedLyrics(best.syncedLyrics)),
          instrumental: Boolean(best.instrumental),
          duration: Number(best.duration) || 0,
          fetchedAt: Date.now()
        }
      : { lines: [], instrumental: false, duration: 0, fetchedAt: Date.now() };
    this.writeCache(key, payload);
    return payload;
  }

  estimatedElapsed(track) {
    const now = Date.now();
    let elapsed = Number.isFinite(track.elapsed) ? track.elapsed : this.lastElapsed;
    if (track.playing && !Number.isFinite(track.elapsed)) elapsed += (now - this.lastTick) / 1000;
    this.lastElapsed = Math.max(0, elapsed || 0);
    this.lastTick = now;
    this.lastPlaying = track.playing;
    return this.lastElapsed;
  }

  render(track) {
    const elapsed = this.estimatedElapsed(track);
    let index = -1;
    for (let cursor = 0; cursor < this.lines.length; cursor += 1) {
      if (this.lines[cursor].time <= elapsed + 0.08) index = cursor;
      else break;
    }
    const current = index >= 0 ? this.lines[index].text : '♪';
    const next = this.lines[index + 1]?.text || '';
    this.onUpdate({
      visible: true,
      title: track.artist ? `${track.title} · ${track.artist}` : track.title,
      current,
      next,
      playing: track.playing
    });
  }

  beginLookup(track, key) {
    if (this.lookup?.key === key || Date.now() < Math.max(this.lookupRetryAt, this.retryAt)) return;
    if (this.lyricsLoadedKey === key && this.lines.length) return;
    const lookup = { key, generation: this.generation };
    this.lookup = lookup;
    const isCurrent = () => this.running && this.generation === lookup.generation &&
      this.lastTrackKey === key && this.lookup === lookup;
    // A slow online source must not stop native lyric polling for seconds.
    lookup.promise = this.fetchLyrics({ ...track }, key).then((lyrics) => {
      if (!isCurrent()) return;
      this.lines = lyrics.lines || [];
      this.lyricsLoadedKey = key;
      this.lyricsDuration = lyrics.duration || 0;
      this.lookupFailures = 0;
      this.lookupError = '';
      this.lookupRetryAt = this.lines.length ? 0 : (Number(lyrics.fetchedAt) || Date.now()) + NEGATIVE_CACHE_TTL;
    }).catch((error) => {
      if (!isCurrent()) return;
      if (error.retryAfter) this.retryAt = Date.now() + error.retryAfter * 1000;
      this.lookupFailures += 1;
      this.lookupRetryAt = Math.max(this.retryAt, Date.now() + Math.min(120000, 15000 * 2 ** Math.min(this.lookupFailures - 1, 3)));
      this.lookupError = error.message || '歌词查询失败';
      this.lyricsLoadedKey = '';
    }).finally(() => {
      if (this.lookup === lookup) this.lookup = null;
    });
  }

  renderUnavailable(track) {
    const direct = this.directStatus;
    let state = this.lookupError ? 'error' : (this.lookup ? 'loading' : 'missing');
    let current = this.lookupError ? '在线歌词查询失败' : (this.lookup ? '正在查找歌词…' : '在线歌词暂未匹配');
    let next = this.lookupError ? '会自动重试' : '';
    if (direct) {
      current = `未读取到${direct.playerName}原生歌词`;
      if (direct.state === 'permission') {
        state = 'permission';
        next = direct.permissionType === 'automation'
          ? '请在自动化中允许桌宠访问系统事件'
          : '请允许桌宠的辅助功能权限';
      } else if (direct.state === 'no-windows') {
        next = '系统未返回播放器窗口，请检查权限和窗口状态';
      } else if (direct.state === 'ambiguous') {
        next = '无法确认当前行，请开启播放器桌面歌词';
      } else if (direct.state === 'unreadable') {
        next = '歌词文字暂不可读取，请尝试开启桌面歌词';
      } else if (direct.state === 'timeout' || direct.state === 'error') {
        state = 'error';
        next = '播放器读取失败，正在自动重试';
      } else {
        next = '请打开播放器歌词页或桌面歌词';
      }
    }
    this.status(state, `${current}；${next || '继续等待播放器歌词'}`);
    this.onUpdate({ visible: true, title: track.artist ? `${track.title} · ${track.artist}` : track.title, current, next });
  }

  async tick() {
    if (!this.running || this.ticking) return;
    this.ticking = true;
    const generation = this.generation;
    try {
      const track = await this.readTrack();
      if (!this.running || generation !== this.generation) return;
      if (track?.state === 'permission') {
        this.status('permission', '需要在系统设置中允许辅助功能');
        this.onUpdate({
          visible: true,
          title: '通用同步歌词',
          current: '需要辅助功能权限',
          next: `请在系统设置中允许${this.productName}`
        });
        return;
      }
      if (!track?.title) {
        this.directLyrics = null;
        this.directStatus = null;
        this.lastPlayerKey = '';
        if (track?.state === 'ambiguous-players') {
          this.status('waiting', '检测到多个音乐播放器，暂时无法确认当前歌曲');
          this.onUpdate({ visible: true, title: '通用同步歌词', current: '检测到多个音乐播放器', next: '请切到正在听的播放器，或暂时退出另一个' });
          return;
        }
        this.status('waiting', '等待音乐播放');
        this.onUpdate({ visible: true, title: '通用同步歌词', current: '等待音乐播放', next: '' });
        return;
      }

      const key = this.trackKey(track);
      const trackChanged = key !== this.lastTrackKey;
      if (trackChanged) {
        this.lastTrackKey = key;
        this.track = track;
        this.lines = [];
        this.lyricsLoadedKey = '';
        this.lookupRetryAt = 0;
        this.lookupFailures = 0;
        this.lookupError = '';
        this.lyricsDuration = 0;
        this.directLyrics = null;
        this.lastDirectProbeAt = 0;
        this.lastElapsed = Number.isFinite(track.elapsed) ? track.elapsed : 0;
        this.lastTick = Date.now();
        this.onUpdate({ visible: true, title: track.title, current: '正在查找歌词…', next: '' });
      }

      const playerKey = track.sourceAppId || track.bundleId || track.playerId || track.appName || '';
      const playerChanged = playerKey !== this.lastPlayerKey;
      if (playerChanged) {
        this.lastPlayerKey = playerKey;
        this.directLyrics = null;
        this.directStatus = null;
      }
      const direct = await this.probeDirectLyrics(track, trackChanged || playerChanged);
      if (!this.running || generation !== this.generation) return;
      if (direct?.current) {
        this.renderDirect(track, direct);
        return;
      }

      // A caption or incomplete media session can identify a song without a clock.
      // Native text above remains usable, but timed lyrics require real progress.
      if (this.platform === 'win32' && !Number.isFinite(track.elapsed)) {
        this.status('progress-missing', `已识别${track.playerName}歌曲，未获得播放进度`);
        this.onUpdate({ visible: true, title: track.artist ? `${track.title} · ${track.artist}` : track.title,
          current: '已识别歌曲，未获得播放进度', next: '请尝试新版播放器，或打开主界面进度条' });
        return;
      }

      this.beginLookup(track, key);
      if (this.lines.length) {
        if (!track.duration && this.lyricsDuration) track.duration = this.lyricsDuration;
        if (Number.isFinite(track.progressRatio) && track.duration) track.elapsed = track.progressRatio * track.duration;
        this.status('active', '在线同步歌词已连接');
        this.render(track);
      } else this.renderUnavailable(track);
    } catch (_error) {
      if (this.running && generation === this.generation) {
        this.status('error', '播放器读取失败，正在自动重试');
        this.onUpdate({ visible: true, title: '音乐陪伴', current: '播放器读取失败', next: '正在自动重试' });
      }
    } finally {
      this.ticking = false;
    }
  }
}

module.exports = {
  LyricsService,
  artistVariants,
  parseSyncedLyrics,
  parseSongDescription,
  resultScore,
  searchQueries,
  selectBestResult,
  titleVariants
};
