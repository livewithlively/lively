// delivery ▸ harness-assets — 스킬·서브에이전트·슬래시커맨드 CRUD + 개인 오버라이드(runtime 권한).
import type { Capability, CapabilityCtx } from "../types.js";
import { z } from "zod";
import { HttpError } from "../rest-util.js";
import type { LivelyUser } from "../../context.js";
import { MEANING } from "../../org/delivery/meaning.js";
import path from "node:path";
import { DEFAULT_SKILLS } from "../../org/delivery/default-content.js"; // #878 시딩 스킬 편집 경고(seed_warning)
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { assertHookId, assertAssetId } from "../../org/asset-id.js";
import { assertNoHardSecrets } from "../../org/ingest/redact.js";
import {
  listMembers, listOrgHarnessAssets, listEnabledAssets, upsertOrgHarnessAsset, removeOrgHarnessAsset, listAssetPrefs, setAssetPref,
  clearAssetPref, clearAssetPrefs, getOrgHook, getOrgHarnessAsset, type AssetPrefKind, type HookHarness, type AssetKind
} from "../../org/store.js";
import { effectiveVisible, targetsMember } from "../../org/asset-visibility.js"; // #699 per-member 유효 가시성 규칙(SoT)
import { HARNESS_ASSET_KINDS, HOOK_HARNESSES, HOOK_HARNESSES_MSG, assertPrefKind, parseAssetFrontmatter, parseTargetMembers, restRead, restRuntime, slug, str, wctx } from "./shared.js";

// ── 시딩 스킬 편집 경고(#878) — 지식 seedSyncWarning(knowledge.ts)과 대칭. 시딩되는 스킬(org_harness_asset)을
//  이 게이트웨이에서 고치면, 고객이 받는 본문의 SoT 는 이 DB 가 아니라 src/org/delivery/default-content.ts(capture 스냅샷)다.
//  시딩이 "손 안 댄 것 갱신"(#878)이라 canonical 에서 capture 후 릴리스하면 고객에 전파되지만, capture 를 빠뜨리면
//  반영되지 않는다 → 그 리마인더. 경고는 seed 소스(src/)가 있는 canonical 체크아웃에서만 뜬다(고객 릴리스 번들엔
//  src/ 없음 — 내부 경로 노출 방지, 지식 경고와 동일 스코핑).
const SEEDED_SKILL_IDS = new Set(DEFAULT_SKILLS.map((s) => s.id));
const SEED_ASSET_SOURCE_PRESENT = fs.existsSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "src", "org", "delivery", "default-content.ts"));
function seedAssetSyncWarning(id: string | null | undefined): { seed_warning?: string } {
  if (!SEED_ASSET_SOURCE_PRESENT || !id || !SEEDED_SKILL_IDS.has(id)) return {};
  return { seed_warning: `⚠ '${id}' 은 신규 고객 게이트웨이에 시딩되는 스킬입니다(#713). 고객이 받는 본문의 SoT 는 이 게이트웨이 DB 가 아니라 src/org/delivery/default-content.ts(capture 스냅샷)입니다 — 이 편집을 고객 배포에 반영하려면 canonical 게이트웨이에서 \`node --env-file=.env scripts/capture-default-content.mjs\` 로 default-content.ts 를 재생성·릴리스하세요(내부 [[링크]]·이슈번호·사내 명칭·타 고객사명은 빼고 고객 맥락으로 — CI 가드가 잡습니다). 미갱신 시 신규 고객은 옛 본문을 받습니다.` };
}

