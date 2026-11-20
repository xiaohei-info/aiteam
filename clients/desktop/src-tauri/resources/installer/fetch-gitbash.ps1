<#
  Prepares the built-in Git Bash that the bundled Agent needs on Windows.

  The Agent asks Pi for a shell and resolves it through `where bash.exe`; a machine without Git for
  Windows has no bash, so /readyz never becomes ready. The NSIS installer runs this script after the
  app files are in place and stores MinGit under <install>\gitbash; the desktop host prepends
  <install>\gitbash\usr\bin to the Agent PATH (src-tauri/src/agent.rs).

  MinGit ships bash as usr\bin\sh.exe (sh mode of the same binary), so the script also creates
  usr\bin\bash.exe. Downloading shows a small progress window (percentage + MB) so the step is
  visible during installation; non-interactive sessions fall back to BITS / Invoke-WebRequest.
  The archive is pinned by SHA-256.

  Manual run:
    powershell -NoProfile -ExecutionPolicy Bypass -File fetch-gitbash.ps1 -Destination D:\AIFred\gitbash

  Exit codes: 0 ready, 2 download failed, 3 hash mismatch, 4 extract/verify failed.
#>
param(
  [Parameter(Mandatory = $true)][string]$Destination,
  [string[]]$Urls = @(
    'https://registry.npmmirror.com/-/binary/git-for-windows/v2.56.1.windows.1/MinGit-2.56.1-64-bit.zip',
    'https://github.com/git-for-windows/git/releases/download/v2.56.1.windows.1/MinGit-2.56.1-64-bit.zip'
  ),
  [string]$Sha256 = '4a92850b6e917da4fd010669b614b55dccf5b0ec333a534cc4be4700dfefdafd'
)

$ErrorActionPreference = 'Stop'
$bash = Join-Path $Destination 'usr\bin\bash.exe'
if (Test-Path -LiteralPath $bash) { Write-Host 'built-in bash already present'; exit 0 }

$log = Join-Path $env:TEMP 'aiteam-gitbash-install.log'
function Write-Log([string]$Message) {
  try { Add-Content -LiteralPath $log -Value ('[{0}] {1}' -f (Get-Date).ToString('s'), $Message) } catch { }
}

function Show-Progress([string]$Url) {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $form = New-Object System.Windows.Forms.Form
  $form.Text = 'AIFred 安装'
  $form.ClientSize = New-Object System.Drawing.Size(460, 150)
  $form.StartPosition = 'CenterScreen'
  $form.FormBorderStyle = 'FixedDialog'
  $form.MaximizeBox = $false
  $form.MinimizeBox = $false
  $form.ControlBox = $false
  $form.TopMost = $true

  $title = New-Object System.Windows.Forms.Label
  $title.Text = '正在准备内置 Git Bash（首次安装）'
  $title.Font = New-Object System.Drawing.Font('Segoe UI', 11, [System.Drawing.FontStyle]::Bold)
  $title.AutoSize = $true
  $title.Location = New-Object System.Drawing.Point(18, 16)

  $detail = New-Object System.Windows.Forms.Label
  $detail.Text = 'AI 助手运行所需，约 40 MB，仅首次安装需要下载。'
  $detail.AutoSize = $true
  $detail.Location = New-Object System.Drawing.Point(20, 48)

  $bar = New-Object System.Windows.Forms.ProgressBar
  $bar.Minimum = 0
  $bar.Maximum = 100
  $bar.Value = 0
  $bar.Width = 420
  $bar.Height = 18
  $bar.Location = New-Object System.Drawing.Point(20, 76)

  $status = New-Object System.Windows.Forms.Label
  $status.Text = '连接下载源…'
  $status.AutoSize = $true
  $status.Location = New-Object System.Drawing.Point(20, 102)

  $form.Controls.Add($title)
  $form.Controls.Add($detail)
  $form.Controls.Add($bar)
  $form.Controls.Add($status)
  $form.Show()
  $form.Refresh()
  [System.Windows.Forms.Application]::DoEvents()
  return [pscustomobject]@{ Form = $form; Bar = $bar; Status = $status; Detail = $detail }
}

$ui = $null
if ([Environment]::UserInteractive) {
  try { $ui = Show-Progress '' } catch { Write-Log "progress window unavailable: $($_.Exception.Message)"; $ui = $null }
}

