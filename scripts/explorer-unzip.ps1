# Unpacks a zip with the Windows shell (zipfldr) - the same code path as Explorer's "Extract All" -
# and waits until the expected number of files has arrived. build-portable.ts uses it to prove the
# archive unpacks correctly for someone who has nothing but Explorer.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File explorer-unzip.ps1 -Zip a.zip -Dest dir -ExpectFiles 123
# Exit codes: 0 all files arrived, 2 cannot open, 3 stalled, 4 timed out.
# ASCII only in this file (Windows PowerShell 5.1 reads BOM-less scripts as ANSI).

param(
    [Parameter(Mandatory = $true)][string]$Zip,
    [Parameter(Mandatory = $true)][string]$Dest,
    [Parameter(Mandatory = $true)][int]$ExpectFiles,
    [int]$TimeoutSeconds = 900,
    [int]$StallSeconds = 90
)

$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
$shell = New-Object -ComObject Shell.Application
$source = $shell.NameSpace($Zip)
if ($null -eq $source) { Write-Output "cannot open zip: $Zip"; exit 2 }
$target = $shell.NameSpace($Dest)
if ($null -eq $target) { Write-Output "cannot open folder: $Dest"; exit 2 }

# 4 = no progress dialog, 16 = yes to all, 512 = no mkdir confirmation, 1024 = no error UI.
# The copy runs on a shell thread inside this process: this script must stay alive until it is done.
$target.CopyHere($source.Items(), 1556)

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$last = -1
$stalledSince = Get-Date
while ((Get-Date) -lt $deadline) {
    $n = @(Get-ChildItem -LiteralPath $Dest -Recurse -File -Force -ErrorAction SilentlyContinue).Count
    if ($n -ge $ExpectFiles) {
        Write-Output "extracted $n files"
        exit 0
    }
    if ($n -ne $last) {
        $last = $n
        $stalledSince = Get-Date
    } elseif (((Get-Date) - $stalledSince).TotalSeconds -ge $StallSeconds) {
        Write-Output "stalled at $n of $ExpectFiles files"
        exit 3
    }
    Start-Sleep -Milliseconds 1000
}
Write-Output "timed out at $last of $ExpectFiles files"
exit 4
