<#
  Lively 컨텍스트 셋업 — Windows (전 멤버 공통)
  ----------------------------------------------------------------
  하는 일: [1] Claude Code 설치  [2] 토큰 입력  [3] /install 번들 다운로드·해제  [4] 사내 MCP 연결  [5] user-level 설치(컨텍스트+훅)
  - git clone 불필요 — 게이트웨이(context-ontology)의 토큰게이트 /install 에서 발행 번들을 받아 설치한다
    (맥 install-via-curl.sh / 관리 UI 설치 명령과 동일 모델 — DB→materialize→generator 로 tar.gz 동적 생성).
  - 이미 설치돼 있으면 최신 번들로 멱등 재설치(재실행 안전). 훅 머지는 중복 안 만듦.
  - [5] user-level 설치는 Node.js 필요 — 설치되면 이후 **어느 폴더에서 claude 를 켜든** 컨텍스트+리플렉스가 따라온다(D2/D3).
    Node 가 없으면 번들 폴더 안에서 직접 켜는 정적 병행 경로로 폴백.

  ▶ 멤버: 이 파일 우클릭 → "PowerShell에서 실행".  (또는 가이드의 한 줄 명령 붙여넣기)
  ▶ 토큰·게이트웨이는 조직 관리자가 발급/안내. -McpToken / -McpUrl 파라미터 또는 LIVELY_TOKEN / LIVELY_GATEWAY 환경변수로 줘도 된다.
#>

param(
  # ── CONFIG (조직별 값은 파라미터/환경변수로 지정) ──────────────────────────────────────
  [string]$McpUrl     = "$env:LIVELY_GATEWAY",  # MCP 게이트웨이 주소 (예: http://<host>:8080/mcp 또는 http://<host>:8080). 파라미터 또는 LIVELY_GATEWAY 환경변수. 필수(설치 번들도 여기서 받음).
  [string]$McpLabel   = "lively",  # MCP 등록 라벨 — 단일 출처: context-ontology/scripts/register-clients.sh (변경은 거기 먼저)
  [string]$McpToken   = "",   # 본인 토큰(사람마다 다름). 비면 LIVELY_TOKEN 환경변수 > 실행 중 프롬프트.
  [string]$InstallDir = "$env:USERPROFILE\lively-context"  # 번들 받아 풀 위치(스테이징 — 설치 후엔 ~/.lively + ~/.claude 가 실체). $env:USERPROFILE = Node os.homedir() 와 동일.
)

