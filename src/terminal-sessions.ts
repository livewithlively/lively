// 중앙 박스 — tmux 세션 매니저 + 큐레이트 설정(허용 루트·하네스 플래그 카탈로그).
// 모든 tmux 호출은 execFile argv(셸 미경유) — 인젝션 차단. 세션은 box-<userSlug>-* 네임스페이스.
// 메타는 tmux @box_* user-option 에 저장(재기동 생존, tmux SoT — DB 미사용).
// 접근 모델: 소유자 + 초대된 멤버(@box_invites). 기본 비공개(초대 없음 = 소유자만). 공개/팀 개념 없음.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import type { LivelyUser } from "./context.js";
import { HttpError } from "./capabilities/rest-util.js";
import { dirToProjectFolder, folderVariants } from "./project-fs.js";
import { projectAccessByFolder as projectAccessByFolderV6, isProjectMember as isProjectMemberV6, recordSessionProject } from "./v6/project-store.js";
import { listMembers } from "./org/store.js";

const execFileAsync = promisify(execFile);
// 게이트웨이가 launchd/nohup 로 떠 PATH 에 brew 가 없을 수 있어 절대경로 우선(env 오버라이드 가능).
export const TMUX_BIN = process.env.TMUX_BIN || "/opt/homebrew/bin/tmux";

// ⚠ tmux 는 로케일이 UTF-8 이 아니면(C/POSIX) format 출력의 제어문자·멀티바이트를 '_' 로 치환한다.
//  게이트웨이가 launchd 로 LANG/LC_* 없이 뜨면 `list-sessions -F "...\t..."` 의 탭 구분자와 한글 라벨이
//  통째로 '_' 가 되어, split("\t") 가 안 쪼개져 라인 전체가 세션 id 로 들어가는 치명 버그가 생긴다
//  (입장 불가 + owner 누락 → '다른 멤버' 오분류). 그래서 모든 tmux 호출에 UTF-8 로케일을 강제한다
//  (terminal-pty 의 attach 가 이미 쓰는 패턴과 동일 — 여기 list/show/set 계열에도 일관 적용).
const TMUX_ENV: NodeJS.ProcessEnv = (() => {
  const env = { ...process.env };
  if (!/utf-?8/i.test(env.LC_ALL || env.LC_CTYPE || env.LANG || "")) {
    env.LANG = "en_US.UTF-8";
    env.LC_CTYPE = "en_US.UTF-8";
  }
  return env;
})();

// ── 큐레이트 허용 루트 ──
export interface Root { key: string; label: string; base: string; perUser?: boolean; }
export const ROOTS: Root[] = [
  { key: "shared", label: "공유 워크스페이스", base: process.env.TERMINAL_ROOT_SHARED || "/Users/lively/.openclaw/workspace" },
  { key: "personal", label: "개인 폴더", base: process.env.TERMINAL_ROOT_PERSONAL || path.join(os.homedir(), "box"), perUser: true },
];

// ── 하네스 플래그 카탈로그(보수적 화이트리스트) ──
export interface FlagDef { name: string; label: string; desc: string; type: "select" | "bool" | "text"; choices?: string[]; default?: string; }
export interface Harness { key: string; label: string; bin: string; autoApproveFlag?: string; flags: FlagDef[]; }
export const HARNESSES: Harness[] = [
  {
    key: "claude", label: "Claude Code", bin: "claude",
    autoApproveFlag: "--dangerously-skip-permissions",
    flags: [{ name: "--model", label: "모델", desc: "비우면 기본 모델", type: "select", choices: ["", "opus", "sonnet", "haiku"] }],
  },
  {
    key: "codex", label: "Codex", bin: "codex",
    autoApproveFlag: "--yolo",
    flags: [{ name: "--model", label: "모델", desc: "비우면 기본 모델(gpt-5.5)", type: "select", choices: ["", "gpt-5.5", "gpt-5.4", "gpt-5.4-mini"] }],
  },
  { key: "shell", label: "셸 (에이전트 없음)", bin: "", flags: [] },
];

