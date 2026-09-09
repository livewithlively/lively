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
import { planTmux, runPlan, outcomeToError, tmuxSessionOf } from "./tmux-route.js";                        // #2600 T2 (d) d2 — 코어 직접 경로의 «무엇을 어디로»
import { makeBrokerClient, type BrokerTransport } from "./broker-client.js";                // #2600 T2 (d) d2 — 그 전송(소켓·허브)
import { shadowTmux } from "./tmux-shadow.js";
import { makeTmuxCallCensus, censusSite } from "./tmux-call-census.js";   // #2600 T2 d4 — 「이 프로세스가 아직 tmux 를 부르나」의 계기(전수·route 무관)
import { logger } from "../log.js";                                               // #2600 T2 (d) d3 — 옛 경로가 답하고 코어 경로는 견주기만
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

/**
 * 이 호출을 얼마나 기다리나 — **로컬과 중계가 다르다**(#2616 후속, 2026-09-07).
 *
 * ── 왜 갈랐나 ───────────────────────────────────────────────────────────────
 * 로컬 tmux 는 같은 호스트의 유닉스 소켓이라 5초면 넉넉하다(종전 값 — 무회귀).
 *  중계(매니지드)는 그 5초 안에 **게이트웨이 → 허브 → 노드 브로커 → runsc exec** 네 홉이 들어간다.
 *  그런데 안쪽 층들의 예산이 바깥보다 **크게** 잡혀 있었다:
 *
 *      코어 5s  >  중계 4s  ‹‹  허브 21.5s(파킹 대기 1.5 + 응답 머리 20)  ›  브로커 15s
 *
 *  즉 «제일 바깥이 제일 짧다». 그러면 안쪽이 아직 일하는 중에 바깥이 끊고, 사람은 원인이 아니라
 *  **끊긴 사실**만 본다 — 실측 2026-09-07: 세션 첫 지시가 `브로커 응답 없음: http://…:9093` 으로
 *  전달 실패했다(허브·브로커는 그 4초 뒤에도 답을 만들고 있었다).
 *  ⚠ 예산은 **안쪽이 짧고 바깥으로 갈수록 길어야** 한다. 이 상수가 그 사슬의 제일 바깥이다:
 *   브로커 6s < 허브(요청 예산 안으로 좁힘) < 중계 9s/회·20s 총 < **여기 22s**.
 *   숫자를 바꿀 땐 넷을 같이 본다(한 층만 줄이면 그 층이 다시 남의 일을 끊는다).
 */
export const TMUX_LOCAL_TIMEOUT_MS = 5_000;
export const TMUX_RELAY_TIMEOUT_MS = 22_000;

/** (순수) 이 호출의 상한 — 중계면 길게, 로컬이면 종전 그대로. 판정이 한 자리에 있어야 시험이 잰다. */
export function tmuxTimeoutMs(relay: readonly string[]): number {
  return relay.length ? TMUX_RELAY_TIMEOUT_MS : TMUX_LOCAL_TIMEOUT_MS;
}

/**
 * 코어 직접 경로(#2600 T2 (d) d2)가 **이 호출**에 성립하나 — 셋이 다 참일 때만: 플래그(`tmuxRoute`)·브로커에 닿는 길(`broker`)·
 *  요청 슬러그. 하나라도 없으면 null = 종전 경로(중계). 슬러그 없는 호출(registry 의 primary 무컨텍스트)은 중계도 `{slug}` 를
 *  못 채우므로 여기서도 새 경로가 아니다 — 두 경로의 «성립 조건»이 같아야 그림자 대조가 같은 호출을 견준다.
 *  ⚠ `{slug}` 치환은 `String.replace(문자열)` = **첫 번째 하나만** — `tmux-relay.cjs`·`tmuxArgvFor` 와 같은 의미를 지킨다.
 */
