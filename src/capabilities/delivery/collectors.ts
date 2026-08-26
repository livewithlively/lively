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
import {
  listCollectors, upsertCollector, removeCollector,
  collectorPresetCatalog, upsertCollectorPreset, removeCollectorPreset,
} from "../../org/store.js";
import { resetConnectorConfigCache, withCollector, resolveConnectorConfig } from "../../connectors/config.js";
import { startConnectorRun } from "../../connectors/run-tracker.js";
import { discoverConnectorScope } from "../../connectors/discover.js";
import { runAutoBackfillSweep } from "../../v6/embedding-backfill.js";
import { itemsPool } from "../../db/client.js";
import { actorOf, restOnly, restRead, str } from "./shared.js";

/** 수집기 1건 조회 + 바인딩 정보 — 실행·discover 가 공용으로 쓴다. */
async function loadBinding(id: number): Promise<{ id: number; presetKey: string; instanceKey: string }> {
  const r = await itemsPool.query<{ preset_key: string; instance_key: string }>(
    `SELECT preset_key, instance_key FROM org_collector WHERE id=$1`, [id]);
  const row = r.rows[0];
  if (!row) throw new HttpError(404, "수집기를 찾을 수 없습니다");
  return { id, presetKey: row.preset_key, instanceKey: row.instance_key };
}

