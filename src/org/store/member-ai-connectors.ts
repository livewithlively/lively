// 구성원 AI 계정 커넥터 기록 (#4213 T6 #4427) — «누가 자기 Claude 에 무엇을 연결했나» 의 저장·조회와 워크스페이스 정책 한 칸.
//
// ── 누가 쓰나 ────────────────────────────────────────────────────────────────
//  · 쓰는 쪽 둘 — ① 수집 실행(T11 terminal/collect-run.ts)이 끝날 때 러너 summary.json 의 서버 목록을 넘긴다
//    ② 게이트웨이 확인(terminal/member-ai-connector-probe.ts)이 그 사람 자리에서 `claude mcp list` 를 돌려 넘긴다.
//    둘 다 recordMemberAiConnectors 하나로 들어온다 — 입구가 둘이면 «removed» 판정이 갈린다.
//  · 읽는 쪽 — 리브의 연결 제안 · 수집 단위 표의 «구성원 AI 계정» 경로(T10) · [외부 앱 연결] 현황판(T13).
//    listMemberAiConnectors 가 사람마다 «마지막 확인 + 앱 줄» 을 준다.
//
// ── 왜 «서버 목록 전체» 를 받나 ─────────────────────────────────────────────────
//  하네스가 주는 목록(claude mcp list · init.mcp_servers)에는 로컬 MCP(lively · lively-local · figma …)가 섞여 나온다
//  (2026-10-15 맥 · 2026-10-16 매니지드 실측 — 같은 형식). 거르는 규칙(«claude.ai » 앞머리)을 부르는 쪽마다 두면
//  한쪽만 고쳐지므로 여기서 한 번 거른다.
//
// ── «removed» 와 «목록을 못 얻었다» 를 가른다 ───────────────────────────────────
//  목록을 얻었으면(ok) 그 목록이 **전부**다 — 목록에 없는 앱 줄은 removed 로 내린다(claude.ai 에서 연결을 끊은 것).
//  목록을 못 얻었으면(로그인 풀림 · CLI 없음 · 시간 초과) 앱 줄은 **지난 값 그대로** 두고 확인 줄에 사유만 남긴다 —
//  실패를 «연결이 다 끊겼다» 로 적으면 현황판이 전원에게 «다시 연결하세요» 를 띄운다.
//  계약: servers=null 은 «못 얻었다», servers=[] 는 «다 봤는데 하나도 없다»(빈 전체 목록)다. 빈 목록을 실패로 볼지는
//   **부르는 쪽**이 정한다 — 그 목록이 어떻게 나왔는지 아는 건 거기다(확인은 로그인·종료 코드까지 보고 0개를 믿고,
//   수집 실행은 0개를 실패로 본다 — collectSummaryScan).
import { itemsPool } from "../../db/client.js";
import { logger } from "../../log.js";
import { audit, type WriteCtx } from "./audit.js";

export type AiConnectorProvider = "claude";
export type AiConnectorStatus = "connected" | "needs-auth" | "failed" | "pending" | "unknown" | "removed";
export type AiConnectorOrigin = "probe" | "collect";

/** claude.ai 커넥터의 서버 이름 앞머리 — Claude Code 가 «claude.ai <앱>» 으로 부른다(실측 2.1.300·2.1.301). */
export const CLAUDE_AI_SERVER_PREFIX = "claude.ai ";

/** 앱 이름 모양 — 하네스가 주는 이름이지만 화면·지시문에 실리므로 좁힌다(T11 collect-run-script 의 APP_RE 와 같은 자). */
const APP_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
/** 한 사람의 앱 줄 상한 — 디렉터리가 수백 개라도 한 사람이 다는 커넥터는 수십 개다. 넘치면 앞에서 자른다(무한 증식 방지). */
const MAX_APPS = 200;

/**
 * (순수) 하네스가 낸 상태 문자열 → 우리 상태.
 *  init.mcp_servers 는 connected · needs-auth · failed · pending 을 쓰고, `claude mcp list` 는 기호와 문장을 쓴다
 *  (✔ Connected · ! Needs authentication · ✘ Failed to connect · ⏸ Pending approval). 둘 다 여기서 접는다.
 */
