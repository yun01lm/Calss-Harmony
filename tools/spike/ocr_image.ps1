# 用 Windows 自带 OCR（Windows.Media.Ocr）识别一张图片，输出"文本 + 包围盒"。
#
# 为什么这么做：鸿蒙模拟器没有 OCR 后端（Core Vision 报 1001400001），
# 但作息解析器（logic/TimetableTextParser.ts）要的只是"一行文字 + 包围盒"。
# 用 Windows OCR 产出**真实 OCR 结果**，就能在本机验证解析器对真实截图的识别率，
# 而不是靠手写假数据。
#
# 用法（需要 Windows PowerShell 5.1，pwsh 7 也行但 5.1 更稳）：
#   powershell -NoProfile -File tools/spike/ocr_image.ps1 -ImagePath <图片> -OutPath <输出.tsv>
#
# 输出格式：首行 OK，之后每行 `文本<TAB>left<TAB>top<TAB>right<TAB>bottom`，末行 END。
param(
  [Parameter(Mandatory = $true)][string]$ImagePath,
  [Parameter(Mandatory = $true)][string]$OutPath,
  [string]$Language = 'zh-Hans-CN'
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Runtime.WindowsRuntime

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]

function Await($op, $type) {
  $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  return $task.Result
}

[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime] | Out-Null

$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

$lang = New-Object Windows.Globalization.Language($Language)
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
if ($null -eq $engine) { throw "没有 $Language 的 OCR 引擎" }

$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

$lines = New-Object System.Collections.Generic.List[string]
$lines.Add('OK')
foreach ($line in $result.Lines) {
  if ($line.Words.Count -eq 0) { continue }
  $l = [double]::MaxValue; $t = [double]::MaxValue; $r = 0.0; $b = 0.0
  foreach ($w in $line.Words) {
    $rect = $w.BoundingRect
    if ($rect.X -lt $l) { $l = $rect.X }
    if ($rect.Y -lt $t) { $t = $rect.Y }
    $rr = $rect.X + $rect.Width
    $bb = $rect.Y + $rect.Height
    if ($rr -gt $r) { $r = $rr }
    if ($bb -gt $b) { $b = $bb }
  }
  $text = $line.Text -replace "[\t\r\n]", ' '
  $lines.Add(("{0}`t{1:F1}`t{2:F1}`t{3:F1}`t{4:F1}" -f $text, $l, $t, $r, $b))
}
$lines.Add('END')
[System.IO.File]::WriteAllLines($OutPath, $lines, (New-Object System.Text.UTF8Encoding($false)))
Write-Output ("lines=$($result.Lines.Count) -> $OutPath")

