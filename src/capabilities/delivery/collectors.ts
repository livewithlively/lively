// delivery ▸ collectors — **수집기 인스턴스** CRUD·실행·스코프 조회(#1419 T1).
//  커넥터(delivery/connectors.ts)의 후계다. 그쪽은 'system 당 1개' 축이고 여기는 'n개 인스턴스' 축이라,
//  경로·도구명을 갈라 둘이 공존한다(구 화면·구 스크립트가 깨지지 않게 — 구 API 는 레거시 축으로 계속 동작).
//
//  ⚠ discover(스코프 픽커)만 특별하다 — 그건 **게이트웨이 프로세스 안에서** 외부 API 를 직접 호출하므로
//   '어느 수집기의 토큰으로 부를지'를 요청 범위로 씌워야 한다(withCollector). 전역 바인딩을 쓰면 동시 요청이
//   서로의 토큰을 덮는다(config.ts 주석 참조).
import type { Capability } from "../types.js";
import { z } from "zod";
import { HttpError } from "../rest-util.js";
import type { LivelyUser } from "../../context.js";
import { MEANING } from "../../org/delivery/meaning.js";
import { listCollectors, upsertCollector, removeCollector } from "../../org/store.js";
import { CONNECTOR_SPECS, resetConnectorConfigCache, withCollector } from "../../connectors/config.js";
import { startConnectorRun } from "../../connectors/run-tracker.js";
import { discoverConnectorScope } from "../../connectors/discover.js";
import { runAutoBackfillSweep } from "../../v6/embedding-backfill.js";
import { itemsPool } from "../../db/client.js";
import { actorOf, restOnly, str } from "./shared.js";

/** 프리셋 카탈로그 — 수집기를 만들 때 고를 수 있는 것들. T2 가 커스텀 프리셋을 여기에 합류시킨다. */
function presetCatalog() {
  return Object.values(CONNECTOR_SPECS).map((s) => ({
    key: s.system, label: s.label, fields: s.fields, guide: s.guide,
    builtin: true,
    // 사람 매핑 지원 여부는 커넥터 SPI(listUsers)가 정한다 — 화면이 패널을 그릴지 미리 알 수 있게.
    kind: "mirror" as const,
  }));
}

/** 수집기 1건 조회 + 바인딩 정보 — 실행·discover 가 공용으로 쓴다. */
async function loadBinding(id: number): Promise<{ id: number; presetKey: string; instanceKey: string }> {
  const r = await itemsPool.query<{ preset_key: string; instance_key: string }>(
    `SELECT preset_key, instance_key FROM org_collector WHERE id=$1`, [id]);
  const row = r.rows[0];
  if (!row) throw new HttpError(404, "수집기를 찾을 수 없습니다");
  return { id, presetKey: row.preset_key, instanceKey: row.instance_key };
}

export const collectorsReadCapabilities: Capability[] = [
  restOnly("org_collectors", "수집기 목록",
    "등록된 **수집기 인스턴스** 목록 + 고를 수 있는 프리셋 카탈로그(#1419). 한 프리셋(슬랙·노션 등)으로 수집기를 여러 개 만들 수 있다 — " +
    "워크스페이스가 둘이거나, 채널 그룹마다 주기·산출정책을 달리할 때. 시크릿 값은 담기지 않는다(설정 여부만). " +
    "⚠ 구 org_connectors(system 당 1개)의 후계 — 구 도구는 레거시 축으로 계속 동작하나 새 작업은 이걸 쓴다.",
    [{ method: "GET", paths: ["/api/ui/org/collectors"], parse: () => ({}) }],
    async () => ({ collectors: await listCollectors(), presets: presetCatalog(), meaning: MEANING["connector"] })),
];

