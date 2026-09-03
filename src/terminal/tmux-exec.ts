// 중앙 박스 — tmux 실행 프리미티브 + 세션 메타 저수준 헬퍼. terminal-sessions.ts 분할(#1313 R15).
//  모든 tmux 호출은 execFile argv(셸 미경유) — 인젝션 차단. 상위 모듈(phase·profiles·write-cap·sessions)이
//  전부 여기의 tmux()/getOpt() 를 쓴다(방향: catalog ← tmux-exec ← 나머지 — 역방향 import 금지).
//  뮤터블 관측 상태(lastBusyAt·paneWaitCache)도 여기 은닉한다 — phase(markSessionActive)와 sessions(collectSessions)가
//  같은 Map 을 공유해야 해서, Map 자체는 노출하지 않고 최소 접근 함수로만 경계를 넘긴다.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import { TMUX_BIN, tenantSlug, isPsmuxBin } from "./catalog.js";
import { execTopology, tmuxArgvFor, tmuxServerIsDedicated } from "../exec-topology.js";   // #2599 T2 — 「어디서 도나」는 토폴로지 한 곳에만 묻는다
import { SESSION_ID_RE } from "../org/auth/agent-identity.js"; // #852 세션 id 형식 — 게이트웨이 헤더 판정과 같은 자

const execFileAsync = promisify(execFile);

// ⚠ tmux 는 로케일이 UTF-8 이 아니면(C/POSIX) format 출력의 제어문자·멀티바이트를 '_' 로 치환한다.
//  게이트웨이가 launchd 로 LANG/LC_* 없이 뜨면 `list-sessions -F "...\t..."` 의 탭 구분자와 한글 라벨이
//  통째로 '_' 가 되어, split("\t") 가 안 쪼개져 라인 전체가 세션 id 로 들어가는 치명 버그가 생긴다
//  (입장 불가 + owner 누락 → '다른 멤버' 오분류). 그래서 모든 tmux 호출에 UTF-8 로케일을 강제한다
//  (terminal-pty 의 attach 가 이미 쓰는 패턴과 동일 — 여기 list/show/set 계열에도 일관 적용).
const TMUX_ENV: NodeJS.ProcessEnv = (() => {
  const env = { ...process.env };
  if (!/utf-?8/i.test(env.LC_ALL || env.LC_CTYPE || env.LANG || "")) {
    env.LANG = "en_US.UTF-8";
    env.LC_CTYPE = "en_US.UTF-8";
  }
  return env;
})();

/**
 * tmux 실행 seam — 기본은 **로컬 execFile**(설정 없으면 종전과 완전히 동일하다).
 *
 * 왜 필요한가: 게이트웨이가 tmux 서버와 **같은 호스트에 있다**는 가정이 이 함수에 박혀 있다.
 *  그 가정이 성립하지 않는 배포가 있다 — 예컨대 게이트웨이는 컨테이너 안, tmux 서버는 호스트에 두는 형태.
 *  그때 여기만 갈아끼우면 상위 모듈(phase·profiles·write-cap·sessions)은 한 줄도 안 바뀐다.
 *
 * 계약: 지정한 프로그램에 **tmux argv 를 그대로 이어 붙여** 실행한다. stdout 이 tmux 의 stdout 이고,
 *  0 이 아닌 종료코드는 예외다(로컬 실행과 같은 규약 — 상위의 try/catch 가 그대로 동작해야 한다).
 *
 * #2599 T2 — 「tmux 가 어디 있나」(부팅 상수)와 「지금 요청이 어느 워크스페이스인가」(요청 컨텍스트)의
 *  **결합은 토폴로지 모듈이 소유한다.** 여기 남은 것은 그 두 입력을 건네는 일뿐이다.
 * ⚠ attach(`tmux -CC`)는 이 경로가 아니다 — 그건 PTY 라 terminal-pty 가 따로 다룬다.
 */
export function tmuxExecArgv(): string[] {
  return tmuxArgvFor(tenantSlug(), TMUX_BIN);
}