export interface SessionInfo {
  id: string; label: string; harness: string; dir: string; autoApprove: boolean;
  owner: string; owned: boolean; created: number; attached: boolean;
  invites: string[]; // 초대된 멤버 id(@box_invites). 빈 배열 = 비공개(소유자만 보기·열기).
  flags: Record<string, string>; // 생성 시 적용된 하네스 플래그(@box_flags, 예: {"--model":"opus"}). 수정 팝업의 비활성 표시용.
  projectId?: number; // 프로젝트 세션이면 그 프로젝트 id(@box_project). 보드의 '내 세션' 칼럼 활성 판단용.
}
export interface CreateInput { label: string; rootKey: string; subpath: string; harness: string; flags: Record<string, unknown>; autoApprove: boolean; invites?: unknown; projectId?: number; projectSrc?: "v6" | "org"; }

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "user";
const userSlug = (u: LivelyUser): string => slug(u.userId || u.email || "user");
const ownerId = (u: LivelyUser): string => u.userId || u.email || "";
export const sessionPrefix = (u: LivelyUser): string => `box-${userSlug(u)}-`;
const ID_RE = /^box-[a-z0-9-]+-[a-f0-9]{8}$/;
const SAFE_VALUE_RE = /^[A-Za-z0-9][A-Za-z0-9._\-:/]*$/;
const cleanLabel = (s: string): string => (s || "").replace(/[\t\n\r]/g, " ").trim().slice(0, 80);

// @box_invites(JSON 문자열) → 멤버 id 배열. 깨진 값·구버전 메타는 빈 배열(=비공개로 안전 폴백).
function parseInvites(raw: string): string[] {
  if (!raw) return [];
  try { const a = JSON.parse(raw); return Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : []; }
  catch { return []; }
}
// 초대 멤버 검증 — 실제 구성원 id 만, 소유자 제외, 중복 제거(위조·중복 초대 차단).
async function validInvites(ids: unknown, ownerUid: string): Promise<string[]> {
  if (!Array.isArray(ids)) return [];
  const valid = new Set((await listMembers().catch(() => [])).map((m) => m.id));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of ids) if (typeof x === "string" && x !== ownerUid && valid.has(x) && !seen.has(x)) { seen.add(x); out.push(x); }
  return out;
}

// 허용 루트 기준 경로 해소(+봉쇄). perUser 루트는 base/<userSlug>. subpath 의 .. 탈출은 거부.
// 세션 생성·생성폼 폴더 탐색이 공유한다(순수 path 연산 — fs 부작용 없음).
export function resolveRootPath(user: LivelyUser, rootKey: string, subpath: string): { base: string; abs: string } {
  const root = ROOTS.find((r) => r.key === rootKey);
  if (!root) throw new HttpError(400, "허용되지 않은 루트입니다");
  let base = root.base;
  if (root.perUser) base = path.join(base, userSlug(user));
  base = path.resolve(base);
  const sub = String(subpath || "").replace(/^[/\\]+/, "");
  const abs = path.resolve(base, sub);
  if (abs !== base && !abs.startsWith(base + path.sep)) throw new HttpError(400, "허용 루트를 벗어난 경로입니다");
  return { base, abs };
}

// ── 멀티프로필 / 프로필별 Claude 계정(#346) ──
//  M1: 프로필 = 세션 owner(멤버). 프로필별 격리된 CLAUDE_CONFIG_DIR(=config·자격증명·MCP)로 claude 를 띄운다.
//  각 프로필 dir 은 1회 로그인(CLAUDE_CONFIG_DIR=<dir> claude)으로 프로비저닝된다(+키트로 lively MCP·훅 주입).
//  ⚠ 폴백 불변식: 프로필이 아직 로그인 안 됐으면(.credentials.json 없음) CLAUDE_CONFIG_DIR 을 주입하지 않아
//    호스트 공유 ~/.claude 를 그대로 쓴다(=오늘 동작, 무회귀). 멀티프로필은 프로필이 준비된 멤버만 opt-in.
//    LIVELY_MULTIPROFILE=0 이면 전면 비활성(항상 공유) — 롤아웃 kill-switch.
const PROFILES_ROOT = process.env.LIVELY_PROFILES_ROOT || path.join(os.homedir(), ".lively", "profiles");
export function profileConfigDir(user: LivelyUser): string {
  return path.join(PROFILES_ROOT, userSlug(user), "claude");
}
// 프로필이 프로비저닝됐으면(로그인된 자격증명 존재) 그 CLAUDE_CONFIG_DIR 을 반환, 아니면 null(→공유 폴백).
async function resolveProfileConfigDir(user: LivelyUser): Promise<string | null> {
  if (process.env.LIVELY_MULTIPROFILE === "0") return null;
  const dir = profileConfigDir(user);
  try { await fsp.access(path.join(dir, ".credentials.json")); return dir; }
  catch { return null; }
}

