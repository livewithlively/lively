// delivery ▸ managers — 관리기 CRUD·발견 큐·지금 실행(#1419 T5).
//
//  ⚠ org_manager_finding_report 는 **AI 가 쓰는 도구**다(모순·코드괴리 판정 배치가 결과를 되돌려 적는 경로).
//   나머지는 사람 화면용. 둘을 같은 파일에 두되 성격이 다름을 명시한다.
import type { Capability } from "../types.js";
import { z } from "zod";
import { HttpError } from "../rest-util.js";
import type { LivelyUser } from "../../context.js";
import {
  listManagers, getManager, upsertManager, removeManager,
  listFindings, resolveFinding, upsertFinding, managerOverview, applyFindings,
  MANAGER_KIND_LABEL, type ManagerKind,
} from "../../org/store/managers.js";
import { runManagerByRef, applyAction } from "../../org/manage/run-manager.js";
import { itemsPool } from "../../db/client.js";
import { actorOf, restWork, str } from "./shared.js";

export const managersCapabilities: Capability[] = [
  restWork("org_manager_list", "관리기 목록",
    "등록된 관리기 + 종류별 현황(열린 발견 수). 4종: mismatch(분류 어긋남) · outdated(지식 아웃데이티드) · " +
    "contradiction(지식 간 모순) · code_drift(지식↔코드 괴리). 앞의 둘은 결정적 SQL 판정이라 LLM 비용이 없고, " +
    "뒤의 둘은 후보를 좁혀 AI 가 판정한다.",
    [{ method: "GET", paths: ["/api/ui/org/managers"], parse: () => ({}) }],
    async () => ({ managers: await listManagers(), overview: await managerOverview(), kinds: MANAGER_KIND_LABEL })),

  restWork("org_manager_upsert", "관리기 저장",
    "관리기를 만들거나 고친다. kind(종류) · 스코프 · 민감도(threshold/stale_days) · action_level(report|propose|auto) 을 정한다. " +
    "⚠ kind 는 만든 뒤 바꿀 수 없다(판정 기준과 발견 형태가 통째로 달라 기존 발견이 섞인다) — 새로 만들고 옛것을 지워라. " +
    "action_level 기본이 report 인 이유: 관리기는 이미 사람이 정리해 둔 것을 건드리므로 오탐 한 번의 반경이 크다.",
    [{ method: "POST", paths: ["/api/ui/org/managers"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const manager = await upsertManager({
        id: input.id === undefined || input.id === null ? undefined : Number(input.id),
        key: input.key === undefined ? undefined : str(input.key, "key", 64),
        label: input.label === undefined ? undefined : (input.label === null || input.label === "" ? null : str(input.label, "label", 200)),
        kind: input.kind === undefined ? undefined : (str(input.kind, "kind", 20) as ManagerKind),
        enabled: input.enabled === undefined ? undefined : Boolean(input.enabled),
        priority: input.priority === undefined ? undefined : Number(input.priority),
        match_spaces: input.match_spaces, match_categories: input.match_categories,
        match_types: input.match_types, exclude_names: input.exclude_names,
        match_provenance: input.match_provenance === undefined ? undefined : (input.match_provenance === null || input.match_provenance === "" ? null : str(input.match_provenance, "match_provenance", 20)),
        lookback_days: input.lookback_days === undefined ? undefined : (input.lookback_days === null || input.lookback_days === "" ? null : Number(input.lookback_days)),
        threshold: input.threshold === undefined ? undefined : (input.threshold === null ? null : Number(input.threshold)),
        stale_days: input.stale_days === undefined ? undefined : (input.stale_days === null ? null : Number(input.stale_days)),
        action_level: input.action_level === undefined ? undefined : str(input.action_level, "action_level", 20),
        criteria_md: input.criteria_md === undefined ? undefined : (input.criteria_md === null || input.criteria_md === "" ? null : String(input.criteria_md).slice(0, 20_000)),
        batch_size: input.batch_size === undefined ? undefined : Number(input.batch_size),
        model: input.model === undefined ? undefined : (input.model === null || input.model === "" ? null : str(input.model, "model", 40)),
        effort: input.effort === undefined ? undefined : (input.effort === null || input.effort === "" ? null : str(input.effort, "effort", 20)),
        requester: input.requester === undefined ? undefined : (input.requester === null || input.requester === "" ? null : str(input.requester, "requester", 200)),
        note: input.note === undefined ? undefined : (input.note === null || input.note === "" ? null : str(input.note, "note", 2000)),
      }, actorOf(user), "web");
      return { manager };
    }, {
      id: z.number().int().positive().optional(),
      key: z.string().optional(),
      label: z.string().nullable().optional(),
      kind: z.enum(["mismatch", "outdated", "contradiction", "code_drift"]).optional().describe("생성 시 필수 · 이후 변경 불가"),
      enabled: z.boolean().optional(),
      priority: z.number().int().optional(),
      match_spaces: z.array(z.string()).or(z.string()).nullable().optional(),
      match_categories: z.array(z.string()).or(z.string()).nullable().optional(),
      match_types: z.array(z.string()).or(z.string()).nullable().optional(),
      match_provenance: z.string().nullable().optional(),
      exclude_names: z.array(z.string()).or(z.string()).nullable().optional(),
      lookback_days: z.number().int().positive().nullable().optional(),
      threshold: z.number().nullable().optional().describe("mismatch=정의 거리 마진(기본 0.1) · contradiction=후보 유사도(기본 0.85)"),
      stale_days: z.number().int().positive().nullable().optional().describe("outdated=자료가 지식보다 며칠 앞서면 문제로 볼지(기본 30)"),
      action_level: z.enum(["report", "propose", "auto"]).optional().describe("report=쌓기만(기본) · propose=조치안 제시 · auto=즉시 적용(되돌릴 수 있는 조치만)"),
      criteria_md: z.string().nullable().optional().describe("판단 기준(자유서술) — 모순·코드괴리 프롬프트에 삽입된다"),
      batch_size: z.number().int().min(1).max(200).optional(),
      model: z.string().nullable().optional(), effort: z.string().nullable().optional(),
      requester: z.string().nullable().optional(),
      note: z.string().nullable().optional(),
    }),

  restWork("org_manager_run", "관리기 지금 실행",
    "관리기를 즉시 실행한다. 결정적 종류(mismatch·outdated)는 이 호출 안에서 판정·저장까지 끝난다. " +
    "판단이 필요한 종류(contradiction·code_drift)는 크론에서 실행해야 한다(헤드리스 배치 접수가 필요).",
    [{ method: "POST", paths: ["/api/ui/org/managers/run"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>) => {
      const ref = input.id ? Number(input.id) : (input.key ? String(input.key) : "");
      if (!ref) throw new HttpError(400, "관리기 key 또는 id 가 필요합니다");
      return await runManagerByRef(ref);
    }, {
      id: z.number().int().positive().optional(), key: z.string().optional(),
    }),

  restWork("org_manager_findings", "관리기 발견 목록",
    "관리기가 낸 발견(할 일 큐). 기본은 열린 것만, 심각도·최근 발견 순. 같은 문제는 한 행이고 재발견은 seen_count 만 오른다 " +
    "— 그래서 사람이 반려한 것이 다음 주기에 새 항목으로 되살아나지 않는다.",
    [{ method: "GET", paths: ["/api/ui/org/manager-findings"], parse: (req) => ({
      manager_id: req.query?.manager_id ? Number(req.query.manager_id) : undefined,
      kind: req.query?.kind ? String(req.query.kind) : undefined,
      state: req.query?.state ? String(req.query.state) : undefined,
      severity: req.query?.severity ? String(req.query.severity) : undefined,
      limit: req.query?.limit ? Number(req.query.limit) : undefined,
      offset: req.query?.offset ? Number(req.query.offset) : undefined,
    }) }],
    async (input: Record<string, unknown>) => ({
      findings: await listFindings({
        managerId: input.manager_id ? Number(input.manager_id) : undefined,
        kind: input.kind ? String(input.kind) : undefined,
        state: input.state ? String(input.state) : undefined,
        severity: input.severity ? String(input.severity) : undefined,
        limit: input.limit ? Number(input.limit) : undefined,
        offset: input.offset ? Number(input.offset) : undefined,
      }),
    }), {
      manager_id: z.number().int().positive().optional(),
      kind: z.enum(["mismatch", "outdated", "contradiction", "code_drift"]).optional(),
      state: z.enum(["open", "accepted", "rejected", "resolved"]).optional().describe("기본 open — 큐는 '할 일'이지 이력이 아니다"),
      severity: z.enum(["note", "warn", "high"]).optional(),
      limit: z.number().int().min(1).max(500).optional(), offset: z.number().int().min(0).optional(),
    }),

  restWork("org_manager_finding_resolve", "발견 처리(승인·반려·해결)",
    "발견을 닫는다. accepted=조치안을 적용하고 닫음 · rejected=오탐(다음 주기에 되살아나지 않는다) · resolved=사람이 직접 고침. " +
    "apply=true 면 accepted 시 조치안(예: 분류 이동)을 실제로 적용한다 — 되돌릴 수 있는 조치만 수행된다.",
    [{ method: "POST", paths: ["/api/ui/org/manager-findings/:id/resolve"], parse: (req) => ({
      id: Number((req.params as Record<string, string>)?.id), ...(req.body as object ?? {}),
    }) }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const id = Number(input.id);
      if (!Number.isFinite(id) || id <= 0) throw new HttpError(400, "발견 id 필요");
      const state = String(input.state ?? "resolved") as "accepted" | "rejected" | "resolved";
      if (!["accepted", "rejected", "resolved"].includes(state)) throw new HttpError(400, "state 는 accepted|rejected|resolved");

      let applied = false;
      if (state === "accepted" && input.apply === true) {
        const cur = (await itemsPool.query(
          `SELECT proposed_action FROM org_manager_finding WHERE id=$1`, [id])).rows[0] as { proposed_action: unknown } | undefined;
        if (cur?.proposed_action) applied = await applyAction(cur.proposed_action, actorOf(user));
      }
      const finding = await resolveFinding(id, state, actorOf(user),
        input.resolution === undefined || input.resolution === null ? null : String(input.resolution).slice(0, 2000));
      if (!finding) throw new HttpError(404, "발견을 찾을 수 없습니다");
      return { finding, applied };
    }, {
      id: z.number().int().positive(),
      state: z.enum(["accepted", "rejected", "resolved"]).describe("rejected 는 존중된다 — 다음 주기에 되살아나지 않는다"),
      apply: z.boolean().optional().describe("accepted 시 조치안을 실제 적용(되돌릴 수 있는 것만)"),
      resolution: z.string().nullable().optional().describe("처리 메모"),
    }),

  restWork("org_manager_findings_apply", "제안된 조치 일괄 적용",
    "선택한 발견들의 조치안을 한 번에 적용하고 accepted 로 닫는다 — action_level='propose'(조치안을 미리 만들어 두고 사람이 적용)의 실행 경로다. " +
    "적용 가능한 조치(되돌릴 수 있는 것)만 수행하고, 나머지는 건드리지 않고 열린 채로 남긴다(조용히 닫으면 안 고쳐진 게 사라진다). " +
    "ids 대신 manager_id 를 주면 그 관리기의 **열린·적용가능 발견 전부**를 대상으로 한다.",
    [{ method: "POST", paths: ["/api/ui/org/manager-findings/apply"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      let ids: number[] = Array.isArray(input.ids) ? input.ids.map(Number).filter((n) => Number.isFinite(n) && n > 0) : [];
      if (!ids.length && input.manager_id) {
        // 관리기 단위 — 지금 열려 있고 적용 가능한 것만(목록이 이미 actionable 을 파생해 준다).
        const open = await listFindings({ managerId: Number(input.manager_id), limit: 500 });
        ids = open.filter((f) => f.actionable).map((f) => f.id);
      }
      if (!ids.length) throw new HttpError(400, "적용할 발견이 없습니다 — ids 또는 manager_id 를 주세요");
      const r = await applyFindings(ids, actorOf(user), applyAction);
      return r;
    }, {
      ids: z.array(z.number().int().positive()).optional().describe("적용할 발견 id 들"),
      manager_id: z.number().int().positive().optional().describe("이 관리기의 열린·적용가능 발견 전부(ids 미지정 시)"),
    }),

  // ── AI 가 쓰는 도구 — 모순·코드괴리 판정 배치가 결과를 되돌려 적는 경로. ──
  restWork("org_manager_finding_report", "관리기 발견 보고 (AI 판정 결과)",
    "관리기 판정 배치(모순·지식↔코드)가 찾아낸 것을 보고한다. **AI 전용 경로** — 사람 화면은 org_manager_findings 로 읽는다. " +
    "같은 (관리기·대상·dedup_key)는 한 행으로 합쳐지고 재보고는 카운트만 오른다. 사람이 반려한 것은 되살아나지 않는다. " +
    "⚠ 확신이 없으면 보고하지 마라 — 거짓 경보가 반복되면 이 큐 전체가 무시된다.",
    [{ method: "POST", paths: ["/api/ui/org/manager-findings"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>) => {
      const mk = str(input.manager_key, "manager_key", 64);
      const m = await getManager(mk);
      if (!m) throw new HttpError(404, `관리기를 찾을 수 없습니다: ${mk}`);
      const r = await upsertFinding(m.id, m.kind, {
        target_kind: (input.target_kind ? String(input.target_kind) : "knowledge") as "knowledge" | "category" | "domain",
        target_ref: str(input.target_ref, "target_ref", 300),
        dedup_key: input.dedup_key === undefined || input.dedup_key === null ? "" : String(input.dedup_key).slice(0, 300),
        severity: (input.severity ? String(input.severity) : "note") as "note" | "warn" | "high",
        summary: str(input.summary, "summary", 1000),
        evidence: input.evidence === undefined || input.evidence === null ? undefined : String(input.evidence).slice(0, 10_000),
        proposed_action: (input.proposed_action ?? undefined) as Record<string, unknown> | undefined,
      });
      return { result: r };
    }, {
      manager_key: z.string().describe("이 발견을 낸 관리기 key(프롬프트가 알려준 값)"),
      target_kind: z.enum(["knowledge", "category", "domain"]).optional().describe("기본 knowledge"),
      target_ref: z.string().describe("대상 식별자 — 지식 name 또는 카테고리 key"),
      dedup_key: z.string().nullable().optional().describe("같은 대상의 다른 문제를 가르는 값(모순이면 상대 지식 이름). 단일 문제면 비움"),
      severity: z.enum(["note", "warn", "high"]).optional(),
      summary: z.string().describe("무엇이 문제인지 한 줄"),
      evidence: z.string().nullable().optional().describe("근거 — 양쪽에서 인용한 문장(모순) 또는 정의↔코드 파일:라인(코드괴리). 필수에 가깝다"),
      proposed_action: z.record(z.unknown()).optional().describe("조치안(선택) — { op, ... }"),
    }),

  restWork("org_manager_remove", "관리기 삭제",
    "관리기와 그 발견을 지운다(발견은 관리기 없이 판단할 근거가 없다).",
    [{ method: "POST", paths: ["/api/ui/org/managers/remove"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const id = Number(input.id);
      if (!Number.isFinite(id) || id <= 0) throw new HttpError(400, "관리기 id 필요");
      await removeManager(id, actorOf(user), "web");
      return { ok: true };
    }, { id: z.number().int().positive() }),
];
