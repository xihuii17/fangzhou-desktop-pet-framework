const clean = value => String(value || '').replace(/[\r\n\t]+/g, ' ').trim();
const applicationTitle = /^(?:QQ\s*音乐|QQMusic|网易云音乐|CloudMusic|NetEase\s*Cloud\s*Music|桌面歌词|歌词|Desktop Lyrics?)$/i;

function clockSeconds(value) {
  const text = clean(value);
  if (!/^(?:\d{1,2}:)?\d{1,3}:\d{2}$/.test(text)) return null;
  const parts = text.split(':').map(Number);
  if (parts.at(-1) >= 60 || (parts.length === 3 && parts[1] >= 60)) return null;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

function accessibleClock(nodes, allowSeparated = true) {
  if (!Array.isArray(nodes)) return null;
  const visible = nodes.filter(node => !(Number(node.state) & 0x20018000) && node.width > 0 && node.height > 0);
  const clocks = [];
  const add = (elapsedTime, duration) => {
    if (elapsedTime != null && duration > 0 && duration <= 86400 && elapsedTime >= 0 && elapsedTime <= duration) clocks.push({ elapsedTime, duration });
  };
  const volume = /音量|volume/i;
  for (const node of visible) {
    if (volume.test(node.name) || node.role === 42) continue;
    for (const text of [node.value, node.name]) {
      const pair = clean(text).match(/^((?:\d{1,2}:)?\d{1,3}:\d{2})\s*[/／]\s*((?:\d{1,2}:)?\d{1,3}:\d{2})$/);
      if (pair) add(clockSeconds(pair[1]), clockSeconds(pair[2]));
    }
  }
  // Separate labels need either a sibling progress control or an explicit
  // elapsed / duration text row. Playlist durations and unitless sliders do
  // not establish a clock. Partial trees cannot prove uniqueness.
  const groups = new Map();
  for (const node of visible) {
    if (!(node.parentId > 0)) continue;
    if (!groups.has(node.parentId)) groups.set(node.parentId, []);
    groups.get(node.parentId).push(node);
  }
  for (const siblings of groups.values()) {
    if (!allowSeparated) break;
    const progress = siblings.some(node => [48, 51].includes(node.role) && !volume.test(node.name));
    const times = siblings.filter(node => [41, 61].includes(node.role)).map(node => {
      const text = clean(node.value || node.name).replace(/^[/／]\s*/, '');
      return { ...node, seconds: clockSeconds(text) };
    }).filter(node => node.seconds != null);
    if (times.length !== 2) continue;
    times.sort((left, right) => left.x - right.x);
    if (times[1].x <= times[0].x || Math.abs(times[1].y - times[0].y) > 24) continue;
    if (!progress) {
      const separators = siblings.filter(node => [41, 61].includes(node.role) && /^[/／]$/.test(clean(node.name)));
      const parent = visible.find(node => node.id === times[0].parentId);
      const height = Math.max(times[0].height, times[1].height);
      const separator = separators[0];
      if (separators.length !== 1 || !parent || ![16, 20].includes(parent.role) || volume.test(parent.name) ||
        parent.height > height * 2 || parent.width > times[0].width + times[1].width + height * 2 ||
        separator.x < times[0].x + times[0].width - 2 || separator.x + separator.width > times[1].x + 2 ||
        separator.width > height || Math.abs(separator.y - times[0].y) > height / 2 ||
        Math.abs(times[1].y - times[0].y) > height / 2 ||
        times[1].x - times[0].x - times[0].width > height * 2) continue;
    }
    add(times[0].seconds, times[1].seconds);
  }
  if (!clocks.length || clocks.some(clock => clock.duration !== clocks[0].duration || Math.abs(clock.elapsedTime - clocks[0].elapsedTime) > 1)) return null;
  return clocks[0];
}

function accessiblePlaybackState(nodes) {
  if (!Array.isArray(nodes)) return null;
  const states = new Set();
  for (const node of nodes) {
    // MSAA push/menu/split buttons can expose transport state even when UIA
    // has no descendants. Text, icons and disabled/hidden controls are not proof.
    if (![43, 56, 57, 58, 62].includes(node.role) || (Number(node.state) & 0x20018001) ||
      !(node.width > 0 && node.height > 0)) continue;
    const name = clean(node.name);
    if (/^(暂停播放|暂停|Pause)$/i.test(name)) states.add(true);
    if (/^(开始播放|播放|Play)$/i.test(name)) states.add(false);
  }
  return states.size === 1 ? [...states][0] : null;
}

function sameWindowsSong(expected, candidate) {
  const normalized = value => clean(value).normalize('NFKC').toLowerCase();
  if (expected.playerId !== candidate.playerId || normalized(expected.title) !== normalized(candidate.title)) return false;
  const artists = value => normalized(value).split(/\s*\/\s*|、/).filter(Boolean);
  const first = artists(expected.artist), second = artists(candidate.artist);
  if (first.length && (!second.length || !first.some(artist => second.includes(artist)))) return false;
  return !(expected.duration > 0 && candidate.duration > 0) || Math.abs(expected.duration - candidate.duration) <= 2;
}

function parseWindowTitle(value, playerId, className) {
  if (!['qqmusic', 'netease'].includes(playerId)) return null;
  if (className && !(playerId === 'qqmusic' ? /TXGuiFoundation/i : /OrpheusBrowserHost/i).test(className)) return null;
  const caption = clean(value).replace(/\s+-\s+(?:QQ\s*音乐|网易云音乐)$/i, '');
  const divider = caption.lastIndexOf(' - ');
  if (divider <= 0 || caption.length > 700) return null;
  const title = caption.slice(0, divider).trim(), artist = caption.slice(divider + 3).trim();
  if (!title || !artist || applicationTitle.test(title) || applicationTitle.test(artist)) return null;
  return { title, artist };
}

function chooseWindowsTrack(snapshot, expected) {
  if (!Array.isArray(snapshot?.candidates)) return snapshot?.title && (!expected || sameWindowsSong(expected, snapshot)) ? snapshot : null;
  const unique = new Map();
  for (const candidate of snapshot.candidates) {
    const song = candidate.title ? { title: clean(candidate.title), artist: clean(candidate.artist) } :
      parseWindowTitle(candidate.windowTitle, candidate.playerId, candidate.className);
    if (!song?.title) continue;
    const clock = !candidate.clockPreviewActive && accessibleClock(candidate.accessibilityNodes, !candidate.accessibilityTruncated);
    const playbackState = typeof candidate.playing === 'boolean' ? candidate.playing : accessiblePlaybackState(candidate.accessibilityNodes);
    const track = { ...candidate, ...song, source: 'window-title', playing: playbackState === true,
      elapsedTime: !candidate.clockPreviewActive && Number.isFinite(candidate.elapsedTime) && candidate.elapsedTime >= 0 ? candidate.elapsedTime : null };
    if (track.elapsedTime == null && clock) Object.assign(track, clock, { source: 'accessibility' });
    if (expected && !sameWindowsSong(expected, track)) continue;
    const key = JSON.stringify([track.playerId, track.title, track.artist]);
    const previous = unique.get(key);
    if (!previous || track.playing || track.foreground || Number.isFinite(track.elapsedTime)) unique.set(key, track);
  }
  const candidates = [...unique.values()];
  const playing = candidates.filter(track => track.playing);
  if (playing.length === 1) return playing[0];
  const foreground = (playing.length ? playing : candidates).filter(track => track.foreground);
  if (foreground.length === 1) return foreground[0];
  if (candidates.length === 1) return candidates[0];
  return candidates.length ? { state: 'ambiguous-players', players: [...new Set(candidates.map(track => track.appName))] } : null;
}

module.exports = { parseWindowTitle, chooseWindowsTrack, clockSeconds, accessibleClock, accessiblePlaybackState, sameWindowsSong };