export const collectorsCapabilities: Capability[] = [
  restOnly("org_collector_upsert", "수집기 저장",
    "수집기 인스턴스를 만들거나 고친다. id 를 주면 수정, 없으면 생성. secrets 는 값이 오면 갱신·빈값/미전송이면 유지(시크릿 저장엔 CONNECTOR_SECRET_KEY 필요). " +
    "enabled=true 로 저장하면 그 수집기 전용 자동 수집 잡(collector-<id>)이 등록된다. " +
    "⚠ 커서 네임스페이스(instance_key)는 생성 시에만 정해지고 이후 변경되지 않는다 — 바꾸면 그 수집기가 커서를 잃고 전체 재수집한다.",
    [{ method: "POST", paths: ["/api/ui/org/collectors"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const asStrMap = (v: unknown): Record<string, string> | undefined => {
        if (v == null || typeof v !== "object") return undefined;
        const out: Record<string, string> = {};
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = val == null ? "" : String(val);
        return out;
      };
      const collector = await upsertCollector({
        id: input.id === undefined || input.id === null ? undefined : Number(input.id),
        key: input.key === undefined ? undefined : str(input.key, "key", 64),
        preset_key: input.preset_key === undefined ? undefined : str(input.preset_key, "preset_key", 64),
        instance_key: input.instance_key === undefined ? undefined : str(input.instance_key, "instance_key", 64),
        label: input.label === undefined ? undefined : (input.label === null || input.label === "" ? null : str(input.label, "label", 200)),
        enabled: input.enabled === undefined ? undefined : Boolean(input.enabled),
        config: asStrMap(input.config),
        secrets: asStrMap(input.secrets),
        sync_interval_sec: input.sync_interval_sec === undefined ? undefined : Number(input.sync_interval_sec),
        output_mode: input.output_mode === undefined ? undefined : str(input.output_mode, "output_mode", 20),
        output_config: (input.output_config ?? undefined) as Record<string, unknown> | undefined,
        sort: input.sort === undefined ? undefined : Number(input.sort),
        note: input.note === undefined ? undefined : (input.note === null || input.note === "" ? null : str(input.note, "note", 500)),
      }, actorOf(user), "web");
      // 인프로세스 해소 캐시 무효화 — 아래 discover·멤버 조회가 새 토큰을 즉시 쓰게(캐시는 원래 짧게 사는
      //  싱크 서브프로세스 전제라, 장수 게이트웨이에선 쓰기 시점에 리셋한다).
      resetConnectorConfigCache();
      return { collector };
    }, {
      id: z.number().int().positive().optional().describe("수정할 수집기 id(없으면 생성)"),
      key: z.string().optional().describe("식별 슬러그(a-z0-9._-) — 비우면 자동 생성"),
      preset_key: z.string().optional().describe("프리셋: slack|notion|clickup|gmail|gdrive|discord|domain-wiki (생성 시 필수)"),
      instance_key: z.string().optional().describe("커서 네임스페이스 — 생성 시에만. 비우면 key(첫 인스턴스는 '_')"),
      label: z.string().nullable().optional(),
      enabled: z.boolean().optional(),
      config: z.record(z.string()).optional().describe("평문 설정값(프리셋 필드 중 secret=false)"),
      secrets: z.record(z.string()).optional().describe("시크릿(암호화 저장 — 값=갱신, 빈값/미전송=유지)"),
      sync_interval_sec: z.number().int().min(60).max(604_800).optional().describe("자동 수집 주기(초, 기본 600)"),
      output_mode: z.enum(["preset", "source", "knowledge", "both"]).optional().describe("수집 결과 산출 — preset=프리셋 기본 동작(현행). 나머지는 T3 에서 배선"),
      output_config: z.record(z.unknown()).optional(),
      sort: z.number().int().optional(),
      note: z.string().nullable().optional(),
    }),

  restOnly("org_collector_sync_run", "수집기 지금 수집(비동기)",
    "이 수집기의 수집을 백그라운드로 시작하고 run_id 를 즉시 반환한다(긴 full 백필도 HTTP 타임아웃 없음). 로그·상태는 org_connector_runs/…run_log 로 폴링(collector_id 필터).",
    [{ method: "POST", paths: ["/api/ui/org/collectors/:id/sync"], parse: (req) => ({
      id: Number((req.params as Record<string, string>)?.id), full: (req.body as Record<string, unknown>)?.full,
    }) }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const b = await loadBinding(Number(input.id));
      const run = await startConnectorRun(b.presetKey, {
        full: Boolean(input.full), trigger: "manual", startedBy: actorOf(user), collectorId: b.id,
      });
      // #669 sync 완료 후 임베딩 잔량 스윕(백그라운드) — 미러가 남긴 pending 을 곧바로 흡수.
      if (!run.alreadyRunning) void run.done.then(() => runAutoBackfillSweep()).catch(() => {});
      return { run_id: run.runId, already_running: run.alreadyRunning };
    }, {
      id: z.number().int().positive().describe("수집기 id"),
      full: z.boolean().optional().describe("true=전체 백필(커서 무시), 기본 false=증분"),
    }),

  restOnly("org_collector_discover", "수집기 스코프 목록 조회",
    "이 수집기에 저장된 토큰으로 소스의 선택지(노션 공유 페이지/DB, 클릭업 리스트)를 조회한다 — 관리 화면 픽커용. 수집기마다 토큰이 다르므로 반드시 수집기 단위로 부른다.",
    [{ method: "POST", paths: ["/api/ui/org/collectors/:id/discover"], parse: (req) => ({
      id: Number((req.params as Record<string, string>)?.id),
    }) }],
    async (input: Record<string, unknown>) => {
      const b = await loadBinding(Number(input.id));
      resetConnectorConfigCache(); // 방금 저장한 토큰 즉시 반영
      // 요청 범위 바인딩 — 이 호출 안에서만 이 수집기의 토큰으로 해소된다(동시 요청과 섞이지 않음).
      return await withCollector(b, () => discoverConnectorScope(b.presetKey));
    }, {
      id: z.number().int().positive().describe("수집기 id — 그 수집기의 토큰으로 조회한다"),
    }),

  restOnly("org_collector_remove", "수집기 삭제",
    "수집기와 그 자동 수집 잡을 지운다. 이미 수집된 자료·지식은 그대로 남는다(삭제 아님). " +
    "커서(connector_state)도 남겨 두므로 같은 instance_key 로 다시 만들면 이어받는다.",
    [{ method: "POST", paths: ["/api/ui/org/collectors/:id/remove"], parse: (req) => ({
      id: Number((req.params as Record<string, string>)?.id),
    }) }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const id = Number(input.id);
      if (!Number.isFinite(id) || id <= 0) throw new HttpError(400, "수집기 id 필요");
      await removeCollector(id, actorOf(user), "web");
      resetConnectorConfigCache();
      return { ok: true };
    }, {
      id: z.number().int().positive().describe("삭제할 수집기 id — 수집된 자료·지식은 남는다"),
    }),
];
