// #1291 v4 — 커넥터별 자료 공개범위 정책 관리(관리탭). 규칙 CRUD + 기존 자료 소급 적용(백필).
//
//  왜 백필이 필요한가: 정책은 **태어날 때** 적용된다(스탬핑). 그런데 정책을 세우는 시점엔 이미 수집된 자료가
//  수천 건 쌓여 있다(어니스트 슬랙 1만건 규모). 백필이 없으면 "정책을 켰는데 옛 자료는 그대로 공개"라
//  기능이 절반만 동작한다. 반대로 백필을 자동으로 돌리지도 않는다 — 수천 건의 공개범위를 바꾸는 일은
//  사람이 의도해서 눌러야 한다.
import { z } from "zod";
import { HttpError } from "../http-error.js";
import type { Capability } from "./types.js";
import { itemsPool } from "../items/store.js";
import {
  sourceVisRules, invalidateSourceVisRules, pickRule, applyVisibility,
} from "../v6/source-vis-policy.js";
import { axisOn } from "../v6/visibility-axes.js";
import { effectiveViewer } from "../v6/visibility.js";

const MEMBERS = z.array(z.object({
  subject_kind: z.enum(["member", "team"]).optional(),
  member_id: z.string().min(1),
})).max(500);


/**
 * 이 사람이 그 규칙의 현재 대상인가 — **정책 편집 = 권한 편집**이라 필요한 판정.
 *  잠긴 채널의 정책을 고쳐 자기를 대상에 넣으면 못 보던 내용을 보게 된다(셀프가입).
 *  v2 에서 팀 편집에 같은 이유로 건 제약과 같은 것이다.
 */
async function inAudience(editor: string, members: Array<{ subject_kind: string; member_id: string }>): Promise<boolean> {
  if (members.some((m) => m.subject_kind === "member" && m.member_id === editor)) return true;
  const teams = members.filter((m) => m.subject_kind === "team").map((m) => m.member_id);
  if (!teams.length) return false;
  const { rows } = await itemsPool.query(
    `SELECT 1 FROM team_member WHERE member_id=$1 AND team_id::text = ANY($2::text[]) LIMIT 1`, [editor, teams]);
  return rows.length > 0;
}

/**
 * 정책 변경이 **넓히는 방향**인지 — 넓히면 그 자료를 이미 볼 수 있는 사람만 할 수 있다.
 *  좁히는 변경(대상 부분집합, open→members)은 새로 얻는 게 없으므로 누구나(admin) 가능하다.
 */
function widens(cur: { visibility: string; members: Array<{ subject_kind: string; member_id: string }> },
                next: { visibility: string; members: Array<{ subject_kind: string; member_id: string }> }): boolean {
  if (cur.visibility !== "members") return false;      // 아직 안 잠김 = 모두가 봄 = 넓힐 것이 없다
  if (next.visibility !== "members") return true;      // members → open = 전원 공개, 가장 넓힘
  const curSet = new Set(cur.members.map((m) => `${m.subject_kind}:${m.member_id}`));
  return next.members.some((m) => !curSet.has(`${m.subject_kind}:${m.member_id}`));   // 대상 추가 = 넓힘
}

const listPolicies: Capability = {
  name: "source_vis_policy_list",
  title: "자료 공개범위 정책 목록",
  description:
    "커넥터(+채널)별 자료 공개범위 규칙을 돌려준다. 수집되는 자료가 태어날 때 이 규칙으로 공개범위가 정해진다. " +
    "채널을 지정한 규칙이 커넥터 전체 규칙보다 우선한다.",
  scope: "admin",
  input: {},
  expose: { mcp: true, rest: [{ method: "GET", paths: ["/api/ui/source-vis-policy"], parse: () => ({}) }] },
  handler: async () => ({
    axis_on: await axisOn("source"),
    rules: await sourceVisRules().catch(() => []),
  }),
};

