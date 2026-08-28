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
# 이 주소가 **게이트웨이**인가 **라이블리 클라우드**인가 (#2044) — sh 판과 같은 계약.
#  굽히지 않은 채 오면 종전대로 'gateway'(새 서버 + 구 스크립트 조합에서 안전한 쪽).
$Mode = if ($env:LIVELY_MODE) { $env:LIVELY_MODE } else { "__LIVELY_MODE__" }
if ($Mode -ne "cloud") { $Mode = "gateway" }
$GW = $GW.TrimEnd('/')

function Say($m, $c = "Gray") { Write-Host $m -ForegroundColor $c }
function OK($m)   { Write-Host "  * $m" -ForegroundColor Green }
function Info($m) { Write-Host "  · $m" -ForegroundColor DarkGray }
function Warn($m) { Write-Host "  ! $m" -ForegroundColor Yellow }
# ⚠ **exit 금지**(#1087) — `irm … | iex` 는 사용자의 **현재 PowerShell 세션 안에서** 돈다. 여기서 exit 를 부르면
#  스크립트가 아니라 **사용자 창이 닫히고**, 방금 찍은 에러 메시지가 통째로 증발한다 → 사용자도 우리도 원인을
#  못 본다(실측: `iex 'Write-Host A; exit 3'` 은 A 만 찍고 세션을 종료시킨다. 실제로 그 사고가 났다).
#  대신 PipelineStoppedException(Ctrl+C 와 같은 취급)으로 **스크립트만** 멈춘다 — 추가 에러 덤프도 안 뜬다.
#  bootstrap.sh 는 `curl | sh` 라 자식 셸에서 죽으므로 이 제약이 없다 — 두 부트스트랩이 갈리는 유일한 지점이다.
function Die($m)  { Write-Host "`n✗ $m" -ForegroundColor Red; throw [System.Management.Automation.PipelineStoppedException]::new() }

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
#
# ⚠ **존재가 아니라 버전으로 판정한다**(#1068 — bootstrap.sh 와 같은 계약). 옛 코드는 `Get-Command node`
#   하나로 시스템 node 를 무조건 채택해서, 구버전 박스에선 CLI 가 그 위에서 돌다 `fetch is not defined`
#   (전역 fetch 는 Node 18+)로 [1/3] 키트 내려받기에서 죽었다. 아래 [2] 의 심(lively.cmd)은 번들 런타임을
#   우선하지만 **여기서 안 깔면 심이 쥘 게 없어** 결국 같은 구버전 node 로 폴백한다.
#   판정 규칙: **못 쓸 버전 = 없는 것**. 시스템 node 는 건드리지 않고 우리 것만 따로 깐다.
$NODE_MIN_MAJOR = 20   # package.json engines(">=20") · bootstrap.sh · lively.mjs 와 같은 계약.
# ⚠ **node 를 eval(-p/-e)로 부르지 마라 — 인자 안의 `"` 가 Windows PowerShell 5.1 에서 벗겨진다**(#1087).
#  PS 5.1 은 네이티브 명령에 인자를 넘길 때 인자 **안**의 큰따옴표를 이스케이프하지 않는다. 그래서 옛 코드의
#  `-p 'process.versions.node.split(".")[0]'` 은 node 에 `process.versions.node.split(.)[0]` 로 도착해
#  SyntaxError 로 죽었고(실측 확인), 이 함수는 **멀쩡한 Node 를 '못 쓴다'고 판정**했다(v22.15.0·v24.18.0 둘 다).
#  피해는 조용했다 — 박스마다 30MB 런타임을 매번 새로 받고(이미 받아둔 것도 재사용 못 함), 사용자에겐
#  "Node 20 미만"이라는 **거짓** 안내가 나갔다. #1068 이 세운 버전 게이트가 Windows 에서만 통째로 무효였다.
#  → 판정은 **인자가 없는 `-v`** 로만 한다(문자열 인자 자체가 없으니 이스케이프 문제가 성립하지 않는다).
function Get-NodeMajor($exe) {
  $out = ""
  try { $out = [string](& $exe -v 2>$null) } catch { return $null }
  if ($LASTEXITCODE -ne 0) { return $null }
  $m = [regex]::Match($out.Trim(), '^v(\d+)\.')
  if (-not $m.Success) { return $null }   # 못 읽음 = 판정 불가(구버전이라는 뜻이 아니다)
  return [int]$m.Groups[1].Value
}
function Test-NodeUsable($exe) {
  if (-not $exe -or -not (Test-Path $exe)) { return $false }
  $mj = Get-NodeMajor $exe
  if ($null -eq $mj) { return $false }
  return ($mj -ge $NODE_MIN_MAJOR)
}
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