export const harnessAssetsCapabilities: Capability[] = [
  // ════════ 하네스 자산 CRUD (스킬·서브에이전트·슬래시커맨드 — runtime 권한) ════════
  //  훅과 같은 runtime 자산군이나 멤버 디스크에 파일로 materialize(하네스가 스캔해야 발견). 회수=fail-OPEN(capability —
  //  게이트웨이 블립에 스킬 상실 방지), 위험 enforcement 는 paired_hook(fail-CLOSED 런너)이 담당. 멤버 fetch=org_runner_assets(별도).
  restRuntime("org_harness_assets", "스킬·서브에이전트·커맨드 목록",
    "조직 스킬·서브에이전트·슬래시커맨드 전체(본문 포함) — runtime 권한 전용. 멤버 materializer fetch 는 org_runner_assets(별도).",
    [{ method: "GET", paths: ["/api/ui/org/harness-assets"], parse: () => ({}) }],
    async () => ({ assets: await listOrgHarnessAssets(), meaning: MEANING["harness-asset"] })),
  restRuntime("org_harness_asset_upsert", "스킬·서브에이전트·커맨드 추가·수정",
    "구성원 하네스에 배포되는 스킬/서브에이전트/커맨드를 저장한다(runtime). 본문은 멤버 디스크에 materialize 되며 스킬은 도구·셸 실행권한을 가질 수 있다(위험 통제=짝훅).",
    [{ method: "POST", paths: ["/api/ui/org/harness-asset"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser, ctx?: CapabilityCtx) => {
      const id = assertAssetId(input.id);
      // 미전송 = 기존 유지(부분수정 안전). 전송했을 때만 검증한다.
      const kind = input.kind === undefined ? undefined : str(input.kind, "kind", 12);
      if (kind !== undefined && !HARNESS_ASSET_KINDS.has(kind)) throw new HttpError(400, `kind 는 ${[...HARNESS_ASSET_KINDS].join("|")} 만 허용됩니다`);
      const harness = input.harness === undefined ? undefined : str(input.harness, "harness", 12);
      if (harness !== undefined && !HOOK_HARNESSES.has(harness)) throw new HttpError(400, HOOK_HARNESSES_MSG);
      // ⚠ 부분수정 보존 — 미전송 필드는 **undefined 로 넘겨 기존 값을 지킨다**. 예전엔 `input.x ?? ""` 라
      //  summary 만 고치려고 id+summary 만 보내면 description·body 가 빈 문자열로 덮여 **본문이 날아갔다**.
      //  (store 의 `a.field ?? before.field` 는 undefined 일 때만 보존한다.)
      const description = input.description === undefined ? undefined : str(input.description, "description", 2000);
      // summary — 관리탭·구성원 화면에 보이는 '쉬운 한 줄'(#1085). description(하네스가 언제 쓸지 판단하는
      //  트리거 문장)을 그대로 보여주면 무슨 기능인지 안 읽혀서 표시용을 따로 받는다.
      const summary = input.summary === undefined ? undefined : str(input.summary, "summary", 300);
      const body = input.body === undefined ? undefined : str(input.body, "body", 262144);
      const frontmatter = input.frontmatter === undefined ? undefined : parseAssetFrontmatter(input.frontmatter);
      if (description !== undefined) assertNoHardSecrets(description, "description");
      if (body !== undefined) assertNoHardSecrets(body, "body"); // 자산 본문도 멤버 디스크로 나가므로 평문 시크릿 hard-block
      if (frontmatter !== undefined) assertNoHardSecrets(JSON.stringify(frontmatter), "frontmatter");
      const targetMembers = input.target_members === undefined ? undefined : parseTargetMembers(input.target_members);
      const pairedHookId = input.paired_hook_id === undefined ? undefined
        : ((input.paired_hook_id === null || input.paired_hook_id === "") ? null : assertHookId(input.paired_hook_id));
      const asset = await upsertOrgHarnessAsset({
        id, kind: kind as AssetKind | undefined,
        label: input.label == null ? undefined : str(input.label, "label", 200).trim(),
        harness: harness as HookHarness | undefined, description, summary, body, frontmatter,
        target_members: targetMembers, paired_hook_id: pairedHookId,
        enabled: input.enabled === undefined ? undefined : Boolean(input.enabled),
        sort: input.sort === undefined ? undefined : Number(input.sort) || 0,
      }, wctx(user, ctx));
      return { asset, ...seedAssetSyncWarning(id) };
    }, {
      id: z.string().describe("자산 id(슬러그) — 있으면 수정, 없으면 생성. 스킬이면 이 id 가 스킬 이름이 된다"),
      summary: z.string().optional().describe("화면에 보이는 쉬운 한 줄 설명(무슨 기능인지). 비우면 description 첫 문장으로 폴백"),
      kind: z.enum(["skill", "subagent", "command"]).optional().describe("자산 종류(기본 skill)"),
      body: z.string().optional().describe("자산 본문 — 멤버 디스크에 파일로 materialize 된다. 평문 시크릿 hard-block"),
      description: z.string().optional().describe("자산 설명(하네스가 소환 판단에 쓴다)"),
      frontmatter: z.record(z.unknown()).optional().describe("자산 frontmatter(키:값 객체, 32키 이하)"),
      harness: z.enum(["claude", "codex", "openclaw", "all"]).optional().describe("대상 하네스(기본 all)"),
      target_members: z.array(z.string()).nullable().optional().describe("이 자산을 받을 멤버 id 배열. null/빈=전원, 미전송=기존 유지(#699)"),
      paired_hook_id: z.string().nullable().optional().describe("짝훅 id — 자산의 위험 enforcement 담당(fail-CLOSED 런너)"),
      label: z.string().optional().describe("자산 라벨(표시명)"),
      enabled: z.boolean().optional().describe("활성 여부"),
      sort: z.number().optional().describe("정렬 순서"),
    }),
  restRuntime("org_harness_asset_remove", "스킬·서브에이전트·커맨드 제거",
    "스킬·서브에이전트·커맨드를 제거한다 — 다음 세션부터 materializer 가 멤버 디스크에서 제거한다(미접속 머신은 직전 상태 유지).",
    [{ method: "POST", paths: ["/api/ui/org/harness-asset/remove"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser, ctx?: CapabilityCtx) => {
      await removeOrgHarnessAsset(assertAssetId(input.id), wctx(user, ctx));
      return { ok: true };
    }, {
      id: z.string().describe("제거할 자산 id — 다음 세션부터 materializer 가 멤버 디스크에서 지운다(미접속 머신은 직전 상태 유지)"),
    }),
  // ── 멤버 초안 승격(#990) — 멤버가 올린 비활성 초안을 클린 id 조직 자산으로 복제·활성화하고 초안 제거. runtime(관리자). ──
  //  멤버 셀프업로드(me_harness_asset_draft)의 짝: 멤버는 비활성 초안만 올리고, 관리자가 여기서 검토·승격한다.
  restRuntime("org_harness_asset_adopt", "멤버 초안 자산을 조직 자산으로 승격",
    "멤버가 올린 비활성 초안(created_by 있는 enabled=false 자산)을 관리자가 정한 클린 id 의 조직 자산으로 복제·활성화하고, 원래 초안은 제거한다. 본문·종류·하네스·frontmatter 는 초안 그대로 옮기고 target_members·enabled 는 관리자가 정한다.",
    [{ method: "POST", paths: ["/api/ui/org/harness-asset/adopt"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser, ctx?: CapabilityCtx) => {
      const draftId = assertAssetId(input.draft_id);
      const draft = await getOrgHarnessAsset(draftId);
      if (!draft) throw new HttpError(404, "초안을 찾을 수 없습니다");
      if (draft.enabled || !draft.created_by) throw new HttpError(400, "이 자산은 멤버 초안이 아닙니다 — 승격은 비활성(enabled=false)·제출자(created_by) 있는 초안만 대상입니다");
      const newId = assertAssetId(input.new_id);
      if (newId === draftId) throw new HttpError(400, "new_id 는 초안 id 와 달라야 합니다 — 배포될 클린 id 를 정하세요");
      if (await getOrgHarnessAsset(newId)) throw new HttpError(409, `'${newId}' 자산이 이미 있습니다 — 다른 id 를 쓰세요`);
      const asset = await upsertOrgHarnessAsset({
        id: newId, kind: draft.kind, label: draft.label ?? undefined,
        harness: draft.harness, description: draft.description, body: draft.body, frontmatter: draft.frontmatter,
        target_members: parseTargetMembers(input.target_members) ?? null,
        paired_hook_id: null, // 짝훅은 관리자가 이후 upsert 로 붙인다(초안엔 없다)
        enabled: input.enabled === undefined ? true : Boolean(input.enabled),
      }, wctx(user, ctx));
      await removeOrgHarnessAsset(draftId, wctx(user, ctx)); // 승격됐으니 초안 제거(중복 방지)
      return { asset, adopted_from: draftId, submitted_by: draft.created_by, ...seedAssetSyncWarning(newId) };
    }, {
      draft_id: z.string().describe("승격할 멤버 초안 id(draft-…)"),
      new_id: z.string().describe("조직 자산으로 쓸 클린 id — 스킬이면 이 id 가 스킬 이름이 된다"),
      target_members: z.array(z.string()).nullable().optional().describe("대상 멤버 id 배열(null/빈=전원)"),
      enabled: z.boolean().optional().describe("활성 여부(기본 true — 바로 배포)"),
    }),

  // ── materializer fetch — 멤버 세션훅(session-preload)이 매 세션 호출. 인증된 멤버면 OK(scope null). ──
  //  멤버 머신이 파일로 materialize 하므로 body/frontmatter 를 받는다(관리 목록과 달리 redact 안 함). user.userId 로 per-member 타깃팅.
  restRead("org_runner_assets", "하네스 자산 fetch(materializer)",
    "멤버 materializer 가 현재 활성 하네스 자산(본문+frontmatter+content_hash)을 받아 디스크에 동기화한다. harness/kind 필터, 멤버별 타깃팅.",
    [{ method: "GET", paths: ["/api/ui/org/runner/assets"],
      parse: (req) => ({ harness: req.query.harness, kind: req.query.kind }) }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const harness = typeof input.harness === "string" && input.harness ? input.harness : undefined;
      const kind = typeof input.kind === "string" && input.kind ? input.kind : undefined;
      const memberId = user?.userId || null;
      const assets = await listEnabledAssets(harness, kind, memberId);
      return { assets: assets.map((a) => ({
        id: a.id, kind: a.kind, harness: a.harness, description: a.description,
        body: a.body, frontmatter: a.frontmatter, content_hash: a.content_hash, paired_hook_id: a.paired_hook_id,
      })) };
    },
    false, { harness: z.string().optional(), kind: z.string().optional() }),   // #1403 — types.ts input 규약

  // ── per-member 개인 오버라이드 (#699) — 관리자 일괄 조회·변경(runtime). 유효성=정책(enabled+target_members) 위 오버라이드. ──
  //  관리자는 대량 배포를 target_members(자산/훅 편집)로, 개별 예외/멤버 opt-in-out 은 아래 오버라이드로. 멤버 본인은 me/asset-pref.
  restRuntime("org_asset_prefs", "스킬·훅 개인 오버라이드 목록",
    "스킬·서브에이전트·커맨드·훅의 멤버별 개인 오버라이드(on/off) 전체 — 관리탭 일괄 조회용. target_kind/ref_id/member_id 로 필터.",
    [{ method: "GET", paths: ["/api/ui/org/asset-prefs"],
      parse: (req) => ({ target_kind: req.query.target_kind, ref_id: req.query.ref_id, member_id: req.query.member_id }) }],
    async (input: Record<string, unknown>) => {
      const filter: { target_kind?: AssetPrefKind; ref_id?: string; member_id?: string } = {};
      if (typeof input.target_kind === "string" && input.target_kind) filter.target_kind = assertPrefKind(input.target_kind);
      if (typeof input.ref_id === "string" && input.ref_id) filter.ref_id = input.ref_id.trim();
      if (typeof input.member_id === "string" && input.member_id) filter.member_id = input.member_id.trim().toLowerCase();
      return { prefs: await listAssetPrefs(filter) };
    }, {
      target_kind: z.enum(["harness_asset", "org_hook"]).optional().describe("대상 종류로 필터"),
      ref_id: z.string().optional().describe("자산/훅 id 로 필터"),
      member_id: z.string().optional().describe("멤버 id 로 필터"),
    }),
  restRuntime("org_asset_pref_set", "스킬·훅 개인 오버라이드 설정",
    "특정 멤버의 스킬/훅 개인 오버라이드를 설정(state=true=강제 on/false=강제 off)하거나 해제(clear=true=관리자 정책 기본값 복귀)한다.",
    [{ method: "POST", paths: ["/api/ui/org/asset-pref"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser, ctx?: CapabilityCtx) => {
      const targetKind = assertPrefKind(input.target_kind);
      const refId = targetKind === "org_hook" ? assertHookId(input.ref_id) : assertAssetId(input.ref_id);
      const memberId = slug(input.member_id, "member_id");
      if (input.clear === true) { await clearAssetPref(targetKind, refId, memberId, wctx(user, ctx)); return { ok: true, cleared: true }; }
      const pref = await setAssetPref(targetKind, refId, memberId, Boolean(input.state), wctx(user, ctx));
      return { pref };
    }, {
      target_kind: z.enum(["harness_asset", "org_hook"]).describe("오버라이드 대상 종류"),
      ref_id: z.string().describe("대상 자산/훅 id"),
      member_id: z.string().describe("오버라이드를 적용할 멤버 id"),
      state: z.boolean().optional().describe("true=강제 on, false=강제 off (clear=true 면 무시)"),
      clear: z.boolean().optional().describe("true=오버라이드 해제(관리자 정책 기본값으로 복귀)"),
    }),
  // 관리탭 [대상 구성원] 표(#860) — 자산/훅 1건 × 전 구성원의 정책 기본값·오버라이드·실효를 한 번에.
  //  실효는 **서버가** asset-visibility SoT 로 계산해 내려준다. 웹(web/tsconfig rootDir='.')이 src/ 를 import 못 해
  //  프론트가 규칙을 복제하면 그 파일이 금지한 4번째 구현이 되기 때문 — me_assets_get 과 같은 처방.
  //  ⚠ me_assets_get 은 enabled 자산만 다뤄 enabled:true 를 상수로 넘기지만, 여기는 비활성 자산도 보여주므로 실제 값을 넘긴다
  //   (그래야 '활성=끔 → 전원 미적용, 예외도 못 이김'이 표에 그대로 나온다).
  restRuntime("org_asset_members", "자산 구성원별 상태",
    "자산/훅 1건의 구성원별 상태 — 정책 기본값(byDefault) · 개인 오버라이드(override: true=강제 on/false=강제 off/null=없음) · 실효(effective=이 구성원이 실제로 받는가). 관리탭 '대상 구성원' 표용.",
    [{ method: "GET", paths: ["/api/ui/org/asset-members"],
      parse: (req) => ({ target_kind: req.query.target_kind, ref_id: req.query.ref_id }) }],
    async (input: Record<string, unknown>) => {
      const targetKind = assertPrefKind(input.target_kind);
      const refId = targetKind === "org_hook" ? assertHookId(input.ref_id) : assertAssetId(input.ref_id);
      const item = targetKind === "org_hook" ? await getOrgHook(refId) : await getOrgHarnessAsset(refId);
      if (!item) throw new HttpError(404, "대상 스킬/훅이 없습니다");
      const targetMembers = item.target_members ?? null;
      const prefBy = new Map((await listAssetPrefs({ target_kind: targetKind, ref_id: refId })).map((p) => [p.member_id, p.state]));
      const members = (await listMembers()).map((m) => {
        const override = prefBy.has(m.id) ? prefBy.get(m.id)! : null;
        // 가시성 정책(SoT)과 **비활성 구성원**은 직교한다 — asset-visibility 는 정책 레이어만 모델링하고 멤버 상태는 모른다.
        //  비활성 멤버는 인증 자체가 막혀(store.verifyDbToken: 멤버 비활성 → 토큰 무효, auth/sessions: 세션 무효)
        //  정책상 대상이어도 **아무것도 못 받는다**. effective 는 '실제로 받는가'라는 질문이므로 둘을 AND 해야
        //  화면이 거짓말하지 않는다(정책만 보면 퇴사자가 '적용 중'으로 뜬다). SoT 규칙 재구현이 아니라 직교한 전제의 AND.
        const visible = effectiveVisible({ enabled: item.enabled, targetMembers, memberId: m.id, override });
        return {
          id: m.id, kind: m.kind, display_name: m.display_name, state: m.state,
          byDefault: targetsMember(targetMembers, m.id),
          override,
          effective: m.state === "active" && visible,
        };
      });
      return { policy: { enabled: item.enabled, target_members: targetMembers, harness: item.harness }, members };
    }, {
      target_kind: z.enum(["harness_asset", "org_hook"]).describe("대상 종류"),
      ref_id: z.string().describe("대상 스킬/훅 id"),
    }),
  restRuntime("org_asset_prefs_clear", "자산 오버라이드 일괄 해제",
    "자산/훅 1건의 구성원 오버라이드를 전부 제거해 전원이 관리자 정책(enabled+target_members)을 따르게 한다 — 관리탭 '전체 기본값 복귀'. 정책 자체는 안 건드린다.",
    [{ method: "POST", paths: ["/api/ui/org/asset-prefs/clear"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser, ctx?: CapabilityCtx) => {
      const targetKind = assertPrefKind(input.target_kind);
      const refId = targetKind === "org_hook" ? assertHookId(input.ref_id) : assertAssetId(input.ref_id);
      return { ok: true, cleared: await clearAssetPrefs(targetKind, refId, wctx(user, ctx)) };
    }, {
      target_kind: z.enum(["harness_asset", "org_hook"]).describe("대상 종류"),
      ref_id: z.string().describe("대상 스킬/훅 id"),
    }),
];