export function tmuxRouteTransport(slug: string | null = tenantSlug()): { transport: BrokerTransport; slug: string; mode: "on" | "shadow"; sample: number } | null {
  const topo = execTopology();
  if (topo.tmuxRoute === "off" || !topo.broker || !slug) return null;
  const transport: BrokerTransport = topo.broker.kind === "hub"
    ? { kind: "hub", url: topo.broker.url, secret: topo.broker.secret, slug }
    : { kind: "socket", socketPath: topo.broker.template.replace("{slug}", slug) };
  return { transport, slug, mode: topo.tmuxRoute, sample: topo.tmuxShadowSample };
}

/**
 * 코어 직접 경로 — 브로커 `/lvly/tmux` 가 하던 «세션 의미» 를 코어가 한다: 목록(`GET /lvly/sessions`) → 계획(`planTmux`) →
 *  실행(범용 exec API) → 병합. 성공은 stdout, 실패는 execFile 오류와 **같은 필드**(`code`·`stdout`·`stderr`)로 던진다 —
 *  상위(`isSessionGoneError`·`isNoTmuxServer`·strict 호출)가 종전과 똑같이 갈린다.
 *  목록 조회 자체가 실패하면 «못 봤다» 다 — «서버 없음»·«세션 없음» 문구로 위장하지 않는다(#2616).
 */
export async function tmuxViaRoute(args: string[], via: { transport: BrokerTransport; slug: string }): Promise<string> {
  //  ⚠ 설정 오류(https 허브·형식 밖 슬러그)도 execFile 오류 모양으로 던진다 — 맨 Error 가 나가면 상위 판정이 전부 거짓으로
  //   떨어져 «못 봤다» 조차 못 된다(블라인드 리뷰 ⑥-4). 여기서 접으면 strict 호출은 던지고 목록은 desired 폴백으로 간다.
  const fold = (why: string, e: unknown): never => {
    throw outcomeToError({ code: 1, stdout: "", stderr: `${why}(못 봤다): ${(e as Error)?.message ?? String(e)}` });
  };
  let client: ReturnType<typeof makeBrokerClient>;
  try { client = makeBrokerClient(via.transport, { timeoutMs: TMUX_RELAY_TIMEOUT_MS }); } catch (e) { return fold("코어 직접 경로 설정 오류", e); }
  let listed: Awaited<ReturnType<typeof client.listSessions>>;
  try { listed = await client.listSessions(); } catch (e) { return fold("브로커 세션 목록 조회 실패", e); }
  let out;
  try {
    const plan = planTmux(via.slug, args, listed.sessions, listed.observed);
    out = await runPlan(plan, via.slug, args, listed.observed, (c, argv) => client.execCapture(c, argv));
  } catch (e) { return fold("코어 직접 경로 실행 오류", e); }
  if (out.code !== 0) throw outcomeToError(out);
  return out.stdout;
}

/**
 * tmux 호출 계수 창 크기 (#2600 T2 d4). 이 값마다 «어느 테넌트에 어떤 동사를 몇 번» 표를 로그로 낸다.
 *
 * ── 왜 seam 인가 ──────────────────────────────────────────────────────────────
 * 이 프로젝트의 완료 조건 하나가 «게이트웨이가 그 테넌트에 tmux 를 부른 횟수 0» 이다. 그걸 그림자 대조로
 *  세면 **틀린다** — 그림자는 표본(기본 25%)·동시상한에 묶이고, 동사는 **불일치와 첫 건에만** 싣는다.
 *  2026-09-08 에 실제로 그렇게 세고 «list-sessions 0건» 이라 결론했는데 같은 창의 요약은 compared 100 이었다.
 *  계기는 **이 seam** 에 있어야 한다: 모든 `tmux()` 가 여기를 지나고(`tmuxBatch`·`getOpt` 도 결국 여기다),
 *  route 모드(off/shadow/on)와 무관하며, 세션 호스트(route=on 이라 그림자가 아예 없다)에서도 같은 자로 잰다.
 * ⚠ 로그에 싣는 것은 **슬러그·동사·호출부(`파일:줄`)뿐**이다 — argv 에는 세션 라벨·send-keys 본문이 있고
 *  그건 로그에 갈 것이 아니다(d2 §6-4). 호출부도 **파일명만** 싣는다(절대경로 금지 — 창이 수 KB 씩 는다).
 * ⚠ 0 으로 두면 보고가 꺼진다(계수 자체는 계속 — 부담이 되는 배포의 탈출구).
 */
