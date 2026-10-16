// 구성원 AI 계정 커넥터 확인 (#4213 T6 #4427) — 그 사람 자리에서 공식 CLI 로 «Claude 에 무엇을 연결했나» 를 잰다.
//
// ── 왜 게이트웨이가 재나(대화 세션이 보고하지 않고) ───────────────────────────────
//  · 훅 입력에는 MCP 목록이 없다(실측 2026-10-16, Claude Code 2.1.301: SessionStart 입력 키 = session_id · transcript_path ·
//    cwd · hook_event_name · source). 그래서 대화 세션이 «내가 가진 커넥터» 를 알리려면 어차피 `claude mcp list` 를
//    따로 돌려야 한다.
//  · 그걸 대화 세션 컨테이너 안에서 돌리면 그 사람의 대화와 메모리를 나눠 쓴다 — 한 번에 2.9초 · 컨테이너 +365~399MB
//    (같은 날 매니지드 실측). 확정판 §5 가 수집을 대화 세션 안에서 돌리지 않기로 한 것과 같은 이유다.
//  · 그리고 재야 하는 것은 «그 사람 PC 의 Claude» 가 아니라 **수집이 실제로 쓰는 홈의 로그인**이다(10/16 실측: 맥과
//    매니지드 홈의 Claude 로그인이 다른 커넥터 묶음이었다). 그 홈에서 도는 자리는 로그인 확인이 이미 쓰는 하네스 자리다.
//  그래서 **사람이 «새로 확인» 을 부를 때만**(리브 · 현황판 · 본인) 그 자리에서 잰다. 수집 실행(T11)은 자기 시작 때
//  같은 목록을 이미 재므로 그쪽 기록은 collect-run.ts 가 넘긴다.
//
// ── 자리 ────────────────────────────────────────────────────────────────────
//  ai-login-run 의 하네스 자리(spawnAtLoginSeat)를 쓰되 **자리 이름을 따로 둔다**(`ac-claude`). 대화형 로그인 자리(`claude`)를
//  같이 쓰면 한쪽의 정리(dropLoginSession)가 다른 쪽 러너까지 죽인다(#4051 이 headless 발급에 `hl-` 를 둔 이유와 같다).
//  다 재면 자리를 바로 놓는다 — 확인은 드물고, 남겨 두면 노드 예약만 잡아먹는다(#4067).
//
// ── 무엇을 남기나 ────────────────────────────────────────────────────────────
//  앱 이름 · 상태뿐이다. `claude mcp list` 의 주소(그 사람 계정의 프록시 주소)와 `claude auth status` 의 이메일·조직은
//  읽은 자리에서 버린다 — 로그에도 원문을 남기지 않는다.
import type { LivelyUser } from "../context.js";
import { HttpError } from "../http-error.js";
import { logger } from "../log.js";
import { tenantSlug } from "./catalog.js";
import { resolveMemberOsUser } from "./terminal-isolation.js";
import { ownerId, userSlug } from "./profiles.js";
import { dropLoginSession, loginHomeOf, loginShQuote, spawnAtLoginSeat } from "./ai-login-run.js";
import {
  claudeAiConnectorsOf, listMemberAiConnectors, memberAiConnectorsPolicy, parseClaudeMcpList, recordMemberAiConnectors, type MemberAiConnectorView,
} from "../org/store/member-ai-connectors.js";

/** 확인 전용 하네스 자리 이름 — 대화형 로그인 자리(`claude`)와 섞지 않는다(머리말). */
export const PROBE_SEAT_KEY = "ac-claude";
/** 한 번의 확인 상한 — 컨테이너 확보(수 초) + auth status(0.6초) + mcp list(2.9초) 에 넉넉히. */
const PROBE_TIMEOUT_MS = 120_000;
/** 방금 잰 사람은 이 안에서 다시 재지 않는다 — 리브와 화면이 겹쳐 불러도 컨테이너를 두 번 띄우지 않게. */
const RECENT_MS = 15_000;

