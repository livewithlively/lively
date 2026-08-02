// delivery ▸ 관리탭 단일 로드(org_overview) — 화면 한 장을 그리는 REST 전용 표면(#1169).
//  payload 조립기는 각 도메인 모듈에서 import 한다(복제 금지 — 복제하면 화면과 메뉴 단위 API 가 갈린다).
import type { Capability } from "../types.js";
import type { LivelyUser } from "../../context.js";
import { MEANING } from "../../org/delivery/meaning.js";
import { toolCandidates } from "../../mcp/mcp-surface.js";
import {
  getOrgProfile, listTokens, getRuntimeConfig, listMcpServers, listOrgHooks, listOrgHarnessAssets, listAssetPrefs, listTools,
  listDbSources, listConnectors
} from "../../org/store.js";
import { envSourcesPayload, maskDbSource } from "./db-sources.js";
import { membersPayload } from "./members.js";
import { sectionsPayload } from "./org-content.js";
import { restRead } from "./shared.js";

// ── org_overview 와 메뉴 단위 툴이 **같은 모양**을 내도록 공유하는 조립기(#1169) ──
//  한쪽만 고쳐져 화면과 에이전트가 다른 것을 보게 되는 드리프트를 원천 차단한다.

export const overviewCapabilities: Capability[] = [
  // ── 단일 로드: 관리 화면 전체 상태 + 의미 가이드 ──
  restRead("org_overview", "조직 전달 개요",
    // ⚠ 이 툴은 **관리탭 화면 한 장을 그리기 위한 단일 로드**다(REST 전용, #1169 에서 MCP 노출 해제).
    //  예전 설명은 "프로필·섹션·구성원·메모리"만 말했지만 실제로는 아래 전부를 한 번에 쏟는다 — 에이전트가
    //  게이트웨이 주소 한 줄 때문에 이걸 부르던 것이 문제였다. 메뉴 단위 툴로 갈랐으니 MCP 에서는 그쪽을 쓴다.
    "관리탭 전체 상태를 한 번에 로드한다(웹 화면 전용) — profile·sections·sectionDefaults·writebackNoticeDefault·members·" +
    "tokens·runtimeConfig·mcpServers·connectors·dbSources·envSources·orgHooks·orgHarnessAssets·orgAssetPrefs·tools·builtins·toolPolicy·meaning. " +
    "admin 은 토큰·구성원 상세까지, 비-admin 은 읽기 전용(민감 필드 redact). " +
    "에이전트는 이걸 부르지 말고 필요한 메뉴 단위만 불러라 — org_profile · org_sections · org_members · org_tokens · org_connectors · " +
    "org_runtime_config · org_mcp_servers · org_db_sources · org_hooks · org_harness_assets · org_asset_prefs · org_tools. 링크용 게이트웨이 주소는 whoami.",
    [{ method: "GET", paths: ["/api/ui/org"], parse: () => ({}) }],
    async (_input: unknown, user: LivelyUser) => {
      const isAdmin = !!(user?.scopes && user.scopes.includes("admin"));
      const isRuntime = !!(user?.scopes && user.scopes.includes("runtime")); // 훅·툴 관리 권한(admin 과 분리)
      const [profile, sectionsPart, memberRows] = await Promise.all([
        getOrgProfile(), sectionsPayload(), membersPayload(isAdmin),
      ]);
      const { sections: sectionMap, sectionDefaults, writebackNoticeDefault } = sectionsPart;
      // admin 에겐 전체 token_hash 노출 — 회수 핸들로 필요. 해시는 비가역(평문 토큰 복원 불가)이라 안전.
      const tokens = isAdmin ? await listTokens() : [];
      const runtimeConfig = isAdmin ? await getRuntimeConfig() : null;
      const mcpServers = isAdmin ? await listMcpServers() : [];
      const connectors = isAdmin ? await listConnectors() : [];
      const dbSources = isAdmin ? await listDbSources() : [];
      const envSources = isAdmin ? await envSourcesPayload(new Set(dbSources.map((s) => s.name))) : [];
      // runtime 권한자: 커스텀 훅·툴 목록 + 빌트인 목록 + 툴 정책(allowlist — 시크릿 아님).
      const orgHooks = isRuntime ? await listOrgHooks() : [];
      const orgHarnessAssets = isRuntime ? await listOrgHarnessAssets() : [];
      const orgAssetPrefs = isRuntime ? await listAssetPrefs() : []; // #699: 멤버 개인 오버라이드(관리탭 '일괄 조회')
      const tools = isRuntime ? await listTools() : [];
      const rc = isRuntime ? (runtimeConfig ?? await getRuntimeConfig()) : null;
      const toolPolicy = isRuntime ? { allowed_auth_envs: rc!.allowed_auth_envs, url_allowlist: rc!.url_allowlist } : null;
      // (#1256) memory 필드 제거 — 구 org_memory 잔여 표면. 소비자 없이 이 응답의 79%(4.3MB)를 차지했고,
      //  #1247 과 같은 LIMIT-후-필터라 핀 목록으로 읽으면 조용히 잘렸다. 핀은 knowledge_list{is_wiki:true}.
      return {
        profile, sections: sectionMap, sectionDefaults, writebackNoticeDefault,
        members: memberRows, tokens, runtimeConfig, mcpServers, connectors,
        dbSources: dbSources.map(maskDbSource), envSources,
        orgHooks, orgHarnessAssets, orgAssetPrefs, tools, builtins: isRuntime ? toolCandidates() : [], toolPolicy,
        meaning: MEANING, canEdit: isAdmin, canRuntime: isRuntime,
      };
    }),
];
