param([switch]$Diagnostic)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$watch = [Diagnostics.Stopwatch]::StartNew()
$candidates = [Collections.Generic.List[object]]::new()
$readErrors = [Collections.Generic.List[object]]::new()
$clockControls = [Collections.Generic.List[object]]::new()
$players = @(
  @{ id = 'qqmusic'; label = 'QQ 音乐'; names = @('QQMusic') },
  @{ id = 'netease'; label = '网易云音乐'; names = @('cloudmusic', 'NeteaseCloudMusic', 'Orpheus') }
)
function Record-Error($stage, $failure) {
  if ($readErrors.Count -lt 8) { $readErrors.Add(@{ stage = $stage; error = [string]$failure.Exception.Message }) }
}
function Test-ClockPreview($target) {
  if ($target.record.playerId -ne 'qqmusic') { return $false }
  try {
    # QQ 19.42 replaces its elapsed label with the seek-hover position while
    # showing a small unnamed player-owned popup over the playback controls.
    # Ignore clocks during such popups; never use a preview as actual position.
    $main = $target.window.Current.BoundingRectangle
    $condition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ProcessIdProperty, $target.processId)
    foreach ($popup in $root.FindAll([Windows.Automation.TreeScope]::Children, $condition)) {
      $info = $popup.Current; $rect = $info.BoundingRectangle
      if ($info.ClassName -ne 'TXGuiFoundation' -or $info.Name -ne '' -or $info.IsOffscreen -or $rect.IsEmpty) { continue }
      if ($rect.Width -gt 0 -and $rect.Width -le $main.Width / 2 -and
        $rect.Height -gt 0 -and $rect.Height -le $main.Height / 3 -and
        $rect.Right -gt $main.Left -and $rect.Left -lt $main.Right -and
        $rect.Bottom -gt $main.Top + $main.Height * 2 / 3 -and $rect.Top -lt $main.Bottom) { return $true }
    }
    return $false
  } catch { Record-Error 'clock-preview' $_; return $true }
}
try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PetForeground {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
}
'@
  [uint32]$foregroundProcess = 0
  [void][PetForeground]::GetWindowThreadProcessId([PetForeground]::GetForegroundWindow(), [ref]$foregroundProcess)
  $root = [Windows.Automation.AutomationElement]::RootElement
  $walker = [Windows.Automation.TreeWalker]::RawViewWalker
  $targets = [Collections.Generic.List[object]]::new()
  # Capture captions before traversing custom UI; subtree failures must not erase them.
  foreach ($player in $players) {
    foreach ($process in @(Get-Process -Name $player.names -ErrorAction SilentlyContinue)) {
      try {
        $condition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ProcessIdProperty, $process.Id)
        foreach ($window in $root.FindAll([Windows.Automation.TreeScope]::Children, $condition)) {
          $info = $window.Current
          if ($info.Name -notmatch '\S\s+-\s+\S') { continue }
          if ($player.id -eq 'qqmusic' -and $info.ClassName -ne 'TXGuiFoundation') { continue }
          if ($player.id -eq 'netease' -and $info.ClassName -ne 'OrpheusBrowserHost') { continue }
          $record = [ordered]@{
            playerId = $player.id; sourceAppId = "$($player.id):$($process.ProcessName)"; appName = $player.label
            windowTitle = [string]$info.Name; className = [string]$info.ClassName; source = 'window-title'
            foreground = ($process.Id -eq $foregroundProcess); playing = $null
            elapsedTime = $null; duration = 0; album = ''
          }
          $candidates.Add($record)
          $targets.Add(@{ window = $window; record = $record; processId = $process.Id })
        }
      } catch { Record-Error 'window-captions' $_ }
    }
  }
  $visited = 0
  foreach ($target in $targets) {
    $target.record.clockPreviewActive = Test-ClockPreview $target
    $queue = [Collections.Generic.Queue[object]]::new()
    $queue.Enqueue(@{ element = $target.window; depth = 0 })
    while ($queue.Count -gt 0 -and $visited -lt 400 -and $watch.ElapsedMilliseconds -lt 2600) {
      $entry = $queue.Dequeue(); $visited++
      try {
        $element = $entry.element; $info = $element.Current
        if ($Diagnostic -and $clockControls.Count -lt 24 -and
          ($info.Name -match '^\s*(?:\d{1,3}:)?\d{1,2}:\d{2}(?:\s*[/／]\s*(?:\d{1,3}:)?\d{1,2}:\d{2})?\s*$|进度|^(播放|暂停|Play|Pause)$' -or $info.AutomationId -match 'progress|seek|position|timeline')) {
          $control = @{ playerId = $target.record.playerId; name = [string]$info.Name; automationId = [string]$info.AutomationId; controlType = [string]$info.ControlType.ProgrammaticName }
          try {
            $range = $null
            if ($element.TryGetCurrentPattern([Windows.Automation.RangeValuePattern]::Pattern, [ref]$range)) {
              $control.range = @{ value = $range.Current.Value; minimum = $range.Current.Minimum; maximum = $range.Current.Maximum }
            }
          } catch { Record-Error 'diagnostic-clock-control' $_ }
          $clockControls.Add($control)
        }
        foreach ($name in @([string]$info.Name, [string]$info.HelpText, [string]$info.ItemStatus)) {
          if ($name -match '^歌曲名[:：]\s*(.+?)\s*[-–—]\s*歌手名[:：]\s*(.+)$') {
            $target.record.title = $Matches[1].Trim(); $target.record.artist = $Matches[2].Trim()
          }
          if ($name -match '^(暂停播放|暂停|Pause)$') { $target.record.playing = $true }
          if ($name -match '^(开始播放|播放|Play)$' -and $null -eq $target.record.playing) { $target.record.playing = $false }
          if ($name -match '^\s*(\d{1,3}):(\d{2})\s*[/／]\s*(\d{1,3}):(\d{2})\s*$') {
            $elapsed = [double]$Matches[1] * 60 + [double]$Matches[2]
            $duration = [double]$Matches[3] * 60 + [double]$Matches[4]
            if ([int]$Matches[2] -lt 60 -and [int]$Matches[4] -lt 60 -and $duration -gt 0 -and $elapsed -le $duration) {
              $target.record.elapsedTime = $elapsed; $target.record.duration = $duration
            }
          }
        }
        if ($entry.depth -lt 12) {
          $child = $walker.GetFirstChild($element)
          while ($null -ne $child -and $queue.Count -lt 400 -and $watch.ElapsedMilliseconds -lt 2600) {
            $queue.Enqueue(@{ element = $child; depth = $entry.depth + 1 })
            $child = $walker.GetNextSibling($child)
          }
        }
      } catch { Record-Error 'status-node' $_ }
    }
  }
  $uiaTruncated = ($visited -ge 400 -or $watch.ElapsedMilliseconds -ge 2600)
  # Older Chromium/native players can expose MSAA without a UI Automation tree.
  try {
    . (Join-Path $PSScriptRoot 'windows-accessibility.ps1')
    foreach ($target in $targets) {
      if ($null -ne $target.record.elapsedTime) { continue }
      $nativeHandle = $target.window.Current.NativeWindowHandle
      if ($nativeHandle -eq 0) { continue }
      $legacy = [PetMsaaReader]::ReadWindow([long]$nativeHandle, 1400, 1200)
      $target.record.accessibilityNodes = @(Select-PetClockNodes $legacy.nodes)
      $target.record.accessibilityTruncated = $legacy.truncated
      if ($Diagnostic) { $target.record.accessibility = @{ visited = $legacy.visited; truncated = $legacy.truncated; errors = @($legacy.errors.ToArray()); windowClasses = @($legacy.windowClasses.ToArray()) } }
      if ($target.window.Current.Name -ne $target.record.windowTitle) {
        # A song change during traversal invalidates the old title/clock pair.
        $target.record.windowTitle = ''; $target.record.title = ''; $target.record.elapsedTime = $null
        $target.record.accessibilityNodes = @()
      }
    }
  } catch { Record-Error 'msaa-status' $_ }
  foreach ($target in $targets) {
    # Check both ends of traversal so a newly opened/closed popup cannot make
    # a sampled preview look like a normal clock.
    if ((Test-ClockPreview $target) -or $target.record.clockPreviewActive) {
      $target.record.clockPreviewActive = $true
      $target.record.elapsedTime = $null; $target.record.duration = 0
    }
  }
  $result = [ordered]@{ state = 'ok'; candidates = @($candidates.ToArray()); readErrors = @($readErrors.ToArray()); scannedNodes = $visited; truncated = $uiaTruncated }
  if ($Diagnostic) { $result.clockControls = @($clockControls.ToArray()) }
  $result | ConvertTo-Json -Compress -Depth 8
} catch {
  Record-Error 'setup' $_
  [ordered]@{ state = 'error'; candidates = @($candidates.ToArray()); readErrors = @($readErrors.ToArray()) } | ConvertTo-Json -Compress -Depth 8
}