export function normalizeAiConnectorStatus(raw: unknown): AiConnectorStatus {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return "unknown";
  if (s === "connected" || s.includes("✔") || s.includes("✓") || /\bconnected\b/.test(s)) return "connected";
  if (s === "needs-auth" || /needs[ -]auth/.test(s)) return "needs-auth";
  if (s === "pending" || s.includes("⏸") || /\bpending\b/.test(s)) return "pending";
  if (s === "failed" || s.includes("✘") || s.includes("✗") || /\bfail/.test(s)) return "failed";
  return "unknown";
}

/**
 * (순수) MCP 서버 목록 → claude.ai 커넥터만. 같은 앱이 두 번 오면 앞의 것(하네스가 먼저 낸 것)을 쓴다.
 *  이름이 앞머리만 있거나 모양 밖이면 버린다 — 지어내지 않는다.
 */
export function claudeAiConnectorsOf(servers: ReadonlyArray<{ name?: unknown; status?: unknown }> | null | undefined): Array<{ app: string; status: AiConnectorStatus }> {
  const out: Array<{ app: string; status: AiConnectorStatus }> = [];
  const seen = new Set<string>();
  for (const s of servers ?? []) {
    const name = String(s?.name ?? "");
    if (!name.startsWith(CLAUDE_AI_SERVER_PREFIX)) continue;
    const app = name.slice(CLAUDE_AI_SERVER_PREFIX.length).trim();
    if (!APP_RE.test(app) || seen.has(app)) continue;
    seen.add(app);
    out.push({ app, status: normalizeAiConnectorStatus(s?.status) });
    if (out.length >= MAX_APPS) break;
  }
  return out;
}

/**
 * (순수) `claude mcp list` 출력 → 서버 목록. 한 줄 모양: `<이름>: <주소 또는 명령> - <기호> <상태>`.
 *  ⚠ 쌍둥이가 있다 — 수집 실행 러너(terminal/collect-run-script.ts COLLECT_RUNNER_JS 의 parseMcpList)가 컨테이너 안에서
 *   같은 출력을 읽는다. 그쪽은 컨테이너의 node 가 도는 문자열이라 이 함수를 import 하지 못한다. 모양을 바꾸면 둘 다 고친다.
 *   두 자리 모두 `--setting-sources project,local` 로 사용자 설정의 MCP 를 빼고 센다(확인 스크립트 probeScript 머리말).
 *   알려진 차이 — 러너 쪽은 « - » 로 가르지 않고 줄 나머지 전체를 보며 pending 을 내지 않는다(unknown 이 된다). 그 상태는
 *   normalizeAiConnectorStatus 를 다시 지나 이 표의 값으로 들어온다.
 *  주소·명령은 버린다(claude.ai 커넥터 주소는 그 사람 계정의 프록시 주소다 — 남길 이유가 없다).
 */
export function parseClaudeMcpList(text: string): Array<{ name: string; status: AiConnectorStatus }> {
  const out: Array<{ name: string; status: AiConnectorStatus }> = [];
  for (const line of String(text ?? "").split("\n")) {
    const i = line.indexOf(": ");
    if (i <= 0) continue;
    const name = line.slice(0, i).trim();
    if (!name || name.length > 120 || /\s{2,}/.test(name)) continue;
    //  상태는 마지막 « - » 뒤에 있다(명령 인자에 « - » 가 섞여도 마지막 것이 상태다). « - » 가 없는 줄은 서버 줄이 아니다
    //   (`Warning: …` 같은 안내 줄) — 세면 «목록이 비지 않았다» 판정이 거짓으로 선다.
    const rest = line.slice(i + 2);
    const dash = rest.lastIndexOf(" - ");
    if (dash < 0) continue;
    out.push({ name, status: normalizeAiConnectorStatus(rest.slice(dash + 3)) });
  }
  return out;
}

export interface MemberAiConnectorScanInput {
  memberId: string;
  provider?: AiConnectorProvider;
  origin: AiConnectorOrigin;
  /** 하네스가 본 MCP 서버 전체(로컬 MCP 가 섞여도 된다 — 여기서 claude.ai 만 고른다). null = 목록을 못 얻었다 · [] = 빈 전체 목록. */
  servers: ReadonlyArray<{ name?: unknown; status?: unknown }> | null;
  /** 목록을 못 얻은 사유(not-logged-in · no-cli · timeout …). servers 가 있으면 무시한다. */
  error?: string | null;
  /** 시험용 — 기본 지금. */
  at?: Date;
}

