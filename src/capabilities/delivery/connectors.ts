// delivery ▸ connectors — 외부 자료 수집 커넥터 설정·실행·사람 매핑(#541/#586/#837).
import type { Capability } from "../types.js";
import { z } from "zod";
import { HttpError } from "../rest-util.js";
import type { LivelyUser } from "../../context.js";
import { MEANING } from "../../org/delivery/meaning.js";
import { listMembers, listConnectors, upsertConnector, removeConnector } from "../../org/store.js";
// ClickUp 멤버 매핑 패널(#541) — 팀 멤버 나열(getTeam) + person_identity 기반 매핑 상태 계산.
import { connectors } from "../../connectors/index.js";
import type { ConnectorUser } from "../../connectors/types.js";
import { resetConnectorConfigCache, CONNECTOR_SPECS } from "../../connectors/config.js";
import { itemsPool } from "../../db/client.js";
// 임베딩(벡터검색 #172) — 런타임 토글(embedding_config)은 updateRuntimeConfig 로, 기존 지식 백필은 공유 코어로.
import { runAutoBackfillSweep } from "../../v6/embedding-backfill.js";
// #586 커넥터 UX — 비동기 실행(run 엔티티)·스코프 발견.
import { startConnectorRun, listConnectorRuns, getConnectorRun, cancelConnectorRun } from "../../connectors/run-tracker.js";
import { discoverConnectorScope } from "../../connectors/discover.js";
import { actorOf, restOnly, str } from "./shared.js";

export const connectorsReadCapabilities: Capability[] = [
  restOnly("org_connectors", "외부 자료 수집(커넥터) 목록",
    "관리탭 [외부 자료 수집] — 등록된 커넥터(슬랙·노션·클릭업·지메일·드라이브 등 **패시브 미러 싱크**) 설정 목록. 시크릿 값은 담기지 않는다. " +
    "실행 이력·로그는 org_connector_runs/org_connector_run_log, 사람 매핑은 org_connector_members, 지금 싱크는 org_connector_sync_run. " +
    "⚠ AI 가 실시간 호출하는 외부 시스템(MCP 서버·사내 API 도구)은 이게 아니라 org_mcp_servers·org_tools 다.",
    [{ method: "GET", paths: ["/api/ui/org/connectors"], parse: () => ({}) }],
    async () => ({ connectors: await listConnectors(), meaning: MEANING["connector"] })),
];

