// 앱 설치 전개 실행기 — 순수 오케스트레이터(install.ts)가 주입받는 InstallDeps 의 **실제 스토어 배선**(#1780).
//  install.ts 는 저널·순서·보상만 순수하게 알고, "harness_asset 을 어디에 어떻게 심나"는 여기서 kind 별로 해석한다.
//
//  kind → deploy/reclaim 은 KIND_HANDLERS 맵으로 둔다(디스패치 자체가 순수 테스트 대상 — deployKindHandled).
//   · harness_asset : org_harness_asset upsert / remove         (실전개)
//   · host          : url_allowlist 병합 / 참조 0 이면 제거      (실전개; 다른 앱 참조는 hostReferenceCount 로 보호)
//   · cron          : org_cron insert(agent_headless) / delete   (실전개; id = 앱스코프 ref = 안정 PK)
//   · mcp_server    : org_mcp_server upsert / remove             (실전개; name = 앱스코프 ref, cross-app 충돌 회피)
//   · tool          : org_tool upsert / remove                   (실전개; name = 앱스코프 ref)
//   · ui_page/ui_widget/section/data_table : no-op(저널만 — addComponent 가 이미 기록, DDL 은 부팅 자식)
//   · 그 외 kind    : deploy = HttpError(500) — 알 수 없는 것을 심지 않는다. reclaim = 경고 + 조인 제거만
//                     (#1780 v2 §7-1, 설계 R2-C8 — v2 코어가 심은 kind 를 이 코어가 만나도 앱 삭제·재설치가 막히지 않게).
import { HttpError } from "../http-error.js";
import { logger } from "../log.js";
import type { WriteCtx } from "../org/store/audit.js";
import type { AppComponentRef } from "./install-plan.js";
import type { DeployItem, InstallDeps } from "./install.js";
import { upsertApp, setAppStatus, addComponent, removeComponent, hostReferenceCount } from "../org/store/apps.js";
import { upsertOrgHarnessAsset, removeOrgHarnessAsset } from "../org/store/harness-assets.js";
import { getRuntimeConfig, updateRuntimeConfig } from "../org/store/runtime-config.js";
import { upsertCronJob, deleteCronJob } from "../org/cron-store.js";
import { upsertMcpServer, removeMcpServer, type McpServerInput } from "../org/store/mcp-servers.js";
import { upsertTool, removeTool, type OrgToolInput } from "../org/store/tools.js";

// harness_asset payload 계약(loader.ts) — { kind, harness, body, label }.
interface HarnessAssetPayload { kind: "skill" | "subagent" | "command"; harness: "claude"; body: string; label: string }
// cron payload 계약(loader.ts) — { schedule, run:{ kind, prompt?, prompt_asset? } }.
interface CronPayload { schedule: string; run: { kind: string; prompt?: string; prompt_asset?: string } }

// 한 kind 의 전개/회수 한 쌍. appId·ctx 는 배선 클로저가 주입한다.
interface KindHandler {
  deploy(appId: string, item: DeployItem, ctx: WriteCtx): Promise<void>;
  reclaim(appId: string, comp: AppComponentRef, ctx: WriteCtx): Promise<void>;
}

// 저널만 있는 kind(ui/section/data) — 실전개 없음. addComponent 가 이미 기록했고 회수도 조인 제거로 끝난다.
const NOOP_HANDLER: KindHandler = {
  async deploy() { /* 저널만 — 실전개 없음 */ },
  async reclaim() { /* 저널만 — 조인 제거는 removeComponent 가 한다 */ },
};