const setPolicy: Capability = {
  name: "source_vis_policy_set",
  title: "자료 공개범위 정책 저장",
  description:
    "커넥터별 자료 공개범위 규칙을 만들거나 고친다. match_system=커넥터(slack·gmail·discord…), " +
    "match_channel=채널(생략하면 그 커넥터 전체). visibility='members' 면 members 에 지정한 대상만 그 자료를 볼 수 있다. " +
    "⚠ 이 규칙은 **앞으로 수집되는 자료**에 적용된다 — 이미 쌓인 자료에도 적용하려면 source_vis_policy_backfill.",
  scope: "admin",
  input: {
    id: z.number().int().positive().optional().describe("주면 그 규칙 수정, 없으면 신규"),
    match_system: z.string().min(1),
    match_channel: z.string().optional().describe("채널/컨테이너 이름 또는 id — 생략하면 커넥터 전체"),
    visibility: z.enum(["open", "members"]),
    members: MEMBERS.optional(),
    priority: z.number().int().optional(),
    enabled: z.boolean().optional(),
    note: z.string().max(500).optional(),
  },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/source-vis-policy"], parse: (req) => (req.body ?? {}) }],
  },
  handler: async (input: any, user: any) => {
    const members = (input.members ?? []).map((m: any) => ({
      subject_kind: m.subject_kind === "team" ? "team" : "member", member_id: String(m.member_id),
    }));
    // 잠그는데 대상이 없으면 그 커넥터의 자료를 아무도 못 보게 된다 — 실수로 그렇게 되는 걸 막는다.
    //  (의도적으로 전면 차단하려면 커넥터를 끄는 게 맞다.)
    if (input.visibility === "members" && !members.length) {
      throw new HttpError(400, "대상이 비어 있습니다 — 이 규칙이 적용되면 그 자료를 아무도 볼 수 없게 됩니다. 대상을 지정하거나 커넥터를 끄세요.");
    }
    // ⚠ 정책 편집 = 권한 편집(#1291 v4). 이미 잠긴 규칙을 **넓히려면** 그 자료를 볼 수 있는 사람이어야 한다 —
    //  아니면 admin 이 자기를 대상에 끼워 넣어 못 보던 내용을 보게 된다(셀프가입). 좁히는 변경은 자유다.
    //  긴급열람 중이면 통과한다(사유·통지·감사가 남는 정당한 복구 경로 — 대상자 전원 퇴사 같은 경우).
    if (input.id) {
      const cur = (await sourceVisRules()).find((r) => r.id === Number(input.id));
      if (cur && widens(cur, { visibility: input.visibility, members })) {
        const editor = user?.userId ?? "";
        const eff = await effectiveViewer(editor);
        const privileged = eff === null;   // 전체 스코프 긴급열람
        if (!privileged && !(await inAudience(editor, cur.members))) {
          throw new HttpError(403,
            "이 규칙의 대상을 넓히려면 그 자료를 볼 수 있어야 합니다 — 지금 대상이 아니면 좁히는 변경만 가능합니다. " +
            "정당한 사유가 있으면 긴급 열람(vis_break_glass_start)을 열고 다시 시도하세요.");
        }
      }
    }
    const row = input.id
      ? await itemsPool.query(
          `UPDATE org_source_vis_policy SET match_system=$2, match_channel=$3, visibility=$4,
                  priority=COALESCE($5, priority), enabled=COALESCE($6, enabled), note=$7,
                  updated_at=now(), updated_by=$8
            WHERE id=$1 RETURNING id`,
          [input.id, input.match_system, input.match_channel ?? null, input.visibility,
           input.priority ?? null, input.enabled ?? null, input.note ?? null, user?.userId ?? null])
      : await itemsPool.query(
          `INSERT INTO org_source_vis_policy(match_system, match_channel, visibility, priority, enabled, note, created_by, updated_by)
           VALUES($1,$2,$3,COALESCE($4,0),COALESCE($5,true),$6,$7,$7) RETURNING id`,
          [input.match_system, input.match_channel ?? null, input.visibility,
           input.priority ?? null, input.enabled ?? null, input.note ?? null, user?.userId ?? null]);
    const id = Number(row.rows[0]?.id);
    if (!id) throw new HttpError(404, "규칙을 찾을 수 없습니다");
    await itemsPool.query(`DELETE FROM org_source_vis_policy_member WHERE policy_id=$1`, [id]);
    if (members.length) {
      await itemsPool.query(
        `INSERT INTO org_source_vis_policy_member(policy_id, subject_kind, member_id)
         SELECT $1, k, m FROM unnest($2::text[], $3::text[]) AS t(k, m) ON CONFLICT DO NOTHING`,
        [id, members.map((m: any) => m.subject_kind), members.map((m: any) => m.member_id)]);
    }
    invalidateSourceVisRules();
    return { id, rules: await sourceVisRules() };
  },
};

