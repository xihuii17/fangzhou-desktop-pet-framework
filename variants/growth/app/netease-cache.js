const path = require('node:path');
const os = require('node:os');
const { matchSong, parseNativeLyrics, localCommand } = require('./qqmusic-cache');
const { LocalLyricsCache, readBounded, cacheJson } = require('./local-lyrics-cache');
let sqlModule;

async function sqliteTrackRows(file, track) {
  // Read only a bounded snapshot, then query in memory. Never write or checkpoint
  // the player's database. Recent WAL-only rows may be absent; playlist files
  // above and the native reader remain the fallback for that case.
  const data = await readBounded(file, 16 * 1024 * 1024);
  if (data.subarray(0, 16).toString() !== 'SQLite format 3\u0000') return [];
  if (!sqlModule) {
    sqlModule = require('./vendor/sql.js/sql-wasm.js')({
      wasmBinary: await readBounded(path.join(__dirname, 'vendor/sql.js/sql-wasm.wasm'))
    }).catch(error => { sqlModule = null; throw error; });
  }
  const SQL = await sqlModule;
  const db = new SQL.Database(data);
  try {
    const result = db.exec("SELECT jsonStr FROM historyTracks WHERE json_extract(jsonStr,'$.name')=? COLLATE NOCASE LIMIT 201", [track.title]);
    const values = result[0]?.values || [];
    if (values.length > 200) throw new Error('Too many matching songs');
    return values.flatMap(([text]) => { try { return trackRows(JSON.parse(text)); } catch (_) { return []; } });
  } finally { db.close(); }
}

function trackRows(value) {
  // Visit known playlist containers only, with bounded depth and number of songs.
  const rows = [];
  let visited = 0;
  const visit = (item, depth) => {
    if (!item || typeof item !== 'object' || depth > 6) return;
    if (++visited > 20000) throw new Error('Playlist too large');
    if (Array.isArray(item)) { for (const child of item) visit(child, depth + 1); return; }
    if (item.name && /^\d+$/.test(String(item.id))) {
      const artists = item.artists || item.ar || [];
      rows.push({ id: String(item.id), name: item.name,
        singer: Array.isArray(artists) ? artists.map(artist => artist?.name || '').filter(Boolean).join('\n') : '',
        album: (item.album || item.al)?.name || '', duration: Number(item.duration || item.dt || 0) / 1000 });
      return;
    }
    for (const key of ['track', 'song', 'tracks', 'songs', 'list', 'data', 'queue']) if (item[key]) visit(item[key], depth + 1);
  };
  visit(value, 0);
  return rows;
}

function parseNeteaseLyrics(value, id) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const payload = value.data && typeof value.data === 'object' ? value.data : value;
  // The filename is also an ID. A conflicting embedded ID indicates stale or
  // mismatched data, never permission to display another song's lyrics.
  for (const item of [value, payload]) {
    if (item.musicId != null && String(item.musicId) !== id) return null;
    if (item.id != null && String(item.id) !== id) return null;
  }
  const firstLines = candidates => {
    for (const text of candidates) {
      const lines = parseNativeLyrics(text);
      if (lines.length) return lines;
    }
    return [];
  };
  const lines = firstLines([payload.lrc?.lyric, payload.lyric, payload.yrc?.lyric, payload.kalaokLyric, payload.klyric?.lyric]);
  const translation = firstLines([payload.tlyric?.lyric, payload.translateLyric, payload.ytlrc?.lyric]);
  return lines.length ? { lines, translation } : null;
}

class NeteaseCache extends LocalLyricsCache {
  constructor({ platform = process.platform, home = os.homedir(), env = process.env, roots, command = localCommand } = {}) {
    super('netease', '网易云音乐');
    this.platform = platform;
    this.command = command;
    this.macStorage = path.join(home, 'Library/Containers/com.netease.163music/Data/Documents/storage');
    // macOS lyric folders are compatibility candidates under the known player
    // storage root; their presence still needs validation on a real client.
    this.roots = roots || (platform === 'darwin' ? [path.join(this.macStorage, 'file_storage'), this.macStorage] :
      [...new Set([env.LOCALAPPDATA || path.join(home, 'AppData/Local'), env.APPDATA || path.join(home, 'AppData/Roaming')])]
        .flatMap(base => {
          const root = path.join(base, 'Netease/CloudMusic');
          return [root, path.join(root, 'storage/file_storage'), path.join(root, 'Data/storage/file_storage')];
        }));
  }

  async load(track) {
    if (!['darwin', 'win32'].includes(this.platform)) return null;
    const rows = [];
    for (const root of this.roots) {
      for (const name of ['queue', 'history', 'playingList']) {
        try { rows.push(...trackRows(cacheJson(await readBounded(path.join(root, 'webdata/file', name), 4 * 1024 * 1024)))); }
        catch (_) { /* A missing/partial/unsupported playlist is not a match. */ }
      }
    }
    if (this.platform === 'win32') {
      for (const root of this.roots) {
        for (const relative of ['storage/sqlite_storage.sqlite3', 'Data/storage/sqlite_storage.sqlite3', 'storage/file_storage/sqlite_storage.sqlite3']) {
          try { rows.push(...await sqliteTrackRows(path.join(root, relative), track)); } catch (_) { /* Missing, locked, oversized or new schema. */ }
        }
      }
    } else if (this.platform === 'darwin') {
      try {
        const title = String(track.title).replace(/'/g, "''");
        const result = JSON.parse(await this.command('/usr/bin/sqlite3', ['-readonly', '-json', path.join(this.macStorage, 'sqlite_storage.sqlite3'),
          `SELECT jsonStr FROM historyTracks WHERE json_extract(jsonStr,'$.name')='${title}' COLLATE NOCASE LIMIT 201;`]) || '[]');
        if (result.length > 200) return null;
        for (const row of result) { try { rows.push(...trackRows(JSON.parse(row.jsonStr))); } catch (_) {} }
      } catch (_) { /* Playlist files can still identify the song. */ }
    }
    const id = matchSong(rows, track);
    if (!id) return null;
    for (const root of this.roots) {
      for (const folder of ['webdata/lyric', 'webdata/lyrics']) {
        for (const suffix of ['', '.json']) {
          try {
            const lyrics = parseNeteaseLyrics(cacheJson(await readBounded(path.join(root, folder, id + suffix))), id);
            if (lyrics) return lyrics;
          } catch (_) { /* Fall back if the client has not saved usable lyrics. */ }
        }
      }
    }
    return null;
  }
}

module.exports = { NeteaseCache, trackRows, parseNeteaseLyrics, sqliteTrackRows };