export async function tmux(args: string[]): Promise<string> {
  const relay = tmuxExecArgv();
  const [bin, ...prefix] = relay.length ? relay : [TMUX_BIN];
  const { stdout } = await execFileAsync(bin!, [...prefix, ...args], { timeout: 5000, env: TMUX_ENV });
  return stdout;
}
export async function tmuxQuiet(args: string[]): Promise<void> { try { await tmux(args); } catch { /* 비치명 */ } }
export async function getOpt(name: string, opt: string): Promise<string> {
  try { return (await tmux(["show-options", "-t", name, "-v", opt])).trim(); } catch { return ""; }
}

// ── 구조값(JSON)을 user option 에 싣는 단일 통로 (#1541) ──────────────────────
// **왜 평문 JSON 을 그대로 안 쓰나** — Windows 네이티브 노드가 쓰는 멀티플렉서(psmux)는 옵션 값에서
//  따옴표를 벗긴다. 실측(psmux 3.3.7, Windows Server 2022):
//     보냄 {"readonly":true} → 받음 {readonly:true}   ·   보냄 ["yoon","jang"] → 받음 [yoon,jang]
//  그 값은 JSON.parse 가 안 되므로 세션 플래그·초대 목록이 통째로 유실된다(초대 유실 = 접근이 조용히
//  비공개로 떨어진다 — 보안 방향으로는 안전하지만 기능은 죽는다). tmux 는 안 벗기지만, **같은 게이트웨이
//  코드가 두 구현을 모두 상대**하므로 양쪽에서 무손실인 표현으로 통일한다.
//  base64 는 같은 실측에서 왕복 무손실이었다(백슬래시·한글·`$`·`#{}`·`;`·`=` 도 안전, 따옴표·탭만 소실).
export function encodeOptJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}
// 읽기는 **구·신 둘 다** 받는다. 이미 떠 있는 세션엔 평문 JSON 이 들어 있고, 그 세션들은 재생성 없이
//  계속 살아야 한다(tmux 서버는 게이트웨이보다 오래 산다 — 배포로 세션을 잃게 만들면 안 된다).
//  판별은 첫 글자로 한다: base64 알파벳엔 `{`·`[` 가 없으므로 그 둘로 시작하면 레거시 평문이 확실하다.
//  ⚠ 따옴표가 벗겨진 값(`{readonly:true}`)도 `{` 로 시작해 평문 경로로 가고, 거기서 JSON.parse 가 실패해
//   fallback 으로 떨어진다 — 즉 psmux 에 쓰인 옛 값도 '조용한 오독' 없이 안전하게 기본값이 된다.
export function decodeOptJson<T>(raw: string, fallback: T): T {
  const s = (raw || "").trim();
  if (!s) return fallback;
  try {
    const text = (s[0] === "{" || s[0] === "[") ? s : Buffer.from(s, "base64").toString("utf8");
    return JSON.parse(text) as T;
  } catch { return fallback; }
}

const ID_RE = SESSION_ID_RE;   // 세션 id 형식의 단일 진실원천 — 게이트웨이가 헤더로 받은 세션도 같은 자로 잰다(#852)

