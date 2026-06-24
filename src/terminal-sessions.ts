// 중앙 박스 — tmux 세션 매니저 + 큐레이트 설정(허용 루트·하네스 플래그 카탈로그).
// 모든 tmux 호출은 execFile argv(셸 미경유) — 인젝션 차단. 세션은 box-<userSlug>-* 네임스페이스.
// 메타는 tmux @box_* user-option 에 저장(재기동 생존, tmux SoT — DB 미사용).
// visibility: public(보기+열기+사용, 협업) | private(소유자만). 기본 public.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import type { LivelyUser } from "./context.js";
import { HttpError } from "./capabilities/rest-util.js";
import { teamDir, isTeamMemberById, myTeamIds } from "./terminal-teams.js";
import { dirToProjectFolder } from "./project-fs.js";
import { projectAccessByFolder } from "./org/store.js";
import { projectAccessByFolder as projectAccessByFolderV6 } from "./v6/project-store.js";

const execFileAsync = promisify(execFile);
// 게이트웨이가 launchd/nohup 로 떠 PATH 에 brew 가 없을 수 있어 절대경로 우선(env 오버라이드 가능).
export const TMUX_BIN = process.env.TMUX_BIN || "/opt/homebrew/bin/tmux";

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

export type Visibility = "public" | "private";
export interface SessionInfo {
  id: string; label: string; harness: string; dir: string; autoApprove: boolean;
  visibility: Visibility; owner: string; owned: boolean; created: number; attached: boolean;
  team: string; // 소속 팀 폴더 id(@box_team). 빈값 = 팀 밖(최상위) 세션.
  flags: Record<string, string>; // 생성 시 적용된 하네스 플래그(@box_flags, 예: {"--model":"opus"}). 수정 팝업의 비활성 표시용.
}
export interface CreateInput { label: string; rootKey: string; subpath: string; harness: string; flags: Record<string, unknown>; autoApprove: boolean; visibility: string; team?: string; }

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "user";
const userSlug = (u: LivelyUser): string => slug(u.userId || u.email || "user");
const ownerId = (u: LivelyUser): string => u.userId || u.email || "";
export const sessionPrefix = (u: LivelyUser): string => `box-${userSlug(u)}-`;
const ID_RE = /^box-[a-z0-9-]+-[a-f0-9]{8}$/;
const SAFE_VALUE_RE = /^[A-Za-z0-9][A-Za-z0-9._\-:/]*$/;
const cleanLabel = (s: string): string => (s || "").replace(/[\t\n\r]/g, " ").trim().slice(0, 80);
const normVis = (v: unknown): Visibility => (v === "private" ? "private" : "public");

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

async function tmux(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(TMUX_BIN, args, { timeout: 5000 });
  return stdout;
}
async function tmuxQuiet(args: string[]): Promise<void> { try { await tmux(args); } catch { /* 비치명 */ } }
async function getOpt(name: string, opt: string): Promise<string> {
  try { return (await tmux(["show-options", "-t", name, "-v", opt])).trim(); } catch { return ""; }
}

// 단일 tmux 호출로 모든 box-* 세션 + @box_* 메타를 읽는다(#{@user-option} 포맷 지원).
// @box_team·@box_flags 는 label 앞에 둔다(label 은 탭 포함 가능해 ...rest 로 받으므로, 단일필드를 먼저 파싱).
//  @box_flags 는 JSON(탭 없음 — 값은 SAFE_VALUE_RE 통과)이라 탭 구분 파싱에 안전.
const LIST_FMT = "#{session_name}\t#{session_created}\t#{session_attached}\t#{@box_owner}\t#{@box_visibility}\t#{@box_harness}\t#{@box_dir}\t#{@box_auto}\t#{@box_team}\t#{@box_flags}\t#{@box_label}";

export async function listSessions(user: LivelyUser): Promise<SessionInfo[]> {
  let out = "";
  try { out = await tmux(["list-sessions", "-F", LIST_FMT]); } catch { return []; }
  const me = ownerId(user);
  const teams = await myTeamIds(user); // 내가 접근 가능한 팀(소유 or 멤버)
  const sessions: SessionInfo[] = [];
  for (const line of out.split("\n")) {
    if (!line.startsWith("box-")) continue;
    const [name, created, attached, owner, vis, harness, dir, auto, team, flagsRaw, ...labelParts] = line.split("\t");
    const visibility = normVis(vis);
    const owned = !!owner && owner === me;
    const teamId = team || "";
    if (teamId) {
      if (!teams.has(teamId)) continue;                  // 팀 세션인데 그 팀 멤버 아님 → 숨김(공개여도)
      if (visibility === "private" && !owned) continue;  // 팀 안 비공개 = 작성자만
    } else if (!owned && visibility !== "public") {
      continue;                                          // 팀 밖 비공개 + 남의 것 → 숨김
    }
    let flags: Record<string, string> = {};
    try { if (flagsRaw) flags = JSON.parse(flagsRaw) as Record<string, string>; } catch { /* 구버전 세션 — 플래그 메타 없음 */ }
    sessions.push({
      id: name, label: (labelParts.join("\t") || name), harness: harness || "shell", dir: dir || "",
      autoApprove: auto === "1", visibility, owner: owner || "", owned,
      created: Number(created) || 0, attached: Number(attached) > 0, team: teamId, flags,
    });
  }
  sessions.sort((a, b) => (a.owned === b.owned ? b.created - a.created : a.owned ? -1 : 1));
  return sessions;
}