export const TMUX_CENSUS_EVERY = 200;
const tmuxCensus = makeTmuxCallCensus(TMUX_CENSUS_EVERY);

export async function tmux(args: string[]): Promise<string> {
  //  #2600 T2 d4 — 계수는 **경로를 고르기 전에** 한다. 어느 경로로 가든 «불렀다» 는 사실은 같고,
  //   그래야 「남은 표면」이 route 를 켜고 끄는 것과 무관하게 같은 자로 세어진다. 비치명이라 삼킨다.
  try {
    //  호출부는 **스택에서** 뽑는다 — 두 칸(슬러그·동사)만으로는 남은 표면을 못 짚는다(`censusSite` 머리말).
    //   `new Error()` 는 여기서만 만든다: tmux 호출은 분당 수십 건이라 스택 한 장의 비용이 무의미하고,
    //   호출부마다 이름을 심는 방식은 «심는 것을 잊은 자리»가 조용히 «(없음)» 이 되어 계기가 거짓말을 한다.
    const rows = tmuxCensus.record(tenantSlug(), tmuxSessionOf(args).verb, censusSite(new Error().stack));
    if (rows) logger.info({ tmuxCensus: { window: TMUX_CENSUS_EVERY, rows } }, "tmux 호출 계수(창)");
  } catch { /* 계수 때문에 tmux 가 실패하면 안 된다 */ }
  //  #2600 T2 (d) d2 — 플래그가 `on` 이고 길이 있을 때만 코어 직접 경로. 아니면 아래 종전 경로가 **한 바이트도** 안 바뀐다.
  const via = tmuxRouteTransport();
  if (via?.mode === "on") return tmuxViaRoute(args, via);
  const relay = tmuxExecArgv();
  const [bin, ...prefix] = relay.length ? relay : [TMUX_BIN];
  const old = execFileAsync(bin!, [...prefix, ...args], { timeout: tmuxTimeoutMs(relay), env: TMUX_ENV });
  //  d3 — `shadow` 면 같은 약속을 곁에서 지켜보며 코어 경로와 견준다. 떼어 놓는다(void): 이 호출의 답·지연·예외는 옛 경로 그대로다.
  //   그림자는 절대 거절하지 않는다(tmux-shadow 규율). 엔진(broker-client)은 호출 시점에 만든다 — 만들다 던지면 그쪽이 드러낸다.
  if (via?.mode === "shadow") void shadowTmux(args, via.slug, via.sample, old, () => shadowEngineFor(via));
  const { stdout } = await old;
  return stdout;
}
/** 그림자의 코어 경로 엔진 — `on` 경로(`tmuxViaRoute`)와 같은 클라이언트·같은 상한. */
function shadowEngineFor(via: { transport: BrokerTransport }) {
  const client = makeBrokerClient(via.transport, { timeoutMs: TMUX_RELAY_TIMEOUT_MS });
  return { list: () => client.listSessions(), exec: (c: string, argv: string[]) => client.execCapture(c, argv) };
}
export async function tmuxQuiet(args: string[]): Promise<void> { try { await tmux(args); } catch { /* 비치명 */ } }

