// delivery ▸ me-self — 인증된 구성원의 셀프 표면(내 프로필·온보딩·내 스킬/훅·로컬 하네스 인벤토리).
import { z } from "zod";
import type { Capability, CapabilityCtx } from "../types.js";
import { HttpError } from "../rest-util.js";
import type { LivelyUser } from "../../context.js";
import { assertHookId, assertAssetId, draftAssetId } from "../../org/asset-id.js";
import { assertNoHardSecrets } from "../../org/ingest/redact.js";
import {
  getMember, upsertMember, listOrgHooks, listOrgHarnessAssets, upsertOrgHarnessAsset, countMemberDraftAssets, listAssetPrefs,
  setAssetPref, clearAssetPref, getOrgHook, getOrgHarnessAsset, type AssetPrefKind, type HookHarness, type AssetKind,
  type LocalSessionMode
} from "../../org/store.js";
import { effectiveVisible, targetsMember } from "../../org/asset-visibility.js"; // #699 per-member 유효 가시성 규칙(SoT)
import { HARNESS_ASSET_KINDS, HOOK_HARNESSES, HOOK_HARNESSES_MSG, actorOf, assertPrefKind, parseAssetFrontmatter, restRead, str, wctx } from "./shared.js";

export const meProfileCapabilities: Capability[] = [
  // ── 본인 프로필 셀프 편집(우측 상단 '내 프로필') — 인증된 구성원이 자기 표시이름·개인레이어를 직접 수정. admin 불요. ──
  //  id 는 principal 에서 강제(타인 편집 불가). 표시이름·개인레이어(body_md)만 — 권한·이메일·상태·신원·kind 는 admin 전용(불변).
  restRead("me_profile_get", "내 프로필 조회",
    "현재 로그인한 구성원의 본인 프로필(표시이름·이메일·개인레이어)을 반환한다 — 우측 상단 '내 프로필' 모달용.",
    [{ method: "GET", paths: ["/api/ui/me/profile"], parse: () => ({}) }],
    async (_input: unknown, user: LivelyUser) => {
      const userId = user?.userId;
      if (!userId) throw new HttpError(401, "인증이 필요합니다");
      const m = await getMember(userId);
      // 이메일은 표시 전용(읽기) — 셀프 편집 대상 아님. 멤버행이 없어도 모달은 열리게 안전 폴백.
      return { id: userId, display_name: m?.display_name ?? null, nickname: m?.nickname ?? null, use_nickname: m?.use_nickname === true, email: m?.email ?? user.email ?? null, body_md: m?.body_md ?? "", avatar: m?.avatar ?? null, avatar_char: m?.avatar_char ?? null, avatar_color: m?.avatar_color ?? null };
    }),

  restRead("me_profile_update", "내 프로필 수정",
    "현재 로그인한 구성원이 본인 표시이름·개인레이어(body_md)를 직접 수정한다. id 는 principal 강제, 권한·이메일·상태·신원·kind 는 불변(admin 전용).",
    [{ method: "POST", paths: ["/api/ui/me/profile"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const userId = user?.userId;
      if (!userId) throw new HttpError(401, "인증이 필요합니다");
      // 셀프 편집은 기존 구성원행만 수정 — 없으면 생성하지 않는다(기본권한 멤버 자가생성 차단).
      const existing = await getMember(userId);
      if (!existing) throw new HttpError(404, "구성원 정보를 찾을 수 없습니다 — 관리자에게 문의하세요");
      // 표시이름: 미전송이면 보존(undefined), 빈 문자열이면 비우기.
      const displayName = input.display_name == null ? undefined : str(input.display_name, "display_name", 200).trim();
      // 닉네임(#762): 미전송이면 보존, 빈 문자열이면 지움(→ display_name 폴백). 정규화는 upsertMember 담당.
      const nickname = input.nickname == null ? undefined : str(input.nickname, "nickname", 80).trim();
      // 「이 닉네임을 내 이름으로 사용」(#1813) — 미전송이면 보존. 닉네임이 비면 저장 쪽(upsertMember)이 알아서 끈다.
      const useNickname = input.use_nickname === undefined ? undefined : input.use_nickname === true;
      // 개인레이어(body_md)는 합성 컨텍스트에 실리는 자유텍스트 — 평문 시크릿 hard-block(ctx_save 와 동일 choke-point).
      const memberBody = input.body_md == null ? undefined : str(input.body_md, "body_md", 20000);
      if (memberBody !== undefined) assertNoHardSecrets(memberBody, "body_md"); // P8
      // 아바타 — data:image data URL(클라이언트 128px 리사이즈). undefined=보존, null/''=이니셜로 되돌림.
      let avatar: string | null | undefined;
      if (input.avatar !== undefined) {
        const raw = input.avatar === null ? "" : str(input.avatar, "avatar", 300000).trim();
        if (raw && !/^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(raw)) {
          throw new HttpError(400, "이미지 형식이 올바르지 않습니다 (png·jpg·webp·gif)");
        }
        if (raw.length > 256 * 1024) throw new HttpError(400, "이미지가 너무 큽니다 — 더 작게 잘라 올려주세요");
        avatar = raw || null;
      }
      // 커스텀 글자·배경색(이미지 없을 때 폴백). undefined=보존, null/''=자동으로 되돌림. 값 정규화(글자 3자·색 #rrggbb만)는 upsertMember 가 담당.
      const avatarChar = input.avatar_char === undefined ? undefined : (input.avatar_char === null ? null : str(input.avatar_char, "avatar_char", 8).trim());
      const avatarColor = input.avatar_color === undefined ? undefined : (input.avatar_color === null ? null : str(input.avatar_color, "avatar_color", 32).trim());
      // id 만 principal 로 강제 — 그 외(권한·이메일·상태·신원·kind)는 넘기지 않아 upsertMember 가 전부 보존.
      const member = await upsertMember({ id: userId, display_name: displayName, nickname, use_nickname: useNickname, body_md: memberBody, avatar, avatar_char: avatarChar, avatar_color: avatarColor }, actorOf(user), "web-self");
      return { member: { id: member.id, display_name: member.display_name, nickname: member.nickname, use_nickname: member.use_nickname, email: member.email, body_md: member.body_md, avatar: member.avatar, avatar_char: member.avatar_char, avatar_color: member.avatar_color } };
    }),
];

export const meSelfCapabilities: Capability[] = [
  // ── 내 온보딩 현황 (#846/850) — 웹 #/start 페이지와 AI 스킬이 **같은 함수**를 읽는다(드리프트 0). ──
  //  ⚠ 상태의 SoT 는 computeMemberOnboarding 이지 화면이 아니다. 화면은 진입·완주 표면일 뿐.
  //  자동 판정(MCP 호출 이력·자격·레포)은 조회 시점 라이브 계산 — 보고로 거짓 완료를 만들 수 없다.
  restRead("me_onboarding_get", "내 온보딩 현황 조회",
    "현재 로그인한 구성원의 온보딩 진행 상태를 반환한다 — 스텝별 done/todo/skipped + 필수 여부 + 자동판정 여부 + 딥링크. 웹 온보딩 페이지와 AI 온보딩 스킬이 이 하나를 함께 읽는다.",
    [{ method: "GET", paths: ["/api/ui/me/onboarding"], parse: () => ({}) }],
    async (_input: unknown, user: LivelyUser) => {
      const userId = user?.userId;
      if (!userId) throw new HttpError(401, "인증이 필요합니다");
      const { computeMemberOnboarding } = await import("../../org/delivery/onboarding.js");
      return { status: await computeMemberOnboarding(userId) };
    }),

  restRead("me_onboarding_set", "내 온보딩 스텝 보고",
    "온보딩 스텝의 상태를 보고한다. **주 사용자는 AI 온보딩 스킬**이다 — 서버가 볼 수 없는 로컬 작업(예: 예전 AI 환경 이관)을 마치면 done 으로, 이관할 게 없으면 skipped 로 보고한다. 사용자가 웹에서 의도적으로 마킹할 때도 같은 경로를 쓴다. state: done|skipped|reset(reset=보고 취소 → 자동 판정으로 복귀). ⚠ 자동 판정되는 스텝은 실제 신호가 이기므로 보고로 거짓 완료를 만들 수 없다.",
    [{ method: "POST", paths: ["/api/ui/me/onboarding"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const userId = user?.userId;
      if (!userId) throw new HttpError(401, "인증이 필요합니다");
      const { isMemberStep, MEMBER_STEPS, computeMemberOnboarding } = await import("../../org/delivery/onboarding.js");
      const step = str(input.step, "step", 32).trim();
      if (!isMemberStep(step)) throw new HttpError(400, `step 은 ${MEMBER_STEPS.join("|")} 중 하나여야 합니다`);
      const state = str(input.state, "state", 12).trim();
      if (!["done", "skipped", "reset"].includes(state)) throw new HttpError(400, "state 는 done|skipped|reset 만 허용됩니다");
      const note = input.note == null ? undefined : (str(input.note, "note", 500).trim() || undefined);
      if (note) assertNoHardSecrets(note, "note"); // 보고 메모도 멤버 레코드에 남으므로 평문 시크릿 차단
      // by 는 표시용(누가 채웠는지) — 위조해도 무해하다. 기본은 self, 스킬이 ai 로 보낸다.
      const by = input.by === "ai" ? "ai" as const : "self" as const;
      const { setMemberOnboardingStep } = await import("../../org/store.js");
      await setMemberOnboardingStep(userId, step,
        state === "reset" ? null : { state: state as "done" | "skipped", at: new Date().toISOString(), by, note });
      return { status: await computeMemberOnboarding(userId) }; // 갱신된 현황을 바로 돌려준다(왕복 1회)
    }),

  // ── 내 스킬·훅 셀프 설정 (#699) — 인증된 멤버가 본인에게 배포되는 스킬·훅을 보고 본인 것만 opt-in/out. admin 불요(principal 강제). ──
  //  관리자 정책(enabled+target_members)이 기본값, 멤버는 본인 오버라이드로 조정. 자산은 시크릿이 아니라 발견/배포 대상 — 본인 opt-in 은 자기 세션에만 영향(안전).
  restRead("me_assets_get", "내 스킬·훅 조회",
    "현재 로그인한 구성원에게 배포되는 스킬·훅 목록과, 관리자 기본값 대비 본인 오버라이드 상태(effective/override/byDefault)를 반환한다 — 멤버 셀프 설정 화면용.",
    [{ method: "GET", paths: ["/api/ui/me/assets"], parse: () => ({}) }],
    async (_input: unknown, user: LivelyUser) => {
      const userId = user?.userId;
      if (!userId) throw new HttpError(401, "인증이 필요합니다");
      const [assets, hooks, prefs] = await Promise.all([listOrgHarnessAssets(), listOrgHooks(), listAssetPrefs({ member_id: userId })]);
      const prefMap = new Map(prefs.map((p) => [`${p.target_kind}:${p.ref_id}`, p.state]));
      const meta = (kind: AssetPrefKind, id: string, targetMembers: string[] | null) => {
        const key = `${kind}:${id}`;
        const override = prefMap.has(key) ? (prefMap.get(key) as boolean) : null; // null=오버라이드 없음(관리자 기본값)
        const byDefault = targetsMember(targetMembers, userId);
        // enabled 은 이미 필터됨(아래 .filter) → 유효성 = 오버라이드 우선, 없으면 기본값. store SQL CASE 와 동일 규칙.
        return { override, byDefault, effective: effectiveVisible({ enabled: true, targetMembers, memberId: userId, override }) };
      };
      return {
        skills: assets.filter((a) => a.enabled).map((a) => ({ id: a.id, kind: a.kind, label: a.label, description: a.description, harness: a.harness, paired_hook_id: a.paired_hook_id, ...meta("harness_asset", a.id, a.target_members) })),
        hooks: hooks.filter((h) => h.enabled).map((h) => ({ id: h.id, label: h.label, event: h.event, matcher: h.matcher, note: h.note, harness: h.harness, ...meta("org_hook", h.id, h.target_members) })),
      };
    }),
  restRead("me_asset_pref_set", "내 스킬·훅 설정",
    "현재 로그인한 구성원이 본인의 스킬/훅 개인 오버라이드를 on/off(state) 하거나 해제(clear=true=관리자 기본값 복귀)한다. member_id 는 principal 강제(타인 설정 불가). 없는/비활성 자산엔 불가(고아 방지).",
    [{ method: "POST", paths: ["/api/ui/me/asset-pref"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const userId = user?.userId;
      if (!userId) throw new HttpError(401, "인증이 필요합니다");
      if (user.tokenSource === "static") throw new HttpError(403, "정적 토큰으로는 설정할 수 없습니다 — 관리자에게 문의하세요");
      const targetKind = assertPrefKind(input.target_kind);
      const refId = targetKind === "org_hook" ? assertHookId(input.ref_id) : assertAssetId(input.ref_id);
      const exists = targetKind === "org_hook" ? await getOrgHook(refId) : await getOrgHarnessAsset(refId);
      if (!exists || exists.enabled === false) throw new HttpError(404, "대상 스킬/훅이 없거나 비활성입니다");
      const wc = { actor: actorOf(user), source: "web-self" };
      if (input.clear === true) { await clearAssetPref(targetKind, refId, userId, wc); return { ok: true, cleared: true }; }
      const pref = await setAssetPref(targetKind, refId, userId, Boolean(input.state), wc);
      return { pref };
    }),

  // ── 멤버 셀프 하네스 자산 업로드 (#990 MVP) — 누구나 '비활성 초안'만 올린다. 승격(활성화+타깃)은 관리자(runtime). ──
  //  왜 안전한가: enabled=false 를 서버가 **강제** → 마스터킬이라 아무에게도 배포 안 됨(asset-visibility, org_runner_assets 는
  //   enabled=true 만 fetch). id 는 서버가 `draft-<sha10(멤버)>-<slug>` 로 고정(사용자는 slug 만) → upsert ON CONFLICT 이 **내
  //   초안에만** 걸린다 = 조직 자산·타인 초안을 절대 덮을 수 없다(멤버해시라 한글 멤버 id 도 안전, 하이픈 모호성 없음).
  //   정적토큰 거부·멤버당 초안 상한. paired_hook 불가(훅=runtime), target 무시. 본문·라벨 시크릿 hard-block.
  //  관리자는 이 초안을 검토해 클린 id 로 승격한다(org_harness_asset_upsert). 로컬에 스킬 파일 직접 쓰는 것과 위험 동급.
  restRead("me_harness_asset_draft", "내 하네스 자산 초안 올리기(비활성)",
    "인증된 구성원이 스킬·서브에이전트·커맨드 **초안**을 올린다 — 서버가 항상 비활성(enabled=false)으로 저장하므로 아무에게도 배포되지 않는다. 관리자가 검토 후 활성화·타깃하면 배포된다. id 는 서버가 `draft-<멤버해시>-<slug>` 로 고정(조직 자산·타인 초안 보호). slug·kind·body 필수. 멤버당 초안 개수 상한. paired_hook·target 은 받지 않는다(승격 시 관리자가 정한다).",
    [{ method: "POST", paths: ["/api/ui/me/harness-asset"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser, ctx?: CapabilityCtx) => {
      const userId = user?.userId;
      if (!userId) throw new HttpError(401, "인증이 필요합니다");
      // 공유 관리테이블 write 라 정적(회수불가) 토큰 거부 — me_asset_pref_set 과 동일 관례(로컬 전용 me_harness_local_pref 와 다르다).
      if (user.tokenSource === "static") throw new HttpError(403, "정적 토큰으로는 초안을 올릴 수 없습니다 — 관리자에게 문의하세요");
      const slug = str(input.slug ?? "", "slug", 40).trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(slug)) throw new HttpError(400, "slug 는 소문자 영숫자·하이픈 1~40자(소문자·숫자로 시작)여야 합니다");
      const id = draftAssetId(userId, slug); // draft-<sha10(userId)>-<slug> — charset-safe(한글 멤버 id 포함), 조직/타인 자산과 충돌 불가
      // 이미 있으면 **내 것이고 아직 비활성일 때만** 갱신 — 승격(활성)된 자산이나 남의 것은 못 덮는다(방어적 이중잠금).
      const before = await getOrgHarnessAsset(id);
      if (before && before.created_by !== userId) throw new HttpError(409, "같은 이름의 초안이 이미 있습니다 — 다른 slug 를 쓰세요");
      if (before && before.enabled) throw new HttpError(409, "이미 활성화(승격)된 자산입니다 — 관리자에게 문의하세요");
      // 신규일 때만 쿼터 — 공유 테이블 무한적재 + 관리 검토화면 DoS 방지. 자기 초안 갱신은 개수 불변이라 통과.
      if (!before) {
        const DRAFT_CAP = 25;
        if (await countMemberDraftAssets(userId) >= DRAFT_CAP) throw new HttpError(429, `초안이 너무 많습니다(최대 ${DRAFT_CAP}개) — 관리자 검토·정리 후 다시 올려주세요`);
      }
      const kind = str(input.kind ?? "skill", "kind", 12);
      if (!HARNESS_ASSET_KINDS.has(kind)) throw new HttpError(400, `kind 는 ${[...HARNESS_ASSET_KINDS].join("|")} 만 허용됩니다`);
      const harness = input.harness === undefined ? "all" : str(input.harness, "harness", 12);
      if (!HOOK_HARNESSES.has(harness)) throw new HttpError(400, HOOK_HARNESSES_MSG);
      const label = input.label == null ? undefined : str(input.label, "label", 200).trim();
      const description = str(input.description ?? "", "description", 2000);
      const body = str(input.body ?? "", "body", 262144);
      if (!body.trim()) throw new HttpError(400, "body(자산 본문)가 필요합니다");
      const frontmatter = parseAssetFrontmatter(input.frontmatter);
      if (label) assertNoHardSecrets(label, "label");
      assertNoHardSecrets(description, "description");
      assertNoHardSecrets(body, "body");
      assertNoHardSecrets(JSON.stringify(frontmatter), "frontmatter");
      const asset = await upsertOrgHarnessAsset({
        id, kind: kind as AssetKind, label,
        harness: harness as HookHarness, description, body, frontmatter,
        target_members: null, // 무시 — 어차피 비활성. 승격 시 관리자가 타깃 지정.
        paired_hook_id: null,  // 멤버는 짝훅 못 붙인다(훅=runtime 권한).
        enabled: false,        // ★ 강제 비활성 — 마스터킬(아무에게도 안 감). 관리자만 켤 수 있다.
      }, wctx(user, ctx));
      return { asset, draft: true, note: "비활성 초안으로 저장됨 — 관리자가 검토 후 활성화하면 배포됩니다" };
    }),

  // ── 로컬 하네스 관측(#891 온보딩 C) — 세션훅 채널로 로컬↔라이블리 하네스를 웹에서 한눈에. 노드 불요. ──
  //  ⚠ 인벤토리는 **메타만**(id·kind·managed) — 스킬 본문·메모리는 서버로 안 온다(사생활·용량). 관측이지 보고 아님.
  restRead("me_harness_report", "로컬 하네스 인벤토리 보고(세션훅)",
    "멤버 세션훅(session-preload)이 매 세션 로컬 하네스 자산 메타(id·kind·managed 여부)를 push 한다. 서버는 마지막 관측만 보관하고 웹이 라이블리 자산과 대조한다. 스킬 본문·메모리 내용은 담지 않는다(hard).",
    [{ method: "POST", paths: ["/api/ui/me/harness-report"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const userId = user?.userId;
      if (!userId) throw new HttpError(401, "인증이 필요합니다");
      const rawAssets = Array.isArray(input.assets) ? input.assets : [];
      if (rawAssets.length > 500) throw new HttpError(400, "항목이 너무 많습니다(500 초과)"); // 스캐너 폭주 가드
      const KINDS = new Set(["skill", "subagent", "command", "hook"]);
      const seen = new Set<string>();
      const assets = [] as { id: string; kind: string; managed: boolean }[];
      for (const a of rawAssets as Record<string, unknown>[]) {
        const id = str(a?.id ?? "", "asset.id", 64).trim();
        const kind = str(a?.kind ?? "", "asset.kind", 12).trim();
        if (!id || !KINDS.has(kind)) continue;                 // 모르는 종류·빈 id 는 조용히 스킵(관측이라 관대)
        const key = `${kind}:${id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        assets.push({ id, kind, managed: Boolean(a?.managed) });
      }
      const defaultMode: LocalSessionMode = input.default_mode === "readonly" || input.default_mode === "incognito"
        ? input.default_mode : "normal";
      const snap = {
        at: new Date().toISOString(),
        host: input.host == null ? undefined : str(input.host, "host", 200).trim() || undefined,
        // #1711 — 종전 2분법(`codex ? codex : claude`)은 opencode·antigravity 세션의 보고를 전부 **claude 로 기록**해
        //  관리탭 [내 하네스]의 하네스 축을 틀리게 만들었다(보고 자체는 그 하네스에서 정상적으로 오고 있었다).
        //  화이트리스트로 받되 'all'(대상 지정자, 하네스 아님)은 제외하고, 모르는 값은 종전대로 claude 로 폴백한다.
        harness: typeof input.harness === "string" && input.harness !== "all" && HOOK_HARNESSES.has(input.harness)
          ? input.harness : "claude",
        default_mode: defaultMode,
        assets,
      };
      // machine_id — 한 멤버의 여러 PC 를 구분(훅이 ~/.lively/machine-id 에 UUID 생성). 없으면 host 로 폴백(구 훅 호환).
      const machineId = (input.machine_id == null ? "" : str(input.machine_id, "machine_id", 64).trim())
        || (snap.host ? `host:${snap.host}` : "unknown");
      const { setHarnessSnapshot } = await import("../../org/store.js");
      await setHarnessSnapshot(userId, machineId, snap);
      return { ok: true, count: assets.length, machine_id: machineId };
    }),

  restRead("me_harness_get", "내 하네스 한눈에(로컬+라이블리)",
    "라이블리가 배포하는 하네스 자산(me_assets)과 이 멤버의 **머신별** 로컬 관측을 함께 반환하고 겹치는 것을 대조한다 — 웹 '내 하네스' 화면용. machines[]: PC 마다 하나. overlap: managed(라이블리가 깐 것) · shadow(로컬 동명 파일이 라이블리 자산을 가림) · local-only(내 것).",
    [{ method: "GET", paths: ["/api/ui/me/harness"], parse: () => ({}) }],
    async (_input: unknown, user: LivelyUser) => {
      const userId = user?.userId;
      if (!userId) throw new HttpError(401, "인증이 필요합니다");
      const { getHarnessSnapshots, getHarnessLocalPref, getHarnessMachineAlias, getLocalModePreferences } = await import("../../org/store.js");
      const [assets, hooks, prefs, snaps, localPref, aliases, modePrefs] = await Promise.all([
        listOrgHarnessAssets(), listOrgHooks(), listAssetPrefs({ member_id: userId }), getHarnessSnapshots(userId), getHarnessLocalPref(userId), getHarnessMachineAlias(userId), getLocalModePreferences(userId),
      ]);
      const prefMap = new Map(prefs.map((p) => [`${p.target_kind}:${p.ref_id}`, p.state]));
      const meta = (kind: AssetPrefKind, id: string, targetMembers: string[] | null) => {
        const override = prefMap.has(`${kind}:${id}`) ? (prefMap.get(`${kind}:${id}`) as boolean) : null;
        return { override, byDefault: targetsMember(targetMembers, userId), effective: effectiveVisible({ enabled: true, targetMembers, memberId: userId, override }) };
      };
      const lively = {
        // summary — 화면에 보이는 '쉬운 한 줄'(#1085). description(하네스 트리거 문장)과 별개다.
        skills: assets.filter((a) => a.enabled).map((a) => ({ id: a.id, kind: a.kind, label: a.label, description: a.description, summary: a.summary, harness: a.harness, ...meta("harness_asset", a.id, a.target_members) })),
        hooks: hooks.filter((h) => h.enabled).map((h) => ({ id: h.id, label: h.label, event: h.event, note: h.note, summary: h.summary, harness: h.harness, ...meta("org_hook", h.id, h.target_members) })),
      };
      const livelyIds = new Set<string>([...lively.skills, ...lively.hooks].map((x) => x.id));
      // 머신별로 라이블리 자산과 대조 + 그 머신의 로컬 토글 지시(disabled) 반영.
      const machines = Object.entries(snaps)
        .map(([machineId, snap]) => {
          const disabled = localPref[machineId] || {};
          const list = (snap.assets ?? []).map((a) => ({
            ...a,
            overlap: livelyIds.has(a.id) ? (a.managed ? "managed" : "shadow") : "local-only",
            disabled: !!disabled[`${a.kind}:${a.id}`], // 이 머신에서 끄기로 지시됨(다음 세션 .disabled rename)
          }));
          return { machine_id: machineId, host: snap.host ?? null, alias: aliases[machineId] ?? null, harness: snap.harness ?? null, at: snap.at ?? null,
            default_mode: snap.default_mode ?? "normal", mode_pref: modePrefs[machineId] ?? null, assets: list };
        })
        .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? "")); // 최근 관측 머신 먼저
      return { lively, machines };
    }),

  restRead("me_local_mode_get", "이 컴퓨터의 라이블리 연결 기본값 조회",
    "`lively run`이 하네스를 띄우기 전에 이 머신의 웹 설정(normal|readonly|incognito)을 조회한다. 명시 설정이 없으면 mode=null — CLI의 마지막 로컬 값을 덮지 않는다.",
    [{ method: "GET", paths: ["/api/ui/me/local-mode"], parse: (req) => ({ machine_id: req.query?.machine_id }) }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const userId = user?.userId;
      if (!userId) throw new HttpError(401, "인증이 필요합니다");
      const machineId = str(input.machine_id ?? "", "machine_id", 64).trim();
      if (!machineId) throw new HttpError(400, "machine_id 가 필요합니다");
      const { getLocalModePreferences } = await import("../../org/store.js");
      return { machine_id: machineId, preference: (await getLocalModePreferences(userId))[machineId] ?? null };
    },
    false, { machine_id: z.string() }),

  restRead("me_local_mode_set", "이 컴퓨터의 라이블리 연결 기본값 설정",
    "웹 또는 `lively mode`가 특정 머신의 다음 세션 기본 연결 상태를 저장한다. 이미 열린 세션에는 영향을 주지 않는다.",
    [{ method: "POST", paths: ["/api/ui/me/local-mode"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const userId = user?.userId;
      if (!userId) throw new HttpError(401, "인증이 필요합니다");
      const machineId = str(input.machine_id ?? "", "machine_id", 64).trim();
      if (!machineId) throw new HttpError(400, "machine_id 가 필요합니다");
      const mode = str(input.mode ?? "", "mode", 16).trim();
      if (mode !== "normal" && mode !== "readonly" && mode !== "incognito") throw new HttpError(400, "mode 는 normal|readonly|incognito 만 허용됩니다");
      const { setLocalModePreference } = await import("../../org/store.js");
      return { machine_id: machineId, preference: await setLocalModePreference(userId, machineId, mode) };
    }),

  restRead("me_harness_local_pref", "로컬 하네스 파일 끄기/켜기(머신별)",
    "이 멤버의 특정 머신에서 로컬 하네스 파일을 끈다(disabled=true → 다음 세션에 세션훅이 .disabled 로 비파괴 rename)·켠다(false → 복원). 라이블리 스킬 opt-out(me_asset_pref)과 다르다: 그건 멤버 단위, 이건 그 머신의 로컬 파일만. machine_id·kind·id 필수.",
    [{ method: "POST", paths: ["/api/ui/me/harness-local-pref"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const userId = user?.userId;
      if (!userId) throw new HttpError(401, "인증이 필요합니다");
      // 정적 토큰 거부 안 함 — 본인 로컬 파일 비파괴 토글(me_onboarding_set 과 동급)이지 fleet 자산정책(me_asset_pref)이 아니다.
      const machineId = str(input.machine_id, "machine_id", 64).trim();
      if (!machineId) throw new HttpError(400, "machine_id 가 필요합니다");
      const assetId = str(input.id, "id", 64).trim();
      const kind = str(input.kind, "kind", 12).trim();
      if (!["skill", "subagent", "command"].includes(kind)) throw new HttpError(400, "kind 는 skill|subagent|command 만(로컬 파일 자산)");
      if (!assetId) throw new HttpError(400, "id 가 필요합니다");
      const { setHarnessLocalPref } = await import("../../org/store.js");
      await setHarnessLocalPref(userId, machineId, `${kind}:${assetId}`, Boolean(input.disabled));
      return { ok: true };
    }),

  restRead("me_harness_local_pref_plan", "이 머신의 로컬 끄기 계획(세션훅 pull)",
    "세션훅(sync-harness-assets)이 자기 machine_id 로 이 머신에서 꺼야 할 로컬 파일 목록을 받아 .disabled 로 rename 한다. 목록에 없으면 켜기(복원). machine_id 쿼리 필수.",
    [{ method: "GET", paths: ["/api/ui/me/harness-local-pref/plan"], parse: (req) => ({ machine_id: req.query?.machine_id }) }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const userId = user?.userId;
      if (!userId) throw new HttpError(401, "인증이 필요합니다");
      const machineId = str(input.machine_id ?? "", "machine_id", 64).trim();
      if (!machineId) throw new HttpError(400, "machine_id 가 필요합니다");
      const { getHarnessLocalPref } = await import("../../org/store.js");
      const pref = (await getHarnessLocalPref(userId))[machineId] || {};
      // "<kind>:<id>": true 인 것만 = 꺼야 할 것. 훅이 쓰기 쉽게 {kind,id} 로 풀어 준다.
      const disabled = Object.entries(pref).filter(([, v]) => v === true).map(([k]) => {
        const i = k.indexOf(":");
        return { kind: k.slice(0, i), id: k.slice(i + 1) };
      });
      return { disabled };
    },
    false, { machine_id: z.string() }),   // #1403 — types.ts input 규약(mcp:false 여도 parse 산출을 선언)

  restRead("me_harness_detail", "라이블리 하네스 자산 상세(본문)",
    "라이블리가 배포하는 스킬·서브에이전트·커맨드·훅의 **본문**을 반환한다 — 웹 '내 하네스 설정'에서 항목을 눌러 내용을 볼 때 lazy 로드. ⚠ 라이블리 배포분만: 로컬 자산 본문은 서버에 없다(메타만 관측). kind=skill|subagent|command 는 org_harness_asset.body, kind=hook 은 org_hook.source_code.",
    [{ method: "GET", paths: ["/api/ui/me/harness/detail"], parse: (req) => ({ kind: req.query?.kind, id: req.query?.id }) }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const userId = user?.userId;
      if (!userId) throw new HttpError(401, "인증이 필요합니다");
      const id = str(input.id ?? "", "id", 64).trim();
      const kind = str(input.kind ?? "", "kind", 12).trim();
      if (!id) throw new HttpError(400, "id 가 필요합니다");
      if (kind === "hook") {
        const h = await getOrgHook(id);
        if (!h || !h.enabled) throw new HttpError(404, "훅이 없거나 비활성입니다");
        return { id: h.id, kind: "hook", label: h.label, description: h.note ?? null, body: h.source_code ?? "", frontmatter: null };
      }
      // skill·subagent·command = org_harness_asset. 인증 멤버면 조회 OK(어차피 로컬로 배포되는 것 — redact 불요).
      const a = await getOrgHarnessAsset(id);
      if (!a || !a.enabled) throw new HttpError(404, "항목이 없거나 비활성입니다");
      return { id: a.id, kind: a.kind, label: a.label, description: a.description ?? null, body: a.body ?? "", frontmatter: a.frontmatter ?? null };
    },
    false, { kind: z.enum(["skill", "subagent", "command", "hook"]), id: z.string() }),   // #1403 — types.ts input 규약

  restRead("me_harness_machine_remove", "내 하네스 관측에서 이 컴퓨터 제거",
    "이 멤버의 하네스 관측·토글지시에서 한 머신(machine_id)을 통째로 뺀다. uninstall 이 서버 싱크로 부르거나(재설치 시 새 UUID 로 중복 방지), 웹에서 '이 컴퓨터 지우기'로 오래된 관측을 정리한다. machine_id 필수.",
    [{ method: "POST", paths: ["/api/ui/me/harness/machine-remove"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const userId = user?.userId;
      if (!userId) throw new HttpError(401, "인증이 필요합니다");
      const machineId = str(input.machine_id, "machine_id", 64).trim();
      if (!machineId) throw new HttpError(400, "machine_id 가 필요합니다");
      const { removeHarnessMachine } = await import("../../org/store.js");
      await removeHarnessMachine(userId, machineId);
      return { ok: true };
    }),

  restRead("me_harness_machine_alias", "내 컴퓨터에 별명 지정",
    "이 멤버의 특정 머신(machine_id)에 사용자 지정 별명을 붙이거나(alias 비우면 해제) 한다 — 웹 '내 스킬·훅'에서 PC 를 알아보기 쉽게. 관측(host)과 별개이고 세션 report 가 덮지 않는다. machine_id 필수, alias 40자 이내.",
    [{ method: "POST", paths: ["/api/ui/me/harness/machine-alias"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const userId = user?.userId;
      if (!userId) throw new HttpError(401, "인증이 필요합니다");
      // 정적 토큰 허용 — 본인 머신 별명(자기 메타)이지 fleet 정책이 아니다(me_harness_local_pref 과 동급).
      const machineId = str(input.machine_id, "machine_id", 64).trim();
      if (!machineId) throw new HttpError(400, "machine_id 가 필요합니다");
      const alias = (input.alias == null ? "" : str(input.alias, "alias", 40)).trim();
      if (alias) assertNoHardSecrets(alias, "alias");
      const { setHarnessMachineAlias } = await import("../../org/store.js");
      await setHarnessMachineAlias(userId, machineId, alias);
      return { ok: true, machine_id: machineId, alias: alias || null };
    }),
];
