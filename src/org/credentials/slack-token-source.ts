// 수집기의 슬랙 토큰 출처 해소(#1881) — 붙여넣기 대신 **금고**에서 토큰을 꺼내 쓴다.
//
//  왜: 라이블리 Slack 앱으로 [Slack 연결] 한 번이면 유저 토큰(그 사람 금고)과 봇 토큰(조직 슬롯)이 이미 금고에 있다.
//  수집기가 그걸 그대로 읽으면 토큰을 **복사하는 단계가 사라진다**(복사가 있으면 재연결 때 두 곳이 어긋난다).
//  `org_collector.config.token_source` 의 값이 출처다:
//    · `member:<id>` — 그 구성원이 연결한 유저 토큰 → 검색 스윕(전 공개채널). "팀 자료로 모으기"를 켠 관리자의 것.
//    · `bot` / `bot:<team_id>` — 조직 슬롯의 봇 토큰 → 봇 초대 채널 스윕(비공개 포함). 워크스페이스가 둘이면 team_id 로 지목.
//    · 비움 — 종전대로(붙여넣기 칸·env). 무회귀.
//  출처를 **명시했으면 그 출처만** 쓴다 — 금고에 없다고 붙여넣기 값으로 조용히 떨어지면 "연결한 사람이 나갔는데 옛
//  토큰으로 계속 긁는" 꼴이 된다. 없으면 둘 다 비워 커넥터가 "연결 없음" 으로 분명히 실패하게 둔다(커서 동결).
import { getMemberSecret, listSecretsByKindPublic, memberOwner, GATEWAY_OWNER } from "./member-secret-store.js";
import { SLACK_BOT_KIND } from "./slack-oauth.js";

export interface SlackTokenResolution { user_token?: string; bot_token?: string; warning?: string }

/** 금고 조회를 주입받는 순수 해소 — 테스트가 DB 없이 표의 행을 전부 돈다. */
export interface SlackVaultReader {
  memberUserToken(memberId: string): Promise<string | null>;         // 그 멤버의 slack_oauth 블롭에서 access_token
  botTokens(): Promise<Array<{ team_id: string; token: string | null }>>; // gateway 소유 slack_bot 슬롯 전부(team_id=scope_key)
}

export async function resolveSlackTokenSource(source: string | undefined, vault: SlackVaultReader): Promise<SlackTokenResolution | null> {
  const s = String(source ?? "").trim();
  if (!s) return null; // 미지정 = 종전 경로
  if (s.startsWith("member:")) {
    const id = s.slice("member:".length).trim();
    if (!id) return { warning: "token_source 'member:' 뒤에 구성원 id 가 없습니다" };
    const tok = await vault.memberUserToken(id);
    return tok ? { user_token: tok } : { warning: `구성원 '${id}' 의 Slack 연결이 없습니다 — [외부 앱 연결 ▸ Slack] 에서 다시 연결하거나 다른 관리자로 바꾸세요` };
  }
  if (s === "bot" || s.startsWith("bot:")) {
    const want = s.startsWith("bot:") ? s.slice(4).trim() : "";
    const all = (await vault.botTokens()).filter((b) => b.token);
    const pick = want ? all.filter((b) => b.team_id === want) : all;
    if (pick.length === 0) return { warning: want ? `워크스페이스 '${want}' 의 Lively 봇 토큰이 없습니다 — 그 워크스페이스에서 [Slack 연결]을 먼저 하세요` : "Lively 봇 토큰이 없습니다 — 관리자가 [Slack 연결]을 먼저 하면 봇 토큰이 함께 저장됩니다" };
    if (pick.length > 1) return { warning: `Slack 워크스페이스가 ${pick.length}개 연결돼 있어 어느 봇을 쓸지 모릅니다 — token_source 를 'bot:<team_id>' 로 지목하세요(${pick.map((b) => b.team_id).join(", ")})` };
    return { bot_token: pick[0].token as string };
  }
  return { warning: `알 수 없는 token_source '${s}' — member:<id> · bot · bot:<team_id> 중 하나여야 합니다` };
}

/** 실제 금고 리더 — 커넥터 설정 해소(config.ts)가 쓴다. */
export const vaultReader: SlackVaultReader = {
  async memberUserToken(memberId) {
    const r = await getMemberSecret(memberOwner(memberId), "slack_oauth", "").catch(() => null);
    if (!r?.secret) return null;
    try { const t = JSON.parse(r.secret) as { access_token?: unknown }; return typeof t.access_token === "string" && t.access_token ? t.access_token : null; }
    catch { return null; }
  },
  async botTokens() {
    const rows = await listSecretsByKindPublic(SLACK_BOT_KIND).catch(() => []);
    const out: Array<{ team_id: string; token: string | null }> = [];
    for (const row of rows) {
      if (row.owner !== GATEWAY_OWNER || !row.has_secret) continue;
      const r = await getMemberSecret(GATEWAY_OWNER, SLACK_BOT_KIND, row.scope_key).catch(() => null);
      out.push({ team_id: row.scope_key, token: r?.secret ?? null });
    }
    return out;
  },
};