// ── 명령 묶어 보내기 (#3537) ────────────────────────────────────────────────
//  **왜 필요한가** — 매니지드에서 tmux 호출 하나는 로컬 execFile 이 아니다:
//    `node tmux-relay.cjs <slug>` (새 Node 프로세스) → 허브 → 브로커 → `docker exec … tmux …`
//   실측(2026-09-04, 매니지드 테넌트): tmux 안 쓰는 API 가 0.02초인데 **tmux 한 번이 0.45~1.0초**(이상치 4.8초)다.
//   createSession 은 그 왕복을 **15번 순차로** 했다(new-session + @box_* 10여 개 + 창 옵션 셋) — 그것만으로
//   7~15초다. 사용자가 «시키기를 눌러도 5초 넘게 아무 일도 안 난다» 고 신고한 시간의 정체가 이것이었다.
//   tmux 는 한 번의 호출에서 `;` 로 여러 명령을 이어 받으므로, 왕복 수를 명령 수에서 **떼어낼 수 있다**.
//
//  ⚠ 실측으로 확인한 계약(2026-09-04, tmux 3.x):
//   · 인자 **안에** `;` 가 있는 것은 구분자가 아니다(`x;y` 는 값 그대로 들어간다) — 판 명령의 셸 스크립트가 안전한 이유.
//   · 인자가 **정확히** `;` 이면 tmux 가 구분자로 읽어 «empty value» 로 죽는다 → 그런 명령은 배치에 안 싣는다(홀로 보낸다).
//   · 중간 명령이 실패하면 그 뒤는 **실행되지 않고** 호출 전체가 비-0 이다 — 순차 실행의 의미가 그대로 보존된다.
//  ⚠ 브로커의 argv 상한(lvly-cloud validateTmuxArgv, 종전 64)보다 **적게** 끊는다. 상한을 올리는 변경과
//   이 변경의 배포 순서가 어긋나도 조용히 깨지지 않게 하려는 것이다(옛 브로커에서도 그대로 돈다).
//  ⚠⚠ **묶는 것은 전송의 최적화처럼 보이지만 라우팅의 입력을 바꾼다** (#3668 리뷰, 2026-09-08).
//   이 argv 를 읽는 사람이 매니지드에 둘 더 있다 — 중계(`tmux-relay.cjs sessionOf`)가 `x-lvly-session`
//   헤더를 만들어 허브가 **세션 라우트**로 노드를 고르게 하고(#3681 ③), 브로커
//   (`sessionbroker.tmuxSessionOf` → `routeKeyOf`)가 두 번째 홉 전달을 정한다(#3563).
//   둘 다 **한 명령** 문법이라 «첫 비옵션이 동사 → `-s`/`-t` 를 찾되 비옵션 인자를 만나면 멈춘다» 로 읽는다.
//   그래서 세션을 안 지목하는 명령(`set-option -g …`)을 앞에 묶으면 파서가 거기서 멈춰 뒤의
//   `new-session -s <id>` 를 **아예 못 본다** → 지목이 null → 그 명령이 세션이 앉은 노드가 아니라
//   테넌트 핀 노드로 간다(크로스노드 배치 세션은 생성이 깨진다).
//   실측(실제 중계 파서를 그대로 실행): 묶으면 `null`, 안 묶으면 `<id>`.
//  ⇒ **세션을 지목하지 않는 명령은 배치에 안 싣는다**(아래 `tmuxBatchable`). 지목이 있는 것끼리만 묶으므로
//   묶음의 첫 명령이 늘 라우팅 키를 쥔다. 전역 옵션 하나가 홀로 나가는 대가(왕복 +1)로 라우팅이 산다.
//
//  ⏳ **이 층은 수명이 있다** (#3668 리뷰, 2026-09-08). 왕복이 비싼 이유는 게이트웨이가 **남의 박스**의
//   tmux 를 부르기 때문이고, #2600 T2 (d)(#3696)의 도착점이 «매니지드 세션의 주인을 노드 박스의 세션
//   호스트로 옮기고 게이트웨이의 매니지드 tmux 호출을 0 으로» 다. 다만 그 태스크는 **생성(create)을 스코프
//   밖에 뒀다**(«create 에는 아직 주인이 없다 — 배치는 용량 판단이라 CP 몫») — 여기서 묶는 15 왕복이 바로
//   그 create 라, 그때까지는 이 층이 값을 한다. create 에도 주인이 생기면 왕복이 로컬 `runsc exec`(15~70ms)로
//   떨어져 이 층은 «7~15초를 없애는 본체» 에서 «0.5초짜리 잔여 최적화» 가 된다 — 그 시점의 죽은 코드
//   정리(#2608)가 이 블록을 후보로 세어야 한다.
export const TMUX_BATCH_MAX_ARGV = 60;

