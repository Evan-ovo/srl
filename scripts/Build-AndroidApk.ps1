[CmdletBinding()]
param(
    [ValidateSet('Native', 'Packaged', 'Remote')]
    [string]$Mode = 'Packaged',

    [ValidateSet('Debug', 'Release')]
    [string]$Variant = 'Debug',

    [switch]$SkipWebBuild,

    [switch]$PreinstallOfficialApps,

    [switch]$BundleOptionalOfficialApps,

    [string[]]$PreinstallOfficialAppIds = @(),

    [ValidatePattern('^$|^[a-fA-F0-9]{64}$')]
    [string]$ExpectedCertificateSha256 = '',

    [string]$ServerUrl = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectDirectory = Split-Path -Parent $PSScriptRoot
$oldServerUrl = $env:CAPACITOR_SERVER_URL
$oldJavaHome = $env:JAVA_HOME
$oldAndroidHome = $env:ANDROID_HOME
$oldAndroidSdkRoot = $env:ANDROID_SDK_ROOT
$oldGradleUserHome = $env:GRADLE_USER_HOME
$oldPreinstallOfficialApps = $env:SRL_ANDROID_PREINSTALL_OFFICIAL_APPS
$oldPreinstallOfficialAppIds = $env:SRL_ANDROID_PREINSTALL_OFFICIAL_APP_IDS
$oldBundleOptionalOfficialApps = $env:SRL_ANDROID_BUNDLE_OPTIONAL_OFFICIAL_APPS
$PreinstallOfficialApps = $PreinstallOfficialApps -or $PreinstallOfficialAppIds.Count -gt 0 -or $BundleOptionalOfficialApps
if ($BundleOptionalOfficialApps -and ($Mode -ne 'Packaged' -or $PreinstallOfficialAppIds.Count -gt 0)) {
    throw 'Bundling optional APP archives requires Packaged mode without an APP selection filter.'
}
if ($PreinstallOfficialAppIds.Count -gt 0 -and $SkipWebBuild) {
    throw 'Selected APP preinstallation requires a new web build.'
}

function Initialize-AndroidEnvironment {
    if (-not $env:GRADLE_USER_HOME) {
        $env:GRADLE_USER_HOME = 'D:\Androidstudio\GradleCache'
    }

    if ($env:JAVA_HOME -and -not (Test-Path -LiteralPath (Join-Path $env:JAVA_HOME 'bin\java.exe'))) {
        Remove-Item Env:JAVA_HOME -ErrorAction SilentlyContinue
    }
    if (-not $env:JAVA_HOME) {
        $studioJavaHome = 'D:\Androidstudio\jbr'
        if (Test-Path -LiteralPath (Join-Path $studioJavaHome 'bin\java.exe')) {
            $env:JAVA_HOME = $studioJavaHome
        }
    }

    if (-not $env:JAVA_HOME) {
        $searchRoots = @(
            (Join-Path (Split-Path -Parent $projectDirectory) 'jdk-21'),
            (Join-Path $env:USERPROFILE '.jdks')
        )
        $javaExecutable = $searchRoots |
            Where-Object { Test-Path -LiteralPath $_ } |
            ForEach-Object {
                Get-ChildItem -LiteralPath $_ -Filter 'java.exe' -Recurse -ErrorAction SilentlyContinue
            } |
            Where-Object {
                $_.FullName -match '\\bin\\java\.exe$' -and
                $_.FullName -match '(jdk|jbr)[-_]?2[1-9]'
            } |
            Select-Object -First 1
        if ($javaExecutable) {
            $env:JAVA_HOME = Split-Path -Parent (Split-Path -Parent $javaExecutable.FullName)
        }
    }

    if ($env:ANDROID_HOME -and -not (
        (Test-Path -LiteralPath (Join-Path $env:ANDROID_HOME 'platforms\android-36')) -and
        (Test-Path -LiteralPath (Join-Path $env:ANDROID_HOME 'build-tools'))
    )) {
        Remove-Item Env:ANDROID_HOME -ErrorAction SilentlyContinue
    }
    if (-not $env:ANDROID_HOME) {
        $localSdk = Join-Path (Split-Path -Parent $projectDirectory) 'android-sdk'
        $sdkCandidates = @(
            'D:\Androidstudio\Sdk',
            $localSdk,
            (Join-Path $env:LOCALAPPDATA 'Android\Sdk'),
            $env:ANDROID_SDK_ROOT,
            'D:\AndrodSDK'
        )
        $env:ANDROID_HOME = $sdkCandidates |
            Where-Object {
                $_ -and
                (Test-Path -LiteralPath (Join-Path $_ 'platforms\android-36')) -and
                (Test-Path -LiteralPath (Join-Path $_ 'build-tools'))
            } |
            Select-Object -First 1
        if (-not $env:ANDROID_HOME -and (Test-Path -LiteralPath $localSdk)) {
            $env:ANDROID_HOME = $localSdk
        }
    }

    if ($env:ANDROID_HOME -and -not $env:ANDROID_SDK_ROOT) {
        $env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
    }

    if (-not $env:JAVA_HOME) {
        throw 'JAVA_HOME is not configured and no JDK was found under the current user profile.'
    }
    if (-not $env:ANDROID_HOME) {
        throw 'ANDROID_HOME is not configured and no reusable SDK was found next to the project.'
    }
}

function Write-AndroidLocalProperties {
    $localPropertiesPath = Join-Path $projectDirectory 'android\local.properties'
    $escapedSdkPath = $env:ANDROID_HOME.Replace('\', '\\').Replace(':', '\:')
    $contents = "sdk.dir=$escapedSdkPath`n"
    [System.IO.File]::WriteAllText(
        $localPropertiesPath,
        $contents,
        [System.Text.UTF8Encoding]::new($false)
    )
}

function Invoke-Checked {
    param(
        [Parameter(Mandatory)]
        [string]$Command,

        [Parameter(Mandatory)]
        [string[]]$Arguments
    )

    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Command $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
    }
}

function Get-OfficialAppCatalogPaths {
    param([Parameter(Mandatory)]$Manifest)
    @(
        "official-apps/$($Manifest.shellVersion)/catalog.json",
        "official-apps/api-$($Manifest.hostApiVersion)/catalog.json"
    )
}

function Assert-SyncedOfficialAppAssets {
    param([Parameter(Mandatory)][string]$ProjectRoot)
    $distRoot = Join-Path $ProjectRoot 'dist'
    $androidPublicRoot = Join-Path $ProjectRoot 'android\app\src\main\assets\public'
    $distManifestPath = Join-Path $distRoot 'official-app-assets.json'
    $syncedManifestPath = Join-Path $androidPublicRoot 'official-app-assets.json'
    foreach ($path in @($distManifestPath, $syncedManifestPath)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Required APP asset manifest is missing: $path" }
    }
    $distManifest = Get-Content -LiteralPath $distManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $syncedManifest = Get-Content -LiteralPath $syncedManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($field in @('shellVersion', 'hostApiVersion')) {
        if ($distManifest.$field -ne $syncedManifest.$field) {
            throw "Capacitor APP manifest $field does not match dist."
        }
    }
    if (-not $syncedManifest.shellFiles -or $syncedManifest.shellFiles.Count -eq 0) {
        throw 'Capacitor APP manifest has no shellFiles.'
    }
    foreach ($relativePath in Get-OfficialAppCatalogPaths -Manifest $distManifest) {
        $distCatalogPath = Join-Path $distRoot $relativePath.Replace('/', '\')
        $syncedCatalogPath = Join-Path $androidPublicRoot $relativePath.Replace('/', '\')
        foreach ($path in @($distCatalogPath, $syncedCatalogPath)) {
            if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Required APP catalog is missing: $path" }
        }
        $distCatalog = Get-Content -LiteralPath $distCatalogPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $syncedCatalog = Get-Content -LiteralPath $syncedCatalogPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($distCatalog.hostApiVersion -ne $distManifest.hostApiVersion -or
            $syncedCatalog.hostApiVersion -ne $distManifest.hostApiVersion) {
            throw "Capacitor APP catalog does not match host API $($distManifest.hostApiVersion): $relativePath"
        }
        $distHash = (Get-FileHash -LiteralPath $distCatalogPath -Algorithm SHA256).Hash
        $syncedHash = (Get-FileHash -LiteralPath $syncedCatalogPath -Algorithm SHA256).Hash
        if ($distHash -ne $syncedHash) { throw "Capacitor APP catalog differs from dist: $relativePath" }
    }
    if ($env:SRL_ANDROID_PREINSTALL_OFFICIAL_APPS -eq '1') {
        $shellCatalogPath = Join-Path $distRoot "official-apps\$($distManifest.shellVersion)\catalog.json"
        $shellCatalog = Get-Content -LiteralPath $shellCatalogPath -Raw -Encoding UTF8 | ConvertFrom-Json
        foreach ($app in $shellCatalog.apps.PSObject.Properties) {
            if (($app.Name -in @('assistant', 'resourcePlaza') -and $env:SRL_ANDROID_BUNDLE_OPTIONAL_OFFICIAL_APPS -ne '1') -or
                ($PreinstallOfficialAppIds.Count -gt 0 -and $app.Name -notin $PreinstallOfficialAppIds)) { continue }
            $relativePackage = ([string]$app.Value.url).TrimStart('/')
            if ($relativePackage -notmatch "^official-apps/$([regex]::Escape($distManifest.shellVersion))/$([regex]::Escape($app.Name))-[a-f0-9]{16}\.srlapp$" -or $relativePackage.Contains('..')) {
                throw "Invalid preinstalled APP package URL: $($app.Value.url)"
            }
            $distPackage = Join-Path $distRoot $relativePackage.Replace('/', '\')
            $syncedPackage = Join-Path $androidPublicRoot $relativePackage.Replace('/', '\')
            foreach ($path in @($distPackage, $syncedPackage)) {
                if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Required preinstalled APP package is missing: $path" }
            }
            if ((Get-FileHash -LiteralPath $distPackage -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $syncedPackage -Algorithm SHA256).Hash) {
                throw "Capacitor APP package differs from dist: $relativePackage"
            }
        }
    }
    return $distManifest
}

function Read-ZipEntryText {
    param([Parameter(Mandatory)]$Entry)
    $reader = [IO.StreamReader]::new($Entry.Open())
    try { return $reader.ReadToEnd() }
    finally { $reader.Dispose() }
}

try {
    Set-Location -LiteralPath $projectDirectory
    Initialize-AndroidEnvironment
    $pnpm = (Get-Command 'pnpm.cmd' -ErrorAction Stop).Source
    if ($Mode -ne 'Native' -and -not (Test-Path -LiteralPath (Join-Path $projectDirectory 'node_modules\.pnpm'))) {
        Write-Host 'Dependencies are missing; installing from pnpm-lock.yaml...' -ForegroundColor Yellow
        Invoke-Checked -Command $pnpm -Arguments @('install', '--frozen-lockfile')
    }

    if ($Mode -eq 'Remote') {
        if (-not [Uri]::IsWellFormedUriString($ServerUrl, [UriKind]::Absolute)) {
            throw "Invalid remote server URL: $ServerUrl"
        }
        $env:CAPACITOR_SERVER_URL = $ServerUrl.TrimEnd('/')
        Write-Warning 'Remote mode is only for explicit online-shell debugging. Use -Mode Packaged for the distributable offline APK.'
    }
    elseif ($Mode -eq 'Packaged') {
        Remove-Item Env:CAPACITOR_SERVER_URL -ErrorAction SilentlyContinue
    }
    if ($BundleOptionalOfficialApps) { $env:SRL_ANDROID_BUNDLE_OPTIONAL_OFFICIAL_APPS = '1' }
    else { Remove-Item Env:SRL_ANDROID_BUNDLE_OPTIONAL_OFFICIAL_APPS -ErrorAction SilentlyContinue }
    if ($PreinstallOfficialApps) { $env:SRL_ANDROID_PREINSTALL_OFFICIAL_APPS = '1' }
    else { Remove-Item Env:SRL_ANDROID_PREINSTALL_OFFICIAL_APPS -ErrorAction SilentlyContinue }
    if ($PreinstallOfficialAppIds.Count -gt 0) { $env:SRL_ANDROID_PREINSTALL_OFFICIAL_APP_IDS = $PreinstallOfficialAppIds -join ',' }
    else { Remove-Item Env:SRL_ANDROID_PREINSTALL_OFFICIAL_APP_IDS -ErrorAction SilentlyContinue }

    Write-Host "Build mode: $Mode / $Variant" -ForegroundColor Cyan
    if ($Mode -ne 'Native') {
        if ($SkipWebBuild) {
            if ($Mode -ne 'Packaged') {
                throw '-SkipWebBuild 只可用于 Packaged 模式。'
            }
            $buildInfo = Get-Content -LiteralPath (Join-Path $projectDirectory 'build-info.json') -Raw -Encoding UTF8 | ConvertFrom-Json
            $catalog = Join-Path $projectDirectory "dist\official-apps\$($buildInfo.buildId)\catalog.json"
            if (-not (Test-Path -LiteralPath (Join-Path $projectDirectory 'dist\index.html') -PathType Leaf) -or
                -not (Test-Path -LiteralPath $catalog -PathType Leaf)) {
                throw '现有 dist 缺少当前 buildId 的网页或功能包清单。'
            }
            Invoke-Checked -Command $pnpm -Arguments @('exec', 'node', 'scripts/Check-BuildInfo.mjs')
            Invoke-Checked -Command $pnpm -Arguments @('exec', 'node', 'scripts/Check-OfficialAppPackages.mjs')
        }
        else {
            Invoke-Checked -Command $pnpm -Arguments @('build')
        }
        Invoke-Checked -Command $pnpm -Arguments @('exec', 'cap', 'sync', 'android')
        if ($Mode -eq 'Packaged') {
            $null = Assert-SyncedOfficialAppAssets -ProjectRoot $projectDirectory
        }
    }
    Write-AndroidLocalProperties

    Push-Location (Join-Path $projectDirectory 'android')
    try {
        $taskName = if ($Variant -eq 'Release') { 'assembleRelease' } else { 'assembleDebug' }
        $task = if ($Mode -eq 'Native') { ":nativeapp:$taskName" } else { ":app:$taskName" }
        Invoke-Checked -Command '.\gradlew.bat' -Arguments @($task)
    }
    finally {
        Pop-Location
    }

    $apkName = if ($Variant -eq 'Release') {
        if ($Mode -eq 'Native') { 'nativeapp-release.apk' } else { 'app-release.apk' }
    } else {
        if ($Mode -eq 'Native') { 'nativeapp-debug.apk' } else { 'app-debug.apk' }
    }
    $moduleName = if ($Mode -eq 'Native') { 'nativeapp' } else { 'app' }
    $apkPath = Join-Path $projectDirectory "android\$moduleName\build\outputs\apk\$($Variant.ToLowerInvariant())\$apkName"
    if (-not (Test-Path -LiteralPath $apkPath)) {
        throw "Build completed but the APK was not found: $apkPath"
    }

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $apkArchive = [System.IO.Compression.ZipFile]::OpenRead($apkPath)
    try {
        $apkEntries = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        foreach ($entry in $apkArchive.Entries) { [void]$apkEntries.Add($entry.FullName) }
        $assetManifestEntry = $apkArchive.GetEntry('assets/public/official-app-assets.json')
        if (-not $assetManifestEntry) {
            throw 'APK is missing required assets/public/official-app-assets.json.'
        }
        $manifestReader = [IO.StreamReader]::new($assetManifestEntry.Open())
        try { $assetManifestText = $manifestReader.ReadToEnd() }
        finally { $manifestReader.Dispose() }
        $assetManifest = $assetManifestText | ConvertFrom-Json
        $distManifestText = Get-Content -LiteralPath (Join-Path $projectDirectory 'dist\official-app-assets.json') -Raw -Encoding UTF8
        if ($assetManifestText -ne $distManifestText) {
            throw 'APK official APP asset manifest differs from dist.'
        }
        if (-not $assetManifest.shellFiles -or $assetManifest.shellFiles.Count -eq 0) {
            throw 'APK official APP asset manifest has no shellFiles.'
        }
        foreach ($file in $assetManifest.shellFiles) {
            $apkPathEntry = 'assets/public/' + $file.path.TrimStart('/')
            if (-not $apkEntries.Contains($apkPathEntry)) {
                throw "APK official APP asset is missing: $apkPathEntry"
            }
        }
        foreach ($entry in $apkEntries) {
            if ($entry -match '^assets/public/icons/assistant-pet(?:-[A-Za-z0-9_-]+)?\.png$') {
                throw "Optional pet artwork must not be bundled in the APK: $entry"
            }
        }
        foreach ($relativePath in Get-OfficialAppCatalogPaths -Manifest $assetManifest) {
            $catalogEntryName = 'assets/public/' + $relativePath
            $catalogEntry = $apkArchive.GetEntry($catalogEntryName)
            if (-not $catalogEntry) { throw "APK is missing required APP catalog: $catalogEntryName" }
            $catalog = Read-ZipEntryText -Entry $catalogEntry | ConvertFrom-Json
            if ($catalog.hostApiVersion -ne $assetManifest.hostApiVersion) {
                throw "APK APP catalog does not match host API $($assetManifest.hostApiVersion): $catalogEntryName"
            }
            $distCatalogPath = Join-Path $projectDirectory ('dist\' + $relativePath.Replace('/', '\'))
            if ((Read-ZipEntryText -Entry $catalogEntry) -ne (Get-Content -LiteralPath $distCatalogPath -Raw -Encoding UTF8)) {
                throw "APK APP catalog differs from dist: $catalogEntryName"
            }
        }
        if ($PreinstallOfficialApps) {
            $shellCatalogPath = Join-Path $projectDirectory "dist\official-apps\$($assetManifest.shellVersion)\catalog.json"
            $shellCatalog = Get-Content -LiteralPath $shellCatalogPath -Raw -Encoding UTF8 | ConvertFrom-Json
            foreach ($app in $shellCatalog.apps.PSObject.Properties) {
                if (($app.Name -in @('assistant', 'resourcePlaza') -and $env:SRL_ANDROID_BUNDLE_OPTIONAL_OFFICIAL_APPS -ne '1') -or
                    ($PreinstallOfficialAppIds.Count -gt 0 -and $app.Name -notin $PreinstallOfficialAppIds)) { continue }
                $relativePackage = ([string]$app.Value.url).TrimStart('/')
                $packageEntryName = 'assets/public/' + $relativePackage
                $packageEntry = $apkArchive.GetEntry($packageEntryName)
                if (-not $packageEntry) { throw "APK is missing preinstalled APP package: $packageEntryName" }
                $distPackagePath = Join-Path $projectDirectory ('dist\' + $relativePackage.Replace('/', '\'))
                $packageStream = $packageEntry.Open()
                $hasher = [Security.Cryptography.SHA256]::Create()
                try { $apkPackageHash = [Convert]::ToHexString($hasher.ComputeHash($packageStream)) }
                finally { $packageStream.Dispose(); $hasher.Dispose() }
                if ($apkPackageHash -ne (Get-FileHash -LiteralPath $distPackagePath -Algorithm SHA256).Hash) {
                    throw "APK APP package differs from dist: $packageEntryName"
                }
            }
        }
    }
    finally { $apkArchive.Dispose() }

    Write-Host ''
    Write-Host 'APK generated:' -ForegroundColor Green
    Write-Host $apkPath
    if ($Variant -eq 'Release') {
        $buildToolsDirectory = Get-ChildItem -LiteralPath (Join-Path $env:ANDROID_HOME 'build-tools') -Directory |
            Sort-Object Name -Descending |
            Select-Object -First 1 -ExpandProperty FullName
        $apkSigner = Join-Path $buildToolsDirectory 'apksigner.bat'
        $signatureOutput = @(& $apkSigner verify --verbose --print-certs $apkPath 2>&1)
        if ($LASTEXITCODE -ne 0) { throw "APK signature verification failed: $apkPath" }
        $signatureOutput | ForEach-Object { Write-Host $_ }
        $certificateMatch = [regex]::Match(($signatureOutput -join "`n"), '(?im)^(?:Signer #1 certificate|V[0-9.]+ Signer: certificate) SHA-256 digest:\s*([0-9a-f]{64})\s*$')
        if (-not $certificateMatch.Success) { throw 'Could not read APK certificate SHA-256.' }
        if ($ExpectedCertificateSha256 -and $certificateMatch.Groups[1].Value -ne $ExpectedCertificateSha256) {
            throw '新 APK 的签名证书与正式发行基线不一致，停止发布。'
        }
    }
}
finally {
    if ($null -eq $oldBundleOptionalOfficialApps) { Remove-Item Env:SRL_ANDROID_BUNDLE_OPTIONAL_OFFICIAL_APPS -ErrorAction SilentlyContinue }
    else { $env:SRL_ANDROID_BUNDLE_OPTIONAL_OFFICIAL_APPS = $oldBundleOptionalOfficialApps }
    if ($null -eq $oldServerUrl) {
        Remove-Item Env:CAPACITOR_SERVER_URL -ErrorAction SilentlyContinue
    }
    else {
        $env:CAPACITOR_SERVER_URL = $oldServerUrl
    }
    if ($null -eq $oldPreinstallOfficialApps) { Remove-Item Env:SRL_ANDROID_PREINSTALL_OFFICIAL_APPS -ErrorAction SilentlyContinue }
    else { $env:SRL_ANDROID_PREINSTALL_OFFICIAL_APPS = $oldPreinstallOfficialApps }
    if ($null -eq $oldPreinstallOfficialAppIds) { Remove-Item Env:SRL_ANDROID_PREINSTALL_OFFICIAL_APP_IDS -ErrorAction SilentlyContinue }
    else { $env:SRL_ANDROID_PREINSTALL_OFFICIAL_APP_IDS = $oldPreinstallOfficialAppIds }

    foreach ($item in @(
        @{ Name = 'JAVA_HOME'; Value = $oldJavaHome },
        @{ Name = 'ANDROID_HOME'; Value = $oldAndroidHome },
        @{ Name = 'ANDROID_SDK_ROOT'; Value = $oldAndroidSdkRoot },
        @{ Name = 'GRADLE_USER_HOME'; Value = $oldGradleUserHome }
    )) {
        if ($null -eq $item.Value) {
            Remove-Item "Env:$($item.Name)" -ErrorAction SilentlyContinue
        }
        else {
            Set-Item "Env:$($item.Name)" $item.Value
        }
    }
}
