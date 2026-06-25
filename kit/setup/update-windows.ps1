#requires -version 5
# 업데이트(Windows) — update-mac.sh 의 PowerShell 대응(self-contained). ⚠ Windows 미검증(테스트 후 사용).
# 설치된 ~/.lively/token + gateway-url 을 읽어 최신 묶음을 받아 멱등 재설치 + MCP 재등록.
#   powershell -ExecutionPolicy Bypass -File update-windows.ps1
# 콘텐츠(강제규칙·회사맥락·메모리)는 매 세션 자동 갱신이라, 훅/설정 변경 시에만 필요.
$ErrorActionPreference = "Stop"
$LivelyDir = Join-Path $HOME ".lively"
if (-not (Test-Path (Join-Path $LivelyDir "token"))) { Write-Host "설치 안 됨(~/.lively/token 없음) — 먼저 설치하세요." -ForegroundColor Red; exit 1 }
$T = (Get-Content (Join-Path $LivelyDir "token") -Raw).Trim()
$G = ((Get-Content (Join-Path $LivelyDir "gateway-url") -Raw).Trim() -replace '/$','') -replace '/mcp$',''
if ([string]::IsNullOrWhiteSpace($G)) { Write-Host "게이트웨이 주소 없음(~/.lively/gateway-url)." -ForegroundColor Red; exit 1 }
$tmp = Join-Path $env:TEMP ("lively-up-" + [Guid]::NewGuid().ToString("N").Substring(0,8))
New-Item -ItemType Directory -Force $tmp | Out-Null
try {
  Write-Host "[1/3] 최신 묶음 다운로드 <- $G/install"
  Invoke-WebRequest -Headers @{Authorization="Bearer $T"} "$G/install" -OutFile (Join-Path $tmp "b.tgz")
  Write-Host "[2/3] 압축 해제"
  tar -xzf (Join-Path $tmp "b.tgz") -C $tmp
  $ui = Join-Path $tmp "setup\user-install.mjs"
  if (-not (Test-Path $ui)) { Write-Host "묶음 손상(user-install.mjs 없음)" -ForegroundColor Red; exit 1 }
  Write-Host "[3/3] MCP 재등록 + 멱등 재설치"
  try { claude mcp remove lively *> $null } catch {}
  try { claude mcp add --transport http --scope user lively "$G/mcp" --header "Authorization: Bearer $T" } catch { Write-Host "  claude mcp add 경고(무시 가능)" -ForegroundColor Yellow }
  node $ui --clone-root $tmp
  Write-Host "OK 업데이트 완료 — 다음 세션부터 최신 적용." -ForegroundColor Green
} finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
