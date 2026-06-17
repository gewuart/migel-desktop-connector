param(
  [Parameter(Position = 0)]
  [string]$RepoUrl = $env:MIGEL_REPO_URL,

  [Parameter(Position = 1)]
  [ValidateSet('hermes', 'openclaw')]
  [string]$Agent = $(if ($env:MIGEL_AGENT) { $env:MIGEL_AGENT } else { 'hermes' }),

  [Parameter(Position = 2)]
  [string]$PairCode = $env:MIGEL_PAIR_CODE,

  [Parameter(Position = 3)]
  [string]$DesktopClaim = $env:MIGEL_DESKTOP_CLAIM,

  [string]$InstallDir = $(if ($env:MIGEL_INSTALL_DIR) { $env:MIGEL_INSTALL_DIR } else { Join-Path $HOME '.migel\installers\migel-desktop' }),
  [string]$Branch = $(if ($env:MIGEL_REPO_BRANCH) { $env:MIGEL_REPO_BRANCH } else { 'main' }),
  [string]$NpmRegistry = $(if ($env:MIGEL_NPM_REGISTRY) { $env:MIGEL_NPM_REGISTRY } else { 'https://registry.npmmirror.com' }),
  [switch]$DryRun,
  [switch]$InstallOnly
)

function Install-MigelAndPair {
  param(
    [Parameter(Position = 0)]
    [string]$RepoUrl = $env:MIGEL_REPO_URL,

    [Parameter(Position = 1)]
    [ValidateSet('hermes', 'openclaw')]
    [string]$Agent = $(if ($env:MIGEL_AGENT) { $env:MIGEL_AGENT } else { 'hermes' }),

    [Parameter(Position = 2)]
    [string]$PairCode = $env:MIGEL_PAIR_CODE,

    [Parameter(Position = 3)]
    [string]$DesktopClaim = $env:MIGEL_DESKTOP_CLAIM,

    [string]$InstallDir = $(if ($env:MIGEL_INSTALL_DIR) { $env:MIGEL_INSTALL_DIR } else { Join-Path $HOME '.migel\installers\migel-desktop' }),
    [string]$Branch = $(if ($env:MIGEL_REPO_BRANCH) { $env:MIGEL_REPO_BRANCH } else { 'main' }),
    [string]$NpmRegistry = $(if ($env:MIGEL_NPM_REGISTRY) { $env:MIGEL_NPM_REGISTRY } else { 'https://registry.npmmirror.com' }),
    [switch]$DryRun,
    [switch]$InstallOnly
  )

  $ErrorActionPreference = 'Stop'
  $requiredNodeMajor = 22
  if (-not $DryRun -and $env:MIGEL_DRY_RUN -match '^(true|1|yes|on)$') { $DryRun = $true }
  if (-not $InstallOnly -and $env:MIGEL_INSTALL_ONLY -match '^(true|1|yes|on)$') { $InstallOnly = $true }

  function Fail($Message) {
    Write-Error $Message
    exit 1
  }

  function Test-Command($Name) {
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
  }

  function Resolve-FileRepoPath($Url) {
    if ($Url -like 'file://*') {
      return ([System.Uri]$Url).LocalPath
    }
    if ($Url -and (Test-Path -LiteralPath $Url)) {
      return (Resolve-Path -LiteralPath $Url).Path
    }
    return $null
  }

  function Test-ZipSource($Url) {
    return $Url -match '(?i)\.zip($|\?)'
  }

  function Install-ZipSource($Url, $TargetDir) {
    $tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("migel-desktop-" + [System.Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
    $zipPath = Join-Path $tmpDir 'migel-desktop-connector.zip'
    $localPath = Resolve-FileRepoPath $Url
    Write-Host '正在下载 Migel 桌面连接器 zip 包...'
    if ($localPath -and (Test-Path -LiteralPath $localPath)) {
      Copy-Item -LiteralPath $localPath -Destination $zipPath -Force
    } else {
      Invoke-WebRequest -Uri $Url -OutFile $zipPath -UseBasicParsing
    }
    if (Test-Path -LiteralPath $TargetDir) { Remove-Item -LiteralPath $TargetDir -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
    Expand-Archive -LiteralPath $zipPath -DestinationPath $TargetDir -Force
    $nested = Get-ChildItem -LiteralPath $TargetDir -Directory | Select-Object -First 1
    if ($nested -and -not (Test-Path -LiteralPath (Join-Path $TargetDir 'tools/migel-skill-bootstrap.mjs')) -and (Test-Path -LiteralPath (Join-Path $nested.FullName 'tools/migel-skill-bootstrap.mjs'))) {
      $flattened = Join-Path $tmpDir 'flattened'
      New-Item -ItemType Directory -Force -Path $flattened | Out-Null
      Get-ChildItem -LiteralPath $nested.FullName -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $flattened -Recurse -Force
      }
      Remove-Item -LiteralPath $TargetDir -Recurse -Force
      Move-Item -LiteralPath $flattened -Destination $TargetDir
    }
    Remove-Item -LiteralPath $tmpDir -Recurse -Force
  }

  function Install-GitSource($Url, $TargetDir) {
    if (-not (Test-Command git)) { Fail '缺少 git，请先安装 Git for Windows，或使用 OSS zip 包安装地址。' }
    if (-not (Test-Path -LiteralPath (Join-Path $TargetDir '.git'))) {
      $localRepo = Resolve-FileRepoPath $Url
      if ($DryRun -and $localRepo -and (Test-Path -LiteralPath $localRepo)) {
        Write-Host 'DRY RUN: 正在复制本地 Migel 工作树...'
        if (Test-Path -LiteralPath $TargetDir) { Remove-Item -LiteralPath $TargetDir -Recurse -Force }
        New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
        Get-ChildItem -LiteralPath $localRepo -Force | Where-Object { $_.Name -notin @('.git', 'node_modules') } | ForEach-Object {
          Copy-Item -LiteralPath $_.FullName -Destination $TargetDir -Recurse -Force
        }
      } else {
        Write-Host '正在下载 Migel 桌面连接器...'
        & git clone --branch $Branch $Url $TargetDir
      }
    } else {
      Write-Host '正在更新 Migel 桌面连接器...'
      & git -C $TargetDir fetch origin $Branch
      & git -C $TargetDir checkout $Branch
      & git -C $TargetDir pull --ff-only origin $Branch
    }
  }

  if ([string]::IsNullOrWhiteSpace($RepoUrl)) {
    Fail '缺少仓库地址。请传入 MIGEL_REPO_URL 或作为第一个参数。'
  }

  if (-not (Test-Command node)) { Fail "缺少 node，请先安装 Node.js $requiredNodeMajor 或更新版本。" }
  if (-not (Test-Command npm)) { Fail '缺少 npm，请确认 Node.js 已正确安装。' }

  $nodeMajor = [int](& node -p "process.versions.node.split('.')[0]")
  if ($nodeMajor -lt $requiredNodeMajor) {
    Fail "Node.js 版本过低：$(& node -v)。请升级到 $requiredNodeMajor 或更新版本。"
  }

  $parentDir = Split-Path -Parent $InstallDir
  if ($parentDir) { New-Item -ItemType Directory -Force -Path $parentDir | Out-Null }

  if (Test-ZipSource $RepoUrl) {
    Install-ZipSource $RepoUrl $InstallDir
  } else {
    Install-GitSource $RepoUrl $InstallDir
  }

  Set-Location $InstallDir

  $required = @(
    'tools/migel-skill-bootstrap.mjs',
    'tools/migel-pairing-skill.mjs',
    'tools/migel-desktop-bootstrap.mjs',
    'tools/install-and-pair.ps1',
    'desktop-connector/src/main.mjs'
  )
  foreach ($path in $required) {
    if (-not (Test-Path -LiteralPath $path)) {
      Fail "仓库内容不完整：缺少 $path"
    }
  }

  if (-not (Test-Path -LiteralPath 'tools/node_modules/qrcode')) {
    Write-Host '正在安装 tools 依赖...'
    Push-Location tools
    & npm install --registry=$NpmRegistry --omit=dev --no-audit --no-fund
    Pop-Location
  }

  if ((Test-Path -LiteralPath 'gateway/package.json') -and -not (Test-Path -LiteralPath 'gateway/node_modules/ws')) {
    Write-Host '正在安装 gateway 依赖...'
    Push-Location gateway
    & npm install --registry=$NpmRegistry --omit=dev --no-audit --no-fund
    Pop-Location
  }

  if ((Test-Path -LiteralPath 'desktop-connector/package.json') -and -not (Test-Path -LiteralPath 'desktop-connector/node_modules')) {
    Write-Host '正在安装 desktop-connector 依赖...'
    Push-Location desktop-connector
    & npm install --registry=$NpmRegistry --omit=dev --no-audit --no-fund
    Pop-Location
  }

  $pairArgs = @('tools/migel-skill-bootstrap.mjs', '--agent', $Agent)
  if (-not [string]::IsNullOrWhiteSpace($PairCode)) { $pairArgs += @('--pair-code', $PairCode) }
  if (-not [string]::IsNullOrWhiteSpace($DesktopClaim)) { $pairArgs += @('--desktop-claim', $DesktopClaim) }
  if ($InstallOnly) { $pairArgs += @('--install-only', 'true') }

  if ($DryRun) {
    Write-Host 'DRY RUN: 依赖安装检查完成，验证 bootstrap 参数，不安装服务、不启动连接器。'
    & node @pairArgs --install-only true --dry-run true
    return $LASTEXITCODE
  }

  Write-Host 'Windows: 跳过 macOS Hermes bridge LaunchAgent 服务安装。'
  Write-Host '正在启动 Migel 配对流程...'
  & node @pairArgs
  return $LASTEXITCODE
}

if ($PSCommandPath) {
  exit (Install-MigelAndPair @PSBoundParameters)
}
