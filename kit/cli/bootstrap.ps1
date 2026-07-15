# lively 부트스트랩 (Windows / PowerShell) — bootstrap.sh 와 역할이 정확히 대칭 (#864)
#
#   irm https://<게이트웨이>/cli.ps1 | iex
#
# 하는 일은 딱 넷: [1] Node 확보  [2] lively CLI 설치  [3] PATH 배선  [4] `lively setup` 으로 인계.
# 실제 설치(키트·훅·MCP 등록)는 전부 CLI(Node)가 한다 — 그래서 mac/linux/windows 가 **같은 설치 코드**를 돈다.
#   (종전엔 여기 1,400자짜리 PowerShell 설치 로직이 통째로 들어 있었고, 그래서 아무도 검증하지 못했다.)
#
# 토큰은 담지 않는다 — [4] 의 `lively login` 이 가림 입력으로 받는다.
# 재실행 안전(idempotent): 이미 있는 건 건너뛰고, 기존 토큰·설정은 건드리지 않는다.

$ErrorActionPreference = "Stop"

# 게이트웨이가 서빙 시점에 자기 주소를 굽는다(src/web.ts 의 /cli.ps1 라우트).
$GW = if ($env:LIVELY_GATEWAY) { $env:LIVELY_GATEWAY } else { "__LIVELY_GATEWAY__" }
$GW = $GW.TrimEnd('/')

function Say($m, $c = "Gray") { Write-Host $m -ForegroundColor $c }
function OK($m)   { Write-Host "  * $m" -ForegroundColor Green }
function Info($m) { Write-Host "  · $m" -ForegroundColor DarkGray }
function Die($m)  { Write-Host "`n✗ $m" -ForegroundColor Red; exit 1 }

if ($GW -notmatch '^https?://') { Die "게이트웨이 주소가 올바르지 않습니다: '$GW'" }

# ⚠ 경로는 반드시 $env:USERPROFILE 기준 — 훅·user-install 이 Node 의 os.homedir()(=%USERPROFILE%)에서 읽는다.
# ⚠ LIVELY_HOME 은 **HOME 리다이렉트**다(.lively 디렉터리가 아니라) — user-install/uninstall/self-update 와 같은 계약.
$LVH = if ($env:LIVELY_HOME) { $env:LIVELY_HOME } else { $env:USERPROFILE }
$LV = Join-Path $LVH ".lively"

Say ""
Say "=== 라이블리 설치 ===" "Cyan"
Say ""

# ── [1] Node 확보 ─────────────────────────────────────────────────────────────
# win zip 은 node.exe 가 폴더 **루트**에 있다(POSIX 의 bin/ 이 아님) — 심(lively.cmd)이 그걸 전제한다.
function Find-LivelyNode {
  $rt = Join-Path $LV "runtime"
  if (Test-Path $rt) {
    $d = Get-ChildItem $rt -Directory -Filter "node-*" -EA 0 |
         Where-Object { Test-Path (Join-Path $_.FullName "node.exe") } |
         Sort-Object Name -Descending | Select-Object -First 1
    if ($d) { return (Join-Path $d.FullName "node.exe") }
  }
  return $null
}

