param(
    [Parameter(Mandatory=$true)][string]$VaultPath,
    [ValidatePattern('^[.A-Za-z0-9_-]+$')][string]$ConfigFolder = '.obsidian',
    [string]$BackupDirectory
)
$ErrorActionPreference = 'Stop'
if ($ConfigFolder -in @('.','..')) {throw 'Choose a named vault configuration folder.'}
$resolvedVault = (Resolve-Path -LiteralPath $VaultPath).Path
$configFolder = Join-Path $resolvedVault $ConfigFolder
if (-not (Test-Path -LiteralPath $configFolder -PathType Container)) {
    throw 'Choose the existing vault and its actual configuration folder; use -ConfigFolder for a custom profile.'
}
if (Get-Process -Name Obsidian -ErrorAction SilentlyContinue) {
    throw 'Close Obsidian before this offline asset installation. Local development can use scripts/deploy-local.mjs for a checked reload.'
}
if (-not $BackupDirectory) {$BackupDirectory = Join-Path $env:LOCALAPPDATA 'NoteworkAI/backups'}
$resolvedBackup = [IO.Path]::GetFullPath($BackupDirectory)
if ($resolvedBackup.Equals($resolvedVault,[StringComparison]::OrdinalIgnoreCase) -or $resolvedBackup.StartsWith($resolvedVault.TrimEnd('\','/')+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) {
    throw 'Keep installation backups outside the vault so they cannot be synchronized to another device.'
}
$activeList = Join-Path $configFolder 'community-plugins.json'
$activeListBefore = if (Test-Path -LiteralPath $activeList -PathType Leaf) {(Get-FileHash -LiteralPath $activeList -Algorithm SHA256).Hash} else {$null}
$sourceFolder = Join-Path $PSScriptRoot 'notework-ai'
if (-not (Test-Path -LiteralPath (Join-Path $sourceFolder 'main.js') -PathType Leaf)) {
    $sourceFolder = Join-Path $PSScriptRoot 'dist/notework-ai'
}
foreach ($fileName in @('main.js','manifest.json','styles.css')) {
    if (-not (Test-Path -LiteralPath (Join-Path $sourceFolder $fileName) -PathType Leaf)) {throw "Missing plugin asset: $fileName"}
}
$packageManifest = Get-Content -LiteralPath (Join-Path $sourceFolder 'manifest.json') -Raw | ConvertFrom-Json
if ($packageManifest.id -ne 'notework-ai') {throw 'This update must retain the notework-ai plugin ID so saved credentials keep their existing namespace.'}
$destination = Join-Path $configFolder 'plugins/notework-ai'
if (Test-Path -LiteralPath $destination) {
    $backupFolder = Join-Path $resolvedBackup ('notework-ai-'+(Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
    New-Item -ItemType Directory -Path $backupFolder -Force | Out-Null
    foreach ($fileName in @('main.js','manifest.json','styles.css')) {
        $oldFile = Join-Path $destination $fileName
        if (Test-Path -LiteralPath $oldFile -PathType Leaf) {Copy-Item -LiteralPath $oldFile -Destination $backupFolder}
    }
    Write-Output "Previous plugin assets saved to: $backupFolder"
}
New-Item -ItemType Directory -Path $destination -Force | Out-Null
foreach ($fileName in @('main.js','manifest.json','styles.css')) {
    Copy-Item -LiteralPath (Join-Path $sourceFolder $fileName) -Destination $destination
}
Write-Output "Installed to: $destination"
if ($activeListBefore -ne $(if (Test-Path -LiteralPath $activeList -PathType Leaf) {(Get-FileHash -LiteralPath $activeList -Algorithm SHA256).Hash} else {$null})) {throw 'The active community plugin list changed during installation. Inspect the other writer before restarting.'}
Write-Output 'The active community plugin list was preserved. This installer never enables a plugin.'
Write-Output 'Before PC development, turn off Active community plugin list and Installed community plugin list in Sync on the PC and phone, or use separate configuration profiles.'
Write-Output 'Reopen Obsidian. Enable the plugin independently on the intended device after checking that separation.'
Write-Output 'Existing settings, local knowledge and saved credentials are retained. This installer replaces only the three plugin assets.'
Write-Output 'Reload reuses the existing login without starting sign-in or an inference test.'
