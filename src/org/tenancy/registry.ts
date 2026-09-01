// 워크스페이스 등록부 스토어(#1750 S1) — 셀프호스트 다중 워크스페이스의 목록·멤버십·캐시.
//
// 소비자 셋: ① 테넌트 미들웨어(요청마다 slug→id — 그래서 캐시가 있다) ② 인증 게이트(멤버십 —
//  같은 캐시) ③ CRUD capability. 표 자체는 전역(비테넌트)이라 어느 컨텍스트에서 읽어도 같다.
//
// 캐시 규약: 30초 TTL + 쓰기 시 즉시 무효화. 미들웨어는 핫패스라 DB 왕복을 요청마다 하지 않는다.
//  낡음의 최악 = 방금 만든 워크스페이스가 30초(실제로는 쓰기 무효화로 0초) 안 보이는 것 — 유출이 아니라
//  지연이다. 반대 방향(archived 가 30초 더 사는 것)도 접근 게이트가 membership 을 다시 보므로 무해.
import { HttpError } from "../../http-error.js";
import { itemsPool, withTx } from "../../db/client.js";
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
  /** #2188 설정 모달 — 사람이 정한 얼굴(색·글자). 비면 화면이 종전대로 파생한다(개인=내 아바타, 팀=첫 글자). */
  face: WorkspaceFace;
}

export interface WorkspaceFace { color?: string; char?: string }

const COLS = "id, slug, name, kind, owner_member, state, created_at, face";
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

/**
 * 워크스페이스 얼굴 입력 규칙(#2188) — **한 벌이다.** face 는 모든 구성원의 화면에 style 로 꽂히는 값이라,
 *  검증이 문마다 흩어지면 느슨한 문 하나가 style 주입 통로가 된다. 색은 hex(#rgb/#rrggbb)만, 글자는
 *  2자(코드포인트 기준 — 이모지가 안 깨지게)까지, 모르는 키는 버린다.
 *  · undefined/null → null («바꾸지 마라» — 지우는 것과 다르다)
 *  · {}             → {}  («지워라» — 화면이 파생값으로 돌아간다)
 */
export function normalizeWorkspaceFace(raw: unknown): WorkspaceFace | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "아바타 값의 모양이 올바르지 않습니다");
  const face: WorkspaceFace = {};
  const color = (raw as { color?: unknown }).color;
  if (color !== undefined && color !== null && String(color).trim() !== "") {
    const c = String(color).trim().toLowerCase();
    if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/.test(c)) throw new HttpError(400, "아바타 색은 #rgb 또는 #rrggbb 형식이어야 합니다");
    face.color = c;
  }
  const char = (raw as { char?: unknown }).char;
  if (char !== undefined && char !== null) {
    const t = Array.from(String(char).trim()).slice(0, 2).join("");
    if (t) face.char = t;
  }
  return face;
}