$NODE = $null
if (Get-Command node -EA 0) {
  $NODE = (Get-Command node).Source
  OK "Node: 시스템 설치 사용 ($(& $NODE -v))"
} elseif ($NODE = Find-LivelyNode) {
  OK "Node: 번들 런타임 재사용 ($(& $NODE -v))"
} else {
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
  $ver = "v22.14.0"   # 폴백(공식 LTS)
  try {
    $idx = Invoke-RestMethod -UseBasicParsing -TimeoutSec 15 "https://nodejs.org/dist/index.json"
    $lts = $idx | Where-Object { $_.lts } | Select-Object -First 1
    if ($lts.version) { $ver = $lts.version }
  } catch { Info "Node 버전 목록 조회 실패 — 폴백 $ver 사용" }

  $bname  = "node-$ver-win-$arch"
  $rt     = Join-Path $LV "runtime"
  $tmp    = Join-Path $env:TEMP "lively-node.zip"
  New-Item -ItemType Directory -Force $rt | Out-Null
  Info "Node $ver ($arch) 내려받는 중… (~30MB · 관리자 권한 불필요)"
  try {
    Invoke-WebRequest -UseBasicParsing -TimeoutSec 300 "https://nodejs.org/dist/$ver/$bname.zip" -OutFile $tmp
  } catch { Die "Node 다운로드 실패 — 네트워크를 확인하고 다시 실행하세요." }
  # 무결성 검증 — 불일치면 중단(공급망 위생). 목록을 못 받으면 TLS 다운로드로 진행.
  try {
    $sums = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 30 "https://nodejs.org/dist/$ver/SHASUMS256.txt").Content
    $want = ($sums -split "`n" | Where-Object { $_ -match [regex]::Escape("$bname.zip") } |
             Select-Object -First 1) -split '\s+' | Select-Object -First 1
    $got  = (Get-FileHash $tmp -Algorithm SHA256).Hash.ToLower()
    if ($want -and ($want.ToLower() -ne $got)) { Die "Node 체크섬 불일치 — 설치를 중단합니다(무결성 실패)." }
    if ($want) { Info "체크섬 검증 통과" }
  } catch { Info "SHASUMS256 확보 실패 — 체크섬 생략(TLS 다운로드로 진행)" }

  $target = Join-Path $rt $bname
  Remove-Item -Recurse -Force $target -EA 0
  Expand-Archive -Path $tmp -DestinationPath $rt -Force
  Remove-Item $tmp -EA 0
  $NODE = Join-Path $target "node.exe"
  if (-not (Test-Path $NODE)) { Die "Node 설치 확인 실패." }
  OK "Node 설치 완료: $target ($(& $NODE -v))"
}

# ── [2] lively CLI ────────────────────────────────────────────────────────────
# /cli/lively.mjs 는 무인증 라우트 — 코드일 뿐 비밀이 없다(/ui 정적 자산과 같은 성격).
New-Item -ItemType Directory -Force (Join-Path $LV "lib") | Out-Null
New-Item -ItemType Directory -Force (Join-Path $LV "bin") | Out-Null
$cliPath = Join-Path $LV "lib\lively.mjs"
# ⚠ 임시 파일도 **.mjs 확장자를 유지**해야 한다 — `node --check` 는 확장자로 모듈 종류를 판정한다.
#  `lively.mjs.new` 로 받으면 CommonJS 로 파싱돼 최상위 import 가 SyntaxError → 멀쩡한 CLI 를 '손상'으로 거부한다.
$tmpCli  = Join-Path $LV "lib\.lively-download.mjs"
try {
  Invoke-WebRequest -UseBasicParsing -TimeoutSec 60 "$GW/cli/lively.mjs" -OutFile $tmpCli
} catch { Die "CLI 다운로드 실패 — 게이트웨이 주소를 확인하세요: $GW" }
# 프록시가 로그인 HTML 을 200 으로 돌려주는 사고를 여기서 잡는다.
& $NODE --check $tmpCli 2>$null
if ($LASTEXITCODE -ne 0) {
  Remove-Item $tmpCli -EA 0
  Die "내려받은 CLI 가 손상됐습니다 — 게이트웨이 주소를 확인하세요: $GW"
}
Move-Item -Force $tmpCli $cliPath

