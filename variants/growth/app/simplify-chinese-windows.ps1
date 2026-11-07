param([string]$Payload = '')

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  Add-Type -AssemblyName Microsoft.VisualBasic
  $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload))
  $items = @($json | ConvertFrom-Json)
  $result = @($items | ForEach-Object {
    [Microsoft.VisualBasic.Strings]::StrConv(
      [string]$_,
      [Microsoft.VisualBasic.VbStrConv]::SimplifiedChinese,
      0x0804
    )
  })
  ConvertTo-Json -InputObject $result -Compress | Write-Output
} catch {
  '[]' | Write-Output
}