$zip = Join-Path $env:TEMP 'aiteam-mingit.zip'
$extract = Join-Path $env:TEMP ('aiteam-mingit-' + [guid]::NewGuid().ToString('N'))
Write-Log "preparing git bash into $Destination"

function Download-ViaWindow([string]$Url) {
  if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
  $request = [System.Net.HttpWebRequest]::Create($Url)
  $request.UserAgent = 'AIFred-Installer'
  $request.Timeout = 600000
  $request.ReadWriteTimeout = 600000
  $response = $request.GetResponse()
  $total = $response.ContentLength
  $input = $response.GetResponseStream()
  $output = [System.IO.File]::Create($zip)
  try {
    $buffer = New-Object byte[] 262144
    $received = 0
    while (($read = $input.Read($buffer, 0, $buffer.Length)) -gt 0) {
      $output.Write($buffer, 0, $read)
      $received += $read
      if ($ui) {
        $percent = if ($total -gt 0) { [int](100 * $received / $total) } else { 0 }
        $ui.Bar.Value = [Math]::Min(100, [Math]::Max(0, $percent))
        $ui.Status.Text = if ($total -gt 0) {
          '{0:N1} / {1:N1} MB（{2}%）' -f ($received / 1MB), ($total / 1MB), $percent
        } else {
          '{0:N1} MB' -f ($received / 1MB)
        }
        [System.Windows.Forms.Application]::DoEvents()
      }
    }
  } finally {
    $output.Close()
    $input.Close()
    $response.Close()
  }
}

function Download-ViaBits([string]$Url) {
  if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
  Start-BitsTransfer -Source $Url -Destination $zip `
    -DisplayName '正在准备内置 Git Bash' `
    -Description 'AI 助手运行所需，约 40 MB，仅首次安装' -ErrorAction Stop
}

function Download-ViaWebRequest([string]$Url) {
  if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
  $progress = $ProgressPreference
  $ProgressPreference = 'SilentlyContinue'
  try { Invoke-WebRequest -Uri $Url -OutFile $zip -UseBasicParsing } finally { $ProgressPreference = $progress }
}

$downloaded = $false
foreach ($url in $Urls) {
  try {
    Write-Log "download $url"
    if ($ui) {
      $ui.Status.Text = '连接下载源…'
      [System.Windows.Forms.Application]::DoEvents()
      Download-ViaWindow $url
    } else {
      try { Download-ViaBits $url } catch {
        Write-Log "BITS failed, falling back to Invoke-WebRequest: $($_.Exception.Message)"
        Download-ViaWebRequest $url
      }
    }
    if ((Test-Path -LiteralPath $zip) -and (Get-Item -LiteralPath $zip).Length -gt 1MB) { $downloaded = $true; break }
    Write-Log 'downloaded file is unexpectedly small'
  } catch {
    Write-Log "download failed: $($_.Exception.Message)"
  }
}

if (-not $downloaded) {
  if ($ui) { $ui.Form.Close() }
  Write-Log 'all download sources failed'
  exit 2
}

if ($ui) {
  $ui.Bar.Value = 100
  $ui.Status.Text = '校验并解压…'
  [System.Windows.Forms.Application]::DoEvents()
}

$actual = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $Sha256.ToLowerInvariant()) {
  if ($ui) { $ui.Form.Close() }
  Write-Log "sha256 mismatch: expected $Sha256, got $actual"
  exit 3
}

try {
  New-Item -ItemType Directory -Force -Path $extract | Out-Null
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $extract)
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  Copy-Item -Path (Join-Path $extract '*') -Destination $Destination -Recurse -Force
  # MinGit ships bash as sh.exe; pi looks for bash.exe by name.
  Copy-Item -LiteralPath (Join-Path $Destination 'usr\bin\sh.exe') -Destination $bash -Force
  $version = & $bash -c 'echo $BASH_VERSION' 2>&1
  if ($LASTEXITCODE -ne 0) { throw "bash did not run: $version" }
  Write-Log "installed bash $version"
} catch {
  if ($ui) { $ui.Form.Close() }
  Write-Log "extract/verify failed: $($_.Exception.Message)"
  exit 4
} finally {
  Remove-Item -LiteralPath $extract -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
}

if ($ui) {
  $ui.Status.Text = '完成'
  [System.Windows.Forms.Application]::DoEvents()
  Start-Sleep -Milliseconds 400
  $ui.Form.Close()
}

exit 0