// 단일 tmux 호출로 모든 box-* 세션 + @box_* 메타를 읽는다(#{@user-option} 포맷 지원).
// @box_flags·@box_invites 는 label 앞에 둔다(label 은 탭 포함 가능해 ...rest 로 받으므로, 단일필드를 먼저 파싱).
//  둘 다 JSON(탭 없음 — 멤버 id·플래그값은 탭 미포함)이라 탭 구분 파싱에 안전.
// pane_current_command(포그라운드 프로세스)·pane_pid(=포그라운드 pid, CPU 판정용)를 label 앞에 추가(label 은 탭 포함 가능해 ...rest 로 받으므로 뒤에 오면 삼켜짐).
// @box_last_busy = 마지막 작업(스피너 관측) 시각 epoch초 — 게이트웨이 재기동에도 살아남게 tmux 세션에 영속(#853).
// @box_state = 하네스가 훅으로 보고한 실행 단계 + 그 시각(#1221, "busy 1753700000") — 화면 스크래핑을 대체하는 주신호.
//  tmux 에 두는 이유는 @box_last_busy 와 같다: 게이트웨이가 재기동해도 살아남고(tmux 서버가 더 오래 산다),
//  목록 조회가 어차피 읽는 이 한 줄에 딸려 와 조회 비용이 0이다.
// @box_last_seen = 이 세션 **화면을 마지막으로 보고 있던** 시각 epoch초 (#1954 3차).
//  왜 session_last_attached 로 부족한가: tmux 는 클라이언트가 **붙는 순간에만** 그 값을 찍는다. 그런데 새 셸은
//  탭 DOM 을 유지해(v2/tabs.ts) 세션 하나당 attach 가 **탭 수명당 한 번**뿐이다 — 이미 열어 둔 세션을 다시 눌러도
//  새 attach 가 없으니 '열람' 시각이 처음 연 순간에 얼어붙고, 그 뒤 작업이 끝날 때마다 '안 본 작업 완료'(초록점)가
//  영영 안 꺼졌다(실측 2026-08-26: att=1 인 세션 5개의 last_attached 가 last_busy 보다 300~440초 뒤처진 채 고정).
//  그래서 '봤다'를 attach 이벤트에서 떼어내 **보고 있는 동안 화면이 직접 찍는** 신호로 따로 둔다.
//  tmux 에 두는 이유는 위 둘과 같다(게이트웨이 재기동 생존 + 이 한 줄에 딸려 와 조회 비용 0).
// @box_managed = 이 세션을 만든 **상시세션 id**(#2170). 상시세션은 desired-state DB 미러가 없어(#1059 E) tmux 가
//  유일한 자리다. 정리기가 "내가 만든 세션인가"를 여기서 읽는다 — 세션 수만큼 getOpt 를 치면 2분마다 O(N) tmux
//  호출이 되므로, 어차피 도는 이 한 줄에 실어 조회 비용을 0 으로 둔다(@box_last_busy 와 같은 이유).
//  ⚠ `@box_label` 은 **맨 뒤**여야 한다 — 라벨에 탭이 들어갈 수 있어 나머지를 다 먹는 자리다
//   (아래 파싱이 `...labelParts` 로 받는다). 새 칸은 반드시 그 **앞에** 넣는다.
//  #2439 — `@box_runtime`: 이 세션이 어느 모드로 떴나(chat|없음). 목록 스캔에 한 칸을 더하는 것은
//   공짜지만, 여기 없으면 화면이 «대화창» 이라 하고 배달은 터미널로 가는 갈림이 생긴다.
export const LIST_FMT = "#{session_name}\t#{session_created}\t#{session_attached}\t#{@box_owner}\t#{@box_harness}\t#{@box_dir}\t#{@box_auto}\t#{@box_flags}\t#{@box_invites}\t#{@box_project}\t#{@box_app}\t#{@box_managed}\t#{pane_current_command}\t#{session_last_attached}\t#{@box_last_busy}\t#{@box_state}\t#{@box_last_seen}\t#{pane_title}\t#{@box_runtime}\t#{@box_label}";

// ── 뮤터블 관측 상태(프로세스 로컬) — Map 은 은닉하고 최소 접근 함수만 노출한다(#1313 R15) ──
// 세션별 마지막 'busy(작업중)' 관측 시각(epoch초). 폴링 관측 기반 — '최근 작업순' 정렬용. 서버 재기동 시 리셋(도그푸드 OK).
//  쓰는 곳: phase.markSessionActive(훅 보고)·sessions.collectSessions(스피너 관측) — 두 모듈이 같은 값을 봐야 한다.
const lastBusyAt = new Map<string, number>();
export function getLastBusy(id: string): number { return lastBusyAt.get(id) || 0; }
export function setLastBusy(id: string, sec: number): void { lastBusyAt.set(id, sec); }