const KIND_HANDLERS: Record<string, KindHandler> = {
  // ── 하네스 자산 — org_harness_asset upsert. id=앱스코프 ref(cross-app 충돌 회피), enabled=true. ──
  harness_asset: {
    async deploy(_appId, item, ctx) {
      const p = item.payload as HarnessAssetPayload;
      await upsertOrgHarnessAsset(
        { id: item.comp.ref, kind: p.kind, harness: "claude", body: p.body, label: p.label, enabled: true },
        ctx,
      );
    },
    async reclaim(_appId, comp, ctx) {
      await removeOrgHarnessAsset(comp.ref, ctx);
    },
  },

  // ── 호스트 — url_allowlist 병합(deny-all 기본). ref 은 이미 소문자(planDeclaredComponents). ──
  host: {
    async deploy(_appId, item, ctx) {
      const host = item.comp.ref;
      const cfg = await getRuntimeConfig();
      if (!cfg.url_allowlist.includes(host)) {
        await updateRuntimeConfig({ url_allowlist: [...cfg.url_allowlist, host] }, ctx.actor, ctx.source);
      }
    },
    async reclaim(appId, comp, ctx) {
      // 다른 앱이 같은 호스트를 아직 참조하면(hostReferenceCount>0) 회수하지 않는다(공유 자산 보호, design R1-F5).
      if ((await hostReferenceCount(comp.ref, appId)) > 0) return;
      const cfg = await getRuntimeConfig();
      if (cfg.url_allowlist.includes(comp.ref)) {
        await updateRuntimeConfig({ url_allowlist: cfg.url_allowlist.filter((h) => h !== comp.ref) }, ctx.actor, ctx.source);
      }
    },
  },

  // ── 크론 — agent_headless 잡. id = 앱스코프 ref(안정 문자열 PK) → reclaim 은 그 id 로 삭제. ──
  //  재전개는 upsertCronJob — 정의만 갱신하고 **last_run_at 을 보존**한다(종전 delete+insert 는 이력이 사라져
  //  interval 잡이 업그레이드 직후 즉시 돌았다 — #1780 v2 §7-1, 설계 R2-O5).
  cron: {
    async deploy(appId, item, ctx) {
      const p = item.payload as CronPayload;
      const run = p.run ?? { kind: "", prompt: undefined, prompt_asset: undefined };
      const prompt = (run.prompt && run.prompt.trim()) ? run.prompt : (run.prompt_asset ?? "");
      if (!prompt) throw new HttpError(500, `크론 잡 프롬프트가 비어 있습니다: ${item.comp.ref}`);
      await upsertCronJob({
        id: item.comp.ref,
        label: item.comp.orig_name ? `앱 잡: ${item.comp.orig_name}` : item.comp.ref,
        action: "agent_headless",
        // params.app_component_ref = comp.ref — reclaim 이 이 잡을 찾는 앵커(id 도 같은 값이라 이중 보증).
        params: JSON.stringify({ prompt, app_id: appId, app_component_ref: item.comp.ref }),
        interval_sec: 600,          // cron_expr 이 있으면 스케줄러가 그걸 우선(interval 은 미사용 폴백값)
        cron_expr: p.schedule,
        enabled: true,
        note: null,
        run_once: false,
        actor: ctx.actor ?? null,
      });
    },
    async reclaim(_appId, comp) {
      await deleteCronJob(comp.ref); // 멱등 — 없는 id 도 에러 아님
    },
  },

  // ── MCP 서버 — org_mcp_server upsert. name = 앱스코프 ref(payload.name 아님 — cross-app 이름 충돌 회피). ──
  mcp_server: {
    async deploy(_appId, item, ctx) {
      const preset = (item.payload ?? {}) as Record<string, unknown>;
      await upsertMcpServer({ ...preset, name: item.comp.ref } as McpServerInput, ctx.actor, ctx.source);
    },
    async reclaim(_appId, comp, ctx) {
      await removeMcpServer(comp.ref, ctx.actor, ctx.source);
    },
  },

  // ── HTTP 툴 — org_tool upsert. name = 앱스코프 ref. ──
  tool: {
    async deploy(_appId, item, ctx) {
      const preset = (item.payload ?? {}) as Record<string, unknown>;
      await upsertTool({ ...preset, name: item.comp.ref } as OrgToolInput, ctx);
    },
    async reclaim(_appId, comp, ctx) {
      await removeTool(comp.ref, ctx);
    },
  },

  ui_page: NOOP_HANDLER,
  ui_widget: NOOP_HANDLER,
  section: NOOP_HANDLER,
  data_table: NOOP_HANDLER,
};

/** 이 kind 를 전개 실행기가 다루는가(순수 — 디스패치 표 자체를 테스트하는 진입점). */
export function deployKindHandled(kind: string): boolean {
  return Object.prototype.hasOwnProperty.call(KIND_HANDLERS, kind);
}

function handlerFor(kind: string): KindHandler {
  const h = KIND_HANDLERS[kind];
  if (!h) throw new HttpError(500, `미지원 전개 kind: ${kind}`);
  return h;
}

/**
 * 설치 오케스트레이터(runInstall)가 소비할 InstallDeps 를 스토어 호출로 배선한다.
 *  appId 는 addComponent·setStatus·deploy 의 앱 스코프, ctx 는 감사(actor/source)를 나른다.
 */
export function makeDeployDeps(appId: string, ctx: WriteCtx): InstallDeps {
  return {
    async upsertApp(meta, status) {
      await upsertApp(
        { id: meta.id, title: meta.title, version: meta.version, manifest: meta.manifest, source: meta.source, content_hash: meta.content_hash, status },
        ctx,
      );
    },
    async setStatus(id, status) {
      await setAppStatus(id, status, ctx);
    },
    async addComponent(id, comp) {
      await addComponent(id, comp.kind, comp.ref, comp.orig_name ?? null);
    },
    async removeComponent(id, comp) {
      await removeComponent(id, comp.kind, comp.ref);
    },
    async deploy(item) {
      await handlerFor(item.comp.kind).deploy(appId, item, ctx);
    },
    async reclaim(comp) {
      // 미지 kind 는 **회수를 막지 않는다** — 실전개가 뭔지 모르니 손대지 않고(경고), 조인 제거(removeComponent)만 남긴다.
      //  롤백 시 v2 가 심은 구성요소가 여기 걸린다; 그 실전개 흔적은 v2 다운 런북이 정리한다(설계 §7 v3).
      const h = KIND_HANDLERS[comp.kind];
      if (!h) { logger.warn({ app: appId, kind: comp.kind, ref: comp.ref }, "app reclaim: unknown component kind — join removed only"); return; }
      await h.reclaim(appId, comp, ctx);
    },
  };
}
