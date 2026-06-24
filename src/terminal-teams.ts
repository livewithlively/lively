// 중앙 박스 — 팀 폴더. 공유 워크스페이스 최상위에 폴더를 만들고 .lively-team.json 마커로
// {owner, label, members[], created} 를 둔다(tmux/FS = SoT, DB 미사용 — terminal-sessions 와 동일 철학).
// 접근: owner OR members 에 든 org_member id. 팀 폴더 안 세션(@box_team)도 이 멤버십으로 게이트한다.
// (세션 owner id = org_member.id 임이 데이터로 확인됨 — auth_token.user_id === member_id.)
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import type { LivelyUser } from "./context.js";
import { HttpError } from "./capabilities/rest-util.js";
import { listMembers } from "./org/store.js";

// 공유 루트 — terminal-sessions.ts 의 ROOTS 'shared' base 와 반드시 일치(순환 import 회피 위해 env 직접 읽음).
const SHARED_BASE = path.resolve(process.env.TERMINAL_ROOT_SHARED || "/Users/lively/.openclaw/workspace");
const MARKER = ".lively-team.json";
const ownerId = (u: LivelyUser): string => u.userId || u.email || "";

// teamId = 공유 루트 바로 아래 폴더명(단일 세그먼트). 경로 탈출·숨김·교묘한 이름 차단.
const TEAM_ID_RE = /^[^/\\.][^/\\]*$/;
function assertTeamId(id: string): void {
  if (!id || id.length > 64 || id.includes("..") || !TEAM_ID_RE.test(id)) throw new HttpError(400, "잘못된 팀 식별자입니다");
}
export function teamDir(id: string): string {
  assertTeamId(id);
  const abs = path.resolve(SHARED_BASE, id);
  if (path.dirname(abs) !== SHARED_BASE) throw new HttpError(400, "허용 위치를 벗어난 팀 폴더입니다");
  return abs;
}

interface TeamMeta { owner: string; label: string; members: string[]; created: number; }
// accessible = 내가 owner/member 라 '들어갈' 수 있는가. 팀 폴더는 모두에게 보이되(목록·이름·구성원),
//  입장(세션 열람/생성)은 accessible=true 만 허용한다.
export interface TeamInfo { id: string; label: string; owner: string; owned: boolean; accessible: boolean; members: string[]; memberNames: string[]; created: number; }

async function readMeta(id: string): Promise<TeamMeta | null> {
  let raw: string;
  try { raw = await fsp.readFile(path.join(teamDir(id), MARKER), "utf8"); } catch { return null; }
  try {
    const m = JSON.parse(raw) as Partial<TeamMeta>;
    if (!m || typeof m.owner !== "string") return null;
    return {
      owner: m.owner,
      label: typeof m.label === "string" ? m.label : id,
      members: Array.isArray(m.members) ? m.members.filter((x): x is string => typeof x === "string") : [],
      created: Number(m.created) || 0,
    };
  } catch { return null; }
}

const isMember = (meta: TeamMeta, uid: string): boolean => !!uid && (meta.owner === uid || meta.members.includes(uid));

// 세션 게이트용(userId 문자열만). teamId 빈값 = 팀 없는 세션(게이트 무관 → true). 마커 없거나 비멤버 = false.
export async function isTeamMemberById(teamId: string, userId: string): Promise<boolean> {
  if (!teamId) return true;
  const meta = await readMeta(teamId).catch(() => null);
  return !!meta && isMember(meta, userId);
}

const cleanLabel = (s: string): string => (s || "").replace(/[\t\n\r]/g, " ").trim().slice(0, 60);
// 라벨 → 폴더명. 한글 등 유니코드 보존, 경로위험·점시작·중복공백만 정리. 비면 'team'.
function slugFolder(label: string): string {
  const s = cleanLabel(label).replace(/[/\\]/g, "-").replace(/^\.+/, "").replace(/\s+/g, " ").trim().slice(0, 48);
  return s || "team";
}

async function memberNameMap(): Promise<Map<string, string>> {
  const ms = await listMembers().catch(() => []);
  return new Map(ms.map((m) => [m.id, m.display_name || m.id]));
}

async function validMemberIds(ids: unknown): Promise<string[]> {
  if (!Array.isArray(ids)) return [];
  const valid = new Set((await listMembers().catch(() => [])).map((m) => m.id));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of ids) if (typeof x === "string" && valid.has(x) && !seen.has(x)) { seen.add(x); out.push(x); }
  return out;
}