/**
 * claude 를 **정식 로그인으로만** 돌리게 env 를 비운다. 수집 실행 러너(collect-run-script env())와 같은 목록이다:
 *  토큰 env 가 있으면 claude 가 그쪽을 쓰는데 setup-token 으로는 claude.ai 커넥터가 안 뜨고, 두 차단 스위치는 목록을 비운다.
 *  하네스 안 세션 표식(CLAUDECODE 등)은 «중첩 세션» 판정을 피하려고 지운다. 라이블리 훅은 끈다(LIVELY_OFF).
 */
const CLEAN_ENV_UNSET = [
  "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT", "LIVELY_SESSION_ID",
  "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "ENABLE_CLAUDEAI_MCP_SERVERS",
] as const;

/**
 * (순수) 확인 스크립트 — 그 사람 자리에서 돈다. 셸 문자열에 사용자 입력이 없다(홈 경로는 우리가 만든 값 · 따옴표로 감싼다).
 *  목록은 `--setting-sources project,local` 로 **사용자 설정을 빼고** 센다 — 수집 실행 러너와 같은 방식이다(T11 #4743).
 *   사용자 설정의 MCP(lively · lively-local …)를 띄우지도 재지도 않아 가볍고(실측 2026-10-16: 프로세스 1개 · +331MB, 빼지 않으면
 *   3개 · +365~399MB), 사용자 settings 의 env·훅이 claude.ai 커넥터를 가리는 일도 없다. claude.ai 커넥터는 로그인(자격 파일)으로
 *   뜨므로 사용자 설정을 빼도 그대로 나온다(같은 실측). 그 플래그를 모르는 옛 claude 면 빼지 않고 센다(목록에 로컬 MCP 가 섞일 뿐이다).
 */
export function probeScript(home: string): string {
  const clean = `env ${CLEAN_ENV_UNSET.map((k) => `-u ${k}`).join(" ")} LIVELY_OFF=1 LIVELY_HOOKS_OFF=1`;
  return [
    `export HOME=${loginShQuote(home)}`,
    `command -v claude >/dev/null 2>&1 || { echo '@@nocli'; exit 0; }`,
    //  timeout 이 없는 이미지면 그냥 돈다 — 게이트웨이 쪽 상한(PROBE_TIMEOUT_MS)이 한 겹 더 있다.
    `T=""; command -v timeout >/dev/null 2>&1 && T="timeout 60"`,
    `S=""; $T ${clean} claude --help < /dev/null 2>/dev/null | grep -q -- '--setting-sources' && S="--setting-sources project,local"`,
    `echo '@@auth'`,
    `$T ${clean} claude auth status --json < /dev/null 2>/dev/null`,
    `echo`,
    `echo '@@list'`,
    `$T ${clean} claude $S mcp list < /dev/null 2>/dev/null`,
    `echo "@@exit $?"`,
  ].join("\n");
}

export interface ProbeParse {
  /** 목록 — null 이면 못 얻었다(error 에 사유) · [] 면 로그인은 맞는데 연결한 앱이 없다. */
  servers: Array<{ name: string; status: string }> | null;
  error: string | null;
}

/**
 * (순수) 확인 스크립트 출력 → 목록 또는 사유.
 *  · 로그인 확인이 먼저다 — 로그인이 풀린 사람의 `claude mcp list` 에는 claude.ai 줄이 그냥 없어서(로컬 MCP 만 나온다)
 *    «연결한 앱이 하나도 없다» 와 구분이 안 된다. 그걸 목록으로 적으면 앱 줄이 전부 removed 가 된다.
 *  · authMethod 가 claude.ai 가 아니면(API 키 · setup-token) claude.ai 커넥터가 안 뜬다(Anthropic 인증 문서) — 그것도 사유로.
 *  · auth 출력은 loggedIn · authMethod 두 칸만 본다(이메일·조직은 읽지 않는다).
 */
