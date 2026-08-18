// 워크스페이스 등록부 스토어(#1750 S1) — 셀프호스트 다중 워크스페이스의 목록·멤버십·캐시.
//
// 소비자 셋: ① 테넌트 미들웨어(요청마다 slug→id — 그래서 캐시가 있다) ② 인증 게이트(멤버십 —
//  같은 캐시) ③ CRUD capability. 표 자체는 전역(비테넌트)이라 어느 컨텍스트에서 읽어도 같다.
//
// 캐시 규약: 30초 TTL + 쓰기 시 즉시 무효화. 미들웨어는 핫패스라 DB 왕복을 요청마다 하지 않는다.
//  낡음의 최악 = 방금 만든 워크스페이스가 30초(실제로는 쓰기 무효화로 0초) 안 보이는 것 — 유출이 아니라
//  지연이다. 반대 방향(archived 가 30초 더 사는 것)도 접근 게이트가 membership 을 다시 보므로 무해.
import { itemsPool } from "../../db/client.js";
import { SINGLE_TENANT_ID } from "../../db/tenant-column.js";

/** primary(기존 박스 워크스페이스)의 테넌트 id — 기존 행의 tenant_id 상수와 같다. */
export const PRIMARY_TENANT_ID = SINGLE_TENANT_ID;
export const PRIMARY_SLUG = "primary";

export interface RegistryWorkspace {
  id: string;
  slug: string;
  name: string;
  kind: "personal" | "team";
  owner_member: string;
  state: "active" | "archived";
  created_at: string;
}

const COLS = "id, slug, name, kind, owner_member, state, created_at";
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

export function normalizeWorkspaceSlug(raw: unknown): string {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!SLUG_RE.test(s)) throw new Error(`워크스페이스 slug 형식 오류(소문자·숫자·하이픈 3~40자): ${s}`);
  return s;
}

// ── 캐시 ────────────────────────────────────────────────────────────────────
const TTL_MS = 30_000;
let cacheAt = 0;
let bySlug = new Map<string, RegistryWorkspace>();
let membersByWs = new Map<string, Set<string>>();

export function invalidateRegistryCache(): void { cacheAt = 0; }

async function refresh(): Promise<void> {
  const [ws, mem] = await Promise.all([
    itemsPool.query(`SELECT ${COLS} FROM gw_workspace`),
    itemsPool.query(`SELECT workspace_id, member_id FROM gw_workspace_member`),
  ]);
  const s = new Map<string, RegistryWorkspace>();
  for (const r of ws.rows as RegistryWorkspace[]) s.set(r.slug, r);
  const m = new Map<string, Set<string>>();
  for (const r of mem.rows as Array<{ workspace_id: string; member_id: string }>) {
    let set = m.get(r.workspace_id);
    if (!set) { set = new Set(); m.set(r.workspace_id, set); }
    set.add(r.member_id);
  }
  bySlug = s; membersByWs = m; cacheAt = Date.now();
}

async function ensureFresh(): Promise<void> { if (Date.now() - cacheAt > TTL_MS) await refresh(); }

/** slug → 워크스페이스(캐시). 없거나 archived 면 null — 미들웨어가 404 로 바꾼다. */
export async function lookupWorkspace(slug: string): Promise<RegistryWorkspace | null> {
  await ensureFresh();
  const w = bySlug.get(slug);
  return w && w.state === "active" ? w : null;
}

/** 멤버십(캐시) — **secondary 전용 게이트 재료.** primary 는 게이트가 항상 통과시키므로 여기 안 온다. */
export async function isWorkspaceMember(workspaceId: string, memberId: string): Promise<boolean> {
  await ensureFresh();
  return membersByWs.get(workspaceId)?.has(memberId) ?? false;
}

// ── CRUD(캐시 무효화 포함) ──────────────────────────────────────────────────
export async function listWorkspaces(): Promise<RegistryWorkspace[]> {
  const r = await itemsPool.query(`SELECT ${COLS} FROM gw_workspace ORDER BY created_at`);
  return r.rows as RegistryWorkspace[];
}

export async function listWorkspacesForMember(memberId: string): Promise<Array<RegistryWorkspace & { role: string }>> {
  const wcols = COLS.split(", ").map((c) => `w.${c}`).join(", ");
  const r = await itemsPool.query(
    `SELECT ${wcols}, m.role FROM gw_workspace w JOIN gw_workspace_member m ON m.workspace_id = w.id
      WHERE m.member_id = $1 AND w.state = 'active' ORDER BY w.created_at`,
    [memberId]);
  return r.rows as Array<RegistryWorkspace & { role: string }>;
}

export async function getWorkspaceBySlug(slug: string): Promise<RegistryWorkspace | null> {
  const r = await itemsPool.query(`SELECT ${COLS} FROM gw_workspace WHERE slug=$1`, [slug]);
  return (r.rows[0] as RegistryWorkspace) ?? null;
}

