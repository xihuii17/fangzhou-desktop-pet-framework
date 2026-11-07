ObjC.import('Foundation');

function value(info, key) {
  const item = info.valueForKey(key);
  if (!item) return null;
  try { return ObjC.unwrap(item); } catch (_error) { return String(item); }
}

function run() {
  try {
    const framework = $.NSBundle.bundleWithPath('/System/Library/PrivateFrameworks/MediaRemote.framework/');
    framework.load;
    const request = $.NSClassFromString('MRNowPlayingRequest');
    const playerPath = request.localNowPlayingPlayerPath;
    const item = request.localNowPlayingItem;
    if (!playerPath || !item) return JSON.stringify({});

    const info = item.nowPlayingInfo;
    const client = playerPath.client;
    const metadata = item.metadata;
    if (!info) {
      return JSON.stringify({
        error: 'Now Playing metadata unavailable',
        item: String(item),
        metadata: metadata ? String(metadata) : null
      });
    }
    const result = {
      appName: client ? ObjC.unwrap(client.displayName) : null,
      bundleId: client ? ObjC.unwrap(client.bundleIdentifier) : null,
      title: value(info, 'kMRMediaRemoteNowPlayingInfoTitle'),
      artist: value(info, 'kMRMediaRemoteNowPlayingInfoArtist'),
      album: value(info, 'kMRMediaRemoteNowPlayingInfoAlbum'),
      duration: value(info, 'kMRMediaRemoteNowPlayingInfoDuration'),
      elapsedTime: value(info, 'kMRMediaRemoteNowPlayingInfoElapsedTime'),
      playbackRate: value(info, 'kMRMediaRemoteNowPlayingInfoPlaybackRate'),
      timestamp: value(info, 'kMRMediaRemoteNowPlayingInfoTimestamp')
    };
    if (metadata) {
      try { result.position = Number(metadata.calculatedPlaybackPosition); } catch (_error) {}
    }
    return JSON.stringify(result);
  } catch (error) {
    return JSON.stringify({ error: String(error) });
  }
}