// 프로필 상태(멀티프로필 #346) — UI 표시용. 이 사용자의 세션이 '내 계정'을 쓸지 '공유 계정'으로 폴백할지.
//  active = 멀티프로필 켜짐 && 로그인됨(=seam 이 실제로 CLAUDE_CONFIG_DIR 을 주입하는 조건).
export async function profileStatus(user: LivelyUser): Promise<{
  multiprofile: boolean; dir: string; provisioned: boolean; loggedIn: boolean; active: boolean;
}> {
  const multiprofile = process.env.LIVELY_MULTIPROFILE !== "0";
  const dir = profileConfigDir(user);
  let provisioned = false; let loggedIn = false;
  try { await fsp.access(dir); provisioned = true; } catch { /* 미프로비저닝 */ }
  try { await fsp.access(path.join(dir, ".credentials.json")); loggedIn = true; } catch { /* 미로그인 */ }
  return { multiprofile, dir, provisioned, loggedIn, active: multiprofile && loggedIn };
}

// 특정 멤버 id 기준 프로필 상태(관리탭 목록용 — owner 파생과 동일 slug 규칙).
export function profileStatusFor(memberId: string): ReturnType<typeof profileStatus> {
  return profileStatus({ userId: memberId } as LivelyUser);
}

// 프로필 프로비저닝(#442) — 프로필 dir + 키트(settings·MCP)를 설치한다. **로그인(OAuth)은 별도**(사람이 웹터미널에서
//  claude /login). 기존 deploy/provision-profile.sh(테스트된 로직) 재활용 — admin 라우트에서만 호출(게이트는 라우트가).
//  ⚠ member 는 실재 org_member.id 여야(라우트가 검증). execFile(셸 미경유)라 인젝션 없음. 스크립트가 slug→dir 계산.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");   // dist/ → 리포 루트
export async function provisionProfile(memberId: string): Promise<{ slug: string; dir: string }> {
  const u = { userId: memberId } as LivelyUser;
  const script = path.join(REPO_ROOT, "deploy", "provision-profile.sh");
  // 게이트웨이 env 상속(PATH 에 claude, .env 토큰은 스크립트가 읽음). 최대 3분(키트 다운로드+등록).
  await execFileAsync("bash", [script, memberId], { timeout: 180_000, env: process.env, cwd: REPO_ROOT, maxBuffer: 4 * 1024 * 1024 });
  return { slug: userSlug(u), dir: profileConfigDir(u) };
}

async function tmux(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(TMUX_BIN, args, { timeout: 5000, env: TMUX_ENV });
  return stdout;
}
async function tmuxQuiet(args: string[]): Promise<void> { try { await tmux(args); } catch { /* 비치명 */ } }
async function getOpt(name: string, opt: string): Promise<string> {
  try { return (await tmux(["show-options", "-t", name, "-v", opt])).trim(); } catch { return ""; }
}

// 단일 tmux 호출로 모든 box-* 세션 + @box_* 메타를 읽는다(#{@user-option} 포맷 지원).
// @box_flags·@box_invites 는 label 앞에 둔다(label 은 탭 포함 가능해 ...rest 로 받으므로, 단일필드를 먼저 파싱).
//  둘 다 JSON(탭 없음 — 멤버 id·플래그값은 탭 미포함)이라 탭 구분 파싱에 안전.
const LIST_FMT = "#{session_name}\t#{session_created}\t#{session_attached}\t#{@box_owner}\t#{@box_harness}\t#{@box_dir}\t#{@box_auto}\t#{@box_flags}\t#{@box_invites}\t#{@box_project}\t#{@box_label}";