const deletePolicy: Capability = {
  name: "source_vis_policy_delete",
  title: "자료 공개범위 정책 삭제",
  description: "규칙을 지운다. ⚠ 그 규칙으로 **이미 잠긴 자료의 공개범위는 그대로 남는다**(앞으로 수집되는 것만 달라진다) — 되돌리려면 backfill 로 다시 적용하세요.",
  scope: "admin",
  input: { id: z.number().int().positive() },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/source-vis-policy/delete"], parse: (req) => ({ id: Number((req.body as any)?.id) }) }],
  },
  handler: async (input: any) => {
    await itemsPool.query(`DELETE FROM org_source_vis_policy WHERE id=$1`, [input.id]);
    invalidateSourceVisRules();
    return { deleted: true, rules: await sourceVisRules() };
  },
};

const backfill: Capability = {
  name: "source_vis_policy_backfill",
  title: "자료 공개범위 정책 소급 적용",
  description:
    "지금 정책을 **이미 수집된 자료**에 적용한다. 정책은 원래 자료가 태어날 때만 적용되므로, 정책을 새로 세웠다면 " +
    "이걸로 과거분을 맞춘다. dry_run=true(기본)면 **무엇이 몇 건 바뀌는지만** 돌려주고 실제로 바꾸지 않는다. " +
    "⚠ 되돌리기 어려운 대량 변경이라 실제 적용은 dry_run=false 로 명시해야 한다.",
  scope: "admin",
  input: {
    system: z.string().optional().describe("이 커넥터만(생략하면 규칙이 있는 전 커넥터)"),
    dry_run: z.boolean().optional(),
    limit: z.number().int().min(1).max(50_000).optional(),
  },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/source-vis-policy/backfill"], parse: (req) => (req.body ?? {}) }],
  },
  handler: async (input: any) => {
    if (!(await axisOn("source"))) {
      throw new HttpError(400, "자료 공개범위 축이 꺼져 있습니다 — 관리탭 ▸ 맥락 공개범위에서 먼저 켜세요(꺼진 채로 잠그면 강제되지 않습니다).");
    }
    const rules = await sourceVisRules();
    if (!rules.length) throw new HttpError(400, "적용할 규칙이 없습니다");
    const systems = input.system ? [String(input.system)] : [...new Set(rules.map((r) => r.match_system))];
    const limit = Math.min(Number(input.limit ?? 20_000), 50_000);
    const dry = input.dry_run !== false;   // 기본은 미리보기 — 대량 변경은 명시적으로만

    const { rows } = await itemsPool.query(
      `SELECT id, external_system, visibility,
              fields->>'container_ref' AS c_ref, fields->>'container_name' AS c_name
         FROM source
        WHERE external_system = ANY($1::text[])
        ORDER BY id DESC LIMIT $2`, [systems, limit]);

    let toLock = 0, already = 0, noRule = 0;
    const samples: string[] = [];
    for (const r of rows as any[]) {
      const picked = pickRule(rules, String(r.external_system), [r.c_ref, r.c_name]);
      if (picked.visibility !== "members") { noRule++; continue; }
      if (r.visibility === "members") { already++; continue; }
      toLock++;
      if (samples.length < 5) samples.push(`#${r.id} ${r.c_name || r.c_ref || ""}`.trim());
      if (!dry) await applyVisibility(itemsPool as any, Number(r.id), picked.members);
    }
    return {
      dry_run: dry, scanned: rows.length, systems,
      locked: toLock, already_locked: already, no_rule: noRule, samples,
      note: dry ? "미리보기입니다 — 실제로 적용하려면 dry_run:false 로 다시 부르세요." : undefined,
    };
  },
};

export const sourceVisPolicyCapabilities: Capability[] = [listPolicies, setPolicy, deletePolicy, backfill];
