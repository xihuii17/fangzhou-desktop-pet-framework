on replaceText(findText, replacementText, sourceText)
  set AppleScript's text item delimiters to findText
  set parts to text items of sourceText
  set AppleScript's text item delimiters to replacementText
  set resultText to parts as text
  set AppleScript's text item delimiters to ""
  return resultText
end replaceText

on cleanField(sourceText)
  set resultText to sourceText as text
  set resultText to my replaceText(tab, " ", resultText)
  set resultText to my replaceText(return, " ", resultText)
  set resultText to my replaceText(linefeed, " ", resultText)
  return resultText
end cleanField

on secondsFromTime(sourceText)
  try
    set cleanText to my cleanField(sourceText)
    set AppleScript's text item delimiters to ":"
    set pieces to text items of cleanText
    set AppleScript's text item delimiters to ""
    if (count of pieces) is not 2 then return -1
    set minutesValue to (item 1 of pieces) as integer
    set secondsValue to (item 2 of pieces) as integer
    if minutesValue < 0 or secondsValue < 0 or secondsValue > 59 then return -1
    return minutesValue * 60 + secondsValue
  on error
    set AppleScript's text item delimiters to ""
    return -1
  end try
end secondsFromTime

tell application "System Events"
  set qqProcesses to every application process whose bundle identifier is "com.tencent.QQMusicMac"
  if (count of qqProcesses) is 0 then return "closed"
  tell item 1 of qqProcesses
    if (count of windows) is 0 then return "closed"
    set songDescription to ""
    set playState to "paused"
    set progressValue to ""
    set progressMaximum to ""

    try
      set playPanel to first UI element of window 1 whose description is "播放控制栏"
      repeat with elementItem in (entire contents of playPanel)
        try
          set elementDescription to description of elementItem as text
          if elementDescription starts with "歌曲名：" then set songDescription to elementDescription
        end try
        try
          set buttonName to name of elementItem as text
          if buttonName is "暂停播放" or buttonName is "暂停" then set playState to "playing"
        end try
        try
          set elementRole to role of elementItem as text
          if elementRole is "AXSlider" or elementRole is "AXProgressIndicator" then
            set candidateValue to value of elementItem as real
            if candidateValue > 0 then
              set progressValue to candidateValue as text
              try
                set progressMaximum to value of attribute "AXMaxValue" of elementItem as text
              end try
            end if
          end if
        end try
        try
          set timeSeconds to my secondsFromTime(value of elementItem as text)
          if timeSeconds >= 0 then
            if progressMaximum is "" then
              set progressMaximum to timeSeconds as text
            else if timeSeconds > (progressMaximum as real) then
              set progressValue to progressMaximum
              set progressMaximum to timeSeconds as text
            else
              set progressValue to timeSeconds as text
            end if
          end if
        end try
      end repeat
    on error
      repeat with elementItem in (entire contents of window 1)
        try
          set elementDescription to description of elementItem as text
          if elementDescription starts with "歌曲名：" then set songDescription to elementDescription
        end try
        try
          set buttonName to name of elementItem as text
          if buttonName is "暂停播放" then set playState to "playing"
        end try
        try
          set timeSeconds to my secondsFromTime(value of elementItem as text)
          if timeSeconds >= 0 then
            if progressMaximum is "" then
              set progressMaximum to timeSeconds as text
            else if timeSeconds > (progressMaximum as real) then
              set progressValue to progressMaximum
              set progressMaximum to timeSeconds as text
            else
              set progressValue to timeSeconds as text
            end if
          end if
        end try
      end repeat
    end try

    return "ok" & tab & my cleanField(songDescription) & tab & playState & tab & progressValue & tab & progressMaximum
  end tell
end tell