export const collectorsReadCapabilities: Capability[] = [
  // ── 목록은 **인증만**(scope null), 편집은 admin. ──
  //  왜 갈랐나: [맥락 관리] 탭은 전 구성원에게 보이는데 목록 조회까지 admin 이면 비-admin 이 [수집] 을 열
  //  때마다 403 카드만 본다 — 탭이 있는데 안이 통째로 에러인 상태가 되고, 그건 "권한이 없다"가 아니라
  //  "고장났다"로 읽힌다. 파이프라인 화면의 목적(어디가 막혔나를 모두가 본다)과도 정면으로 어긋난다.
  //  ⚠ 안전한 이유: listCollectors 는 시크릿 **값**을 애초에 담지 않는다 — 프리셋의 secret:true 항목은
  //   secretsSet(설정 여부 boolean)으로만 나가고, config 에는 non-secret 항목만 담긴다. 즉 이 응답에는
  //   비-admin 에게 가리고 말고 할 자격 정보가 없다(그래서 여기선 redact 가 아니라 scope 만 내린다).
  //  canEdit 을 함께 준다 — 화면이 '버튼을 그릴지'를 서버 판정 하나로 정하게. 프론트가 scope 를 자체
  //   해석하면 서버 게이트와 어긋나 '눌러도 403' 이 난다(#1419 T9 에서 같은 종류의 드리프트를 겪었다).
  restRead("org_collectors", "수집기 목록",
    "등록된 **수집기 인스턴스** 목록 + 고를 수 있는 프리셋 카탈로그(#1419). 한 프리셋(슬랙·노션 등)으로 수집기를 여러 개 만들 수 있다 — " +
    "워크스페이스가 둘이거나, 채널 그룹마다 주기·산출정책을 달리할 때. 시크릿 값은 담기지 않는다(설정 여부만). " +
    "조회는 전 구성원, 생성·수정·삭제·실행은 admin(응답의 canEdit 이 그 판정). " +
    "⚠ 구 org_connectors(system 당 1개)의 후계 — 구 도구는 레거시 축으로 계속 동작하나 새 작업은 이걸 쓴다.",
    [{ method: "GET", paths: ["/api/ui/org/collectors"], parse: () => ({}) }],
    async (_input: unknown, user: LivelyUser) => ({
      collectors: await listCollectors(), presets: await collectorPresetCatalog(),
      canEdit: !!(user?.scopes && user.scopes.includes("admin")),
      meaning: MEANING["connector"],
    }), true),
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
      preset_key: z.string().optional().describe("프리셋: slack|notion|clickup|gmail|gdrive|discord|figma|domain-wiki (생성 시 필수)"),
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

  // ── 커스텀 프리셋(#1419 T2) — "커스텀하게 프리셋을 추가할 수 있게" ──
  restOnly("org_collector_preset_upsert", "커스텀 프리셋 저장",
    "수집 **프리셋**을 만들거나 고친다. 두 갈래: driver='clone'(내장 프리셋을 복제해 라벨·기본값만 바꾼 템플릿) 또는 " +
    "driver='http'|'rss'|'webhook'(코드 배포 없이 새 수집 방식을 정의 — 사내 API·공개 피드·웹훅 수신). " +
    "⚠ 자격(토큰)은 프리셋이 아니라 **수집기**가 갖는다 — 프리셋의 fields 에 secret:true 항목을 선언하면 각 수집기가 자기 값을 채운다. " +
    "⚠ parser_script 는 격리 자식 프로세스에서 실행되는 **관리자 작성 코드**다(fs·child_process 차단, 환경변수 미주입, 10초 타임아웃 — 단 네트워크는 막지 못한다).",
    [{ method: "POST", paths: ["/api/ui/org/collector-presets"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const preset = await upsertCollectorPreset({
        id: input.id === undefined || input.id === null ? undefined : Number(input.id),
        key: input.key === undefined ? undefined : str(input.key, "key", 64),
        label: input.label === undefined ? undefined : str(input.label, "label", 200),
        driver: input.driver === undefined ? undefined : (str(input.driver, "driver", 20) as never),
        base_preset: input.base_preset === undefined ? undefined : (input.base_preset === null || input.base_preset === "" ? null : str(input.base_preset, "base_preset", 64)),
        description: input.description === undefined ? undefined : (input.description === null || input.description === "" ? null : str(input.description, "description", 2000)),
        fields: (input.fields ?? undefined) as never,
        driver_config: (input.driver_config ?? undefined) as Record<string, unknown> | undefined,
        guide: (input.guide ?? undefined) as never,
        parser_script: input.parser_script === undefined ? undefined : (input.parser_script === null || input.parser_script === "" ? null : String(input.parser_script).slice(0, 100_000)),
        enabled: input.enabled === undefined ? undefined : Boolean(input.enabled),
      }, actorOf(user), "web");
      return { preset };
    }, {
      id: z.number().int().positive().optional().describe("수정할 프리셋 id(없으면 생성)"),
      key: z.string().optional().describe("프리셋 식별 슬러그 — 내장 이름(slack·notion 등)은 쓸 수 없다"),
      label: z.string().optional().describe("화면에 보일 이름"),
      driver: z.enum(["clone", "http", "rss", "webhook"]).optional().describe("수집 방식"),
      base_preset: z.string().nullable().optional().describe("clone 일 때 복제할 내장 프리셋 key(필수)"),
      description: z.string().nullable().optional(),
      fields: z.array(z.record(z.unknown())).optional().describe("수집기가 채울 설정 항목 — {key, label, secret, required, hint}[]"),
      driver_config: z.record(z.unknown()).optional().describe("드라이버 설정 — http: {url, auth, pagination, itemsPath, map} · rss: {url} · webhook: {signature, map}"),
      guide: z.record(z.unknown()).nullable().optional().describe("설정 안내 — {intro, steps[], url}"),
      parser_script: z.string().nullable().optional().describe("커스텀 파서 — parse(input) 를 정의하거나 마지막 값을 남긴다. 격리 실행"),
      enabled: z.boolean().optional(),
    }),

  restOnly("org_collector_preset_remove", "커스텀 프리셋 삭제",
    "커스텀 프리셋을 지운다. 그 프리셋으로 만든 수집기가 하나라도 있으면 거부한다(지우면 그 수집기들이 없는 프리셋을 가리켜 조용히 멈춘다). 내장 프리셋은 지울 수 없다.",
    [{ method: "POST", paths: ["/api/ui/org/collector-presets/:id/remove"], parse: (req) => ({
      id: Number((req.params as Record<string, string>)?.id),
    }) }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const id = Number(input.id);
      if (!Number.isFinite(id) || id <= 0) throw new HttpError(400, "프리셋 id 필요");
      await removeCollectorPreset(id, actorOf(user), "web");
      return { ok: true };
    }, {
      id: z.number().int().positive().describe("삭제할 커스텀 프리셋 id"),
    }),

  restOnly("org_collector_preview", "수집기 미리보기(실호출 샘플)",
    "저장된 설정으로 **실제로 한 번 호출해** 무엇이 잡히는지 샘플을 돌려준다 — 적재는 하지 않는다(읽기만). " +
    "필드 매핑이 맞는지, 고유 id 가 비지 않는지를 저장 전에 눈으로 확인하는 자리다. 최대 5건.",
    [{ method: "POST", paths: ["/api/ui/org/collectors/:id/preview"], parse: (req) => ({
      id: Number((req.params as Record<string, string>)?.id),
    }) }],
    async (input: Record<string, unknown>) => {
      const b = await loadBinding(Number(input.id));
      resetConnectorConfigCache();
      return await withCollector(b, async () => {
        const { connectorForPresetKey } = await import("../../connectors/generic/index.js");
        const settings = await resolveConnectorConfig(b.presetKey);
        const { connector, preset } = await connectorForPresetKey(b.presetKey, settings, b.id);
        const sample: unknown[] = [];
        let noExternalId = 0;
        try {
          // 미리보기는 **증분 옵션 없이** 최신부터 훑는다. 5건에서 끊으므로 대형 소스도 즉시 끝난다.
          for await (const item of connector.backfill()) {
            sample.push({
              external_id: item.provenance.external_id,
              title: item.title ?? null,
              body_preview: item.body ? String(item.body).slice(0, 200) : null,
              occurred_at: item.occurred_at ?? null,
              container_name: item.container_name ?? null,
              author: item.actor?.display_name ?? item.actor?.email ?? null,
              url: item.provenance.external_url ?? null,
            });
            if (sample.length >= 5) break;
          }
        } catch (e) {
          // 실패도 결과다 — 던지면 화면이 500 을 받고 '무엇이 왜 안 되는지'를 못 보여준다.
          return { ok: false, driver: preset.driver, error: String((e as Error)?.message ?? e).slice(0, 1000), sample: [] };
        }
        return { ok: true, driver: preset.driver, sample, note: noExternalId ? `고유 id 가 비어 건너뛴 항목 ${noExternalId}건` : undefined };
      });
    }, {
      id: z.number().int().positive().describe("미리볼 수집기 id — 실제 호출하되 적재하지 않는다"),
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
