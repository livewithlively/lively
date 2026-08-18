// 연결한 워크스페이스(#1750) — "이 사람이 이 워크스페이스에서 **다른 라이블리 워크스페이스**(보통 팀)로 올릴 수 있는 곳".
//  워크스페이스 1개 = 게이트웨이 1개(현 구조). 개인 워크스페이스는 팀 워크스페이스를 n개 연결하고, 연결마다 그 사람이
//  **팀 쪽에서 발급받은 자기 토큰**(lvk_ — 팀 게이트웨이의 자기 구성원 토큰, memory·context 스코프면 충분)을 맡긴다.
//  ⚠ 새 테이블이 아니다 — 토큰이 있는 것이라 member_secret(봉투 암호화 vault, kind='lively_workspace')에 산다.
//   scope_key = 원격 호스트(host[:port]) 하나가 한 연결. meta(평문 jsonb) = 이름·주소·종류·원격 멤버·auto_promote·상태.
//   그래서 관리탭 [내 자격] 목록에도 'lively_workspace' 로 보이고, 삭제·회전도 같은 vault 규약을 탄다.
//  outbound 는 SSRF 가드(makeSsrfFetch — 사설/loopback 은 allowed_internal_hosts 등록 시만, 자기 자신은 차단)로만 나간다.
//   개인 워크스페이스(매니지드) → 팀(셀프호스트 공개 주소 / 매니지드 테넌트) 이 정상 경로다. 사내망 팀 게이트웨이는 닿지 않는다(당연).
import { gatewayUrl } from "../../gateway-url.js";
import { makeSsrfFetch } from "../../net/mcp-ssrf-fetch.js";
import { getRuntimeConfig } from "./runtime-config.js";
import {
  deleteMemberSecret, getMemberSecret, listMemberSecretsPublic, memberOwner, setMemberSecret,
} from "../credentials/member-secret-store.js";

export const LINK_KIND = "lively_workspace";
const PROBE_TIMEOUT_MS = 8000;
const CALL_TIMEOUT_MS = 20000;

export interface LinkedWorkspace {
  scope_key: string;              // host[:port] — 연결 식별자(그 사람 안에서 유일)
  base_url: string;               // https://host[:port] (경로 없음)
  name: string;                   // 표시 이름(원격 org 이름 — 프로브가 채움, 사람이 덮어쓸 수 있음)
  kind: "personal" | "team" | null; // 원격이 자기 종류를 알려주면(신 코어) 그 값, 모르면 null(구 코어) — 화면은 '팀'으로 취급
  remote_member_id: string | null;  // 그 토큰의 원격 구성원 id(프로브 결과)
  remote_display_name: string | null;
  auto_promote: boolean;          // true = AI 의 승격 요청도 사람 승인 없이 즉시 실행(사람이 이 연결에 대해 '자동 허락'을 켠 것)
  state: "active" | "error";      // 마지막 프로브/호출 결과
  last_error: string | null;
  last_ok_at: string | null;
  has_token: boolean;
  created_at: string | null; updated_at: string | null;
}

// 주소 → 정규화 base_url + scope_key. https 만(내부 host 는 http 허용 — allowed_internal_hosts 가 SSRF 층에서 다시 검사한다).
export function parseWorkspaceUrl(raw: unknown): { base_url: string; scope_key: string } {
  const s = String(raw ?? "").trim();
  if (!s) throw new Error("워크스페이스 주소가 필요합니다(예: https://team.example.com)");
  let u: URL;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`); } catch { throw new Error(`워크스페이스 주소 형식 오류: ${s}`); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("워크스페이스 주소는 http(s) 만 됩니다");
  if (u.username || u.password) throw new Error("주소에 자격을 넣지 마세요 — 토큰은 별도 칸에");
  const host = u.hostname.toLowerCase();
  if (!host) throw new Error("워크스페이스 주소에 호스트가 없습니다");
  const port = u.port ? `:${u.port}` : "";
  return { base_url: `${u.protocol}//${host}${port}`, scope_key: `${host}${port}` };
}

