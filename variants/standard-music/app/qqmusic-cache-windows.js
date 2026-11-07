const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { decryptQrc } = require('./vendor/qrc-decoder/index.cjs');
const { parseNativeLyrics } = require('./qqmusic-cache');
const { LocalLyricsCache, MAX_LYRIC_BYTES, readBounded, decodeText } = require('./local-lyrics-cache');

// QMC1 format constants from GotKiCry/QQMusicMonitor (MIT).
// Attribution and source are retained in vendor/qqmusic-cache-format/.
const QMC_KEY = Buffer.from(
  'c34ad6ca9067f752d8a166629f5b0900c35e95239f13117ed8923fbc90bb740e' +
  'c347743d90aa3f51d8f411849fde951dc3c609d59ffa66f9d8f0f7a090a1d6f3' +
  'c3f3d6a190a0f7f0d8f966fa9fd509c6c31d95de9f8411f4d8513faa903d7447' +
  'c30e74bb90bc3f92d87e11139f23955ec300095b9f6266a1d852f76790cad64a', 'hex');
const QRC_MAGIC = Buffer.from('9825b0ace3028368e8fc6c', 'hex');

function decodeWindowsLyrics(buffer) {
  if (!buffer.length || buffer.length > MAX_LYRIC_BYTES) return [];
  if (buffer.subarray(0, 11).equals(QRC_MAGIC)) {
    const decoded = Buffer.from(buffer);
    for (let i = 0; i < decoded.length; i++) decoded[i] ^= QMC_KEY[(i <= 0x7fff ? i : i % 0x7fff) & 0x7f];
    const payload = decoded.subarray(11);
    if (!payload.length || payload.length % 8) return [];
    return parseNativeLyrics(decryptQrc(payload.toString('hex')));
  }
  // Plain LRC and XML are also used by QQ. Unknown encrypted formats fall back.
  return parseNativeLyrics(decodeText(buffer));
}

const filenameText = value => String(value || '').normalize('NFKC').toLowerCase()
  .replace(/[.<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim();

function parseCacheName(name) {
  const match = name.match(/^(.*?) - (.*?) - (\d+) - (.*?)_qm(ts)?\.(qrc|lrc)$/i);
  return match ? { artist: match[1], title: match[2], duration: Number(match[3]), album: match[4],
    translation: Boolean(match[5]), extension: match[6].toLowerCase(), stem: name.replace(/_qm(?:ts)?\.(qrc|lrc)$/i, ''), name } : null;
}

function matchesCacheName(file, track) {
  if (filenameText(file.title) !== filenameText(track.title)) return false;
  const artist = filenameText(track.artist);
  const artistVariants = [filenameText(file.artist), ...file.artist.split('_').map(filenameText)];
  const joined = filenameText(String(track.artist || '').split(/\s*\/\s*|、|\r?\n/).join('_'));
  if (artist ? !artistVariants.includes(artist) && filenameText(file.artist) !== joined : !track.album) return false;
  if (track.album && filenameText(file.album) !== filenameText(track.album)) return false;
  return !(track.duration > 0) || Math.abs(file.duration - track.duration) <= 2;
}

function configuredRoot(text) {
  const value = text.match(/^\s*Path\s*=\s*(.+?)\s*$/im)?.[1]?.replace(/^"|"$/g, '');
  if (!value || !path.win32.isAbsolute(value) || value.startsWith('\\\\')) return null;
  return /[\\/]WebkitCache[\\/]?$/i.test(value) ? path.win32.dirname(value.replace(/[\\/]$/, '')) : value;
}

class QQMusicWindowsCache extends LocalLyricsCache {
  constructor({ platform = process.platform, home = os.homedir(), env = process.env, roots } = {}) {
    super('qqmusic', 'QQ 音乐');
    this.platform = platform;
    this.home = home;
    this.env = env;
    this.roots = roots;
    this.rootMemo = null;
  }

  async findRoots() {
    if (this.roots) return this.roots;
    if (this.rootMemo?.expiresAt > Date.now()) return this.rootMemo.roots;
    const roots = [];
    const roaming = this.env.APPDATA || path.join(this.home, 'AppData/Roaming');
    const local = this.env.LOCALAPPDATA || path.join(this.home, 'AppData/Local');
    try {
      const root = configuredRoot(decodeText(await readBounded(path.join(roaming, 'Tencent/QQMusic/WebkitCachePath.ini'), 64 * 1024)));
      if (root) roots.push(root);
    } catch (_) { /* Use exact default locations when the setting is absent. */ }
    for (const base of [roaming, local]) roots.push(path.join(base, 'Tencent/QQMusicCache'), path.join(base, 'Tencent/QQMusic/QQMusicCache'));
    // Check only the known folder at each drive root; never recursively scan disks.
    for (let code = 67; code <= 90; code++) roots.push(`${String.fromCharCode(code)}:\\QQMusicCache`);
    this.rootMemo = { roots: [...new Set(roots)], expiresAt: Date.now() + 30000 };
    return this.rootMemo.roots;
  }

  async load(track) {
    if (this.platform !== 'win32') return null;
    for (const root of await this.findRoots()) {
      const folder = path.join(root, 'QQMusicLyricNew');
      const groups = new Map();
      let complete = true, count = 0;
      const started = Date.now();
      try {
        const directory = await fs.opendir(folder);
        for await (const entry of directory) {
          if (++count > 20000 || Date.now() - started > 300) { complete = false; break; }
          if (!entry.isFile()) continue;
          const file = parseCacheName(entry.name);
          if (!file || !matchesCacheName(file, track)) continue;
          const key = file.stem.toLowerCase();
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(file);
        }
      } catch (_) { continue; }
      if (!complete) continue;
      const matches = [...groups.values()].filter(files => files.some(file => !file.translation));
      // Never pick the newest of two different versions of the same title.
      if (matches.length > 1) return null;
      if (matches.length !== 1) continue;
      const selected = matches[0];
      const readPart = async translation => {
        for (const file of selected.filter(file => file.translation === translation).sort((a, b) => Number(a.extension !== 'qrc') - Number(b.extension !== 'qrc'))) {
          try {
            const lines = decodeWindowsLyrics(await readBounded(path.join(folder, file.name)));
            if (lines.length) return lines;
          } catch (_) { /* Try another representation or the native UI. */ }
        }
        return [];
      };
      const lines = await readPart(false);
      if (lines.length) return { lines, translation: await readPart(true) };
    }
    return null;
  }
}

module.exports = { QQMusicWindowsCache, decodeWindowsLyrics, configuredRoot, parseCacheName, matchesCacheName };