export async function insertWorkspace(w: { id: string; slug: string; name: string; kind: "personal" | "team"; owner: string }): Promise<RegistryWorkspace> {
  const r = await itemsPool.query(
    `INSERT INTO gw_workspace(id, slug, name, kind, owner_member) VALUES($1,$2,$3,$4,$5) RETURNING ${COLS}`,
    [w.id, w.slug, w.name, w.kind, w.owner]);
  await itemsPool.query(
    `INSERT INTO gw_workspace_member(workspace_id, member_id, role) VALUES($1,$2,'owner') ON CONFLICT DO NOTHING`,
    [w.id, w.owner]);
  invalidateRegistryCache();
  return r.rows[0] as RegistryWorkspace;
}

export async function updateWorkspaceName(id: string, name: string): Promise<void> {
  await itemsPool.query(`UPDATE gw_workspace SET name=$2, updated_at=now() WHERE id=$1`, [id, name]);
  invalidateRegistryCache();
}

export async function archiveWorkspace(id: string): Promise<void> {
  await itemsPool.query(`UPDATE gw_workspace SET state='archived', updated_at=now() WHERE id=$1`, [id]);
  invalidateRegistryCache();
}

export async function getWorkspaceMemberRole(workspaceId: string, memberId: string): Promise<"owner" | "member" | null> {
  const r = await itemsPool.query(`SELECT role FROM gw_workspace_member WHERE workspace_id=$1 AND member_id=$2`, [workspaceId, memberId]);
  const role = r.rows[0]?.role;
  return role === "owner" || role === "member" ? role : null;
}

export async function listWorkspaceMembers(workspaceId: string): Promise<Array<{ member_id: string; role: string }>> {
  const r = await itemsPool.query(
    `SELECT member_id, role FROM gw_workspace_member WHERE workspace_id=$1 ORDER BY role, member_id`, [workspaceId]);
  return r.rows as Array<{ member_id: string; role: string }>;
}

export async function addWorkspaceMember(workspaceId: string, memberId: string, role: "owner" | "member" = "member"): Promise<void> {
  await itemsPool.query(
    `INSERT INTO gw_workspace_member(workspace_id, member_id, role) VALUES($1,$2,$3)
     ON CONFLICT (workspace_id, member_id) DO UPDATE SET role=EXCLUDED.role`,
    [workspaceId, memberId, role]);
  invalidateRegistryCache();
}

export async function removeWorkspaceMember(workspaceId: string, memberId: string): Promise<void> {
  await itemsPool.query(`DELETE FROM gw_workspace_member WHERE workspace_id=$1 AND member_id=$2`, [workspaceId, memberId]);
  invalidateRegistryCache();
}

// ── 세션 → 워크스페이스 정본(#1750 후속) ────────────────────────────────────
//
// 워크스페이스 신호가 클라이언트 헤더에만 실리면 SSE·iframe·WS·구 번들·훅이 전부 조용히 primary 로
//  떨어진다(dev '다온' 실측). 세션 생성이 소속을 여기 새기면, 이후의 모든 세션 축 요청은 서버가
//  이 표로 컨텍스트를 되찾는다 — 클라이언트가 뭘 실었든/못 실었든.
//
// primary 세션은 행을 만들지 않는다(부재 = primary — 구 세션·종전 동작과 정확히 일치).
// 캐시: 미들웨어 핫패스(세션당 요청 다발)라 15초 TTL 개별 캐시. 낡음의 최악 = 방금 만든 세션의
//  첫 요청 몇 개가 맵 미스 → primary 로 가는 것인데, 쓰기 직후 캐시에 심으므로 실제로는 0.

const sessionWsCache = new Map<string, { ws: RegistryWorkspace | null; at: number }>();
const SESSION_TTL_MS = 15_000;

export async function setSessionWorkspace(sessionId: string, workspaceId: string): Promise<void> {
  await itemsPool.query(
    `INSERT INTO gw_session_map(session_id, workspace_id) VALUES($1,$2)
     ON CONFLICT (session_id) DO UPDATE SET workspace_id=EXCLUDED.workspace_id`,
    [sessionId, workspaceId]);
  sessionWsCache.delete(sessionId);
}

export async function clearSessionWorkspace(sessionId: string): Promise<void> {
  await itemsPool.query(`DELETE FROM gw_session_map WHERE session_id=$1`, [sessionId]);
  sessionWsCache.delete(sessionId);
}

/** 세션의 소속 워크스페이스(active 만). 행 없음/보관됨 = null → 호출자는 primary 로 다룬다. */
export async function workspaceForSession(sessionId: string): Promise<RegistryWorkspace | null> {
  const hit = sessionWsCache.get(sessionId);
  if (hit && Date.now() - hit.at < SESSION_TTL_MS) return hit.ws;
  const r = await itemsPool.query(
    `SELECT ${COLS.split(", ").map((c) => `w.${c}`).join(", ")}
       FROM gw_session_map m JOIN gw_workspace w ON w.id = m.workspace_id
      WHERE m.session_id=$1 AND w.state='active'`, [sessionId]);
  const ws = (r.rows[0] as RegistryWorkspace) ?? null;
  sessionWsCache.set(sessionId, { ws, at: Date.now() });
  return ws;
}