function metaToLink(scopeKey: string, meta: Record<string, unknown>, extra: { has_token: boolean; created_at: string | null; updated_at: string | null }): LinkedWorkspace {
  const kind = meta.kind === "personal" ? "personal" : meta.kind === "team" ? "team" : null;
  return {
    scope_key: scopeKey,
    base_url: String(meta.base_url ?? `https://${scopeKey}`),
    name: String(meta.name ?? scopeKey),
    kind,
    remote_member_id: meta.remote_member_id == null ? null : String(meta.remote_member_id),
    remote_display_name: meta.remote_display_name == null ? null : String(meta.remote_display_name),
    auto_promote: meta.auto_promote === true,
    state: meta.state === "error" ? "error" : "active",
    last_error: meta.last_error == null ? null : String(meta.last_error),
    last_ok_at: meta.last_ok_at == null ? null : String(meta.last_ok_at),
    ...extra,
  };
}

export async function listLinkedWorkspaces(memberId: string): Promise<LinkedWorkspace[]> {
  const rows = await listMemberSecretsPublic(memberOwner(memberId));
  return rows.filter((r) => r.kind === LINK_KIND).map((r) => metaToLink(r.scope_key, r.meta, { has_token: r.has_secret, created_at: r.created_at, updated_at: r.updated_at }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function getLinkedWorkspace(memberId: string, scopeKey: string): Promise<LinkedWorkspace | null> {
  const all = await listLinkedWorkspaces(memberId);
  return all.find((l) => l.scope_key === scopeKey) ?? null;
}

// ── outbound — 그 연결의 토큰으로 원격 라이블리 REST 를 부른다(SSRF 가드 안에서). ──
async function outbound(): Promise<{ fetch: ReturnType<typeof makeSsrfFetch>; selfHost: string | null }> {
  const cfg = await getRuntimeConfig().catch(() => null);
  const selfHosts: string[] = [];
  let selfHost: string | null = null;
  try { const g = await gatewayUrl(); if (g) { selfHost = new URL(g).host.toLowerCase(); selfHosts.push(new URL(g).hostname.toLowerCase()); } } catch { /* 프로필 없음 */ }
  return { fetch: makeSsrfFetch({ allowedInternalHosts: cfg?.allowed_internal_hosts ?? [], selfHosts, timeoutMs: CALL_TIMEOUT_MS }), selfHost };
}

export interface RemoteResult { status: number; json: unknown; text: string }
export async function remoteCall(
  memberId: string, link: { base_url: string; scope_key: string }, path: string,
  opts: { method?: "GET" | "POST"; body?: unknown; token?: string; timeoutMs?: number } = {},
): Promise<RemoteResult> {
  let token = opts.token;
  if (!token) {
    const sec = await getMemberSecret(memberOwner(memberId), LINK_KIND, link.scope_key);
    token = sec?.secret ?? undefined;
  }
  if (!token) throw new Error(`연결 '${link.scope_key}' 에 토큰이 없습니다 — 팀 워크스페이스에서 발급받은 토큰을 다시 등록하세요`);
  const { fetch, selfHost } = await outbound();
  if (selfHost && link.scope_key === selfHost) throw new Error("이 워크스페이스 자기 자신은 연결할 수 없습니다");
  const url = `${link.base_url}${path.startsWith("/") ? path : `/${path}`}`;
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: "application/json", "user-agent": "lively-workspace-link/1" };
  let body: string | undefined;
  if (opts.body !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(opts.body); }
  const res = await fetch(url, { method: opts.method ?? "GET", headers, body, signal: AbortSignal.timeout(opts.timeoutMs ?? CALL_TIMEOUT_MS) });
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, json, text };
}

// 원격 신원 프로브 — 그 토큰이 누구인지·조직 이름·(신 코어면) 워크스페이스 종류. 실패 사유는 사람이 읽을 문장으로.
export interface RemoteProbe { remote_member_id: string | null; remote_display_name: string | null; org_name: string | null; kind: "personal" | "team" | null; scopes: string[] }
export async function probeLinkedWorkspace(memberId: string, link: { base_url: string; scope_key: string }, token?: string): Promise<RemoteProbe> {
  let r: RemoteResult;
  try { r = await remoteCall(memberId, link, "/api/ui/me", { token, timeoutMs: PROBE_TIMEOUT_MS }); }
  catch (e) { throw new Error(`워크스페이스에 닿지 못했습니다(${link.base_url}): ${(e as Error).message}`); }
  if (r.status === 401 || r.status === 403) throw new Error("토큰이 거부됐습니다(401/403) — 그 워크스페이스에서 발급한 내 토큰인지 확인하세요");
  if (r.status < 200 || r.status >= 300) throw new Error(`워크스페이스가 ${r.status} 로 답했습니다 — 라이블리 게이트웨이 주소가 맞는지 확인하세요`);
  const j = (r.json ?? {}) as Record<string, unknown>;
  if (!j || typeof j !== "object" || !("userId" in j)) throw new Error("라이블리 게이트웨이 응답이 아닙니다(/api/ui/me 형식 아님)");
  const ws = (j.workspace && typeof j.workspace === "object") ? (j.workspace as Record<string, unknown>) : null;
  const scopes = Array.isArray(j.scopes) ? (j.scopes as unknown[]).map(String) : [];
  return {
    remote_member_id: j.userId == null ? null : String(j.userId),
    remote_display_name: j.display_name == null ? null : String(j.display_name),
    org_name: j.org_name == null ? null : String(j.org_name),
    kind: ws?.kind === "personal" ? "personal" : ws?.kind === "team" ? "team" : null,
    scopes,
  };
}

// 등록/갱신 — 토큰이 오면 프로브로 검증하고 신원을 meta 에 채운다. 토큰 없이 부르면(이름·auto_promote 만 갱신) 기존 토큰 유지.
export async function setLinkedWorkspace(
  memberId: string,
  input: { url: string; token?: string | null; name?: string | null; auto_promote?: boolean },
  actor: string,
): Promise<LinkedWorkspace> {
  const { base_url, scope_key } = parseWorkspaceUrl(input.url);
  const owner = memberOwner(memberId);
  const before = await getLinkedWorkspace(memberId, scope_key);
  const token = typeof input.token === "string" && input.token.trim() ? input.token.trim() : undefined;
  if (!before && !token) throw new Error("처음 연결할 땐 그 워크스페이스에서 발급한 내 토큰이 필요합니다");
  const meta: Record<string, unknown> = {
    base_url,
    name: input.name?.trim() || before?.name || scope_key,
    kind: before?.kind ?? null,
    remote_member_id: before?.remote_member_id ?? null,
    remote_display_name: before?.remote_display_name ?? null,
    auto_promote: input.auto_promote !== undefined ? input.auto_promote === true : (before?.auto_promote ?? false),
    state: before?.state ?? "active",
    last_error: null,
    last_ok_at: before?.last_ok_at ?? null,
  };
  if (token || before) {
    // 토큰이 새로 왔거나 기존 연결을 만질 때 — 한 번 찔러 살아 있는지 본다(죽은 연결을 '정상'으로 저장하지 않게).
    const probe = await probeLinkedWorkspace(memberId, { base_url, scope_key }, token);
    if (!probe.scopes.includes("memory")) throw new Error("이 토큰엔 memory 스코프가 없어 지식·프로젝트를 올릴 수 없습니다 — 팀 워크스페이스에서 memory·context 스코프로 다시 발급하세요");
    meta.remote_member_id = probe.remote_member_id;
    meta.remote_display_name = probe.remote_display_name;
    meta.kind = probe.kind;
    if (!input.name?.trim() && !before?.name && probe.org_name) meta.name = probe.org_name;
    if (!input.name?.trim() && before && before.name === before.scope_key && probe.org_name) meta.name = probe.org_name;
    meta.state = "active";
    meta.last_ok_at = new Date().toISOString();
  }
  await setMemberSecret(owner, LINK_KIND, scope_key, { secret: token ?? null, meta, label: String(meta.name) }, actor);
  const after = await getLinkedWorkspace(memberId, scope_key);
  if (!after) throw new Error("연결 저장 후 조회 실패");
  return after;
}

export async function removeLinkedWorkspace(memberId: string, scopeKey: string): Promise<boolean> {
  return deleteMemberSecret(memberOwner(memberId), LINK_KIND, scopeKey);
}

// 마지막 호출 결과를 meta 에 남긴다(토큰은 그대로). 승격 실행이 401 을 받으면 여기서 state=error 로 보인다.
export async function markLinkedWorkspace(memberId: string, scopeKey: string, ok: boolean, err?: string): Promise<void> {
  const cur = await getLinkedWorkspace(memberId, scopeKey);
  if (!cur) return;
  const meta: Record<string, unknown> = {
    base_url: cur.base_url, name: cur.name, kind: cur.kind, remote_member_id: cur.remote_member_id, remote_display_name: cur.remote_display_name,
    auto_promote: cur.auto_promote, state: ok ? "active" : "error", last_error: ok ? null : String(err ?? "").slice(0, 300),
    last_ok_at: ok ? new Date().toISOString() : cur.last_ok_at,
  };
  await setMemberSecret(memberOwner(memberId), LINK_KIND, scopeKey, { meta, label: cur.name }, "system:workspace-link").catch(() => {});
}
