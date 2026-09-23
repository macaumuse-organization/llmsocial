# Local OCR through the Windows.Media.Ocr engine. No network, no install, no per-call cost.
# usage: windows-ocr.ps1 <image-path> <out.json>  -> JSON array of {text,x,y,w,h,confidence}, origin top-left, 0..1
#        windows-ocr.ps1 --probe                  -> one installed OCR language tag per line
# exit:  0 ok | 1 failure | 2 usage | 3 no OCR language installed
# ASCII only: PowerShell 5.1 reads a BOM-less script as ANSI, so any non-ASCII literal here would be
# mangled. Operator-facing wording lives in index.ts instead.
# The result goes to a file to keep the same contract as vision-ocr.swift.

Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'

function Fail([string] $message, [int] $code) {
  [Console]::Error.WriteLine($message)
  exit $code
}

function Clamp01([double] $value) {
  if ($value -lt 0) { return 0.0 }
  if ($value -gt 1) { return 1.0 }
  return $value
}

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
  $null = [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType=WindowsRuntime]
  $null = [Windows.Globalization.Language, Windows.Globalization, ContentType=WindowsRuntime]
  $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
  $null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage, ContentType=WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType=WindowsRuntime]
  $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics, ContentType=WindowsRuntime]

  # Every WinRT call here returns IAsyncOperation. PowerShell 5.1 cannot bind the AsTask extension
  # method directly, so it has to be picked out by reflection and closed over the result type.
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]

  function Await($operation, $resultType) {
    $task = $asTask.MakeGenericMethod($resultType).Invoke($null, @($operation))
    $task.Wait(-1) | Out-Null
    return $task.Result
  }

  # @() around every WinRT collection: these project as IReadOnlyList, and reading .Count off one
  # silently enumerates its members instead of counting them.
  $languages = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages)
  if ($languages.Count -eq 0) { Fail 'no OCR language installed' 3 }

  if ($args.Count -eq 1 -and $args[0] -eq '--probe') {
    foreach ($language in $languages) { [Console]::Out.WriteLine($language.LanguageTag) }
    exit 0
  }
  if ($args.Count -ne 2) { Fail 'usage: windows-ocr.ps1 <image> <out.json> | --probe' 2 }

  $engine = $null
  $preferred = @($languages | Where-Object { $_.LanguageTag -like 'zh-Hans*' })
  if ($preferred.Count -gt 0) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($preferred[0]) }
  if ($engine -eq $null) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
  if ($engine -eq $null) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($languages[0]) }
  if ($engine -eq $null) { Fail 'no usable OCR engine' 3 }

  $imagePath = [System.IO.Path]::GetFullPath($args[0])
  $outPath = [System.IO.Path]::GetFullPath($args[1])

  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($imagePath)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

  $maxSide = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension
  if ($bitmap.PixelWidth -gt $maxSide -or $bitmap.PixelHeight -gt $maxSide) { Fail "image too large (max $maxSide px per side)" 1 }
  $imageWidth = [double] $bitmap.PixelWidth
  $imageHeight = [double] $bitmap.PixelHeight

  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

  $out = New-Object System.Collections.ArrayList
  foreach ($ocrLine in @($result.Lines)) {
    $ocrWords = @($ocrLine.Words)
    if ($ocrWords.Count -eq 0) { continue }
    $minX = [double]::MaxValue
    $minY = [double]::MaxValue
    $maxX = 0.0
    $maxY = 0.0
    $lineText = ''
    foreach ($ocrWord in $ocrWords) {
      $rect = $ocrWord.BoundingRect
      if ($rect.X -lt $minX) { $minX = $rect.X }
      if ($rect.Y -lt $minY) { $minY = $rect.Y }
      if (($rect.X + $rect.Width) -gt $maxX) { $maxX = $rect.X + $rect.Width }
      if (($rect.Y + $rect.Height) -gt $maxY) { $maxY = $rect.Y + $rect.Height }
      # This engine makes every CJK character its own word, so joining on spaces would put one
      # between every character. Same rule parseChat.ts uses when it merges wrapped lines.
      if ($lineText -ne '' -and $lineText -match '[A-Za-z0-9,.!?]$' -and $ocrWord.Text -match '^[A-Za-z0-9]') { $lineText += ' ' }
      $lineText += $ocrWord.Text
    }
    $null = $out.Add([ordered] @{
      text = $lineText
      x = [math]::Round((Clamp01 ($minX / $imageWidth)), 5)
      y = [math]::Round((Clamp01 ($minY / $imageHeight)), 5)
      w = [math]::Round((Clamp01 (($maxX - $minX) / $imageWidth)), 5)
      h = [math]::Round((Clamp01 (($maxY - $minY) / $imageHeight)), 5)
      confidence = 1.0
    })
  }

  # -InputObject keeps a 0- or 1-element result an array; a BOM would break JSON.parse on the Node side.
  $json = ConvertTo-Json -InputObject @($out.ToArray()) -Compress -Depth 4
  [System.IO.File]::WriteAllText($outPath, $json, (New-Object System.Text.UTF8Encoding($false)))
  exit 0
} catch {
  [Console]::Error.WriteLine('ocr failed: ' + $_.Exception.Message)
  exit 1
}
