// ⚠ Lively Enterprise Edition — 이 디렉터리(src/ee)는 상용 라이센스다. src/ee/LICENSE 참조.
//   유효한 구독 없이 프로덕션에서 사용할 수 없다(열람·개발·테스트는 허용).
//
// 긴급 열람(break-glass, #1291 v2) — admin 이 공개범위를 넘는 **유일한 문**.
//
//  왜 이 문이 필요한가: v2 에서 admin 우회를 없앴다(admin 신원을 물려받은 AI 자동화가 잠긴 내용을 읽어
//  공개 지식으로 되뱉는 걸 막기 위해). 그런데 그것만 하면 퇴사자 인수인계·장애 대응·법적 요구에서 운영이 막힌다.
//  그래서 **열람 자체를 막는 대신 '흔적 없는 열람'을 막는다** — 사유를 적어야 열리고, 감사에 남고, 대상자가 알게 된다.
//  (Slack 의 컴플라이언스 익스포트가 법적 근거를 요구하는 것과 같은 자리. 우리는 그걸 조직 안에서 처리한다.)
import { z } from "zod";
import { HttpError } from "../../capabilities/rest-util.js";
import type { Capability } from "../../capabilities/types.js";
import { itemsPool } from "../../db/client.js";
import { q, one } from "../../db/client.js";
import { invalidateBreakGlass } from "../../v6/visibility.js";
import { logActivity } from "../../activity/store.js";

const MAX_MINUTES = 24 * 60;      // 하루를 넘기면 그건 '긴급'이 아니라 상시 권한이다
const DEFAULT_MINUTES = 30;

function requireAdmin(user: { scopes?: string[] } | undefined): void {
  if (!user?.scopes?.includes("admin")) throw new HttpError(403, "긴급 열람은 관리자만 열 수 있습니다");
}

const breakGlassStart: Capability = {
  name: "vis_break_glass_start",
  title: "긴급 열람 시작",
  description:
    "공개범위가 걸린 맥락을 **한시적으로** 열어 본다(관리자 전용). 사유가 필수이고, 시작 사실이 작업기록에 남아 대상자가 볼 수 있다. "
    + "list_id 를 주면 그 리스트에만 열리고, 안 주면 전체. 기본 30분·최대 24시간.",
  scope: "admin",
  input: {
    reason: z.string().min(5).max(500).describe("왜 열어야 하는가 — 나중에 사람이 읽고 판단할 수 있게 구체적으로"),
    minutes: z.number().int().min(1).max(MAX_MINUTES).optional(),
    list_id: z.number().int().positive().optional().describe("이 리스트에만 한정(생략 시 전체)"),
  },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/vis/break-glass"], parse: (req) => (req.body ?? {}) }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    requireAdmin(user);
    const me = ctx?.actor ?? user?.userId ?? null;
    if (!me) throw new HttpError(401, "로그인이 필요합니다");
    const reason = String(input.reason ?? "").trim();
    if (reason.length < 5) throw new HttpError(400, "사유를 적어 주세요 — 나중에 사람이 읽고 판단할 수 있게");
    const minutes = Math.min(Math.max(Number(input.minutes) || DEFAULT_MINUTES, 1), MAX_MINUTES);
    const scopeKind = input.list_id != null ? "project_list" : null;
    const scopeId = input.list_id != null ? String(input.list_id) : null;

    const row: any = await one(itemsPool, `
      INSERT INTO vis_break_glass(member_id, reason, scope_kind, scope_id, expires_at)
      VALUES($1,$2,$3,$4, now() + ($5 || ' minutes')::interval)
      RETURNING id, started_at, expires_at`, [me, reason, scopeKind, scopeId, String(minutes)]);
    invalidateBreakGlass();

    // 통지 = 작업기록. 잠긴 리스트에 한정해 열었으면 그 프로젝트 타임라인에도 뜨도록 project_id 를 달아 준다.
    //  (별도 알림 채널을 새로 만들지 않는다 — 이미 모두가 보는 자리에 남기는 게 통지로서 더 확실하다.)
    await logActivity({
      type: "decision",
      title: `긴급 열람 시작 — ${scopeKind ? `리스트 #${scopeId}` : "전체"} (${minutes}분)`,
      summary: "공개범위 - 긴급 열람",
      body: `사유: ${reason}\n\n관리자 ${me} 가 공개범위가 걸린 맥락을 ${minutes}분 동안 열람합니다. 만료: ${row?.expires_at}`,
    }, me).catch(() => { /* 통지 실패가 열람을 막지는 않되, 아래 감사 기록은 이미 남았다 */ });

    return { id: row?.id, started_at: row?.started_at, expires_at: row?.expires_at, scope: scopeKind ?? "all", minutes };
  },
};

const breakGlassEnd: Capability = {
  name: "vis_break_glass_end",
  title: "긴급 열람 종료",
  description: "열어 둔 긴급 열람을 지금 닫는다(만료를 기다리지 않고). id 를 주면 그 건만, 없으면 내가 연 것 전부.",
  scope: "admin",
  input: { id: z.number().int().positive().optional() },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/vis/break-glass/end"], parse: (req) => (req.body ?? {}) }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    requireAdmin(user);
    const me = ctx?.actor ?? user?.userId ?? null;
    const res = input.id
      ? await itemsPool.query(`UPDATE vis_break_glass SET ended_at=now() WHERE id=$1 AND member_id=$2 AND ended_at IS NULL`, [input.id, me])
      : await itemsPool.query(`UPDATE vis_break_glass SET ended_at=now() WHERE member_id=$1 AND ended_at IS NULL`, [me]);
    invalidateBreakGlass();
    return { ended: res.rowCount ?? 0 };
  },
};

const breakGlassList: Capability = {
  name: "vis_break_glass_list",
  title: "긴급 열람 이력",
  description: "누가 언제 왜 열었는지 — 활성 건과 지난 건. 관리자 전용(감사용).",
  scope: "admin",
  input: { limit: z.number().int().min(1).max(200).optional() },
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/vis/break-glass"], parse: (req) => ({ limit: req.query?.limit ? Number(req.query.limit) : undefined }) }],
  },
  handler: async (input: any, user: any) => {
    requireAdmin(user);
    const rows = await q(itemsPool, `
      SELECT b.id, b.member_id, m.display_name, b.reason, b.scope_kind, b.scope_id,
             b.started_at, b.expires_at, b.ended_at,
             (b.ended_at IS NULL AND b.expires_at > now()) AS active
        FROM vis_break_glass b LEFT JOIN org_member m ON m.id = b.member_id
       ORDER BY b.started_at DESC LIMIT $1`, [Math.min(Number(input.limit) || 50, 200)]);
    return { entries: rows };
  },
};

export const breakGlassCapabilities: Capability[] = [breakGlassStart, breakGlassEnd, breakGlassList];