export function parseProbeOutput(out: string): ProbeParse {
  const text = String(out ?? "");
  if (/^@@nocli\s*$/m.test(text)) return { servers: null, error: "no-cli" };
  const authAt = text.indexOf("@@auth"), listAt = text.indexOf("@@list");
  if (authAt < 0 || listAt < 0 || listAt < authAt) return { servers: null, error: "probe-output" };
  const authRaw = text.slice(authAt + "@@auth".length, listAt).trim();
  let auth: { loggedIn?: unknown; authMethod?: unknown } | null = null;
  try { auth = JSON.parse(authRaw); } catch { auth = null; }
  if (!auth || typeof auth !== "object") return { servers: null, error: "auth-unreadable" };
  if (auth.loggedIn !== true) return { servers: null, error: "not-logged-in" };
  if (String(auth.authMethod ?? "") !== "claude.ai") return { servers: null, error: "not-claude-ai-login" };
  //  종료 표식이 없으면 목록이 끝까지 왔는지 모른다 — 잘린 목록을 «전부» 로 적으면 잘린 뒤쪽 앱이 removed 가 된다. 믿지 않는다.
  const exitM = /^@@exit (\d+)\s*$/m.exec(text);
  if (!exitM) return { servers: null, error: "probe-output" };
  if (exitM[1] !== "0") return { servers: null, error: exitM[1] === "124" ? "timeout" : `mcp-list-exit-${exitM[1]}` };
  //  로그인이 맞고 목록 명령이 0 으로 끝났으면 빈 목록도 «다 봤는데 없다» 다(사용자 설정을 빼고 세므로 로컬 MCP 가 없는 게 정상).
  //   다만 «원래 있던 것이 전부 사라졌다» 는 한 번으로 믿지 않는다 — probeMemberAiConnectors 의 두 번 확인.
  return { servers: parseClaudeMcpList(text.slice(listAt + "@@list".length, exitM.index)), error: null };
}

/** 원래 있던 커넥터가 한 번에 전부 사라진 확인 — 한 번 더 같아야 반영한다(probeMemberAiConnectors 머리말). */
export const UNCONFIRMED_EMPTY = "unconfirmed-empty";

/**
 * (순수) 이번 확인이 «원래 있던 커넥터를 전부 지우는» 모양인데 아직 한 번도 그렇게 본 적이 없으면 true — 이번 것은 미확정으로 적는다.
 *  왜: `claude auth status` 가 «로그인됨» 이라 해도 그건 자격 파일을 본 것일 수 있다(서버에 물었는지 이 버전에서 확인하지 못했다).
 *   만료·취소된 토큰이면 목록 명령이 0 으로 끝나면서 claude.ai 줄만 빠진다 — 그걸 그대로 적으면 그 사람의 앱이 전부 removed 가 되고
 *   현황판은 «Claude 에 연결한 앱이 없어요» 를 띄운다. 진짜로 다 끊었다면 바로 다음 확인도 같다 — 두 번 연속일 때만 반영한다.
 */
export function needsEmptyConfirmation(parsedServers: ReadonlyArray<{ name?: unknown; status?: unknown }> | null, current: MemberAiConnectorView): boolean {
  if (!parsedServers) return false;
  if (claudeAiConnectorsOf(parsedServers).length) return false;
  const had = current.connectors.some((c) => c.status !== "removed");
  return had && current.scan?.error !== UNCONFIRMED_EMPTY;
}

export interface ProbeResult {
  /** 이번에 쟀나 — false 면 정책이 꺼져 있거나 못 읽었거나(skipped) 방금 잰 값을 돌려준 것이다. */
  probed: boolean;
  skipped: "policy-off" | "policy-unknown" | "recent" | null;
  record: MemberAiConnectorView;
}

/** 사람마다 한 번에 하나 — 겹친 요청은 같은 확인을 기다린다. 키는 테넌트까지(ai-login-run seatKey 와 같은 이유 — #3894). */
const inflight = new Map<string, Promise<ProbeResult>>();
const lastDone = new Map<string, number>();
const keyOf = (user: LivelyUser): string => `${tenantSlug() ?? ""}|${ownerId(user)}`;