$SYS_NODE  = (Get-Command node -EA 0).Source
$BUNDLED   = Find-LivelyNode
# 시스템 node 를 안 쓰기로 했을 때만 안내한다(정상 경로는 조용히 지나간다).
#  ⚠ **"미만"이라고 단정하지 않는다** — 버전을 못 읽어서 못 쓰는 경우도 있고, 그 때 거짓말을 하면 사용자가
#   엉뚱한 곳(노드 업그레이드)을 파게 된다. #1087 에서 실제로 v22.15.0 을 "Node 20 미만"이라고 안내했다.
function Say-OldSysNode($what) {
  if (-not $SYS_NODE) { return }
  $ver = ""
  try { $ver = ([string](& $SYS_NODE -v 2>$null)).Trim() } catch { }
  $why = if ($null -eq (Get-NodeMajor $SYS_NODE)) { "버전 확인 실패" } else { "Node $NODE_MIN_MAJOR 미만" }
  Info "시스템 node($ver) 는 쓰지 않습니다($why) — $what"
}
$NODE = $null
if (Test-NodeUsable $SYS_NODE) {
  $NODE = $SYS_NODE
  OK "Node: 시스템 설치 사용 ($(& $NODE -v))"
} elseif (Test-NodeUsable $BUNDLED) {
  $NODE = $BUNDLED
  Say-OldSysNode "라이블리 전용 런타임을 씁니다(시스템 node 는 그대로 둡니다)."
  OK "Node: 번들 런타임 재사용 ($(& $NODE -v))"
} else {
  Say-OldSysNode "라이블리 전용 런타임을 설치합니다(시스템 node 는 그대로 둡니다)."
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
  $fallback = "v22.14.0"   # 폴백(공식 LTS · 실재 확인됨)
  $ver = $fallback
  try {
    $idx = Invoke-RestMethod -UseBasicParsing -TimeoutSec 15 "https://nodejs.org/dist/index.json"
    $lts = $idx | Where-Object { $_.lts } | Select-Object -First 1
    if ($lts.version) { $ver = $lts.version }
  } catch { Info "Node 버전 목록 조회 실패 — 폴백 $ver 사용" }
  # 해석이 어긋나 최소 버전 미만을 집어오면 이 수정이 통째로 무의미해진다 — 그 땐 폴백(고정 LTS)으로.
  $vm = [regex]::Match([string]$ver, '^v(\d+)\.')
  if (-not $vm.Success -or [int]$vm.Groups[1].Value -lt $NODE_MIN_MAJOR) { $ver = $fallback }

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
# ⚠ 클라우드 모드에선 주소를 쓰지 않는다 — 아직 아무도 모르는 값이다(로그인이 받아 온다).
if ($Mode -eq "gateway") {
  Set-Content -Path (Join-Path $LV "gateway-url") -Value $GW -NoNewline
}

# ── [3] PATH 배선 (User 스코프 — 관리자 권한 불필요) ──────────────────────────
# ⚠ 쓰기 전에 **줄인다**(#2172). 종전엔 새 항목을 무조건 앞에 붙이기만 해서 사용자 PATH 가 조용히 자랐다.
#  실측(2026-08-28 amorite): 84개 / 6224자까지 불어났고 그중 70개가 **삭제된 테스트 임시홈**이었다. 그런데
#  윈도우는 사용자 PATH 가 너무 길면 **뒤를 자르는 게 아니라 통째로 안 합친다** — 그 PC 의 프로세스 PATH 는
#  616자(시스템만)였고 `.lively\bin`·`.local\bin`·`Roaming\npm` 이 어느 프로세스에도 안 보였다.
#  결과: lively·claude 미검출, 노드 하네스 탐지 5종 전멸. 정리 후 14개/727자 → 전부 복구.
#  버리는 기준은 **"TEMP 아래인데 지금 없다"** 로 좁게 잡는다 — 없다는 이유만으로 버리면 이동식·네트워크
#  드라이브를 뺏는다(되돌릴 수도, 원인을 볼 수도 없다). 판정 규칙은 kit/setup/host-effects.mjs 와 같다.
$binDir = Join-Path $LV "bin"
$uPath  = [Environment]::GetEnvironmentVariable("PATH", "User")
if (-not $uPath) { $uPath = "" }
$tempRoots = @($env:TEMP, $env:TMP, (Join-Path $env:LOCALAPPDATA "Temp")) |
  Where-Object { $_ } | ForEach-Object { $_.TrimEnd('\').ToLower() } | Select-Object -Unique
$norm = { param($e) $e.Trim().TrimEnd('\','/').Replace('/','\').ToLower() }
$kept = New-Object System.Collections.ArrayList
$seen = New-Object System.Collections.Generic.HashSet[string]
$deadCount = 0; $dupCount = 0
foreach ($e in ($uPath -split ';')) {
  if (-not $e -or -not $e.Trim()) { continue }
  $n = & $norm $e
  $underTemp = $false
  foreach ($t in $tempRoots) { if ($n -eq $t -or $n.StartsWith($t + '\')) { $underTemp = $true; break } }
  if ($underTemp -and -not (Test-Path -LiteralPath $e)) { $deadCount++; continue }
  if ($seen.Contains($n)) { $dupCount++; continue }
  [void]$seen.Add($n); [void]$kept.Add($e.Trim())
}
$binNorm = & $norm $binDir
if (-not $seen.Contains($binNorm)) { [void]$kept.Insert(0, $binDir) }
$newPath = ($kept -join ';')
if ($newPath -ne $uPath) {
  [Environment]::SetEnvironmentVariable("PATH", $newPath, "User")
  if ($deadCount -or $dupCount) { OK "PATH 정리: 죽은 임시경로 $deadCount 개 · 중복 $dupCount 개 제거" }
  OK "PATH 준비 완료: $binDir  (새 창부터 적용)"
} else {
  Info "PATH 기존 유지"
}
# 길이 경고 — 조용히 넘기면 어느 날 사용자 PATH 가 통째로 무효가 되고, 그때는 원인이 안 보인다.
if ($newPath.Length -gt 1800) {
  Warn "사용자 PATH 가 $($newPath.Length)자로 깁니다 — 너무 길면 윈도우가 이 PATH 를 통째로 무시합니다."
  Warn "  불필요한 항목을 정리하세요:  [Environment]::GetEnvironmentVariable('PATH','User') -split ';'"
}
$env:PATH = "$binDir;$env:PATH"   # 현재 세션 즉시 반영

# ── [4] 인계 — 로그인 + 설치 ──────────────────────────────────────────────────
# `irm | iex` 는 현재 PowerShell 세션 안에서 돌기 때문에 콘솔 입력이 살아 있다 → 바로 인계한다.
#  단 스크립트/CI 로 돌린 경우(stdin 리다이렉트)엔 물어볼 사람이 없다 → bootstrap.sh 와 **같은 규칙**으로
#  안내만 출력한다(대화형 프롬프트에서 불친절하게 죽지 않게 — 두 부트스트랩의 동작을 대칭으로 유지).
$canPrompt = $true
try { $canPrompt = [Environment]::UserInteractive -and -not [Console]::IsInputRedirected } catch { $canPrompt = $true }

if ($canPrompt) {
  if ($Mode -eq "cloud") {
    # 클라우드 — 브라우저 승인 한 번으로 워크스페이스·자격이 온다(주소를 묻지 않는다).
    & $NODE $cliPath setup --cloud $GW
  } else {
    & $NODE $cliPath setup
  }
  # ⚠ 여기서도 exit 금지(위 Die 주석과 같은 이유) — 실패했으면 **사실대로 알리고** 스크립트만 끝낸다.
  #  종전엔 `exit $LASTEXITCODE` 라서, 설치가 실패한 바로 그 순간 사용자 창이 닫혀 에러를 아무도 못 읽었다.
  if ($LASTEXITCODE -ne 0) {
    Write-Host "`n✗ 설치를 끝내지 못했습니다 (종료코드 $LASTEXITCODE)." -ForegroundColor Red
    Write-Host "  이 창은 그대로 두고, 위 메시지를 확인한 뒤 다시 시도하세요:  lively login  →  lively install" -ForegroundColor DarkGray
  }
  return
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
