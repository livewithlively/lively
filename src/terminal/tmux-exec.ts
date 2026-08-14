// 중앙 박스 — tmux 실행 프리미티브 + 세션 메타 저수준 헬퍼. terminal-sessions.ts 분할(#1313 R15).
//  모든 tmux 호출은 execFile argv(셸 미경유) — 인젝션 차단. 상위 모듈(phase·profiles·write-cap·sessions)이
//  전부 여기의 tmux()/getOpt() 를 쓴다(방향: catalog ← tmux-exec ← 나머지 — 역방향 import 금지).
//  뮤터블 관측 상태(lastBusyAt·paneWaitCache)도 여기 은닉한다 — phase(markSessionActive)와 sessions(collectSessions)가
//  같은 Map 을 공유해야 해서, Map 자체는 노출하지 않고 최소 접근 함수로만 경계를 넘긴다.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import { TMUX_BIN } from "./catalog.js";
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
 * ⚠ **호출 시점에 읽는다.** 모듈 로드 시점에 굳히면 부팅 순서·테스트에서 값이 안 먹는다
 *  (세션 spawn 훅에서 같은 함정을 밟았다).
 * ⚠ attach(`tmux -CC`)는 이 경로가 아니다 — 그건 PTY 라 terminal-pty 가 따로 다룬다.
 */
export function tmuxExecArgv(): string[] {
  const raw = (process.env.LIVELY_TMUX_EXEC || "").trim();
  return raw ? raw.split(/\s+/) : [];
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
export const LIST_FMT = "#{session_name}\t#{session_created}\t#{session_attached}\t#{@box_owner}\t#{@box_harness}\t#{@box_dir}\t#{@box_auto}\t#{@box_flags}\t#{@box_invites}\t#{@box_project}\t#{pane_current_command}\t#{session_last_attached}\t#{@box_last_busy}\t#{@box_state}\t#{pane_title}\t#{@box_label}";

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
export function isSessionGoneError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { killed?: boolean; signal?: string | null; stderr?: unknown };
  if (e.killed || e.signal) return false; // 타임아웃(SIGTERM 으로 kill)·시그널 종료 → 판정 불가
  // tmux 응답: "can't find session: <id>". 소켓 접속불가("error connecting to …", "no server running")는
  //  tmux 서버가 죽었거나 못 붙은 것 = 판정 불가로 둔다(일시장애일 수 있음 → 재연결 유지).
  return /can't find session|session not found/i.test(String(e.stderr ?? ""));
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