# 한글 출력 깨짐 방지
try { chcp 65001 > $null; [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

$ErrorActionPreference = "Stop"
function Say($m,$c="White"){ Write-Host $m -ForegroundColor $c }
function Have($cmd){ [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function RefreshPath(){
  $env:Path = [Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
              [Environment]::GetEnvironmentVariable("Path","User")
}
# 네이티브 명령(claude/git)의 stderr 가 스크립트를 멈추지 않게 감싸 실행
function Soft($block){ $e=$ErrorActionPreference; $ErrorActionPreference='Continue'; try { & $block } catch {}; $ErrorActionPreference=$e }

Say "`n=== Lively 컨텍스트 셋업 ===`n" Cyan

# ── [1] Claude Code ─────────────────────────────────────────────
if (Have claude) {
  Say "[1] Claude Code: 이미 설치됨 -> 건너뜀" Green
} else {
  Say "[1] Claude Code 설치 중... (1~2분)" Yellow
  Soft { irm https://claude.ai/install.ps1 | iex }
  RefreshPath
  if (-not (Have claude)) {
    Say "  설치는 됐지만 이번 창에서 인식 안 됨. PowerShell 새로 열고 이 스크립트를 한 번 더 실행하세요." Yellow
  } else { Say "  완료" Green }
}

# ── [2] 본인 토큰 ───────────────────────────────────────────────
# 토큰 우선순위: -McpToken 파라미터 > LIVELY_TOKEN 환경변수 > 대화형 프롬프트 (setup-mac.sh 와 동일).
# /install 번들 다운로드와 MCP 등록에 모두 쓰이므로 먼저 확보한다. 값은 화면/로그에 출력하지 않는다.
if ([string]::IsNullOrWhiteSpace($McpToken) -and -not [string]::IsNullOrWhiteSpace($env:LIVELY_TOKEN)) {
  $McpToken = $env:LIVELY_TOKEN; Say "[2] 토큰: LIVELY_TOKEN 환경변수 사용" DarkGray
}
if ([string]::IsNullOrWhiteSpace($McpToken)) { $McpToken = Read-Host "[2] 본인 접속 토큰을 붙여넣으세요 (관리자 발급)" }
if ([string]::IsNullOrWhiteSpace($McpToken)) {
  Say "    토큰이 비어 있습니다. 관리자에게 토큰을 받아 다시 실행하세요." Red; Read-Host "엔터로 종료"; exit 1
}

# 게이트웨이 URL 정규화: 베이스(.../install 용)와 /mcp(등록용) 둘 다 만든다.
if ([string]::IsNullOrWhiteSpace($McpUrl)) {
  Say "[2] MCP 게이트웨이 주소가 비어 있습니다 — -McpUrl 파라미터 또는 LIVELY_GATEWAY 환경변수로 지정하세요 (예: http://<host>:8080/mcp)." Red
  Read-Host "엔터로 종료"; exit 1
}
$GwBase = ($McpUrl.TrimEnd('/')) -replace '/mcp$',''   # http://host:8080
$GwMcp  = "$GwBase/mcp"

# ── [3] /install 번들 받기 (git clone 대체) ─────────────────────
# 이 스크립트가 발행 번들 안에서 실행되면(번들에 setup/user-install.mjs 동봉) 재다운로드 없이 그 번들을 쓴다(dual-mode).
# 그 외(관리자가 ps1 파일만 건넨 부트스트랩)에는 토큰게이트 /install 에서 번들을 받아 $InstallDir 에 푼다.
$BundleRoot = $null
if (Test-Path (Join-Path $PSScriptRoot "user-install.mjs")) {
  $BundleRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
  Say "[3] 발행 번들 안에서 실행 -> 다운로드 건너뜀 ($BundleRoot)" Green
} else {
  if (-not (Have tar)) {
    Say "[3] tar 가 없습니다 — Windows 10 1803+ 이면 기본 포함입니다. 업데이트 후 재실행하세요." Red
    Read-Host "엔터로 종료"; exit 1
  }
  Say "[3] 발행 번들 다운로드 <- $GwBase/install" Yellow
  if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir -ErrorAction SilentlyContinue }
  New-Item -ItemType Directory -Force $InstallDir | Out-Null
  $tgz = Join-Path $InstallDir "bundle.tgz"
  Invoke-WebRequest -Headers @{ Authorization = "Bearer $McpToken" } "$GwBase/install" -OutFile $tgz
  tar -xzf $tgz -C $InstallDir
  Remove-Item -Force $tgz -ErrorAction SilentlyContinue
  if (-not (Test-Path (Join-Path $InstallDir "setup\user-install.mjs"))) {
    Say "  ✗ 번들에 setup\user-install.mjs 가 없습니다(발행 손상 또는 토큰/게이트웨이 오류)." Red
    Read-Host "엔터로 종료"; exit 1
  }
  $BundleRoot = $InstallDir
  Say "  완료: $InstallDir" Green
}

# ── [4] 사내 MCP 게이트웨이 연결 ────────────────────────────────
if (Have claude) {
  Say "[4] MCP 게이트웨이 연결: $GwMcp (라벨: $McpLabel)" Yellow
  Soft { claude mcp remove $McpLabel *> $null }   # 기존 있으면 제거(없어도 무시)
  Soft { claude mcp add --transport http --scope user $McpLabel $GwMcp --header "Authorization: Bearer $McpToken" }
  Say "  등록됨 (claude mcp list 로 확인)" Green
} else {
  Say "[4] claude 미설치 — MCP 등록 건너뜀(Node user-level 설치 후 새 창에서 재실행 가능)." DarkGray
}

# ── [4.5] 세션 훅용 토큰 파일 (~/.lively) ───────────────────────
# 세션 훅(session-preload 등)이 ~/.lively/token + gateway-url 을 읽는다. 값은 화면에 출력하지 않는다.
# 경로는 반드시 $env:USERPROFILE — 훅·user-install 이 Node os.homedir()(=%USERPROFILE%)에서 읽으므로 일치해야 한다
#  (PowerShell $HOME 는 도메인/로밍/OneDrive 계정에서 %USERPROFILE% 와 갈려 훅이 token/context.md 를 못 읽게 됨).
$LivelyDir = Join-Path $env:USERPROFILE ".lively"
New-Item -ItemType Directory -Force -Path $LivelyDir | Out-Null
[IO.File]::WriteAllText((Join-Path $LivelyDir "token"), $McpToken)
[IO.File]::WriteAllText((Join-Path $LivelyDir "gateway-url"), $GwBase)
Say "    세션 훅 토큰 기록: ~/.lively/token" DarkGray

# ── [5] user-level 설치 (컨텍스트 + 훅) ─────────────────────────
# 번들 동봉 설치기(setup/user-install.mjs)로 ~/.lively + ~/.claude(비파괴 머지) 설치 →
#   이후 어느 폴더에서 claude 를 켜든 컨텍스트+리플렉스가 따라온다(D2/D3). Node 필요.
# 설치된 하네스(claude/codex) 자동 감지 → --harness. codex 면 $PROFILE 에 "파일→env 수화" 블록(토큰 리터럴 비저장).
$Vendored = Join-Path $BundleRoot "setup\user-install.mjs"
$UserLevelDone = $false
if ((Have node) -and (Test-Path $Vendored)) {
  $h = @()
  if (Have claude) { $h += "claude" }
  if (Have codex)  { $h += "codex" }
  if ($h.Count -eq 0) { $h = @("claude") }
  Say "[5] user-level 설치 (번들 동봉 설치기 — harness=$($h -join ',') — 컨텍스트 + 훅)" Yellow

  # codex: 현재 세션 + $PROFILE 에 토큰 수화(파일에서 읽음 — 리터럴 비저장). User 환경변수 리터럴은 제거.
  if ($h -contains "codex") {
    $env:LIVELY_TOKEN = $McpToken
    [Environment]::SetEnvironmentVariable('LIVELY_TOKEN', $null, 'User')
    $pf = $PROFILE.CurrentUserAllHosts
    New-Item -ItemType Directory -Force (Split-Path $pf) *> $null
    if (-not (Test-Path $pf)) { New-Item -ItemType File -Force $pf *> $null }
    $marker = "# lively-managed (codex LIVELY_TOKEN)"
    if (-not (Select-String -Path $pf -SimpleMatch $marker -Quiet -ErrorAction SilentlyContinue)) {
      Add-Content $pf ""
      Add-Content $pf $marker
      Add-Content $pf 'if(-not $env:LIVELY_TOKEN -and (Test-Path "$HOME\.lively\token")){ $env:LIVELY_TOKEN=(Get-Content "$HOME\.lively\token" -Raw).Trim() }'
    }
  }

  $wr = @()
  if (-not [string]::IsNullOrWhiteSpace($env:LIVELY_WORK_ROOT)) { $wr = @("--work-root", $env:LIVELY_WORK_ROOT) }
  Soft { node $Vendored --clone-root $BundleRoot --harness ($h -join ",") @wr }
  $UserLevelDone = $true
} else {
  Say "[5] Node.js 미설치 — user-level 설치 건너뜀(이 폴더에서 직접 claude 실행 시 정적 컨텍스트 자동 로드)." DarkGray
}

# ── 끝 ──────────────────────────────────────────────────────────
Say "`n=== 끝! 이렇게 시작하세요 ===" Cyan
Say "  1) 등록 확인:  claude mcp list"
if ($UserLevelDone) {
  Say "  2) **아무 폴더**(자기 코드 레포 포함)에서 claude 를 켜면 회사 맥락+리플렉스가 따라옵니다."
  Say "     (user-level 설치 — 실행 디렉토리 무의미. 훅은 다음 세션부터 적용.)"
} else {
  Say "  2) 이 폴더($BundleRoot)에서 claude 를 켜세요(정적 컨텍스트 자동 로드)."
}
Say "  · incognito(전부 off): 환경변수 LIVELY_OFF=1" DarkGray
Say "  · 업데이트/제거: setup/update-windows.ps1 / setup/uninstall-windows.ps1 (설치된 토큰 자동 사용)" DarkGray
Say "`n처음 실행이면 브라우저 로그인 창이 뜹니다(회사 계정으로 로그인)." DarkGray
Read-Host "엔터를 누르면 이 창이 닫힙니다"
