const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execFile } = require('child_process');

const QQ_MUSIC_BUNDLE_ID = 'com.tencent.QQMusicMac';
const DEFAULT_CLIENT_HEADER = 'DesktopCompanion/1.0 (personal macOS desktop companion)';
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

function parseSongDescription(description) {
  const match = String(description || '').match(/^歌曲名：(.*?)\s*-\s*歌手名：(.*)$/);
  if (!match) return null;
  return { title: match[1].trim(), artist: match[2].trim() };
}

async function readSystemNowPlaying(scriptPath) {
  try {
    const output = await runFile('/usr/bin/osascript', ['-l', 'JavaScript', scriptPath]);
    const info = JSON.parse(output || '{}');
    if (!info.title || (info.bundleId && info.bundleId !== QQ_MUSIC_BUNDLE_ID)) return null;
    return {
      title: String(info.title),
      artist: String(info.artist || ''),
      album: String(info.album || ''),
      duration: Number(info.duration) || 0,
      elapsed: Number(info.position ?? info.elapsedTime) || 0,
      playing: Number(info.playbackRate) > 0,
      source: 'system'
    };
  } catch (_error) {
    return null;
  }
}

async function readQQMusicAccessibility(scriptPath) {
  const output = await runFile('/usr/bin/osascript', [scriptPath], 5000);
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
    source: 'accessibility'
  };
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
  constructor({ app, systemPreferences, productName, clientHeader, onUpdate, onStatus }) {
    this.app = app;
    this.systemPreferences = systemPreferences;
    this.onUpdate = onUpdate;
    this.onStatus = onStatus;
    this.productName = productName || app.getName();
    this.clientHeader = clientHeader || DEFAULT_CLIENT_HEADER;
    this.systemScript = path.join(__dirname, 'now-playing.js');
    this.qqScript = path.join(__dirname, 'qqmusic-status.scpt');
    this.simplifyScript = path.join(__dirname, 'simplify-chinese.js');
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
  }

  permission(prompt = false) {
    return this.systemPreferences.isTrustedAccessibilityClient(Boolean(prompt));
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
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (clear) this.onUpdate({ visible: false });
  }

  trackKey(track) {
    return `${normalize(track.title)}|${normalize(track.artist)}|${Math.round(track.duration || 0)}`;
  }

  async readTrack() {
    const systemTrack = await readSystemNowPlaying(this.systemScript);
    if (systemTrack) return systemTrack;
    if (!this.permission(false)) return { state: 'permission' };
    try { return await readQQMusicAccessibility(this.qqScript); }
    catch (error) {
      if (/not allowed assistive access|-1719|不允许辅助访问/i.test(String(error))) return { state: 'permission' };
      return { state: 'idle' };
    }
  }

  cachePath(key, version = CACHE_VERSION) {
    const hash = crypto.createHash('sha256').update(`${version}|${key}`).digest('hex');
    return path.join(this.cacheDir, `${hash}.json`);
  }

  readCache(key) {
    try {
      const cached = JSON.parse(fs.readFileSync(this.cachePath(key), 'utf8'));
      const negativeExpired = !cached.lines?.length &&
        Date.now() - Number(cached.fetchedAt || 0) > NEGATIVE_CACHE_TTL;
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
      const output = await runFile('/usr/bin/osascript', [
        '-l', 'JavaScript', this.simplifyScript, source
      ], 5000);
      const simplified = JSON.parse(output || '[]');
      if (!Array.isArray(simplified) || simplified.length !== lines.length) return lines;
      return lines.map((line, index) => ({ ...line, text: simplified[index] || line.text }));
    } catch (_error) {
      return lines;
    }
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

  async tick() {
    if (!this.running || this.ticking) return;
    this.ticking = true;
    try {
      const track = await this.readTrack();
      if (track?.state === 'permission') {
        this.status('permission', '需要在系统设置中允许辅助功能');
        this.onUpdate({
          visible: true,
          title: 'QQ 音乐同步歌词',
          current: '需要辅助功能权限',
          next: `请在系统设置中允许${this.productName}`
        });
        return;
      }
      if (!track?.title) {
        this.status('waiting', '等待 QQ 音乐播放');
        this.onUpdate({ visible: true, title: 'QQ 音乐同步歌词', current: '等待 QQ 音乐播放', next: '' });
        return;
      }

      const key = this.trackKey(track);
      if (key !== this.lastTrackKey) {
        this.lastTrackKey = key;
        this.track = track;
        this.lines = [];
        this.lastElapsed = Number.isFinite(track.elapsed) ? track.elapsed : 0;
        this.lastTick = Date.now();
        this.onUpdate({ visible: true, title: track.title, current: '正在查找歌词…', next: '' });
        try {
          const lyrics = await this.fetchLyrics(track, key);
          this.lines = lyrics.lines || [];
          if (!track.duration && lyrics.duration) track.duration = lyrics.duration;
          if (Number.isFinite(track.progressRatio) && track.duration) {
            track.elapsed = track.progressRatio * track.duration;
          }
          this.status(this.lines.length ? 'active' : 'missing', this.lines.length ? '同步歌词已连接' : '这首歌暂未找到同步歌词');
        } catch (error) {
          if (error.retryAfter) this.retryAt = Date.now() + error.retryAfter * 1000;
          this.status('error', error.message || '歌词查询失败');
          this.lines = [];
        }
      }

      if (this.lines.length) this.render(track);
      else this.onUpdate({
        visible: true,
        title: track.artist ? `${track.title} · ${track.artist}` : track.title,
        current: '暂未找到同步歌词',
        next: ''
      });
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
