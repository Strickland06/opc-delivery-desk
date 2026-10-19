$ErrorActionPreference = 'Stop'
$project = 'opc-delivery-desk'
$composeFile = Join-Path $PSScriptRoot 'docker-compose.yml'
docker compose -p $project -f $composeFile down
if ($LASTEXITCODE -ne 0) { throw 'Could not stop the OPC delivery desk.' }
Write-Output 'OPC demo stopped. Persistent database volumes were preserved.'