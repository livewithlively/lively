// 자격 ↔ 수집기 연결표 — 금고의 어느 칸(kind)이 어느 수집기(preset)를 돌리는가. «주인 잃은 수집기» 를 막는 정본.
//
//  겨누는 고장(2026-10-29 원준님 «조테로 연결 지웠는데 외부 앱 연결에 계속 있다»): 수집기는 켤 때만 자격을 확인하고
//   (member-collect 불변식 ③) 그 뒤 키를 지우는 길(금고 삭제)은 그 키에 기대는 수집기를 몰랐다. 그래서 키가 사라져도
//   enabled 깃발이 남고, 화면은 그 깃발만 보고 «모으는 중» 이라 했다. 고치는 자리는 둘이다:
//   ① 금고에서 칸이 지워지면 그 칸으로 돌던 수집기를 끈다(stopOrphanedCollectors — deleteMemberSecret 이 부른다).
//      끄기 = enabled:false(삭제 아님) — 커서·자료가 남고, 다시 연결해 켜면 이어받는다(member-collect 불변식 ②).
//   ② 상태 계산은 깃발이 아니라 «그 사람이 아직 키를 쥐고 있나» 를 본다(connect-status 의 probe) — ①이 닿지 않은
//      옛 수집기·다른 길로 지워진 칸도 화면이 거짓말하지 않게.
//  노션은 워크스페이스 단위 연결이라 끊기(org_notion_workspace_disconnect)가 이미 수집기를 먼저 끈다 — 이 표에 없다.
import { listCollectors, upsertCollector, type CollectorView } from "../store/collectors.js";
import { listMemberSecretsPublic, GATEWAY_OWNER, type MemberSecretPublic } from "./member-secret-store.js";
import { resetConnectorConfigCache } from "../../connectors/config.js";
import { FIGMA_TOKEN_KIND } from "./figma-token-source.js";
import { CLICKUP_TOKEN_KIND, ZOTERO_TOKEN_KIND } from "./plain-token-source.js";
import { GITHUB_TOKEN_KIND } from "./github-token-source.js";
import { GITLAB_TOKEN_KIND } from "./gitlab-token-source.js";
import { LINEAR_APP_KIND } from "./linear-oauth.js";
import { MICROSOFT_KIND } from "./microsoft-oauth.js";
import { GOOGLE_KIND, GOOGLE_LEGACY_KINDS } from "./google-oauth.js";

export interface CredentialLink {
  /** 이 수집기들을 돌리는 금고 kind 들 — 하나라도 남아 있으면 연결로 본다(구글: 통합 kind + 옛 서비스별 kind). */
  kinds: readonly string[];
  /** org_collector.preset_key. */
  presets: readonly string[];
  /** true 면 scope_key 를 가리지 않는다(github_pat·gitlab_pat: 호스트마다 칸). 아니면 scope_key '' 칸만 본다. */
  anyScope?: boolean;
}

//  새 토큰 앱을 붙일 때 여기 한 줄 — 빠지면 그 앱은 키를 지워도 수집기가 켜진 채 남는다(connect-status 는 ②로 막는다).
export const COLLECTOR_CREDENTIAL_LINKS: readonly CredentialLink[] = [
  { kinds: [FIGMA_TOKEN_KIND], presets: ["figma"] },
  { kinds: [CLICKUP_TOKEN_KIND], presets: ["clickup"] },
  { kinds: [ZOTERO_TOKEN_KIND], presets: ["zotero"] },
  { kinds: [GITHUB_TOKEN_KIND], presets: ["github"], anyScope: true },
  { kinds: [GITLAB_TOKEN_KIND], presets: ["gitlab"], anyScope: true },
  { kinds: [LINEAR_APP_KIND], presets: ["linear"] },
  { kinds: [MICROSOFT_KIND], presets: ["outlook"] },
  //  슬랙 봇 수집기는 token_source=bot 이라 member:<id> 로 걸러지지 않는다 — 여기 걸리는 건 검색(사람 연결) 수집기뿐.
  { kinds: ["slack_oauth"], presets: ["slack"] },
  { kinds: [GOOGLE_KIND, ...GOOGLE_LEGACY_KINDS], presets: ["gdrive", "gmail"] },
];

/** 금고 owner → 수집기 config.token_source 값. 구성원 칸은 owner 문자열이 곧 token_source 다(member:<id>). */
export function tokenSourceOfOwner(owner: string): string {
  return owner === GATEWAY_OWNER ? "org" : owner;
}

/** 이 칸들(공개 목록 — PKCE·클라이언트 칸은 이미 빠져 있다)에 그 연결의 키가 아직 있는가 — 순수. */
export function holdsCredential(rows: readonly Pick<MemberSecretPublic, "kind" | "scope_key" | "has_secret">[], link: CredentialLink): boolean {
  return rows.some((r) => r.has_secret && link.kinds.includes(r.kind) && (link.anyScope || r.scope_key === ""));
}

/** 지워진 칸 하나로 꺼야 할 수집기 — 순수. 남은 칸이 같은 연결을 이으면(호스트가 둘인 깃랩 등) 끄지 않는다. */
export function orphanedCollectors(
  collectors: readonly Pick<CollectorView, "id" | "preset_key" | "enabled" | "config">[],
  deletedKind: string, tokenSource: string, remaining: readonly Pick<MemberSecretPublic, "kind" | "scope_key" | "has_secret">[],
): number[] {
  const out: number[] = [];
  for (const link of COLLECTOR_CREDENTIAL_LINKS) {
    if (!link.kinds.includes(deletedKind) || holdsCredential(remaining, link)) continue;
    for (const c of collectors) {
      if (c.enabled && link.presets.includes(c.preset_key) && (c.config?.token_source ?? "") === tokenSource) out.push(c.id);
    }
  }
  return out;
}

/**
 * 금고 칸이 지워진 뒤 — 그 칸으로 돌던 수집기를 끈다. 끈 수집기 id 를 돌려준다. 연결표에 없는 kind 면 DB 를 읽지 않는다.
 *  actor 는 감사 기록용(구성원 칸이면 그 사람, 조직 칸이면 gateway).
 */
export async function stopOrphanedCollectors(owner: string, kind: string, source = "credential-delete"): Promise<number[]> {
  if (!COLLECTOR_CREDENTIAL_LINKS.some((l) => l.kinds.includes(kind))) return [];
  const remaining = await listMemberSecretsPublic(owner);
  const ids = orphanedCollectors(await listCollectors(), kind, tokenSourceOfOwner(owner), remaining);
  const actor = owner.startsWith("member:") ? owner.slice("member:".length) : owner;
  for (const id of ids) await upsertCollector({ id, enabled: false }, actor, source);
  if (ids.length) resetConnectorConfigCache();
  return ids;
}