/**
 * 그 사람의 Claude 커넥터를 지금 잰다(본인만 — 부르는 자리가 그 사람이어야 한다).
 *  정책이 꺼져 있으면 재지 않는다 — 이 워크스페이스는 구성원 AI 계정 커넥터를 쓰지 않기로 했다(남의 계정을 들여다볼 이유가 없다).
 *  실패(로그인 풀림 · CLI 없음 · 시간 초과 · 자리 부족)는 던지지 않고 기록의 확인 줄에 사유로 남긴다 — 화면·리브가 그 사유로 안내한다.
 *  «원래 있던 커넥터가 전부 사라짐» 은 한 번으로 믿지 않는다(UNCONFIRMED_EMPTY — needsEmptyConfirmation 머리말).
 *  실패한 확인도 15초 안 재요청은 막는다 — 자리 부족 같은 실패는 곧바로 다시 불러도 같고, 컨테이너만 더 띄운다.
 */
export async function probeMemberAiConnectors(user: LivelyUser, deps: {
  run?: (user: LivelyUser, osUser: string | null, script: string) => Promise<string>;
  now?: () => number;
} = {}): Promise<ProbeResult> {
  const memberId = ownerId(user);
  if (!memberId) throw new HttpError(401, "누구의 커넥터를 확인할지 알 수 없습니다");
  const key = keyOf(user);
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = (async (): Promise<ProbeResult> => {
    const current = async (): Promise<MemberAiConnectorView> =>
      (await listMemberAiConnectors({ memberId, includeRemoved: true }))[0] ?? { member_id: memberId, provider: "claude", scan: null, connectors: [] };
    //  정책이 꺼져 있으면 재지 않는다. 못 읽었으면 그것도 재지 않는다(fail-closed — 끈 워크스페이스일 수 있다).
    const policy = await memberAiConnectorsPolicy();
    if (policy !== "allowed") return { probed: false, skipped: policy === "blocked" ? "policy-off" : "policy-unknown", record: await current() };
    const now = (deps.now ?? Date.now)();
    if (now - (lastDone.get(key) ?? 0) < RECENT_MS) return { probed: false, skipped: "recent", record: await current() };
    const run = deps.run ?? (async (u: LivelyUser, os: string | null, script: string) => {
      try { return await spawnAtLoginSeat(u, os, PROBE_SEAT_KEY, script); }
      finally { await dropLoginSession(u, PROBE_SEAT_KEY).catch(() => undefined); }   // 확인은 드물다 — 자리를 바로 놓는다(머리말)
    });
    let parsed: ProbeParse;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const osUser = await resolveMemberOsUser(userSlug(user));
      const out = await Promise.race([
        run(user, osUser, probeScript(loginHomeOf(osUser))),
        new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("timeout")), PROBE_TIMEOUT_MS); }),
      ]);
      parsed = parseProbeOutput(out);
      if (needsEmptyConfirmation(parsed.servers, await current())) parsed = { servers: null, error: UNCONFIRMED_EMPTY };
    } catch (e) {
      //  자리를 못 얻었다(노드 용량 등) · 중계 실패 · 시간 초과 — 사유만 남긴다. 원문 출력은 로그에 싣지 않는다(머리말).
      const msg = String((e as Error)?.message || e);
      parsed = { servers: null, error: /timeout/i.test(msg) ? "timeout" : /CAPACITY/i.test(msg) ? "no-capacity" : "probe-failed" };
      logger.warn({ memberId, reason: parsed.error }, "구성원 Claude 커넥터 확인 실패 — 사유만 기록한다(#4427)");
    } finally {
      if (timer) clearTimeout(timer);
    }
    const record = await recordMemberAiConnectors({ memberId, origin: "probe", servers: parsed.servers, error: parsed.error });
    lastDone.set(key, (deps.now ?? Date.now)());
    return { probed: true, skipped: null, record };
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** (시험용) 겹침·최근 표를 비운다. */
export function _resetProbeStateForTest(): void { inflight.clear(); lastDone.clear(); }