export interface MemberAiConnectorRow {
  app: string;
  status: AiConnectorStatus;
  origin: AiConnectorOrigin;
  first_seen_at: string;
  seen_at: string;
  status_at: string;
}

export interface MemberAiConnectorScan {
  scanned_at: string;
  origin: AiConnectorOrigin;
  ok: boolean;
  error: string | null;
  connected: number;
}

export interface MemberAiConnectorView {
  member_id: string;
  provider: AiConnectorProvider;
  /** 마지막 확인. null = 한 번도 안 재 봤다(«연결한 앱이 없다» 와 다르다). */
  scan: MemberAiConnectorScan | null;
  connectors: MemberAiConnectorRow[];
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v ?? ""));
const clip = (v: unknown, n: number): string | null => { const s = String(v ?? "").trim(); return s ? s.slice(0, n) : null; };

/**
 * 확인 실패 사유는 **정해진 모양의 코드**만 남긴다(not-logged-in · timeout · no-capacity …). 이 값은 구성원 누구나 보는
 *  표면(member_ai_connectors)에 그대로 실린다 — 러너의 자유 문장(stderr · 오류 메시지)에는 경로·계정 이름이 섞일 수 있다.
 *  모양 밖이면 «failed» 로 접는다.
 */
export const SCAN_ERROR_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export function scanErrorCode(v: unknown): string {
  const s = String(v ?? "").trim();
  return SCAN_ERROR_RE.test(s) ? s : "failed";
}

/**
 * 한 번의 확인을 적는다 — 확인 줄은 늘 갱신하고, 목록을 얻었을 때만 앱 줄을 맞춘다(머리말 «removed» 절).
 *  상태가 바뀐 줄만 status_at 을 옮긴다 — «언제부터 다시 로그인이 필요했나» 를 현황판이 말할 수 있게.
 *  관측 시각은 지금을 넘지 못한다 — 앞날 시각이 한 번 들어가면 그 뒤의 모든 확인이 «옛 관측» 으로 버려진다.
 *  돌려주는 값 = 적은 뒤의 그 사람 기록(listMemberAiConnectors 한 사람분).
 */