export async function listSessions(user: LivelyUser): Promise<SessionInfo[]> {
  let out = "";
  try { out = await tmux(["list-sessions", "-F", LIST_FMT]); } catch { return []; }
  const me = ownerId(user);
  const sessions: SessionInfo[] = [];
  for (const line of out.split("\n")) {
    if (!line.startsWith("box-")) continue;
    const [name, created, attached, owner, harness, dir, auto, flagsRaw, invitesRaw, projectRaw, ...labelParts] = line.split("\t");
    const owned = !!owner && owner === me;
    const invites = parseInvites(invitesRaw);
    // 프로젝트 폴더 세션은 '프로젝트 공동 세션' — 소비자(프로젝트 페이지)가 프로젝트 멤버십으로 게이트하고
    //  터미널 탭은 isProjectSessionDir 로 숨긴다. 여기서 초대 게이트를 걸면 프로젝트 멤버가 못 보는 회귀가 나므로 예외.
    if (!dirToProjectFolder(dir || "")) {
      if (!owned && !invites.includes(me)) continue;     // 개인 세션: 소유자 또는 초대된 사람만
    }
    let flags: Record<string, string> = {};
    try { if (flagsRaw) flags = JSON.parse(flagsRaw) as Record<string, string>; } catch { /* 구버전 세션 — 플래그 메타 없음 */ }
    sessions.push({
      id: name, label: (labelParts.join("\t") || name), harness: harness || "shell", dir: dir || "",
      autoApprove: auto === "1", owner: owner || "", owned,
      created: Number(created) || 0, attached: Number(attached) > 0, invites, flags,
      projectId: Number(projectRaw) || 0,
    });
  }
  sessions.sort((a, b) => (a.owned === b.owned ? b.created - a.created : a.owned ? -1 : 1));
  return sessions;
}

export async function createSession(user: LivelyUser, input: CreateInput): Promise<SessionInfo> {
  const { abs: target } = resolveRootPath(user, input.rootKey, input.subpath);
  await fsp.mkdir(target, { recursive: true, mode: 0o700 });

  const harness = HARNESSES.find((h) => h.key === input.harness);
  if (!harness) throw new HttpError(400, "허용되지 않은 하네스입니다");

  const cmd: string[] = [];
  const appliedFlags: Record<string, string> = {}; // 생성 시 적용한 플래그 — @box_flags 로 저장(수정 팝업 표시용).
  if (harness.bin) {
    cmd.push(harness.bin);
    for (const def of harness.flags) {
      const raw = input.flags?.[def.name];
      if (raw === undefined || raw === null || raw === "") continue;
      if (def.type === "bool") { if (raw) { cmd.push(def.name); appliedFlags[def.name] = "1"; } continue; }
      const v = String(raw);
      if (def.type === "select") { if (!def.choices?.includes(v)) throw new HttpError(400, `${def.label} 값이 허용 목록에 없습니다`); cmd.push(def.name, v); appliedFlags[def.name] = v; continue; }
      if (!SAFE_VALUE_RE.test(v) || v.length > 64) throw new HttpError(400, `${def.label} 값 형식이 잘못되었습니다`);
      cmd.push(def.name, v); appliedFlags[def.name] = v;
    }
    if (input.autoApprove && harness.autoApproveFlag) cmd.push(harness.autoApproveFlag);
  }

  const invites = await validInvites(input.invites, ownerId(user));
  const id = `${sessionPrefix(user)}${crypto.randomBytes(4).toString("hex")}`;
  const args = ["new-session", "-d", "-s", id, "-c", target];
  // 멀티프로필(#346): 프로필이 프로비저닝된 멤버면 세션스코프 -e CLAUDE_CONFIG_DIR 로 그 계정을 격리해 claude 를 띄운다.
  //  ⚠ 세션스코프 -e 만 쓴다(persistent tmux 서버라 global set-environment 는 세션 간 누수). 미프로비저닝=주입 안 함→공유 폴백.
  const profileDir = await resolveProfileConfigDir(user);
  if (profileDir) args.push("-e", `CLAUDE_CONFIG_DIR=${profileDir}`);
  if (cmd.length) args.push(...cmd);
  await tmux(args);
  const label = cleanLabel(input.label) || id;
  await tmux(["set-option", "-t", id, "@box_owner", ownerId(user)]);
  await tmux(["set-option", "-t", id, "@box_label", label]);
  await tmux(["set-option", "-t", id, "@box_harness", harness.key]);
  await tmux(["set-option", "-t", id, "@box_dir", target]);
  await tmux(["set-option", "-t", id, "@box_auto", input.autoApprove ? "1" : "0"]);
  await tmux(["set-option", "-t", id, "@box_flags", JSON.stringify(appliedFlags)]);
  await tmux(["set-option", "-t", id, "@box_invites", JSON.stringify(invites)]);
  // 프로젝트 세션엔 프로젝트 id 를 박아둔다 — 입장 게이트(canAttach)가 폴더 문자열이 아니라 이 id 로 멤버십을
  //  판정하게 해, 폴더 이름변경·접미사(-N)·아카이브(legacy-project/)·이동에도 입장이 끊기지 않게 한다.
  if (input.projectId) {
    await tmux(["set-option", "-t", id, "@box_project", String(input.projectId)]);
    await tmux(["set-option", "-t", id, "@box_project_src", input.projectSrc === "org" ? "org" : "v6"]);
    // v6 프로젝트 세션이면 세션↔프로젝트를 영속 기록 — 작업 타임라인이 이 세션의 AI 작업을 프로젝트로 귀속(끝난 세션 포함).
    //  (org 프로젝트는 session_project FK 대상이 아니라 제외.) best-effort: 실패해도 세션 생성은 진행.
    if (input.projectSrc !== "org") {
      try { await recordSessionProject(id, input.projectId); } catch { /* 비치명 */ }
    }
  }
  // 마우스 휠 스크롤 + window-size latest(상세 근거는 아래 ensureSessionOpts 주석 — #252 깨짐 수정).
  await tmuxQuiet(["set-option", "-t", id, "mouse", "on"]);
  await tmuxQuiet(["set-window-option", "-t", id, "aggressive-resize", "off"]);
  await tmuxQuiet(["set-window-option", "-t", id, "window-size", "latest"]);
  return { id, label, harness: harness.key, dir: target, autoApprove: !!input.autoApprove, owner: ownerId(user), owned: true, created: Math.floor(Date.now() / 1000), attached: false, invites, flags: appliedFlags };
}

