$ErrorActionPreference = 'Stop'
$project = 'opc-delivery-desk'
$composeFile = Join-Path $PSScriptRoot 'docker-compose.yml'
docker info *> $null
if ($LASTEXITCODE -ne 0) { throw 'Docker Engine is not running. Start Docker Desktop and retry.' }
docker compose -p $project -f $composeFile up --build -d
if ($LASTEXITCODE -ne 0) { throw 'Could not start the OPC delivery desk.' }
docker compose -p $project -f $composeFile ps
$port = if ($env:OPC_PORT) { $env:OPC_PORT } else { '8080' }
Write-Output "OPC demo: http://localhost:$port/  Register: /register  Login: /login"