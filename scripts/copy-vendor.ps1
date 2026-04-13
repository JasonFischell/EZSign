$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$vendorRoot = Join-Path $repoRoot "extension\vendor"

New-Item -ItemType Directory -Force -Path $vendorRoot | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $vendorRoot "pdfjs") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $vendorRoot "pdf-lib") | Out-Null

Copy-Item -LiteralPath (Join-Path $repoRoot "node_modules\pdfjs-dist\build\pdf.mjs") -Destination (Join-Path $vendorRoot "pdfjs\pdf.mjs") -Force
Copy-Item -LiteralPath (Join-Path $repoRoot "node_modules\pdfjs-dist\build\pdf.worker.mjs") -Destination (Join-Path $vendorRoot "pdfjs\pdf.worker.mjs") -Force
Copy-Item -LiteralPath (Join-Path $repoRoot "node_modules\pdf-lib\dist\pdf-lib.min.js") -Destination (Join-Path $vendorRoot "pdf-lib\pdf-lib.min.js") -Force
