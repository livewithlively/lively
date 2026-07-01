#requires -version 5
# 제거(Windows) — uninstall-mac.sh 의 PowerShell 대응. ⚠ Windows 미검증(테스트 후 사용).
# 묶음의 user-uninstall.mjs(크로스플랫폼)가 ~/.claude 훅·`claude mcp remove lively`·~/.lively 를 surgical 제거.
#   powershell -ExecutionPolicy Bypass -File uninstall-windows.ps1
# 완전 차단은 관리자가 서버에서 토큰을 회수해야 한다([토큰] 탭).
$ErrorActionPreference = "Stop"
$LivelyDir = Join-Path $HOME ".lively"
$T = if (Test-Path (Join-Path $LivelyDir "token")) { (Get-Content (Join-Path $LivelyDir "token") -Raw).Trim() } else { "" }
$G = if (Test-Path (Join-Path $LivelyDir "gateway-url")) { ((Get-Content (Join-Path $LivelyDir "gateway-url") -Raw).Trim() -replace '/$','') -replace '/mcp$','' } else { "" }
if ([string]::IsNullOrWhiteSpace($T) -or [string]::IsNullOrWhiteSpace($G)) {
  Write-Host "토큰/게이트웨이 정보가 없어 묶음을 받을 수 없습니다. 수동 제거:" -ForegroundColor Yellow
  Write-Host "  claude mcp remove lively --scope user"
  Write-Host "  Remove-Item -Recurse -Force `"$LivelyDir`""
  exit 1
}
$tmp = Join-Path $env:TEMP ("lively-un-" + [Guid]::NewGuid().ToString("N").Substring(0,8))
New-Item -ItemType Directory -Force $tmp | Out-Null
try {
  Invoke-WebRequest -Headers @{Authorization="Bearer $T"} "$G/install" -OutFile (Join-Path $tmp "b.tgz")
  tar -xzf (Join-Path $tmp "b.tgz") -C $tmp
  $un = Join-Path $tmp "setup\user-uninstall.mjs"
  if (Test-Path $un) { node $un } else { Write-Host "user-uninstall.mjs 없음(묶음 손상)" -ForegroundColor Red }
  # #355: 번들 Node 경로(~/.lively\runtime\node-*)를 User PATH 에서 제거 — ~/.lively 삭제와 대칭. node 실행 후에 정리.
  try {
    $uPath = [Environment]::GetEnvironmentVariable("Path","User")
    if ($uPath) {
      $cleaned = (@($uPath -split ';' | Where-Object { $_ -and ($_ -notlike "*\.lively\runtime\node-*") }) -join ';')
      if ($cleaned -ne $uPath) { [Environment]::SetEnvironmentVariable("Path", $cleaned, "User"); Write-Host "User PATH 에서 lively 번들 Node 경로 제거" -ForegroundColor DarkGray }
    }
  } catch {}
  Write-Host "OK 제거 완료. 서버 토큰 회수는 관리자가 [토큰] 탭에서." -ForegroundColor Green
} finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