interface OwnerMeta { owner: string; invites: string[]; }
async function ownerMeta(id: string): Promise<OwnerMeta | null> {
  if (!ID_RE.test(id)) return null;
  const owner = await getOpt(id, "@box_owner");
  if (!owner) return null; // box 세션이지만 메타 없음(우리 것 아님) → 거부
  return { owner, invites: parseInvites(await getOpt(id, "@box_invites")) };
}
// attach·파일접근 = 소유자 OR 초대된 멤버. 프로젝트 폴더 세션은 프로젝트 멤버십으로 게이트. kill/edit = 소유자만.
export async function canAttach(id: string, userId: string): Promise<boolean> {
  const m = await ownerMeta(id);
  if (!m) return false;
  // 프로젝트 폴더 세션은 '공동 세션' — 그 프로젝트 팀원(생성자 포함)만 입장(초대 목록과 무관, 멤버십이 게이트).
  const dir = await sessionDir(id);
  const folder = dirToProjectFolder(dir);
  if (folder) {
    // 1순위: 세션에 박힌 프로젝트 id 로 멤버십 판정 — 폴더 이름변경·접미사·아카이브·이동에 면역. src 로 v6/org 스토어 선택.
    const pid = Number(await getOpt(id, "@box_project")) || 0;
    if (pid) {
      // org_project 폐기(2026-06) — 모든 프로젝트 세션은 v6 project. src 구분 제거(org 분기는 DROP된 테이블 참조였음).
      if (await isProjectMemberV6(pid, userId)) return true;
    }
    // 폴백(구 세션·id 없음): 폴더 기준 — project/ ↔ legacy-project/ 양형 × v6·org 양쪽. 여전히 멤버십을 요구(과허용 없음).
    for (const f of folderVariants(folder)) {
      if (await projectAccessByFolderV6(f, userId)) return true;
    }
    return false;
  }
  return m.owner === userId || m.invites.includes(userId);
}
async function assertManage(user: LivelyUser, id: string): Promise<void> {
  const m = await ownerMeta(id);
  if (!m || m.owner !== ownerId(user)) throw new HttpError(403, "본인 세션이 아닙니다");
}
export async function killSession(user: LivelyUser, id: string): Promise<void> {
  await assertManage(user, id);
  await tmux(["kill-session", "-t", id]);
}
export async function editSession(user: LivelyUser, id: string, patch: { label?: string; invites?: unknown }): Promise<void> {
  await assertManage(user, id);
  if (patch.label !== undefined) {
    const clean = cleanLabel(patch.label);
    if (!clean) throw new HttpError(400, "이름이 필요합니다");
    await tmux(["set-option", "-t", id, "@box_label", clean]);
  }
  if (patch.invites !== undefined) {
    const invites = await validInvites(patch.invites, ownerId(user));
    await tmux(["set-option", "-t", id, "@box_invites", JSON.stringify(invites)]);
  }
}