/** tmux 명령 하나 — argv 조각. */
export type TmuxCmd = readonly string[];

/**
 * (순수) 이 명령이 지목하는 세션 — 없거나 이름 형식 밖이면 null.
 *
 * ⚠ **문법을 여기서 다시 쓰지 않는다.** 정본은 `tmux-route.tmuxSessionOf` 이고, 그건 브로커
 *  (`sessionbroker.tmuxSessionOf`)·중계(`tmux-relay.cjs sessionOf`)와 «같은 답» 을 내기로 못박힌 자리다.
 *  배치 판정이 그들과 갈리면 그 갈림이 곧 라우팅 오류이므로, 같은 함수를 쓴다(사본을 넷째로 만들지 않는다).
 */
export function tmuxBatchRefOf(cmd: TmuxCmd): string | null {
  const { ref } = tmuxSessionOf(cmd);
  return ref.kind === "session" ? ref.sid : null;
}

/**
 * (순수) 이 명령을 배치에 실을 수 있나.
 *  · 인자가 정확히 `;` 이면 못 싣는다(위 tmux 계약 — 구분자로 읽혀 죽는다).
 *  · **세션을 지목하지 않으면 못 싣는다**(위 ⚠⚠ — 묶으면 뒤 명령의 라우팅 키가 가려진다).
 * 못 싣는 명령은 버리는 게 아니라 **홀로** 나간다(종전과 완전히 같은 동작).
 */
export function tmuxBatchable(cmd: TmuxCmd): boolean {
  return cmd.length > 0 && !cmd.some((a) => a === ";") && tmuxBatchRefOf(cmd) !== null;
}

/**
 * (순수) 명령들을 `;` 로 이어 붙인 **argv 묶음들**로 나눈다 — 묶음 하나가 중계 왕복 하나다.
 *  못 싣는 명령(위)은 홀로 떼어 종전과 똑같이 나간다. 명령 하나가 상한을 넘으면 쪼갤 수 없으므로 그대로 둔다.
 */
export function chunkTmuxCommands(cmds: readonly TmuxCmd[], maxArgv = TMUX_BATCH_MAX_ARGV): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  let curRef: string | null = null;                                  // 이 묶음이 지목하는 세션 — 라우팅 키
  const flush = (): void => { if (cur.length) { out.push(cur); cur = []; } curRef = null; };
  for (const cmd of cmds) {
    if (!cmd.length) continue;
    if (!tmuxBatchable(cmd)) { flush(); out.push([...cmd]); continue; }
    const ref = tmuxBatchRefOf(cmd);
    //  ★ 한 묶음 = 한 세션. 묶음은 **첫 명령의 지목**으로 라우팅되므로(중계·브로커·`planTmux` 셋 다),
    //   다른 세션의 명령을 같이 실으면 그 명령이 남의 세션 컨테이너에서 돈다.
    if (cur.length && ref !== curRef) flush();
    if (cur.length && cur.length + 1 + cmd.length > maxArgv) flush();
    if (cur.length) cur.push(";");
    else curRef = ref;
    cur.push(...cmd);
  }
  flush();
  return out;
}

