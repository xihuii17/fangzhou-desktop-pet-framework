param(
  [string]$SourceAppId = '',
  [string]$Player = '',
  [switch]$Diagnostic
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$watch = [Diagnostics.Stopwatch]::StartNew()
$budgetMs = 2600
$visited = 0
$failed = 0
$resultWindows = [Collections.Generic.List[object]]::new()
$observed = [Collections.Generic.List[object]]::new()
$readErrors = [Collections.Generic.List[object]]::new()
function Record-ReadError($stage, $failure) {
  if ($readErrors.Count -lt 10) { $readErrors.Add(@{ stage = $stage; error = [string]$failure.Exception.Message }) }
}

function Bounds-Object($rectangle) {
  [ordered]@{ x = [double]$rectangle.X; y = [double]$rectangle.Y; width = [double]$rectangle.Width; height = [double]$rectangle.Height }
}

function Is-LyricsRegion($element) {
  $info = $element.Current
  # A lyric-labelled button is not a lyric container. Size alone proves nothing.
  if ($info.ControlType -in @(
    [Windows.Automation.ControlType]::Button,
    [Windows.Automation.ControlType]::MenuItem,
    [Windows.Automation.ControlType]::CheckBox,
    [Windows.Automation.ControlType]::Hyperlink
  )) { return $false }
  return ($info.AutomationId -match 'lyric|歌词' -or
    $info.ClassName -match 'lyric|歌词' -or
    $info.Name -match '^(?:(QQ音乐|QQ 音乐|网易云音乐)\s*[-·:]?\s*)?(桌面歌词|歌词|歌词面板|歌词窗口|滚动歌词|Desktop Lyrics?|Lyrics?)(\s*[-|·].*)?$')
}

function Add-Text($list, $value, $bounds, $selected, $current, $origin) {
  if ([string]::IsNullOrWhiteSpace($value) -or $value.Length -gt 4000) { return }
  $list.Add([ordered]@{ text = [string]$value; selected = [bool]$selected; current = [bool]$current; bounds = $bounds; origin = $origin })
}

function Read-Text($element, $list) {
  $info = $element.Current
  if ($info.IsOffscreen) { return }
  $rect = $info.BoundingRectangle
  if ($rect.IsEmpty -or $rect.Width -le 0 -or $rect.Height -le 0) { return }
  $type = $info.ControlType
  if ($type -in @(
    [Windows.Automation.ControlType]::Button,
    [Windows.Automation.ControlType]::MenuItem,
    [Windows.Automation.ControlType]::CheckBox,
    [Windows.Automation.ControlType]::Slider,
    [Windows.Automation.ControlType]::Hyperlink
  )) { return }

  $bounds = Bounds-Object $rect
  $selected = $false
  $selection = $element.GetCurrentPropertyValue([Windows.Automation.SelectionItemPattern]::IsSelectedProperty, $true)
  if ($selection -is [bool]) { $selected = $selection }
  # Keyboard focus and manually selected text do not identify the sung line.
  $current = $info.ItemStatus -match '^(current|active|playing|当前|当前行|正在播放)$' -or
    $info.AutomationId -match '(current|active|playing)[_-]?lyric|lyric[_-]?(current|active|playing)'
  $textControl = $type -in @(
    [Windows.Automation.ControlType]::Text,
    [Windows.Automation.ControlType]::Edit,
    [Windows.Automation.ControlType]::Document,
    [Windows.Automation.ControlType]::ListItem
  )
  $pattern = $null
  $hasVisibleText = $false
  if ($element.TryGetCurrentPattern([Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) {
    # Keep each visible line's own bounds; don't collapse the whole document.
    $start = [Windows.Automation.Text.TextPatternRangeEndpoint]::Start
    $end = [Windows.Automation.Text.TextPatternRangeEndpoint]::End
    $lineCount = 0
    foreach ($visibleRange in $pattern.GetVisibleRanges()) {
      $cursor = $visibleRange.Clone()
      $cursor.MoveEndpointByRange($end, $cursor, $start)
      while ($cursor.CompareEndpoints($start, $visibleRange, $end) -lt 0 -and $lineCount -lt 64 -and $watch.ElapsedMilliseconds -lt $budgetMs) {
        $line = $cursor.Clone()
        $line.ExpandToEnclosingUnit([Windows.Automation.Text.TextUnit]::Line)
        if ($line.CompareEndpoints($start, $visibleRange, $start) -lt 0) { $line.MoveEndpointByRange($start, $visibleRange, $start) }
        if ($line.CompareEndpoints($end, $visibleRange, $end) -gt 0) { $line.MoveEndpointByRange($end, $visibleRange, $end) }
        $rects = @($line.GetBoundingRectangles())
        $value = $line.GetText(4000).Trim()
        if ($rects.Count -gt 0 -and $value -and $value -notmatch '[\r\n]') {
          Add-Text $list $value (Bounds-Object $rects[0]) $false $false 'text-pattern'
          $hasVisibleText = $true
        }
        $lineCount++
        if ($line.CompareEndpoints($end, $cursor, $start) -le 0) { break }
        $cursor.MoveEndpointByRange($start, $line, $end)
        $cursor.MoveEndpointByRange($end, $cursor, $start)
      }
    }
  }
  if ($textControl -and (-not $hasVisibleText -or $current -or $selected)) {
    Add-Text $list $info.Name $bounds $selected $current 'name'
  }
  $pattern = $null
  if (-not $hasVisibleText -and $element.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
    Add-Text $list $pattern.Current.Value $bounds $selected $current 'value'
  }
}

try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  Add-Type -AssemblyName WindowsBase
  $patterns = switch ($Player) {
    'qqmusic' { @('QQMusic') }
    'netease' { @('cloudmusic', 'NeteaseCloudMusic', 'Orpheus') }
    default { @() }
  }
  if ($patterns.Count -eq 0) {
    [ordered]@{ state = 'unsupported'; player = $Player; windows = @() } | ConvertTo-Json -Compress -Depth 8
    exit 0
  }
  $processes = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
    $processName = $_.ProcessName
    @($patterns | Where-Object { $processName -like "*$_*" }).Count -gt 0
  })
  $root = [Windows.Automation.AutomationElement]::RootElement
  $walker = [Windows.Automation.TreeWalker]::RawViewWalker
  foreach ($process in $processes) {
    $condition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ProcessIdProperty, $process.Id)
    # Scan small explicit lyric windows first, before a large library view uses
    # the traversal budget. We never infer a lyric window from its size.
    $windows = @($root.FindAll([Windows.Automation.TreeScope]::Children, $condition) | Sort-Object {
      try { [int](Is-LyricsRegion $_) } catch { 0 }
    } -Descending)
    foreach ($window in $windows) {
      if ($watch.ElapsedMilliseconds -ge $budgetMs) { break }
      try {
        $info = $window.Current
        if ($info.IsOffscreen -or $info.BoundingRectangle.IsEmpty) { continue }
        if ($Diagnostic) {
          $observed.Add([ordered]@{ name = $info.Name; className = $info.ClassName; automationId = $info.AutomationId; process = $process.ProcessName; bounds = Bounds-Object $info.BoundingRectangle })
        }
        # Search main windows too, but only read text inside lyric subtrees.
        $queue = [Collections.Generic.Queue[object]]::new()
        $queue.Enqueue(@{ element = $window; region = $null; depth = 0 })
        while ($queue.Count -gt 0 -and $visited -lt 1600 -and $watch.ElapsedMilliseconds -lt $budgetMs) {
          $entry = $queue.Dequeue()
          $visited++
          try {
            $element = $entry.element
            $node = $element.Current
            if ($node.IsOffscreen) { continue }
            $region = $entry.region
            if ($null -eq $region -and (Is-LyricsRegion $element)) {
              $region = [ordered]@{
                name = $node.Name
                kind = if ($entry.depth -eq 0) { 'overlay' } else { 'lyrics-region' }
                preferred = $true
                bounds = Bounds-Object $node.BoundingRectangle
                texts = [Collections.Generic.List[object]]::new()
                nativeHandle = if ($entry.depth -eq 0) { $node.NativeWindowHandle } else { 0 }
              }
              $resultWindows.Add($region)
            }
            if ($null -ne $region) { try { Read-Text $element $region.texts } catch { $failed++; Record-ReadError 'read-text' $_ } }
            if ($entry.depth -lt 24) {
              $child = $walker.GetFirstChild($element)
              while ($null -ne $child -and $queue.Count -lt 1600 -and $watch.ElapsedMilliseconds -lt $budgetMs) {
                $queue.Enqueue(@{ element = $child; region = $region; depth = $entry.depth + 1 })
                $child = $walker.GetNextSibling($child)
              }
            }
          } catch { $failed++; Record-ReadError 'read-node' $_ }
        }
      } catch { $failed++; Record-ReadError 'read-window' $_ }
    }
  }
  $uiaTruncated = ($visited -ge 1600 -or $watch.ElapsedMilliseconds -ge $budgetMs)
  try {
    $overlays = @($resultWindows | Where-Object { $_.kind -eq 'overlay' -and $_.texts.Count -eq 0 -and $_.nativeHandle -ne 0 } | Select-Object -First 3)
    if ($overlays.Count -gt 0) { . (Join-Path $PSScriptRoot 'windows-accessibility.ps1') }
    foreach ($overlay in $overlays) {
      $legacy = [PetMsaaReader]::ReadWindow([long]$overlay.nativeHandle, 800, 400)
      if ($Diagnostic) { $overlay.accessibility = @{ visited = $legacy.visited; truncated = $legacy.truncated; errors = @($legacy.errors.ToArray()); windowClasses = @($legacy.windowClasses.ToArray()) } }
      if ($legacy.truncated) { continue }
      foreach ($node in $legacy.nodes) {
        # Mirror text in a named desktop-lyrics window, never arbitrary main UI.
        if ($node.role -notin @(10, 15, 40, 41, 42) -or $node.width -le 0 -or $node.height -le 0) { continue }
        $bounds = @{ x = $node.x; y = $node.y; width = $node.width; height = $node.height }
        Add-Text $overlay.texts $node.value $bounds $false $false 'msaa-value'
        if ($node.role -in @(40, 41, 42)) { Add-Text $overlay.texts $node.name $bounds $false $false 'msaa-name' }
      }
    }
  } catch { $failed++; Record-ReadError 'msaa-lyrics' $_ }
  $state = if ($processes.Count -eq 0) { 'closed' } elseif ($resultWindows.Count -eq 0) { 'no-region' } else { 'ok' }
  $result = [ordered]@{
    state = $state; player = $Player; sourceAppId = $SourceAppId
    windows = @($resultWindows.ToArray()); scannedNodes = $visited; failedNodes = $failed
    truncated = $uiaTruncated
    readErrors = @($readErrors.ToArray())
  }
  if ($Diagnostic) { $result.observedWindows = @($observed.ToArray()) }
  $result | ConvertTo-Json -Compress -Depth 8 | Write-Output
} catch {
  [ordered]@{ state = 'error'; player = $Player; error = [string]$_.Exception.Message; windows = @() } | ConvertTo-Json -Compress -Depth 8 | Write-Output
}