// pane '확인 필요' 감지 2.5초 캐시(폴링 버스트 공유) — 판정 로직은 phase.paneAwaitingInput, 캐시 저장만 여기.
const _paneWaitCache = new Map<string, { at: number; waiting: boolean }>();
export function getPaneWait(id: string): { at: number; waiting: boolean } | undefined { return _paneWaitCache.get(id); }
export function setPaneWait(id: string, entry: { at: number; waiting: boolean }): void { _paneWaitCache.set(id, entry); }

// 세션 id → 그 세션 pane 들의 pid(#1220). 압박 회수가 **RSS 큰 세션부터** 고르기 위한 트리 뿌리다
//  (합산은 session-rss.ts — pane pid 자체는 격리 경로에서 sudo 라 그것만 재면 세션 크기를 착각한다).
//  tmux 가 없거나 서버가 안 떠 있으면 빈 맵 → 호출부가 idle 순으로 폴백(측정 실패로 회수를 막지 않는다).
export async function listSessionPanePids(): Promise<{ ok: boolean; panes: Map<string, number[]> }> {
  const out = new Map<string, number[]>();
  let raw = "";
  // ⚠ **tmux 조회 실패와 '세션이 0개'를 반드시 구분해서 알린다**(#1251). 둘 다 빈 맵이라 호출부가 못 가른다면,
  //  "못 봤다"가 "다 죽었다"로 읽힌다 — 하필 그 오해가 가장 잘 나는 때가 **메모리 압박**(스래싱·느린 exec 로
  //  tmux 호출이 타임아웃)이고, 그건 earlyoom 이 도는 바로 그 순간이다. #1240 의 `readable` 과 같은 교리.
  try { raw = await tmux(["list-panes", "-a", "-F", "#{session_name}\t#{pane_pid}"]); } catch { return { ok: false, panes: out }; }
  for (const line of raw.split("\n")) {
    const [sid, pidRaw] = line.split("\t");
    if (!sid?.startsWith("box-")) continue;
    const pid = Number(pidRaw);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const arr = out.get(sid);
    if (arr) arr.push(pid); else out.set(sid, [pid]);
  }
  return { ok: true, panes: out };
}

// ── '이 세션은 진짜 끝났다'의 확답 판정(#835) ──
// canAttach=false 는 두 가지가 섞여 있다: ⓐ 권한 없음 ⓑ 세션이 아예 없음(종료됨) ⓒ tmux 가 답을 못 줌(과부하·타임아웃).
//  웹터미널이 '세션 종료됨'을 띄우려면 ⓑ여야 한다 — ⓒ를 종료로 오인하면 살아있는 세션을 죽었다고 알리게 되는데,
//  그게 #687 이 막으려던 바로 그 오인이다(그래서 그때 프론트를 '계속 재연결'로 바꿨고, 이번엔 그 반대급부인
//  '진짜 닫혔는데 영원히 재접속중'을 고친다). 따라서 tmux 가 **응답해서 "그런 세션 없음"이라고 말할 때만** true.
// ── 종전 `tmuxRelayManaged()` 를 두 술어로 가른다 (#2599 T3 · 조사 함정 4) ─────────────────────────
// 그 이름 하나가 **서로 다른 두 질문**에 답하고 있었다. 답이 갈리는 표면(registry secondary)이 있어서,
//  한쪽을 고치면 다른 쪽이 함께 바뀌는 구조였다 — 그게 함정 4 가 T2 까지 안 고쳐진 이유다.
//   Q1 «tmux 서버가 없다 = 그 세션들이 영구 소실됐다는 확답인가»  → 아래 tmuxServerAbsenceIsFinal
//   Q2 «tmux 호출이 중계를 지나나(= 실패가 전송 장애일 수 있나)»   → 아래 tmuxViaRelay