export async function recordMemberAiConnectors(input: MemberAiConnectorScanInput): Promise<MemberAiConnectorView> {
  const memberId = String(input.memberId || "").trim();
  if (!memberId) throw new Error("recordMemberAiConnectors: memberId 가 비었습니다");
  const provider: AiConnectorProvider = input.provider ?? "claude";
  const now = Date.now();
  const at = new Date(Math.min(input.at ? input.at.getTime() : now, now));
  const ok = Array.isArray(input.servers);
  const error = ok ? null : scanErrorCode(input.error ?? "no-list");
  const apps = ok ? claudeAiConnectorsOf(input.servers) : [];
  const connected = apps.filter((a) => a.status === "connected").length;
  const client = await itemsPool.connect();
  try {
    await client.query("BEGIN");
    //  늦게 도착한 옛 관측은 버린다 — 같은 수집 실행의 결과를 상태 읽기마다 다시 넘기거나(게이트웨이 재기동 뒤),
    //   확인(probe)이 그 뒤에 이미 새 값을 적었을 수 있다. 관측 시각(at)이 마지막 확인보다 앞서면 아무것도 바꾸지 않는다.
    const prev = await client.query(
      `SELECT scanned_at FROM member_ai_connector_scan WHERE member_id=$1 AND provider=$2 FOR UPDATE`, [memberId, provider]);
    const prevAt = prev.rows[0]?.scanned_at ? new Date(prev.rows[0].scanned_at as string | Date).getTime() : null;
    if (prevAt === null || prevAt <= at.getTime()) {
      // ON CONFLICT 타깃에 tenant_id — ensureTenantColumn 이 PK 를 (tenant_id, …) 로 재작성한다(session-apps 와 같은 규약).
      await client.query(
        `INSERT INTO member_ai_connector_scan(member_id, provider, scanned_at, origin, ok, error, connected)
           VALUES($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (tenant_id, member_id, provider) DO UPDATE SET
           scanned_at=EXCLUDED.scanned_at, origin=EXCLUDED.origin, ok=EXCLUDED.ok, error=EXCLUDED.error,
           connected=CASE WHEN EXCLUDED.ok THEN EXCLUDED.connected ELSE member_ai_connector_scan.connected END`,
        [memberId, provider, at, input.origin, ok, error, connected]);
      if (ok) {
        for (const a of apps) {
          await client.query(
            `INSERT INTO member_ai_connector(member_id, provider, app, status, origin, first_seen_at, seen_at, status_at)
               VALUES($1,$2,$3,$4,$5,$6,$6,$6)
             ON CONFLICT (tenant_id, member_id, provider, app) DO UPDATE SET
               status=EXCLUDED.status, origin=EXCLUDED.origin, seen_at=EXCLUDED.seen_at,
               status_at=CASE WHEN member_ai_connector.status = EXCLUDED.status THEN member_ai_connector.status_at ELSE EXCLUDED.seen_at END`,
            [memberId, provider, a.app, a.status, input.origin, at]);
        }
        //  이번 목록에 없는 앱 = claude.ai 에서 끊은 것. 줄은 지우지 않고 removed 로 내린다 — 언제 끊었는지가 남는다.
        await client.query(
          `UPDATE member_ai_connector SET status='removed', origin=$3, status_at=$4
            WHERE member_id=$1 AND provider=$2 AND status <> 'removed' AND NOT (app = ANY($5::text[]))`,
          [memberId, provider, input.origin, at, apps.map((a) => a.app)]);
      }
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
  const [view] = await listMemberAiConnectors({ memberId, provider, includeRemoved: true });
  return view ?? { member_id: memberId, provider, scan: null, connectors: [] };
}

/**
 * 기록 조회 — 사람마다 «마지막 확인 + 앱 줄». 확인 줄이나 앱 줄 중 하나라도 있는 사람만 나온다.
 *  includeRemoved 기본 false — 현황판·리브는 지금 연결된 것만 본다(끊은 이력은 명시로).
 *  app 은 대소문자를 가리지 않는다(사람·리브가 «slack» 으로 물어도 «Slack» 이 잡히게).
 *  비활성 구성원(org_member.state='inactive')은 뺀다 — 나간 사람이 «누가 무엇을 연결했나» 에 남지 않게. 줄은 지우지 않는다
 *   (다시 활성이 되면 그대로 보인다). FK 가 없어 조인이 아니라 NOT EXISTS 로 본다(schema/member-ai-connector.ts 머리말).
 */
export async function listMemberAiConnectors(filter: {
  memberId?: string | null; app?: string | null; provider?: AiConnectorProvider; includeRemoved?: boolean;
} = {}): Promise<MemberAiConnectorView[]> {
  const provider: AiConnectorProvider = filter.provider ?? "claude";
  const memberId = clip(filter.memberId, 128);
  const app = clip(filter.app, 64);
  const active = (alias: string): string =>
    `NOT EXISTS (SELECT 1 FROM org_member m WHERE m.id = ${alias}.member_id AND m.state = 'inactive')`;
  const scanRows = (await itemsPool.query(
    `SELECT s.member_id, s.scanned_at, s.origin, s.ok, s.error, s.connected FROM member_ai_connector_scan s
      WHERE s.provider=$1 AND ($2::text IS NULL OR s.member_id=$2) AND ${active("s")} ORDER BY s.member_id`,
    [provider, memberId])).rows;
  const appRows = (await itemsPool.query(
    `SELECT c.member_id, c.app, c.status, c.origin, c.first_seen_at, c.seen_at, c.status_at FROM member_ai_connector c
      WHERE c.provider=$1 AND ($2::text IS NULL OR c.member_id=$2) AND ($3::text IS NULL OR lower(c.app)=lower($3))
        AND ($4::boolean OR c.status <> 'removed') AND ${active("c")}
      ORDER BY c.member_id, c.app`,
    [provider, memberId, app, !!filter.includeRemoved])).rows;
  const byMember = new Map<string, MemberAiConnectorView>();
  const viewOf = (id: string): MemberAiConnectorView => {
    let v = byMember.get(id);
    if (!v) { v = { member_id: id, provider, scan: null, connectors: [] }; byMember.set(id, v); }
    return v;
  };
  //  앱으로 거르면 그 앱 줄이 있는 사람만 — 확인 줄만 있는 사람은 «그 앱이 없다» 이므로 빠진다.
  if (!app) for (const r of scanRows) viewOf(String(r.member_id));
  for (const r of appRows) {
    viewOf(String(r.member_id)).connectors.push({
      //  값은 표의 CHECK 가 이미 좁혔다(normalize 를 다시 태우면 'removed' 가 'unknown' 으로 접힌다).
      app: String(r.app), status: r.status as AiConnectorStatus, origin: r.origin as AiConnectorOrigin, first_seen_at: iso(r.first_seen_at), seen_at: iso(r.seen_at), status_at: iso(r.status_at),
    });
  }
  for (const r of scanRows) {
    const v = byMember.get(String(r.member_id));
    if (v) v.scan = { scanned_at: iso(r.scanned_at), origin: r.origin as AiConnectorOrigin, ok: !!r.ok, error: r.error == null ? null : String(r.error), connected: Number(r.connected) || 0 };
  }
  return [...byMember.values()];
}

/**
 * (순수) 수집 실행(T11)의 결과 → 기록에 넘길 목록. 러너 summary.json 의 `servers`(`claude mcp list` 전부)를 먼저 보고,
 *  없으면 init 의 mcp_servers 를 본다. 목록으로 못 쓰면 servers=null 과 사유 코드.
 *  · skip — 러너가 목록 단계에 닿지 못했다(요약 없음 · claude 버전도 못 잼 = 실행이 잃었거나 그 전에 죽었다). 그건 «커넥터 확인» 이
 *    아니라 «실행 실패» 라 그 사람의 확인 줄을 덮지 않는다(덮으면 방금 성공한 확인의 결과가 실행 실패 사유로 바뀐다).
 *  · ★ claude.ai 커넥터가 **하나도 없다** = 실패로 본다(확정판 §8-5 — 헤드리스에서 커넥터가 빠지는 회귀가 3월에 있었고,
 *    로그인이 풀려도 같은 모양이다). 수집 실행은 커넥터가 있는 담당자에게만 띄우므로 0개는 «끊었다» 가 아니다 —
 *    그대로 적으면 그 사람의 앱 줄이 전부 removed 가 된다. 진짜 «다 끊었다» 는 게이트웨이 확인(로그인부터 본다)이 적는다.
 *  · 사유는 코드로만 — 러너의 자유 문장은 싣지 않는다(SCAN_ERROR_RE 머리말).
 */
export function collectSummaryScan(summary: Record<string, unknown> | null, exit: Record<string, unknown> | null):
  { skip: true } | { skip: false; servers: Array<{ name?: unknown; status?: unknown }> | null; error: string | null } {
  const claude = (summary?.claude ?? null) as { version?: unknown } | null;
  if (!claude?.version) return { skip: true };
  const fromList = Array.isArray(summary?.servers) ? summary!.servers as Array<{ name?: unknown; status?: unknown }> : [];
  const init = summary?.init as { mcp?: unknown } | null | undefined;
  const fromInit = Array.isArray(init?.mcp) ? init!.mcp as Array<{ name?: unknown; status?: unknown }> : [];
  const servers = fromList.length ? fromList : fromInit;
  const runErr = String(exit?.error ?? "");
  const why = runErr === "no-connector" ? "no-connector" : runErr === "timeout" ? "timeout" : runErr ? "collect-failed" : null;
  if (!servers.length) return { skip: false, servers: null, error: why ?? "collect-no-list" };
  if (!claudeAiConnectorsOf(servers).length) return { skip: false, servers: null, error: why ?? "no-claude-ai-connectors" };
  return { skip: false, servers, error: null };
}

/**
 * 수집 실행(T11)이 끝났을 때 부른다 — collectSummaryScan 으로 고른 목록을 적는다.
 *  관측 시각 = 그 실행이 시작한 때(실행 id 에 박힌 시각 — collect-run.ts 가 넘긴다. 목록은 시작 직후에 잰다).
 *   같은 실행을 몇 번 넘겨도 같은 시각이라 옛 관측 가드가 뒤집지 않는다. 시각을 모르면 적지 않는다 — «지금» 으로 적으면
 *   잃은 실행을 읽을 때마다 더 새 확인을 덮는다.
 *  ⚠ 실패해도 던지지 않는다 — 수집 실행의 뒷정리(세션 내리기)를 막으면 안 된다. 경고만 남긴다.
 */
export async function recordFromCollectSummary(memberId: string, summary: Record<string, unknown> | null,
  exit: Record<string, unknown> | null, startedAtMs: number | null): Promise<void> {
  try {
    const scan = collectSummaryScan(summary, exit);
    if (scan.skip || startedAtMs == null || !Number.isFinite(startedAtMs)) return;
    await recordMemberAiConnectors({ memberId, origin: "collect", servers: scan.servers, error: scan.error, at: new Date(startedAtMs) });
  } catch (e) {
    logger.warn({ memberId, err: (e as Error)?.message }, "수집 실행의 커넥터 기록 실패 — 수집 뒷정리는 계속한다(#4427)");
  }
}

// ── 워크스페이스 정책 한 칸 — org_runtime_config.allow_member_ai_connectors ─────────────────
//  app_bundle_policy 와 같은 «한 칸 전용 입구» 다: getRuntimeConfig 의 큰 SELECT·org_runtime_update 에 섞지 않는다
//  (그 입구는 보안 필드와 묶여 있고, 이 칸만 바꾸려는 관리자 도구가 다른 칸을 흔들지 않게).

/** 정책 읽기 결과 — unknown = 못 읽었다(DB 오류 · 컨텍스트 없음). */
export type MemberAiConnectorsPolicy = "allowed" | "blocked" | "unknown";

/**
 * 이 워크스페이스가 구성원 AI 계정 커넥터를 쓰나 — 세 갈래. 못 읽으면 unknown 이고, **집행하는 자리는 unknown 을 막음으로 읽는다**
 *  (CONTRIBUTING «보안 관련 기본값은 fail-closed» — 끈 워크스페이스가 DB 가 잠깐 막힌 사이에 연 세션이 그 수명 내내 claude.ai
 *  커넥터를 들고 가는 일이 없게). 허용이 기본인 워크스페이스가 치르는 값은 «그 사이 연 세션에 커넥터가 안 실린다» 뿐이다.
 */
export async function memberAiConnectorsPolicy(): Promise<MemberAiConnectorsPolicy> {
  try {
    const r = await itemsPool.query(`SELECT allow_member_ai_connectors FROM org_runtime_config WHERE id=1`);
    return r.rows[0]?.allow_member_ai_connectors === false ? "blocked" : "allowed";
  } catch (err) {
    logger.error({ err: String(err) }, "구성원 AI 계정 커넥터 정책을 읽지 못했다 — 막음으로 본다(fail-closed, #4427)");
    return "unknown";
  }
}

/** 허용으로 확인됐을 때만 true(못 읽음 = false — fail-closed). 안내문 조립·수집 실행 판정이 쓴다. */
export async function memberAiConnectorsAllowed(): Promise<boolean> {
  return (await memberAiConnectorsPolicy()) === "allowed";
}

/** 관리자가 정책을 바꾼다. 이 칸만 쓴다. 감사에 남긴다. 돌려주는 값 = 바뀌었나. 지금 값을 못 읽으면 던진다(못 읽음을 «같은 값» 으로 접지 않는다). */
export async function setMemberAiConnectorsAllowed(allowed: boolean, ctx: WriteCtx = {}): Promise<boolean> {
  const r = await itemsPool.query(`SELECT allow_member_ai_connectors FROM org_runtime_config WHERE id=1`);
  const before = r.rows[0]?.allow_member_ai_connectors !== false;
  if (before === allowed) return false;
  await itemsPool.query(`UPDATE org_runtime_config SET allow_member_ai_connectors=$1 WHERE id=1`, [allowed]);
  await audit("org_runtime_config", "1", "allow_member_ai_connectors", before, allowed, ctx.actor, ctx.source);
  return true;
}