export const connectorsCapabilities: Capability[] = [
  // ── 커넥터 설정/토큰 (프로젝트 #541) — config=평문, secrets=암호화(secret-box) ──
  restOnly("org_connector_upsert", "커넥터 설정·토큰 저장",
    "커넥터(slack/notion/clickup/…)의 설정(config, 평문)과 토큰(secrets, 암호화 저장)을 저장한다. secrets 는 값이 오면 갱신·빈값/미전송이면 유지. 시크릿 저장엔 게이트웨이 CONNECTOR_SECRET_KEY 필요.",
    [{ method: "POST", paths: ["/api/ui/org/connector"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const system = str(input.system, "system", 40).trim();
      const asStrMap = (v: unknown): Record<string, string> | undefined => {
        if (v == null || typeof v !== "object") return undefined;
        const out: Record<string, string> = {};
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = val == null ? "" : String(val);
        return out;
      };
      const connector = await upsertConnector({
        system,
        enabled: input.enabled === undefined ? undefined : Boolean(input.enabled),
        config: asStrMap(input.config),
        secrets: asStrMap(input.secrets),
        note: input.note === undefined ? undefined : (input.note === null || input.note === "" ? null : str(input.note, "note", 500)),
      }, actorOf(user), "web");
      // 게이트웨이 인프로세스 해소 캐시 무효화(#541) — 아래 clickup 멤버 조회 등이 새 토큰을 즉시 쓰게
      //  (캐시는 원래 짧게 사는 싱크 서브프로세스 전제 — 장수 게이트웨이에선 쓰기 시점에 리셋).
      resetConnectorConfigCache();
      return { connector };
    }, {
      system: z.string().describe("커넥터 시스템: slack|notion|clickup|gmail|drive 등"),
      enabled: z.boolean().optional(),
      config: z.record(z.string()).optional().describe("평문 설정값(secret=false 필드)"),
      secrets: z.record(z.string()).optional().describe("시크릿(암호화 저장 — 값=갱신, 빈값/미전송=유지)"),
      note: z.string().nullable().optional(),
    }),
  // ── #586 커넥터 실행(run) — 비동기 "지금 싱크" + 실행 이력/로그(폴링). ──
  restOnly("org_connector_sync_run", "커넥터 지금 싱크(비동기)",
    "커넥터 싱크를 백그라운드로 시작하고 run_id 를 즉시 반환한다(긴 full 백필도 HTTP 타임아웃 없음). 로그·상태는 runs API 로 폴링.",
    [{ method: "POST", paths: ["/api/ui/org/connector/sync"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const system = str(input.system, "system", 40).trim();
      const run = await startConnectorRun(system, { full: Boolean(input.full), trigger: "manual", startedBy: actorOf(user) });
      // #669 sync 완료 후 임베딩 잔량 스윕(백그라운드) — 미러가 남긴 pending(신규·제목/본문 변경 리셋)을 곧바로 흡수.
      if (!run.alreadyRunning) void run.done.then(() => runAutoBackfillSweep()).catch(() => {});
      return { run_id: run.runId, already_running: run.alreadyRunning }; // done 은 await 하지 않는다(비동기)
    }, {
      system: z.string().describe("커넥터 시스템(slack·notion·clickup 등)"),
      full: z.boolean().optional().describe("true=전체 백필(커서 무시), 기본 false=증분"),
    }),
  restOnly("org_connector_runs", "커넥터 실행 이력",
    "커넥터 실행(connector_run) 목록 — 상태·모드·트리거·소요. 로그는 개별 run 조회로. limit(≤100, 기본 20)·offset 으로 과거 이력 페이지네이션(#709).",
    [{ method: "GET", paths: ["/api/ui/org/connector/runs"], parse: (req) => ({
      system: req.query?.system ? String(req.query.system) : undefined,
      collector_id: req.query?.collector_id ? Number(req.query.collector_id) : undefined,
      limit: req.query?.limit ? Number(req.query.limit) : undefined,
      offset: req.query?.offset ? Number(req.query.offset) : undefined,
    }) }],
    async (input: Record<string, unknown>) => {
      const limit = Number.isFinite(Number(input.limit)) && Number(input.limit) > 0 ? Number(input.limit) : 20;
      const offset = Number.isFinite(Number(input.offset)) && Number(input.offset) > 0 ? Number(input.offset) : 0;
      const collectorId = Number(input.collector_id ?? 0) || undefined;
      return { runs: await listConnectorRuns(input.system ? String(input.system) : undefined, limit, offset, collectorId) };
    }, {
      system: z.string().optional().describe("커넥터 시스템(예: clickup)으로 필터 — 그 프리셋의 전 인스턴스가 함께 보인다"),
      collector_id: z.number().int().positive().optional().describe("수집기 인스턴스로 필터(#1419) — 그 수집기의 이력만"),
      limit: z.number().int().min(1).max(100).optional().describe("페이지 크기(≤100, 기본 20)"),
      offset: z.number().int().min(0).optional().describe("페이지 오프셋(기본 0) — 최신 N건 너머 과거 이력(#709)"),
    }),
  restOnly("org_connector_run_log", "커넥터 실행 로그",
    "실행 1건의 메타 + 로그 청크(offset 이후) — 웹이 폴링으로 이어붙여 진행상황을 본다.",
    [{ method: "GET", paths: ["/api/ui/org/connector/runs/:id"], parse: (req) => ({
      id: Number(req.params?.id), offset: req.query?.offset ? Number(req.query.offset) : 0,
    }) }],
    async (input: Record<string, unknown>) => {
      const id = Number(input.id);
      if (!Number.isFinite(id) || id <= 0) throw new HttpError(400, "run id 필요");
      const off = Number.isFinite(Number(input.offset)) && Number(input.offset) > 0 ? Number(input.offset) : 0;
      const run = await getConnectorRun(id, off);
      if (!run) throw new HttpError(404, "run 없음");
      return run;
    }, {
      id: z.number().int().positive().describe("connector_run id(org_connector_runs 로 조회)"),
      offset: z.number().int().min(0).optional().describe("로그 바이트 오프셋(기본 0) — 이 위치 이후 청크만 받아 이어붙인다"),
    }),
  restOnly("org_connector_run_cancel", "커넥터 실행 중지",
    "진행 중인 실행을 중지한다(자식 프로세스 kill + canceled 기록). 커서 미전진이라 데이터 손실 없음 — 다음 run 이 재수집.",
    [{ method: "POST", paths: ["/api/ui/org/connector/runs/:id/cancel"], parse: (req) => ({ id: Number(req.params?.id) }) }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const id = Number(input.id);
      if (!Number.isFinite(id) || id <= 0) throw new HttpError(400, "run id 필요");
      return await cancelConnectorRun(id, actorOf(user));
    }, {
      id: z.number().int().positive().describe("중지할 connector_run id — 커서 미전진이라 데이터 손실 없음(다음 run 이 재수집)"),
    }),
  restOnly("org_connector_discover", "커넥터 스코프 목록 조회",
    "저장된 토큰으로 소스의 선택지(노션 공유 페이지/DB, 클릭업 리스트)를 조회한다 — 관리탭 픽커용.",
    [{ method: "POST", paths: ["/api/ui/org/connector/discover"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>) => {
      const system = str(input.system, "system", 40).trim();
      const { resetConnectorConfigCache } = await import("../../connectors/config.js");
      resetConnectorConfigCache(); // 방금 저장한 토큰 즉시 반영
      return await discoverConnectorScope(system);
    }, {
      system: z.string().describe("커넥터 시스템(notion·clickup 등) — 저장된 토큰으로 선택지를 조회한다"),
    }),

  restOnly("org_connector_remove", "커넥터 설정 제거",
    "커넥터 설정/토큰 행을 제거한다(env 폴백으로 복귀).",
    [{ method: "POST", paths: ["/api/ui/org/connector/remove"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      await removeConnector(str(input.system, "system", 40).trim(), actorOf(user), "web");
      resetConnectorConfigCache(); // env 폴백 복귀도 즉시 반영
      return { ok: true };
    }, {
      system: z.string().describe("제거할 커넥터 시스템 — 설정/토큰 행이 사라지고 env 폴백으로 복귀한다"),
    }),
];

export const connectorMembersCapabilities: Capability[] = [
  // ── ClickUp 멤버 매핑 조회(#541) — 관리탭 커넥터 패널용. 팀 멤버 나열 + 매핑 상태 계산.
  //  '효과적 매핑'은 미러(connector-mirror resolveMemberId)와 동일 순서로 판정:
  //   ① person_identity(system='clickup', external_id∈{이메일 소문자, 숫자 id}) JOIN org_member(실재 확인)
  //   ② org_member.email 소문자 직접 매치.
  //  응답 users[]: { clickup, mapped_member_id(①??②), mapped_via('identity'|'email'|null), suggested_member_id }
  //   — mapped_via='identity' 만 UI 에서 '해제' 가능(②는 이메일에서 오는 암묵 매핑 — 드롭다운 미리선택으로 확정 유도).
  //  ClickUp 토큰 미설정/호출 실패는 { error } 폴백(500 금지 — 패널이 우아하게 안내).
  // ── 사람 매핑 목록(#837) — 커넥터 **일반**. 구 org_connector_clickup_members 를 대체한다(구 경로는 별칭 유지). ──
  //  왜 커넥터 쪽이 편집 SoT 인가: 매핑은 "외부 시스템의 사람 ↔ 우리 구성원"인데, 구성원 화면은 외부 목록을
  //  안 가져오므로 관리자가 외부 id(ClickUp 숫자 id 등)를 **손으로 타이핑**해야 했다 — 어디서 찾는지도 모르고
  //  오타는 조용히 매칭 실패로 끝난다. 여기선 커넥터가 실제 목록을 주므로 드롭다운으로 고르기만 하면 된다.
  //  listUsers 를 안 다는 커넥터(gmail·gdrive — 개인 OAuth 라 '멤버' 개념이 없다)는 supported:false 로 답한다.
  restOnly("org_connector_members", "커넥터 사람 매핑 목록",
    "커넥터(clickup·slack·notion)의 사용자 목록과 각자의 org_member 매핑 상태를 계산해 반환한다 — 관리탭 [외부 자료 수집 ▸ 멤버 매핑] 패널용. 구 이름 org_connector_clickup_members.",
    [{ method: "GET", paths: ["/api/ui/org/connector/:system/members", "/api/ui/org/connector/clickup/members"],
       parse: (req) => ({ system: String((req.params as Record<string, string>)?.system ?? "clickup") }) }],
    async (input: { system: string }) => {
      const system = String(input.system || "clickup");
      const conn = connectors[system];
      if (!conn) throw new HttpError(404, `알 수 없는 커넥터: ${system}`);
      if (!conn.listUsers) return { system, supported: false, users: [] };

      let users: ConnectorUser[];
      try { users = await conn.listUsers(); }
      catch (e) { return { system, supported: true, error: `${CONNECTOR_SPECS[system]?.label ?? system} 사용자 목록을 불러오지 못했습니다: ${e instanceof Error ? e.message : String(e)}`, users: [] }; }

      const members = await listMembers();
      // org_member.email(소문자) → id — 효과적 매핑 ② 겸 자동매치 제안 공용.
      const emailToMember = new Map<string, string>();
      for (const m of members) {
        const k = (m.email ?? "").trim().toLowerCase();
        if (k && !emailToMember.has(k)) emailToMember.set(k, m.id);
      }
      // ① person_identity 배치 조회 — 유저별 후보 external_id(외부 id · 소문자 이메일)를 한 번에.
      //   (이메일도 후보인 이유: 관리탭 매핑은 external_id=외부 id 로 저장하지만, 미러가 raw 이메일로 굳혀 둔
      //    과거 데이터가 있다 — #697 clickup-mirror-member-remap-retroactive 참조.)
      const extIds: string[] = [];
      for (const u of users) {
        extIds.push(String(u.id));
        const em = (u.email ?? "").trim().toLowerCase();
        if (em) extIds.push(em);
      }
      const identityMap = new Map<string, string>(); // external_id → org_member.id
      if (extIds.length) {
        const r = await itemsPool.query(
          `SELECT pi.external_id, pi.person_id FROM person_identity pi
             JOIN org_member om ON om.id = pi.person_id
            WHERE pi.system=$2 AND pi.external_id = ANY($1::text[])`, [extIds, system]);
        for (const row of r.rows as Array<{ external_id: string; person_id: string }>) {
          identityMap.set(row.external_id, row.person_id);
        }
      }
      const rows = users.map((u) => {
        const em = (u.email ?? "").trim().toLowerCase();
        const viaIdentity = identityMap.get(String(u.id)) ?? (em ? identityMap.get(em) : undefined) ?? null;
        const viaEmail = em ? (emailToMember.get(em) ?? null) : null;
        return {
          user: u,
          mapped_member_id: viaIdentity ?? viaEmail,
          mapped_via: viaIdentity ? "identity" : (viaEmail ? "email" : null),
          suggested_member_id: viaIdentity ? null : viaEmail,
        };
      });
      return { system, supported: true, instance: users[0]?.instance ?? null, users: rows };
    }, {
      system: z.string().optional().describe("커넥터 시스템(clickup·slack·notion — 기본 clickup). listUsers 미지원 커넥터(gmail·gdrive)는 supported:false 로 답한다"),
    }),
];