# 런처 심(.cmd) — 메시지는 ASCII 로만(콘솔 코드페이지에 따라 한글이 깨질 수 있음).
#  번들 Node 를 최우선으로 찾고(폴더명 내림차순 = 최신), 없으면 PATH 의 node.
$shim = @'
@echo off
setlocal EnableDelayedExpansion
set "LVH=%LIVELY_HOME%"
if "%LVH%"=="" set "LVH=%USERPROFILE%"
set "LV=%LVH%\.lively"
set "N="
for /f "delims=" %%d in ('dir /b /ad /o-n "%LV%\runtime\node-*" 2^>nul') do (
  if exist "%LV%\runtime\%%d\node.exe" (
    set "N=%LV%\runtime\%%d\node.exe"
    goto :found
  )
)
where node >nul 2>nul && set "N=node"
:found
if not defined N (
  echo lively: Node not found. Reinstall:  irm ^<gateway^>/cli.ps1 ^| iex 1>&2
  exit /b 1
)
"%N%" "%LV%\lib\lively.mjs" %*
exit /b %errorlevel%
'@
# ⚠ **CRLF + 말미 개행으로 쓴다.** 이 here-string 은 LF 로 저장돼 있고 마지막 줄 뒤에 개행이 없다.
#  cmd.exe 의 여러 줄 `for /f … do ( … )` 블록은 LF-only 파일에서 동작이 들쭉날쭉하다.
#  user-install.mjs 의 CLI_SHIM_CMD 는 CRLF + 말미 개행이므로 **바이트가 정확히 일치**해야 한다
#  (드리프트는 kit/cli/lively.test.mjs 의 '심 동일성(Windows)' 케이스가 잡는다 — POSIX 심과 같은 방식).
$shimCrlf = ((($shim -replace "`r`n", "`n") -replace "`n", "`r`n")) + "`r`n"
[System.IO.File]::WriteAllText((Join-Path $LV "bin\lively.cmd"), $shimCrlf, [System.Text.Encoding]::ASCII)
OK "lively 설치: $LV\bin\lively.cmd"

# 게이트웨이 주소 기록 — `lively login` 이 어디에 물어볼지 알게 된다(토큰은 여기 없다).
Set-Content -Path (Join-Path $LV "gateway-url") -Value $GW -NoNewline

# ── [3] PATH 배선 (User 스코프 — 관리자 권한 불필요) ──────────────────────────
$binDir = Join-Path $LV "bin"
$uPath  = [Environment]::GetEnvironmentVariable("PATH", "User")
if (-not $uPath) { $uPath = "" }
if (($uPath -split ';') -notcontains $binDir) {
  [Environment]::SetEnvironmentVariable("PATH", ($binDir + ";" + $uPath).TrimEnd(';'), "User")
  OK "PATH 에 추가: $binDir  (새 창부터 적용)"
} else {
  Info "PATH 기존 유지"
}
$env:PATH = "$binDir;$env:PATH"   # 현재 세션 즉시 반영

# ── [4] 인계 — 로그인 + 설치 ──────────────────────────────────────────────────
# `irm | iex` 는 현재 PowerShell 세션 안에서 돌기 때문에 콘솔 입력이 살아 있다 → 바로 인계한다.
#  단 스크립트/CI 로 돌린 경우(stdin 리다이렉트)엔 물어볼 사람이 없다 → bootstrap.sh 와 **같은 규칙**으로
#  안내만 출력한다(대화형 프롬프트에서 불친절하게 죽지 않게 — 두 부트스트랩의 동작을 대칭으로 유지).
$canPrompt = $true
try { $canPrompt = [Environment]::UserInteractive -and -not [Console]::IsInputRedirected } catch { $canPrompt = $true }

if ($canPrompt) {
  & $NODE $cliPath setup
  exit $LASTEXITCODE
}

Say ""
OK "lively CLI 준비 완료."
Say ""
Say "  다음 두 명령을 실행하세요:"
Say ""
Say "      lively login      # 접속 토큰 입력(화면에 안 보임)"
Say "      lively install    # 키트 설치"
Say ""
Say "  (지금 창에서 'lively' 를 못 찾으면 PowerShell 을 새로 여세요 — PATH 는 새 창부터 적용됩니다.)"
Say ""