export async function createSession(user: LivelyUser, input: CreateInput): Promise<SessionInfo> {
  const teamId = (input.team || "").trim();
  if (teamId && !(await isTeamMemberById(teamId, ownerId(user)))) throw new HttpError(403, "팀 접근 권한이 없습니다");
  const { abs: target } = resolveRootPath(user, input.rootKey, input.subpath);
  if (teamId) {
    // 팀 세션은 그 팀 폴더(또는 하위) 안에서만 — 경로 위조 차단.
    const tdir = teamDir(teamId);
    if (target !== tdir && !target.startsWith(tdir + path.sep)) throw new HttpError(400, "팀 폴더 밖 경로입니다");
  }
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

  const visibility = normVis(input.visibility);
  const id = `${sessionPrefix(user)}${crypto.randomBytes(4).toString("hex")}`;
  const args = ["new-session", "-d", "-s", id, "-c", target];
  if (cmd.length) args.push(...cmd);
  await tmux(args);
  const label = cleanLabel(input.label) || id;
  await tmux(["set-option", "-t", id, "@box_owner", ownerId(user)]);
  await tmux(["set-option", "-t", id, "@box_label", label]);
  await tmux(["set-option", "-t", id, "@box_harness", harness.key]);
  await tmux(["set-option", "-t", id, "@box_dir", target]);
  await tmux(["set-option", "-t", id, "@box_auto", input.autoApprove ? "1" : "0"]);
  await tmux(["set-option", "-t", id, "@box_flags", JSON.stringify(appliedFlags)]);
  await tmux(["set-option", "-t", id, "@box_visibility", visibility]);
  if (teamId) await tmux(["set-option", "-t", id, "@box_team", teamId]);
  // 스크롤 줄중복·리사이즈 개선: 휠→tmux copy-mode + window-size largest(작은 피커가 창 못 줄임).
  await tmuxQuiet(["set-option", "-t", id, "mouse", "on"]);
  await tmuxQuiet(["set-window-option", "-t", id, "aggressive-resize", "off"]);
  await tmuxQuiet(["set-window-option", "-t", id, "window-size", "largest"]);
  return { id, label, harness: harness.key, dir: target, autoApprove: !!input.autoApprove, visibility, owner: ownerId(user), owned: true, created: Math.floor(Date.now() / 1000), attached: false, team: teamId, flags: appliedFlags };
}

interface OwnerVis { owner: string; visibility: Visibility; team: string; }
async function ownerVis(id: string): Promise<OwnerVis | null> {
  if (!ID_RE.test(id)) return null;
  const owner = await getOpt(id, "@box_owner");
  if (!owner) return null; // box 세션이지만 메타 없음(우리 것 아님) → 거부
  return { owner, visibility: normVis(await getOpt(id, "@box_visibility")), team: await getOpt(id, "@box_team") };
}
// attach·파일접근 = (팀 세션이면 팀 멤버) AND (소유자 OR 공개). kill/edit = 소유자만.
export async function canAttach(id: string, userId: string): Promise<boolean> {
  const m = await ownerVis(id);
  if (!m) return false;
  // 프로젝트 폴더 세션은 '공동 세션' — 그 프로젝트 팀원(생성자 포함)만 입장(공개여도 외부 차단).
  //  폴더는 레거시(org_project)·v6(project) 어느 쪽 프로젝트에도 속할 수 있다. UI 프로젝트 탭은 v6 에
  //  세션을 만들므로 둘 다 확인해야 한다 — 안 그러면 v6 프로젝트 세션은 생성자 본인도 입장이 거부된다.
  const dir = await sessionDir(id);
  const folder = dirToProjectFolder(dir);
  if (folder) return (await projectAccessByFolder(folder, userId)) || (await projectAccessByFolderV6(folder, userId));
  if (m.team && !(await isTeamMemberById(m.team, userId))) return false; // 팀 멤버 아니면 공개여도 차단
  return m.owner === userId || m.visibility === "public";
}
async function assertManage(user: LivelyUser, id: string): Promise<void> {
  const m = await ownerVis(id);
  if (!m || m.owner !== ownerId(user)) throw new HttpError(403, "본인 세션이 아닙니다");
}
export async function killSession(user: LivelyUser, id: string): Promise<void> {
  await assertManage(user, id);
  await tmux(["kill-session", "-t", id]);
}
export async function editSession(user: LivelyUser, id: string, patch: { label?: string; visibility?: string }): Promise<void> {
  await assertManage(user, id);
  if (patch.label !== undefined) {
    const clean = cleanLabel(patch.label);
    if (!clean) throw new HttpError(400, "이름이 필요합니다");
    await tmux(["set-option", "-t", id, "@box_label", clean]);
  }
  if (patch.visibility !== undefined) {
    await tmux(["set-option", "-t", id, "@box_visibility", normVis(patch.visibility)]);
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

// attach 시점에 스크롤·리사이즈 옵션 보장(생성 전 세션이나 옵션 누락 케이스 방어). 비치명.
// window-size largest: 여러 클라이언트가 같은 세션을 봐도 '가장 큰' 클라 기준 유지 → 작은 피커가
//  창을 쪼그라뜨려(=리사이즈 churn → 프롬프트 중복이 히스토리에 쌓임) 다른 사람 화면을 깨는 것 방지.
//  (aggressive-resize 는 정반대로 '가장 작은' 클라에 맞춰서 이 버그의 원인 — 사용 안 함.)
export async function ensureSessionOpts(id: string): Promise<void> {
  if (!ID_RE.test(id)) return;
  await tmuxQuiet(["set-option", "-t", id, "mouse", "on"]);
  await tmuxQuiet(["set-window-option", "-t", id, "aggressive-resize", "off"]);
  await tmuxQuiet(["set-window-option", "-t", id, "window-size", "largest"]);
}