export async function updateWorkspaceFace(id: string, face: WorkspaceFace): Promise<void> {
  await itemsPool.query(`UPDATE gw_workspace SET face=$2::jsonb, updated_at=now() WHERE id=$1`, [id, JSON.stringify(face)]);
  invalidateRegistryCache();
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

// ── 개인/팀 판정(#1875) ─────────────────────────────────────────────────────
//
// ★ 개인이냐 팀이냐는 **저장된 값이 아니라 지금 명부에 몇 명인가**다. gw_workspace.kind 는 만들 때의
//  의도를 적어 둔 것일 뿐이라, 사람이 들어오고 나가는 동안 조용히 거짓이 된다 — 혼자 남은 '팀',
//  둘이 쓰는 '개인'. 화면과 게이트가 서로 다른 말을 하는 사고가 거기서 난다.
//  그래서 표시·판정은 전부 이 함수를 지나간다(컬럼은 만들 때의 기본 이름·기본 kind 용으로만 남는다).
export function kindEffective(memberCount: number): "personal" | "team" {
  return memberCount >= 2 ? "team" : "personal";
}

// ── 나가기의 세 갈래(#1875 D5″, 2026-08-28 장원준) ──────────────────────────
//
// ★ 주인은 **두 곳**에 적혀 있다 — 등록부 `gw_workspace.owner_member`(만든 사람)와 명부 role='owner'.
//  requireOwner 가 둘을 OR 로 보므로, 갈래 판정을 핸들러 안에 흩어 두면 «권한은 넘겼는데 나는 여전히
//  주인» 같은 반쪽 상태가 조용히 난다. 그래서 규칙을 이 한 벌로 두고 핸들러는 이것만 따른다
//  (레포 선례: sessionInWorkspace + session-workspace-isolation.test.ts).
//
//  갈래는 **역할 이름이 아니라 어드민 수**가 정한다(#1875 D1·D5' 와 같은 축):
//   · 어드민이 아니다        → 그냥 나간다
//   · 어드민이 여럿이다      → 그냥 나간다. 단 내가 «만든 사람»이면 그 자리는 남은 어드민이 자동 승계한다
//                              (안 하면 등록부가 나간 사람을 계속 주인으로 가리킨다 — 유령 주인)
//   · 어드민이 나뿐이다      → **넘길 사람을 받아야** 나간다. 8/27 엔 여기서 막았고(#1971 로 미룸),
//                              이제 묻고 넘긴다.
export type LeavePlan =
  | { ok: true; transferTo: string | null }
  | { ok: false; reason: "primary" | "not-member" | "alone" | "bad-transfer" }
  | { ok: false; reason: "needs-transfer"; candidates: string[] };

export function planWorkspaceLeave(input: {
  me: string;
  ownerMember: string;
  isPrimary: boolean;
  members: Array<{ member_id: string; role: string }>;
  transferTo?: string | null;
}): LeavePlan {
  const { me, ownerMember, isPrimary, members } = input;
  if (isPrimary) return { ok: false, reason: "primary" };
  if (!members.some((m) => m.member_id === me)) return { ok: false, reason: "not-member" };
  if (members.length < 2) return { ok: false, reason: "alone" };

  // 어드민 = 명부 role='owner' **또는** 등록부가 가리키는 만든 사람. requireOwner 와 같은 OR 여야 한다 —
  //  여기서 더 좁게 세면 «게이트는 통과하는데 나갈 땐 어드민이 아닌» 사람이 생긴다.
  const isAdmin = (id: string): boolean =>
    id === ownerMember || members.some((m) => m.member_id === id && m.role === "owner");
  // 정렬은 장식이 아니다 — 자동 승계가 명부 순서에 흔들리면 같은 상황에서 주인이 매번 달라진다.
  const otherAdmins = members
    .map((m) => m.member_id)
    .filter((id) => id !== me && isAdmin(id))
    .sort();

  if (!isAdmin(me)) return { ok: true, transferTo: null };
  if (otherAdmins.length) {
    // 공동 어드민이 있으니 그냥 나간다. 다만 «만든 사람» 자리는 비울 수 없어 자동으로 넘긴다.
    return { ok: true, transferTo: ownerMember === me ? otherAdmins[0] : null };
  }

  const to = String(input.transferTo ?? "").trim();
  if (!to) {
    return { ok: false, reason: "needs-transfer", candidates: members.map((m) => m.member_id).filter((id) => id !== me).sort() };
  }
  if (to === me) return { ok: false, reason: "bad-transfer" };
  if (!members.some((m) => m.member_id === to)) return { ok: false, reason: "bad-transfer" };
  return { ok: true, transferTo: to };
}

/**
 * 주인 넘기기 — 두 자리를 **한 트랜잭션에서** 민다. 하나만 밀면 반쪽 주인이 남는다(위 머리말).
 * 넘겨받는 사람이 명부에 없을 수는 없지만(planWorkspaceLeave 가 먼저 거른다), UPSERT 로 둬서
 *  다른 호출부가 생겨도 «명부엔 없는데 등록부 주인» 이 만들어지지 않게 한다.
 */
export async function transferWorkspaceOwner(workspaceId: string, newOwnerId: string): Promise<void> {
  await withTx(async (c) => {
    await c.query(
      `INSERT INTO gw_workspace_member(workspace_id, member_id, role) VALUES($1,$2,'owner')
       ON CONFLICT (workspace_id, member_id) DO UPDATE SET role='owner'`,
      [workspaceId, newOwnerId]);
    await c.query(`UPDATE gw_workspace SET owner_member=$2, updated_at=now() WHERE id=$1`, [workspaceId, newOwnerId]);
  });
  invalidateRegistryCache();
}

/** 워크스페이스별 어드민 수 — 화면이 «나가면 그냥 나가지나, 넘겨야 하나»를 열기 전에 알아야 한다. */
export async function ownerCounts(workspaceIds: string[]): Promise<Map<string, number>> {
  if (!workspaceIds.length) return new Map();
  const r = await itemsPool.query(
    `SELECT w.id, count(*) FILTER (WHERE m.role = 'owner' OR m.member_id = w.owner_member)::int AS n
       FROM gw_workspace w JOIN gw_workspace_member m ON m.workspace_id = w.id
      WHERE w.id = ANY($1::uuid[]) GROUP BY w.id`,
    [workspaceIds]);
  const out = new Map<string, number>();
  for (const row of r.rows as Array<{ id: string; n: number }>) out.set(row.id, Number(row.n));
  for (const id of workspaceIds) if (!out.has(id)) out.set(id, 0);
  return out;
}

export async function countWorkspaceMembers(workspaceId: string): Promise<number> {
  const r = await itemsPool.query(`SELECT count(*)::int AS n FROM gw_workspace_member WHERE workspace_id=$1`, [workspaceId]);
  return Number(r.rows[0]?.n ?? 0);
}

/** 여러 워크스페이스의 인원을 한 번에(스위처 목록이 n+1 쿼리를 돌지 않게). */
export async function memberCounts(workspaceIds: string[]): Promise<Map<string, number>> {
  if (!workspaceIds.length) return new Map();
  const r = await itemsPool.query(
    `SELECT workspace_id, count(*)::int AS n FROM gw_workspace_member WHERE workspace_id = ANY($1::uuid[]) GROUP BY workspace_id`,
    [workspaceIds]);
  const m = new Map<string, number>();
  for (const row of r.rows as Array<{ workspace_id: string; n: number }>) m.set(row.workspace_id, Number(row.n));
  for (const id of workspaceIds) if (!m.has(id)) m.set(id, 0);
  return m;
}

// ── 구성원 초대(#1875) ──────────────────────────────────────────────────────
//
// 이메일이 키다 — 초대하는 시점에 그 사람의 member_id 가 아직 없을 수 있고(이 박스에 처음 오는 사람),
//  member_id 를 먼저 알아야 부를 수 있다면 그건 초대가 아니라 명부 편집이다(종전 workspace_member_add).

export interface WorkspaceInvite {
  id: string;
  workspace_id: string;
  email: string;
  role: "owner" | "member";
  invited_by: string;
  state: "pending" | "accepted" | "declined" | "revoked";
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
}

const INVITE_COLS = "id, workspace_id, email, role, invited_by, state, created_at, resolved_at, resolved_by";

/** 이메일 정규화 — 대소문자·공백만 정리한다(플러스주소·점 제거 같은 제공자별 규칙은 흉내 내지 않는다). */
export function normalizeInviteEmail(raw: unknown): string {
  const e = String(raw ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new Error(`이메일 형식이 올바르지 않습니다: ${e || "(빈 값)"}`);
  return e;
}

// ── 초대 정책(순수) ────────────────────────────────────────────────────────
//
// 아래 셋은 핸들러가 실제로 부르는 판정이다. 인라인 if 로 흩어 두면 "누가 무엇을 할 수 있나"가
//  요청 처리 코드 사이에 숨어, 규칙이 바뀔 때 한쪽만 바뀐다.

export type InviteDecision = "accept" | "decline" | "revoke";

/** 보류인 초대만 처리할 수 있다 — 이미 끝난 초대를 되살리는 경로는 없다. */
export function inviteResolvable(state: WorkspaceInvite["state"]): boolean {
  return state === "pending";
}

/** 그 결정을 **누가** 하는가. 받는 사람이 취소하거나 보낸 사람이 대신 수락하는 일이 없어야 한다. */
export function inviteDecisionActor(decision: InviteDecision): "recipient" | "owner" {
  return decision === "revoke" ? "owner" : "recipient";
}

/** 결정 → 다음 상태. */
export function inviteNextState(decision: InviteDecision): "accepted" | "declined" | "revoked" {
  return decision === "accept" ? "accepted" : decision === "decline" ? "declined" : "revoked";
}

/**
 * 받는 사람 확인 — 초대의 이메일과 처리하는 사람의 이메일이 같은가.
 *  대소문자·앞뒤 공백만 접는다(초대 저장 때와 **같은 규칙**이어야 한다). 처리자 이메일이 없으면 불일치다 —
 *  "이메일이 없으니 통과"는 링크 id 만 아는 사람에게 남의 초대를 열어 주는 것과 같다(fail-closed).
 */
export function inviteRecipientMatches(inviteEmail: string, actorEmail: string | null | undefined): boolean {
  const a = String(actorEmail ?? "").trim().toLowerCase();
  if (!a) return false;
  return a === String(inviteEmail ?? "").trim().toLowerCase();
}

export async function createInvite(v: {
  id: string; workspaceId: string; email: string; role: "owner" | "member"; invitedBy: string;
}): Promise<WorkspaceInvite> {
  const r = await itemsPool.query(
    `INSERT INTO gw_workspace_invite(id, workspace_id, email, role, invited_by)
     VALUES($1,$2,$3,$4,$5) RETURNING ${INVITE_COLS}`,
    [v.id, v.workspaceId, v.email, v.role, v.invitedBy]);
  return r.rows[0] as WorkspaceInvite;
}

export async function listWorkspaceInvites(workspaceId: string, state = "pending"): Promise<WorkspaceInvite[]> {
  const r = await itemsPool.query(
    `SELECT ${INVITE_COLS} FROM gw_workspace_invite WHERE workspace_id=$1 AND state=$2 ORDER BY created_at DESC`,
    [workspaceId, state]);
  return r.rows as WorkspaceInvite[];
}

/** 이 이메일 앞으로 온 **보류** 초대 — 받는 사람이 어느 워크스페이스에 있든 보인다(전역 표인 이유). */
export async function listInvitesForEmail(email: string): Promise<Array<WorkspaceInvite & { workspace_name: string; workspace_slug: string }>> {
  const r = await itemsPool.query(
    `SELECT ${INVITE_COLS.split(", ").map((c) => `i.${c}`).join(", ")}, w.name AS workspace_name, w.slug AS workspace_slug
       FROM gw_workspace_invite i JOIN gw_workspace w ON w.id = i.workspace_id
      WHERE i.email=$1 AND i.state='pending' AND w.state='active'
      ORDER BY i.created_at DESC`, [email]);
  return r.rows as Array<WorkspaceInvite & { workspace_name: string; workspace_slug: string }>;
}

export async function getInvite(id: string): Promise<WorkspaceInvite | null> {
  const r = await itemsPool.query(`SELECT ${INVITE_COLS} FROM gw_workspace_invite WHERE id=$1`, [id]);
  return (r.rows[0] as WorkspaceInvite) ?? null;
}

/**
 * 초대 상태 전이 — **보류일 때만** 통과한다(원자적). 반환 null = 이미 누가 처리했다는 뜻이고,
 *  호출자는 그걸 오류가 아니라 "방금 처리됨"으로 사람에게 말해야 한다.
 */
export async function resolveInvite(
  id: string, state: "accepted" | "declined" | "revoked", by: string,
): Promise<WorkspaceInvite | null> {
  const r = await itemsPool.query(
    `UPDATE gw_workspace_invite SET state=$2, resolved_at=now(), resolved_by=$3
      WHERE id=$1 AND state='pending' RETURNING ${INVITE_COLS}`,
    [id, state, by]);
  return (r.rows[0] as WorkspaceInvite) ?? null;
}

/** 워크스페이스가 보관되면 그 보류 초대는 갈 곳이 없다 — 함께 거둔다. */
export async function revokeInvitesForWorkspace(workspaceId: string, by: string): Promise<number> {
  const r = await itemsPool.query(
    `UPDATE gw_workspace_invite SET state='revoked', resolved_at=now(), resolved_by=$2
      WHERE workspace_id=$1 AND state='pending'`, [workspaceId, by]);
  return r.rowCount ?? 0;
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
  // (이쪽은 워크스페이스 **레코드**를 돌려주는 자리라 INNER JOIN 이 맞다 — 행이 없으면 줄 것이 없다.
  //  «소속 id 만» 필요한 sessionWorkspaceIds 와 계약이 다르다: 그쪽은 LEFT JOIN 이어야 한다. 위 주석 참조.)
  const r = await itemsPool.query(
    `SELECT ${COLS.split(", ").map((c) => `w.${c}`).join(", ")}
       FROM gw_session_map m JOIN gw_workspace w ON w.id = m.workspace_id
      WHERE m.session_id=$1 AND w.state='active'`, [sessionId]);
  const ws = (r.rows[0] as RegistryWorkspace) ?? null;
  sessionWsCache.set(sessionId, { ws, at: Date.now() });
  return ws;
}

/**
 * 여러 세션의 **소속 워크스페이스 id** 를 한 번에(#1875 세션 목록 격리). 반환 맵에 없는 세션 = 부재/보관됨 =
 *  primary(호출자가 PRIMARY_TENANT_ID 로 채운다 — workspaceForSession 과 같은 규칙: active 만, 그 외 primary).
 *  목록 필터 전용이라 캐시를 태우지 않는다(대량 id 를 한 방에 — 세션당 왕복은 목록 크기만큼의 지연이 된다).
 */
/**
 * 세션이 **지금 보고 있는 워크스페이스**의 것인가(#1875 목록 격리의 단일 규칙 — SQL·JS 두 필터가 같은 명제를 쓴다).
 *  `mappedWsId` = gw_session_map 이 준 소속(active 만; 부재/보관됨이면 undefined). 규칙: 소속 = mappedWsId ?? primary,
 *  그것이 현재 워크스페이스와 같을 때만 보인다. 그래서 ① 안 묶인 옛 세션은 primary(박스)에서만 보이고 개인 ws 엔
 *  안 새며 ② 개인 ws 세션은 그 ws 에서만 보이고 primary·다른 개인 ws 엔 안 샌다.
 */
export function sessionInWorkspace(mappedWsId: string | null | undefined, currentWsId: string): boolean {
  return (mappedWsId ?? PRIMARY_TENANT_ID) === currentWsId;
}

export async function sessionWorkspaceIds(sessionIds: string[]): Promise<Map<string, string>> {
  const ids = Array.from(new Set(sessionIds.filter((s) => typeof s === "string" && s)));
  if (!ids.length) return new Map();
  // ⚠ **LEFT JOIN 이어야 한다**(실측 2026-08-27, 매니지드 프로덕션): 이 조인의 목적은 «보관된(archived)
  //  워크스페이스를 빼는 것» 인데, INNER JOIN 이면 «gw_workspace 에 행이 아예 없는 배포» 에서 **전부**
  //  빠진다. 매니지드가 정확히 그 배포다 — 워크스페이스 축을 CP 가 테넌트로 갖고 있어 이 표는 비어 있고,
  //  gw_session_map 에는 매핑이 멀쩡히 있다. 그래서 목록이 통째로 비었다(«세션이 목록에 안 나타남»).
  //  없는 것(w.id IS NULL)은 «모름» 이라 매핑값을 그대로 쓰고, 있는데 보관됐을 때만 뺀다.
  const r = await itemsPool.query(
    `SELECT m.session_id, m.workspace_id::text AS wsid
       FROM gw_session_map m LEFT JOIN gw_workspace w ON w.id = m.workspace_id
      WHERE (w.id IS NULL OR w.state='active') AND m.session_id = ANY($1::text[])`,
    [ids]);
  return new Map(r.rows.map((x) => [x.session_id as string, x.wsid as string]));
}