/**
 * tmux 서버 부재("no server running")를 **세션 영구 소실의 확답**으로 승격해도 되는 자리인가(#1437).
 *
 * 참인 조건은 «**이 호출이** 간 tmux 서버가 그 워크스페이스 전용인가» 다 — 전용 서버가 없으면 그 서버에만
 *  살던 인메모리 세션은 실제로 증발한 것이고, 스스로 돌아오지 않는다(복원만이 길이다).
 *  · `exec`(매니지드 중계) — 테넌트별 tmux 컨테이너. #1437 이 고친 원래 자리.
 *  · 이름 있는 소켓 + 슬러그 있음(registry **secondary**, `-L lvly-<slug>`) — 워크스페이스 전용 소켓이라
 *    같은 논리가 성립한다. T2 까지는 여기가 «판정 불가» 로 접혀 셀프호스트 secondary 가 #1437 이전 증상
 *    (복원이 영영 안 열리고 클라가 무한 재연결)을 그대로 갖고 있었다 — 조사 함정 4 가 지목한 구멍이다.
 *  · 기본 소켓(공용)은 **종전 그대로 거짓** — #835 의 보수적 규약(모르면 종료라 말하지 않는다)을 지킨다.
 *
 * ⚠ **부팅 상수가 아니라 요청 축이다.** registry 모드로 뜬 게이트웨이도 primary 워크스페이스를
 *  무컨텍스트로 함께 서비스하고, 그 호출은 `tmuxArgvFor` 가 **공용 기본 소켓**으로 보낸다. 그래서 슬러그를
 *  받아야 하고, 판정은 argv 를 만드는 쪽과 **같은 함수**(`tmuxServerIsDedicated`)를 봐야 어긋나지 않는다.
 *  (첫 구현은 `tmux.socket !== null` 만 봤다가 리뷰에서 잡혔다 — T3 이 `attachTransport` 를 지운 이유와 같은 함정.)
 *
 * ⚠ 소켓 **파일이 사라진** 경우("error connecting … No such file or directory")도 확답으로 둔다.
 *  서버 프로세스가 살아 있더라도 경로가 unlink 되면 **어떤 클라이언트도 다시 붙을 수 없다**(tmux 에 다른
 *  통로가 없다). 즉 그 세션들은 실제로 회수 불가이고, 사람에게 옳은 안내는 «복원» 이다.
 */
export function tmuxServerAbsenceIsFinal(slug: string | null = tenantSlug()): boolean {
  return tmuxServerIsDedicated(slug);
}

/**
 * tmux 호출이 **중계를 지나나**(매니지드) — 목록 실패를 «못 봤다» 로 볼 수 있는 자리인가(#2544).
 *
 * ⚠ 위 술어와 **일부러 다르다.** 중계는 브로커 재접속·허브 503·타임아웃 같은 «전송이 못 닿았다» 가 있어
 *  목록 실패가 «세션 0개» 를 뜻하지 않는다. 로컬 소켓(primary·registry secondary)은 전송 층이 없어서
 *  그 폴백이 성립하지 않는다 — `session-unobserved` 머리말이 «registry 는 이 조각에 들어오지 않는다» 를
 *  #2544 의 완료 조건으로 적어 두었다. 그래서 gone 확답을 secondary 로 넓히면서도 이쪽은 안 넓힌다.
 */
