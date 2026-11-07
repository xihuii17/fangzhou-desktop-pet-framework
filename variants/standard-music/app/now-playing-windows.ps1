param([switch]$Diagnostic)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Await-WinRt($operation, [Type]$resultType) {
  $method = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetGenericArguments().Count -eq 1 -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } |
    Select-Object -First 1
  $task = $method.MakeGenericMethod($resultType).Invoke($null, @($operation))
  if (-not $task.Wait(1800)) { throw 'Windows media operation timed out' }
  $task.GetAwaiter().GetResult()
}

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime] | Out-Null
  [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType=WindowsRuntime] | Out-Null
  $managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
  $propertiesType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]
  $manager = Await-WinRt ($managerType::RequestAsync()) $managerType
  $current = $manager.GetCurrentSession()
  $sessions = @($manager.GetSessions())
  $errors = [Collections.Generic.List[object]]::new()
  $tracks = [Collections.Generic.List[object]]::new()
  foreach ($session in @($sessions | Sort-Object {
    $music = [string]$_.SourceAppUserModelId -match 'qqmusic|cloudmusic|netease|orpheus'
    $isCurrent = $null -ne $current -and $_.SourceAppUserModelId -eq $current.SourceAppUserModelId
    $playing = $false
    try { $playing = [string]$_.GetPlaybackInfo().PlaybackStatus -eq 'Playing' } catch {}
    if ($music -and $playing -and $isCurrent) { 0 } elseif ($music -and $playing) { 1 } elseif ($isCurrent) { 2 } elseif ($music) { 3 } else { 4 }
  } | Select-Object -First 4)) {
  try {
    $media = Await-WinRt ($session.TryGetMediaPropertiesAsync()) $propertiesType
    if ([string]::IsNullOrWhiteSpace([string]$media.Title)) { continue }
    $timeline = $session.GetTimelineProperties()
    $playback = $session.GetPlaybackInfo()
    $status = [string]$playback.PlaybackStatus
    $duration = [Math]::Max(0, $timeline.EndTime.TotalSeconds - $timeline.StartTime.TotalSeconds)
    $track = [ordered]@{
    sourceAppId = [string]$session.SourceAppUserModelId
    appName = [string]$session.SourceAppUserModelId
    title = [string]$media.Title
    artist = [string]$media.Artist
    album = [string]$media.AlbumTitle
    duration = $duration
    elapsedTime = if ($duration -gt 0) { [Math]::Max(0, $timeline.Position.TotalSeconds - $timeline.StartTime.TotalSeconds) } else { $null }
    playbackRate = if ($status -eq 'Playing') { 1 } else { 0 }
    playing = $status -eq 'Playing'
    }
    if ($Diagnostic) {
      $track.timeline = @{ position = $timeline.Position.TotalSeconds; start = $timeline.StartTime.TotalSeconds; end = $timeline.EndTime.TotalSeconds; lastUpdated = [string]$timeline.LastUpdatedTime; playbackStatus = $status }
    }
    $tracks.Add($track)
    if (-not $Diagnostic) { break }
  } catch { $errors.Add(@{ sourceAppId = [string]$session.SourceAppUserModelId; error = [string]$_.Exception.Message }) }
  }
  $result = [ordered]@{}
  if ($tracks.Count -gt 0) { foreach ($key in $tracks[0].Keys) { $result[$key] = $tracks[0][$key] } }
  else { $result.state = 'no-media-session' }
  if ($Diagnostic) { $result.sessions = @($tracks.ToArray()); $result.sessionErrors = @($errors.ToArray()); $result.sessionCount = $sessions.Count }
  $result | ConvertTo-Json -Compress -Depth 6 | Write-Output
} catch {
  [ordered]@{ state = 'error'; stage = 'system-media'; error = [string]$_.Exception.Message } | ConvertTo-Json -Compress | Write-Output
}