/**
 * 읽기 여럿을 **한 왕복**으로 — 묶어 보내고 합쳐진 stdout 을 그대로 돌려준다 (#2600 T2 d6).
 *
 * ── 왜 (2026-09-09 계수 실측) ────────────────────────────────────────────────
 * 아웃박스의 준비 판정(`waitReady`)이 500ms 마다 `capture-pane` 과 `display-message` 를 **각각** 부른다 =
 *  대기 중인 세션 하나당 초당 4 왕복. 그게 매니지드 게이트웨이 tmux 호출의 **41%**(115/분 중 57+57)였다.
 *  두 읽기는 같은 세션을 같은 순간에 보는 것이라 한 번에 물어도 되고, 그러면 **왕복이 절반**이 된다.
 *
 * ⓘ 덤으로 **한 시점의 값**이 된다 — 종전엔 두 왕복 사이에 pane 이 바뀔 수 있어서 «화면은 t0, 명령은 t0+Δ»
 *  로 어긋난 짝이 `firstPromptStep` 에 들어갈 수 있었다.
 *
 * ⚠ 한 묶음이 안 되면(세션 지목이 다르거나 못 싣는 명령) **던진다.** 조용히 두 번 나가면 이 함수를 쓰는
 *  이유가 사라지고, 호출부는 «한 왕복» 을 믿은 채로 남는다 — 왕복 수가 이 함수의 계약이다.
 * ⚠ 출력은 명령 **순서대로** 이어 붙는다. 어느 줄이 누구 것인지는 호출부가 안다(그 지식을 여기 두지 않는다).
 */
export async function tmuxReadOneRoundTrip(cmds: readonly TmuxCmd[]): Promise<string> {
  const chunks = chunkTmuxCommands(cmds);
  if (chunks.length !== 1) {
    throw new Error(`tmux 읽기를 한 왕복으로 못 묶는다(묶음 ${chunks.length}개) — 세션 지목이 갈렸거나 못 싣는 명령이다`);
  }
  return tmux(chunks[0]!);
}

/** 묶어 보낸다 — 실패는 던진다(순차 `tmux()` 여러 번과 같은 의미). */
export async function tmuxBatch(cmds: readonly TmuxCmd[]): Promise<void> {
  for (const argv of chunkTmuxCommands(cmds)) await tmux(argv);
}
/**
 * 묶어 보내되 실패는 삼킨다(`tmuxQuiet` 여러 번의 자리).
 *  ⚠ 한 묶음 안에서 앞 명령이 실패하면 **그 묶음의 뒤 명령은 안 돈다**(위 계약) — 종전에는 각자 독립이었다.
 *   여기 싣는 것은 창 표시 옵션(mouse·window-size 류)뿐이라, 그중 하나가 실패하는 판은 나머지도 의미가 없다.
 */
export async function tmuxBatchQuiet(cmds: readonly TmuxCmd[]): Promise<void> {
  for (const argv of chunkTmuxCommands(cmds)) await tmuxQuiet(argv);
}
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
  //  '서버 접속불가'라는 별개 상태가 없다 — exit 1 + 빈 stderr 는 '그 세션 없음'의 유력한 모양이다.
  //  ⚠ 다만 그 모양은 **다른 실패와도 겹친다**(isPsmuxSilentExit 머리말) — 그래서 확답이 필요한 자리
  //   (sessionGone)는 이 술어를 그대로 믿지 않고 `list-sessions` 로 한 번 더 확인한다(#3569).
  if (isPsmuxSilentExit(err, bin)) return true;
  return false;
}

/**
 * psmux 의 **'조용한 실패'** — exit 1 인데 stderr 가 한 글자도 없다.
 *
 * ⚠ 이 모양은 «그 세션 없음» **만**을 뜻하지 않는다. psmux 는 tmux 의 "can't find session" 같은 문구를
 *  주지 않으므로, 이 한 가지 모양 안에 «없는 세션 조회»와 «다른 이유로 실패»가 **함께** 들어 있다.
 *  그래서 이 술어는 «없다는 확답»이 아니라 «구분이 안 되는 실패»의 이름이다 — 확답이 필요한 자리
 *  (sessionGone)는 목록으로 한 번 더 확인한다. (실행 파일 부재(ENOENT)는 code 가 문자열이라 안 걸린다.)
 */
