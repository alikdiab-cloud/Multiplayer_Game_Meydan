[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProjectRoot = $PSScriptRoot

function Get-NodeExecutable {
    $pathNode = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($null -ne $pathNode) {
        return $pathNode.Source
    }

    $configuredPath = [Environment]::GetEnvironmentVariable('MEYDAN_NODE_PATH')
    if (-not [string]::IsNullOrWhiteSpace($configuredPath)) {
        if ([System.IO.Path]::IsPathRooted($configuredPath)) {
            $candidate = [System.IO.Path]::GetFullPath($configuredPath)
        }
        else {
            $candidate = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot $configuredPath))
        }

        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            throw "MEYDAN_NODE_PATH is set, but no file exists at '$candidate'. Set it to a Node.js executable or clear it."
        }

        return $candidate
    }

    $localCandidates = @(
        (Join-Path $ProjectRoot '.tools\node\node.exe'),
        (Join-Path $ProjectRoot 'tools\node\node.exe'),
        (Join-Path $ProjectRoot '.runtime\node.exe')
    )
    foreach ($localCandidate in $localCandidates) {
        if (Test-Path -LiteralPath $localCandidate -PathType Leaf) {
            $resolvedCandidate = (Resolve-Path -LiteralPath $localCandidate).Path
            $rootWithSeparator = [System.IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
            if (-not $resolvedCandidate.StartsWith($rootWithSeparator, [System.StringComparison]::OrdinalIgnoreCase)) {
                throw "The discovered Node.js runtime is outside the project folder: '$resolvedCandidate'."
            }

            return $resolvedCandidate
        }
    }

    throw @"
Node.js was not found on PATH, MEYDAN_NODE_PATH is not configured, and no project-local portable runtime was found.
Install Node.js 22.12 or newer and make node.exe available on PATH, or set MEYDAN_NODE_PATH to an existing node.exe.
The launcher does not download executables or require administrator rights.
"@
}

try {
    $packagePath = Join-Path $ProjectRoot 'package.json'
    $lockPath = Join-Path $ProjectRoot 'package-lock.json'
    if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) {
        throw "Could not find package.json beside the launcher: '$packagePath'."
    }
    if (-not (Test-Path -LiteralPath $lockPath -PathType Leaf)) {
        throw "Could not find package-lock.json beside the launcher: '$lockPath'."
    }

    $package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
    $nodeEngine = [string]$package.engines.node
    if ($nodeEngine -notmatch '^>=\s*(\d+\.\d+\.\d+)') {
        throw "The package Node.js engine '$nodeEngine' is not in the supported >=major.minor.patch form. Update this launcher to match package.json."
    }
    $minimumNodeVersion = [version]$Matches[1]

    $nodeExecutable = Get-NodeExecutable
    $nodeVersionOutput = & $nodeExecutable -p 'process.versions.node'
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace([string]$nodeVersionOutput)) {
        throw "Could not read the Node.js version from '$nodeExecutable'."
    }
    if ([string]$nodeVersionOutput -notmatch '^(\d+\.\d+\.\d+)') {
        throw "Node.js returned an unrecognized version string: '$nodeVersionOutput'."
    }
    $nodeVersion = [version]$Matches[1]
    if ($nodeVersion -lt $minimumNodeVersion) {
        throw "Node.js $nodeVersion is too old. This project requires Node.js $minimumNodeVersion or newer."
    }

    $tsxPackage = Join-Path $ProjectRoot 'node_modules\tsx\package.json'
    $tsxLoader = Join-Path $ProjectRoot 'node_modules\tsx\dist\loader.mjs'
    if (-not (Test-Path -LiteralPath $tsxPackage -PathType Leaf) -or -not (Test-Path -LiteralPath $tsxLoader -PathType Leaf)) {
        throw @"
The project's local development dependencies are missing.
From the app folder '$ProjectRoot', install exactly the locked dependencies with: npm ci
The launcher will not install packages or perform a global install.
"@
    }

    Write-Host "Using Node.js $nodeVersion at $nodeExecutable"
    Write-Host "Starting the integrated development server from $ProjectRoot"
    Write-Host 'The server prints the actual local and network URLs after it starts.'
    Write-Host 'The localhost URL is for this computer only. A network URL is for devices on the same LAN if the network and firewall permit it.'
    Write-Host 'This does not create public Internet hosting; public access requires a separately hosted and reachable deployment.'

    Push-Location -LiteralPath $ProjectRoot
    try {
        & $nodeExecutable '--import' 'tsx' 'server/index.ts'
        $serverExitCode = $LASTEXITCODE
    }
    finally {
        Pop-Location
    }

    if ($serverExitCode -ne 0) {
        exit $serverExitCode
    }
}
catch {
    Write-Error $_
    exit 1
}