// 리사이즈로 tmux 히스토리에 쌓인 프롬프트 중복(shrink→grow 시 overflow가 history 로 밀림)을 정리.
//  force=false: 히스토리가 작을 때만(=신선/경량 세션의 시작 churn) 정리 → 실작업 스크롤백은 보존.
//  force=true: 무조건 정리('다시 그리기' 버튼). clear-history 는 보이는 화면이 아니라 스크롤백만 비운다.
export async function tidyHistory(id: string, force: boolean): Promise<boolean> {
  if (!ID_RE.test(id)) return false;
  if (!force) {
    let sz = 9999;
    try { sz = Number((await tmux(["display-message", "-t", id, "-p", "#{history_size}"])).trim()) || 0; } catch { return false; }
    if (sz >= 50) return false; // 실작업 스크롤백이 있는 세션은 건드리지 않음
  }
  await tmuxQuiet(["clear-history", "-t", id]);
  return true;
}

// WS/파일 브리지용 작업 디렉터리(id 형식 검증 포함).
export async function sessionDir(id: string): Promise<string> {
  if (!ID_RE.test(id)) return os.homedir();
  return (await getOpt(id, "@box_dir")) || os.homedir();
}

// 단일 세션의 현재 라벨(@box_label) — 단독 터미널 페이지가 id 로 '지금 이름'을 조회한다.
//  목록 API(/sessions)는 프로젝트 세션을 빼므로, 그 세션의 상단 제목이 생성 시점 ?label= 에 고정되던 문제를 푼다.
//  접근통제(canAttach)는 라우트에서 — 여기선 값만 읽는다.
export async function getSessionLabel(id: string): Promise<string> {
  if (!ID_RE.test(id)) return "";
  return (await getOpt(id, "@box_label")) || "";
}

// attach 시점에 스크롤·리사이즈 옵션 보장(생성 전 세션·옵션 누락 방어 + 옛 세션을 latest 로 마이그레이트). 비치명.
// window-size latest: 창 크기를 '가장 최근 활동(refresh-client -C 포함) 클라이언트'에 맞춘다.
//  웹 터미널은 한 tmux pane 을 여러 클라(여러 탭·기기·잔존 연결)가 공유하는데 pane 크기는 하나뿐이라,
//  자기보다 큰 pane 을 받는 좁은 클라는 출력이 깨진다(254폭 내용이 83폭 xterm 에 들어가 줄이 어긋남).
//  - largest(옛 설정): 가장 큰 클라에 고정 → 좁은 탭이 영구히 깨지고 '화면 복구'(refresh-client 재전송)도
//    창을 못 줄여 무효였다(#252). 잔존하던 큰 연결 하나가 현재 탭을 계속 깨뜨림 → 새 세션만 정상이던 증상.
//  - latest: 지금 보는 탭이 connect/포커스/'화면 복구' 때 refresh-client 를 보내면 그 순간 '최근 활동'이
//    되어 pane 이 그 탭 크기로 맞춰진다 → 곧바로 정상 렌더(잔존·백그라운드 클라는 활동이 없어 크기를 못 끈다).
//    실측(tmux 3.6a, 격리소켓): largest 는 작은 클라 refresh 후에도 창 유지, latest 는 마지막 refresh 한
//    클라 크기로 전환됨을 확인. aggressive-resize 는 다중 '세션' 공유용이라 무관(끔 유지).
export async function ensureSessionOpts(id: string): Promise<void> {
  if (!ID_RE.test(id)) return;
  await tmuxQuiet(["set-option", "-t", id, "mouse", "on"]);
  await tmuxQuiet(["set-window-option", "-t", id, "aggressive-resize", "off"]);
  await tmuxQuiet(["set-window-option", "-t", id, "window-size", "latest"]);
}