export function isPsmuxSilentExit(err: unknown, bin: string = TMUX_BIN): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { killed?: boolean; signal?: string | null; stderr?: unknown; code?: unknown };
  if (e.killed || e.signal) return false;                     // 타임아웃·시그널 종료 → 판정 불가
  return isPsmuxBin(bin) && e.code === 1 && String(e.stderr ?? "").trim() === "";
}

/** `list-sessions -F "#{session_name}"` 출력에 이 세션이 있나(순수 — 한 줄에 이름 하나). */
export function sessionInList(raw: string, id: string): boolean {
  return String(raw ?? "").split("\n").some((line) => line.trim() === id);
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
/**
 * 이 세션이 **정말 끝났나** — `true` 일 때만 '죽었다'로 다뤄도 된다(#835 '확답 only').
 *
 * 🔴 psmux(윈도우 노드)만 한 겹 더 확인한다 (#3569, 2026-09-07 실측).
 *  `isPsmuxSilentExit` 머리말대로 psmux 의 exit 1 + 빈 stderr 에는 «그 세션 없음»과 «다른 이유로 실패»가
 *  **같은 모양으로** 들어 있다. 그런데 #1791 은 그 모양을 곧바로 «없다는 확답»으로 승격했고, 그래서 **갓 만들어
 *  아직 등록 전인 세션**까지 죽었다고 답했다. 그 오답의 대가가 크다 — 화면의 부팅 게이트(maybeRestoreOnOpen)가
 *  그 한 마디를 믿고 살아 있는 세션을 복원으로 몰고, 갓 만든 세션엔 이어받을 대화가 없어 인자 없는
 *  `claude --resume` = **후보 0건 피커**가 뜬다(상민님 신고 2026-09-07: 홈에서 [시키기] 를 누르면
 *  «이어받기 세션을 열었어요» 와 함께 빈 피커로 떨어진다. 실측 로그: 생성 t+99ms 메타가 restorable:true,
 *  t+1303ms 에 movedTo 로 뒤집힘).
 *
 *  고침은 판정을 옮기는 것이 아니라 **확답을 만드는 것**이다: psmux 는 `list-sessions` 를 멀쩡히 답한다
 *  (실측 hammurabi 2026-09-07 — `psmux list-sessions -F "#{session_name}"` → exit 0 + 세션명 한 줄씩,
 *   `psmux has-session -t <없는 id>` → exit 1 + 빈 stderr). 목록을 볼 수 있으면 그게 확답이다.
 *  ⚠ 목록조차 못 보면 **종전 판정을 유지한다**(gone) — #1791 이 연 길(윈도우의 죽은 세션도 복원·삭제된다)을
 *   닫지 않기 위해서다. 이 변경은 «목록이 보일 때만» 판정을 바꾼다(무회귀).
 */
export async function sessionGone(id: string): Promise<boolean> {
  return (await sessionGoneVerdict(id)) === true;
}

/**
 * 같은 판정에 **«모른다»** 를 살려서 돌려준다 (#3752 ④) — `true` 끝남 · `false` 살아있음 · `null` **판정 불가**.
 *
 * ── 왜 (실측 2026-09-08, #3688) ──────────────────────────────────────────────
 * `sessionGone` 은 «모른다» 를 `false`(살아있음)로 접는다. 그 접기는 **자동 경로에선 옳다** — 모름을 죽음으로
 *  읽으면 살아 있는 세션이 복원으로 끌려가고, 갓 만든 세션은 후보 0건 피커로 떨어진다(#2108·#3626).
 *  그런데 그 접기가 **사람에게 보이는 자리**까지 덮으면 다른 고장이 된다: 매니지드에서 샌드박스가 wedged 되어
 *  브로커가 503 `LVLY_STATE_UNKNOWN` 을 주면, 게이트웨이는 그 세션을 «살아 있다» 고 답한다 — 사람은 화면이
 *  «응답이 없다» 로만 보이는데 복원 게이트는 영영 안 열린다(실측: 메타 6.9초 뒤 restorable 없음 ·
 *  `POST …/restore` 는 `already:true`). 그 샌드박스는 사람이 개입하기 전엔 스스로 돌아오지 않는다.
 *
 * ★ 그래서 판정을 바꾸지 않고 **사실을 하나 더 낸다.** 「없다는 확답」과 「모른다」는 다른 사실이고, 후자는
 *  화면이 «상태를 확인할 수 없어요» 라고 말할 수 있어야 하는 자리다. `sessionGone` 의 계약은 그대로다(무회귀) —
 *  이 함수를 **일부러 부르는 자리만** 그 차이를 본다. [[reboot-stale-session-route-restore-3675]] §3 과 같은 자리.
 */
export async function sessionGoneVerdict(id: string): Promise<boolean | null> {
  if (!ID_RE.test(id)) return false; // 형식 자체가 틀림 = '종료'가 아니라 잘못된 요청
  try { await tmux(["has-session", "-t", id]); return false; } // 살아있음
  catch (err) {
    //  ⚠ 여기가 «모른다» 다 — 중계 불통·타임아웃·브로커 503(LVLY_STATE_UNKNOWN). 종전엔 이 갈래가 곧바로
    //   false(살아있음)였다. 그 접기를 **부르는 쪽이 고르게** 남겨 둔다.
    if (!isSessionGoneError(err)) return null;
    if (!isPsmuxSilentExit(err)) return true;   // tmux 는 문구로 확답한다 — 되물을 것이 없다
    try { return !sessionInList(await tmux(["list-sessions", "-F", "#{session_name}"]), id); }
    catch { return true; }                      // 목록도 못 봤다 → 종전 판정 유지(#1791 무회귀)
  }
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
//  - latest: **마지막으로 `refresh-client -C` 를 보낸 클라**의 크기로 창이 맞춰진다.
//    실측(tmux 3.6a, 격리소켓): largest 는 작은 클라 refresh 후에도 창 유지, latest 는 마지막 refresh 한
//    클라 크기로 전환됨을 확인. aggressive-resize 는 다중 '세션' 공유용이라 무관(끔 유지).
//  ⚠ 정정(2026-09-01 실측 tmux 3.3a, 격리소켓): 종전 주석은 "지금 보는 탭이 포커스·'화면 복구' 때
//   refresh-client 를 보내면 그 순간 '최근 활동'이 되어 pane 이 그 탭 크기로 맞춰진다"고 적었는데 **틀렸다**.
//   `refresh-client -C` 는 client_activity 를 갱신하지 않고, control-mode 클라는 사용자 입력조차 `send-keys`
//   **명령**으로 보내므로 활동이 영영 안 잡힌다 → 붙은 뒤로는 '최근 활동' 클라가 될 수 없다. 즉 클라가 둘 이상이면
//   **먼저 줄인 쪽이 이기고, 큰 쪽은 다시 보내도 못 되돌린다**(줄인 클라가 detach 하면 그때 남은 클라 크기로 복귀).
//   그래서 '못 잰 크기는 아예 보내지 않는다'를 클라가 지켜야 한다 — web/standalone/terminal.ts canReportSize.
//   (되돌리는 명령은 `resize-window -x/-y` 뿐인데, 그건 window-size 를 manual 로 굳혀 이후 refresh-client 를
//    통째로 무력화한다 — 실 터미널 attach 의 자동 크기맞춤까지 죽으므로 쓰지 않는다. 실측으로 확인.)
export async function ensureSessionOpts(id: string): Promise<void> {
  if (!ID_RE.test(id)) return;
  await tmuxQuiet(["set-option", "-t", id, "mouse", "on"]);
  await tmuxQuiet(["set-window-option", "-t", id, "aggressive-resize", "off"]);
  await tmuxQuiet(["set-window-option", "-t", id, "window-size", "latest"]);
}