function toInfo(id: string, meta: TeamMeta, me: string, names: Map<string, string>): TeamInfo {
  return { id, label: meta.label, owner: meta.owner, owned: meta.owner === me, accessible: isMember(meta, me), members: meta.members, memberNames: meta.members.map((m) => names.get(m) || m), created: meta.created };
}

export async function listTeams(user: LivelyUser): Promise<TeamInfo[]> {
  const me = ownerId(user);
  let entries: fs.Dirent[] = [];
  try { entries = await fsp.readdir(SHARED_BASE, { withFileTypes: true }); } catch { return []; }
  const names = await memberNameMap();
  const out: TeamInfo[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".") || !TEAM_ID_RE.test(e.name)) continue;
    const meta = await readMeta(e.name).catch(() => null);
    if (!meta) continue; // 마커 없음(일반 폴더) → 숨김. 팀이면 비멤버여도 노출(입장만 차단).
    out.push(toInfo(e.name, meta, me, names));
  }
  // 접근 가능(내 팀) 먼저 → 소유 먼저 → 최신 먼저.
  out.sort((a, b) => (Number(b.accessible) - Number(a.accessible)) || (Number(b.owned) - Number(a.owned)) || (b.created - a.created));
  return out;
}

// 내가 '접근 가능한' 팀 id 집합 — listSessions 의 팀 세션 가시성 게이트용(비멤버에 팀 세션 노출 방지).
//  팀 폴더 자체는 모두에게 보이지만(accessible=false 포함), 세션 게이트는 accessible 만 통과시킨다.
export async function myTeamIds(user: LivelyUser): Promise<Set<string>> {
  return new Set((await listTeams(user)).filter((t) => t.accessible).map((t) => t.id));
}

export async function createTeam(user: LivelyUser, input: { label: string; members: unknown }): Promise<TeamInfo> {
  const me = ownerId(user);
  if (!me) throw new HttpError(403, "사용자 신원이 없습니다");
  const label = cleanLabel(input.label);
  if (!label) throw new HttpError(400, "팀 이름이 필요합니다");
  await fsp.mkdir(SHARED_BASE, { recursive: true }).catch(() => { /* 이미 존재 */ });
  // 폴더명 결정 — 이미 존재하는 이름(팀이든 일반 폴더든)은 피해서 -2, -3 … 으로 회피(덮어쓰기 금지).
  const baseName = slugFolder(label);
  let name = baseName, n = 1;
  while (fs.existsSync(path.join(SHARED_BASE, name))) { n += 1; name = `${baseName}-${n}`; if (n > 999) throw new HttpError(409, "팀 폴더 이름이 충돌합니다"); }
  const members = await validMemberIds(input.members);
  const dir = teamDir(name);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const meta: TeamMeta = { owner: me, label, members, created: Math.floor(Date.now() / 1000) };
  await fsp.writeFile(path.join(dir, MARKER), JSON.stringify(meta, null, 2), { mode: 0o600 });
  return toInfo(name, meta, me, await memberNameMap());
}

async function assertOwner(user: LivelyUser, id: string): Promise<TeamMeta> {
  const meta = await readMeta(id);
  if (!meta) throw new HttpError(404, "팀을 찾을 수 없습니다");
  if (meta.owner !== ownerId(user)) throw new HttpError(403, "팀 소유자만 변경할 수 있습니다");
  return meta;
}

export async function editTeam(user: LivelyUser, id: string, patch: { label?: string; members?: unknown }): Promise<void> {
  const meta = await assertOwner(user, id);
  if (patch.label !== undefined) { const l = cleanLabel(patch.label); if (!l) throw new HttpError(400, "팀 이름이 필요합니다"); meta.label = l; }
  if (patch.members !== undefined) meta.members = await validMemberIds(patch.members);
  await fsp.writeFile(path.join(teamDir(id), MARKER), JSON.stringify(meta, null, 2), { mode: 0o600 });
}

// 팀 해제 — 마커만 제거(폴더·파일은 보존, 데이터 삭제 안 함). 소유자만. 안의 세션은 팀 태그가 풀려 일반 세션으로.
export async function deleteTeam(user: LivelyUser, id: string): Promise<void> {
  await assertOwner(user, id);
  await fsp.rm(path.join(teamDir(id), MARKER), { force: true });
}