export function tmuxViaRelay(): boolean {
  return execTopology().tmux.kind === "exec";
}
// 중계에서 'tmux 서버 자체가 없다'의 확답 문구 — 소켓이 스테일(서버 죽음)이면 "no server running on <path>",
//  소켓 파일이 없으면(재생성된 빈 컨테이너) "error connecting to <path> (No such file or directory)".
//  ⚠ 컨테이너 보장/생성 실패("tmux 컨테이너 …")는 여기 안 걸린다 = 판정 불가로 남는다(도커·노드 일시장애 → 재연결 유지).
const RELAY_SERVER_GONE_RE = /\bno server running\b|error connecting to .+\((?:No such file or directory|Connection refused)\)/i;
export function isSessionGoneError(err: unknown, bin: string = TMUX_BIN, serverAbsenceIsFinal: boolean = tmuxServerAbsenceIsFinal()): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { killed?: boolean; signal?: string | null; stderr?: unknown; code?: unknown };
  if (e.killed || e.signal) return false; // 타임아웃(SIGTERM 으로 kill)·시그널 종료 → 판정 불가
  // tmux 응답: "can't find session: <id>". 소켓 접속불가("error connecting to …", "no server running")는
  //  로컬 단일호스트에선 tmux 서버가 죽었거나 못 붙은 것 = 판정 불가로 둔다(일시장애일 수 있음 → 재연결 유지).
  if (/can't find session|session not found/i.test(String(e.stderr ?? ""))) return true;
  // ── 관리형 중계: tmux 서버 부재를 **확답으로 승격**한다(#1437 — 이미지 롤아웃이 테넌트 tmux 컨테이너를 재생성하면
  //  그 안의 tmux 서버가 새로 뜨며 **인메모리 세션이 전부 증발**한다. OOM 으로 서버만 죽어도 같다. 어느 쪽도 스스로
  //  돌아오지 않는다 — 복원만이 길이다). 종전엔 이 문구가 로컬 규약대로 '판정 불가'라 sessionGone 이 false 를 줘,
  //  GET /sessions/:id 는 '입장 가능'으로, POST /restore 는 '이미 살아있음(already)'으로 떨어져 **복원이 영영 막혔다**
  //  (상민님 실측 2026-08-26, lively-46e3/box-sangmin-yoon: has-session → "no server running", 복원 두 번 뜨고 실패).
  //  #835 오검출 위험 없음: **살아 있는 세션은 서버가 살아 있다는 뜻**이라 이 문구가 나올 수 없다(그땐 has-session 성공
  //  또는 "can't find session"). 컨테이너 정지→재기동 창의 서버 부재도 그 테넌트 세션이 실제로 증발한 상태라 gone 이 맞다.
  if (serverAbsenceIsFinal && RELAY_SERVER_GONE_RE.test(String(e.stderr ?? ""))) return true;
  // psmux(윈도우 노드, #1791 실측): `has-session -t <없는 id>` 가 **stderr 한 글자 없이 exit 1** 로 끝난다(tmux 의 "can't find
  //  session" 문구가 없다). 그래서 종전엔 윈도우 노드의 죽은 세션이 영영 '판정 불가'였다 — nodeCanAttach 가 4410 대신 4403 을
  //  내고, #1791 복원·삭제의 gone 확답도 못 받았다(복원이 already 로 끝남, 실측). psmux 는 서버가 세션당 프로세스라
  //  '서버 접속불가'라는 별개 상태가 없다 — exit 1 + 빈 stderr = 그 세션 없음. 실행 파일 부재(ENOENT)는 code 가 문자열이라 안 걸린다.
  if (isPsmuxBin(bin) && e.code === 1 && String(e.stderr ?? "").trim() === "") return true;
  return false;
}
/**
 * tmux 실패가 **'서버가 없다'(정상 — 세션 0개)** 인가, **'못 봤다'(장애)** 인가.
 *  이 구분이 곧 "없다"와 "모른다"의 구분이다. 섞으면 모르는 상태를 '없음'으로 단정해 파괴적 결정을 내린다
 *  (#1675 ⑥ 실측: 상시세션 ensure 가 조회 실패를 '세션 없음'으로 읽고 2분마다 새 세션을 만들어 30개까지 쌓였다).
 *  #2544 — sessions.ts 에서 여기(최하층)로 내렸다: 목록 폴백(session-unobserved)도 같은 자로 재야 하고, 그 모듈이
 *  sessions.ts 를 import 하면 순환이 된다. sessions.ts 는 그대로 재수출한다(호출부 무변경).
 */
export function isNoTmuxServer(e: unknown): boolean {
  const stderr = String((e as { stderr?: unknown })?.stderr ?? "");
  return /no server running|error connecting/i.test(stderr);
}
export async function sessionGone(id: string): Promise<boolean> {
  if (!ID_RE.test(id)) return false; // 형식 자체가 틀림 = '종료'가 아니라 잘못된 요청
  try { await tmux(["has-session", "-t", id]); return false; } // 살아있음
  catch (err) { return isSessionGoneError(err); }
}

