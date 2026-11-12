# 用 Windows 自带的 OCR（Windows.Media.Ocr）识别一张图，输出 行文本 + 包围盒（TSV）
# 用途：这台鸿蒙模拟器没有 OCR 后端，借桌面 OCR 引擎验证"设备渲染出来的图"能不能被识别、
# 识别结果能不能被我们的作息/课表解析器吃下去。**不是**应用内代码路径。
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [Parameter(Mandatory = $true)][string]$Out
)

Add-Type -AssemblyName System.Runtime.WindowsRuntime

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}

[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Media, ContentType = WindowsRuntime] | Out-Null
[Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime] | Out-Null

Write-Output ("可用识别语言: " + (([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag }) -join ', '))

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) {
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('zh-Hans'))
}
if ($null -eq $engine) {
  Write-Error '没有可用的 OCR 引擎'
  exit 1
}

$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

$lines = New-Object System.Collections.Generic.List[string]
foreach ($line in $result.Lines) {
  $left = [double]::MaxValue
  $top = [double]::MaxValue
  $right = 0.0
  $bottom = 0.0
  foreach ($word in $line.Words) {
    $r = $word.BoundingRect
    if ($r.X -lt $left) { $left = $r.X }
    if ($r.Y -lt $top) { $top = $r.Y }
    if (($r.X + $r.Width) -gt $right) { $right = $r.X + $r.Width }
    if (($r.Y + $r.Height) -gt $bottom) { $bottom = $r.Y + $r.Height }
  }
  $text = $line.Text -replace "[`t`r`n]", ' '
  # 注意：单引号字符串里 `t 不是转义，必须用 [char]9 拼（踩过一次：文件里全是字面 `t）
  $tab = [char]9
  $lines.Add(('{0:F0}{1}{2:F0}{3}{4:F0}{5}{6:F0}{7}{8}' -f $left, $tab, $top, $tab, $right, $tab, $bottom, $tab, $text))
}
[System.IO.File]::WriteAllLines($Out, $lines, (New-Object System.Text.UTF8Encoding($false)))
Write-Output ("行数: " + $lines.Count + " → " + $Out)