// 리사이즈로 tmux 히스토리에 쌓인 프롬프트 중복(shrink→grow 시 overflow가 history 로 밀림)을 정리.
//  force=false: 히스토리가 작을 때만(=신선/경량 세션의 시작 churn) 정리 → 실작업 스크롤백은 보존.
//  force=true: 무조건 정리('다시 그리기' 버튼). clear-history 는 보이는 화면이 아니라 스크롤백만 비운다.
export async function tidyHistory(id: string, force: boolean): Promise<boolean> {
  if (!ID_RE.test(id)) return false;
  if (!force) {
    let sz = 9999;
    try { sz = Number((await tmux(["display-message", "-t", id, "-p", "#{history_size}"])).trim()) || 0; } catch { return false; }
    if (sz >= 50) return false; // 실작업 스크롤백이 있는 세션은 건드리지 않음
  }
  await tmuxQuiet(["clear-history", "-t", id]);
  return true;
}

// WS/파일 브리지용 작업 디렉터리(id 형식 검증 포함).
export async function sessionDir(id: string): Promise<string> {
  if (!ID_RE.test(id)) return os.homedir();
  return (await getOpt(id, "@box_dir")) || os.homedir();
}

// 단일 세션의 현재 라벨(@box_label) — 단독 터미널 페이지가 id 로 '지금 이름'을 조회한다.
//  목록 API(/sessions)는 프로젝트 세션을 빼므로, 그 세션의 상단 제목이 생성 시점 ?label= 에 고정되던 문제를 푼다.
//  접근통제(canAttach)는 라우트에서 — 여기선 값만 읽는다.
export async function getSessionLabel(id: string): Promise<string> {
  if (!ID_RE.test(id)) return "";
  return (await getOpt(id, "@box_label")) || "";
}

// 단일 세션의 프로젝트 id(@box_project) — 단독 터미널 페이지가 상단 '프로젝트 페이지 열기' 버튼을 위해 id 로 조회.
//  프로젝트 세션이면 그 프로젝트 id, 개인 세션이면 0. 접근통제(canAttach)는 라우트에서 — 여기선 값만 읽는다.
export async function getSessionProject(id: string): Promise<number> {
  if (!ID_RE.test(id)) return 0;
  return Number(await getOpt(id, "@box_project")) || 0;
}

// attach 시점에 스크롤·리사이즈 옵션 보장(생성 전 세션·옵션 누락 방어 + 옛 세션을 latest 로 마이그레이트). 비치명.
// window-size latest: 창 크기를 '가장 최근 활동(refresh-client -C 포함) 클라이언트'에 맞춘다.
//  웹 터미널은 한 tmux pane 을 여러 클라(여러 탭·기기·잔존 연결)가 공유하는데 pane 크기는 하나뿐이라,
//  자기보다 큰 pane 을 받는 좁은 클라는 출력이 깨진다(254폭 내용이 83폭 xterm 에 들어가 줄이 어긋남).
//  - largest(옛 설정): 가장 큰 클라에 고정 → 좁은 탭이 영구히 깨지고 '화면 복구'(refresh-client 재전송)도
//    창을 못 줄여 무효였다(#252). 잔존하던 큰 연결 하나가 현재 탭을 계속 깨뜨림 → 새 세션만 정상이던 증상.
//  - latest: 지금 보는 탭이 connect/포커스/'화면 복구' 때 refresh-client 를 보내면 그 순간 '최근 활동'이
//    되어 pane 이 그 탭 크기로 맞춰진다 → 곧바로 정상 렌더(잔존·백그라운드 클라는 활동이 없어 크기를 못 끈다).
//    실측(tmux 3.6a, 격리소켓): largest 는 작은 클라 refresh 후에도 창 유지, latest 는 마지막 refresh 한
//    클라 크기로 전환됨을 확인. aggressive-resize 는 다중 '세션' 공유용이라 무관(끔 유지).
export async function ensureSessionOpts(id: string): Promise<void> {
  if (!ID_RE.test(id)) return;
  await tmuxQuiet(["set-option", "-t", id, "mouse", "on"]);
  await tmuxQuiet(["set-window-option", "-t", id, "aggressive-resize", "off"]);
  await tmuxQuiet(["set-window-option", "-t", id, "window-size", "latest"]);
}
