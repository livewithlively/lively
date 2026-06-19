// 중앙 박스 — tmux 세션 매니저 + 큐레이트 설정(허용 루트·하네스 플래그 카탈로그).
// 모든 tmux 호출은 execFile argv(셸 미경유) — 인젝션 차단. 세션은 box-<userSlug>-* 네임스페이스로
// 격리해 기존 인프라 세션(claude-*·wj-* 등)과 불간섭. 메타는 tmux @box_* user-option 에 저장(재기동 생존).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import type { LivelyUser } from "./context.js";
import { HttpError } from "./capabilities/rest-util.js";

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
    flags: [
      { name: "--model", label: "모델", desc: "비우면 기본 모델. 예: sonnet · opus · haiku", type: "text" },
    ],
  },
  {
    key: "codex", label: "Codex", bin: "codex",
    autoApproveFlag: "--dangerously-bypass-approvals-and-sandbox",
    flags: [
      { name: "--model", label: "모델", desc: "비우면 기본 모델", type: "text" },
    ],
  },
  { key: "shell", label: "셸 (에이전트 없음)", bin: "", flags: [] },
];

export interface SessionInfo { id: string; label: string; harness: string; dir: string; autoApprove: boolean; created: number; attached: boolean; }
export interface CreateInput { label: string; rootKey: string; subpath: string; harness: string; flags: Record<string, unknown>; autoApprove: boolean; }

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "user";
const userSlug = (u: LivelyUser): string => slug(u.userId || u.email || "user");
const ownerId = (u: LivelyUser): string => u.userId || u.email || "";
export const sessionPrefix = (u: LivelyUser): string => `box-${userSlug(u)}-`;
// 세션 id 형식 강제 — argv 안전 + 소유권 prefix 검증의 기반.
const ID_RE = /^box-[a-z0-9-]+-[a-f0-9]{8}$/;
// 플래그 텍스트값 — argv 라 셸 인젝션은 없지만, 하네스가 플래그로 오인하지 않게 leading dash 차단 + 보수적 charset.
const SAFE_VALUE_RE = /^[A-Za-z0-9][A-Za-z0-9._\-:/]*$/;

async function tmux(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(TMUX_BIN, args, { timeout: 5000 });
  return stdout;
}
async function getOpt(name: string, opt: string): Promise<string> {
  try { return (await tmux(["show-options", "-t", name, "-v", opt])).trim(); } catch { return ""; }
}
interface Meta { owner: string; label: string; harness: string; dir: string; auto: string; }
async function readMeta(name: string): Promise<Meta> {
  return {
    owner: await getOpt(name, "@box_owner"), label: await getOpt(name, "@box_label"),
    harness: await getOpt(name, "@box_harness"), dir: await getOpt(name, "@box_dir"), auto: await getOpt(name, "@box_auto"),
  };
}

export async function listSessions(user: LivelyUser): Promise<SessionInfo[]> {
  let out = "";
  try { out = await tmux(["list-sessions", "-F", "#{session_name}\t#{session_created}\t#{session_attached}"]); }
  catch { return []; } // tmux 서버 없음/세션 없음
  const prefix = sessionPrefix(user);
  const me = ownerId(user);
  const rows = out.split("\n").filter(Boolean).map((l) => l.split("\t")).filter((p) => p[0].startsWith(prefix));
  const sessions: SessionInfo[] = [];
  for (const [name, created, attached] of rows) {
    const meta = await readMeta(name);
    if (meta.owner && meta.owner !== me) continue; // 이중 확인
    sessions.push({
      id: name, label: meta.label || name, harness: meta.harness || "shell", dir: meta.dir || "",
      autoApprove: meta.auto === "1", created: Number(created) || 0, attached: Number(attached) > 0,
    });
  }
  sessions.sort((a, b) => b.created - a.created);
  return sessions;
}

export async function createSession(user: LivelyUser, input: CreateInput): Promise<SessionInfo> {
  const root = ROOTS.find((r) => r.key === input.rootKey);
  if (!root) throw new HttpError(400, "허용되지 않은 루트입니다");
  let base = root.base;
  if (root.perUser) base = path.join(base, userSlug(user));
  base = path.resolve(base);
  // 디렉터리 봉쇄 — subpath 가 base 를 벗어나면(.. 등) 거부.
  const sub = String(input.subpath || "").replace(/^[/\\]+/, "");
  const target = path.resolve(base, sub);
  if (target !== base && !target.startsWith(base + path.sep)) throw new HttpError(400, "허용 루트를 벗어난 경로입니다");
  await fsp.mkdir(target, { recursive: true, mode: 0o700 });

  const harness = HARNESSES.find((h) => h.key === input.harness);
  if (!harness) throw new HttpError(400, "허용되지 않은 하네스입니다");

  // 하네스 실행 argv 구성(화이트리스트 + 값 검증).
  const cmd: string[] = [];
  if (harness.bin) {
    cmd.push(harness.bin);
    for (const def of harness.flags) {
      const raw = input.flags?.[def.name];
      if (raw === undefined || raw === null || raw === "") continue;
      if (def.type === "bool") { if (raw) cmd.push(def.name); continue; }
      const v = String(raw);
      if (def.type === "select") { if (!def.choices?.includes(v)) throw new HttpError(400, `${def.label} 값이 허용 목록에 없습니다`); cmd.push(def.name, v); continue; }
      if (!SAFE_VALUE_RE.test(v) || v.length > 64) throw new HttpError(400, `${def.label} 값 형식이 잘못되었습니다`);
      cmd.push(def.name, v);
    }
    if (input.autoApprove && harness.autoApproveFlag) cmd.push(harness.autoApproveFlag);
  }

  const id = `${sessionPrefix(user)}${crypto.randomBytes(4).toString("hex")}`;
  const args = ["new-session", "-d", "-s", id, "-c", target];
  if (cmd.length) args.push(...cmd);
  await tmux(args);
  const label = (input.label || "").trim().slice(0, 80) || id;
  await tmux(["set-option", "-t", id, "@box_owner", ownerId(user)]);
  await tmux(["set-option", "-t", id, "@box_label", label]);
  await tmux(["set-option", "-t", id, "@box_harness", harness.key]);
  await tmux(["set-option", "-t", id, "@box_dir", target]);
  await tmux(["set-option", "-t", id, "@box_auto", input.autoApprove ? "1" : "0"]);
  return { id, label, harness: harness.key, dir: target, autoApprove: !!input.autoApprove, created: Math.floor(Date.now() / 1000), attached: false };
}

async function assertOwner(user: LivelyUser, id: string): Promise<void> {
  if (!ID_RE.test(id) || !id.startsWith(sessionPrefix(user))) throw new HttpError(403, "본인 세션이 아닙니다");
  const owner = await getOpt(id, "@box_owner");
  if (owner && owner !== ownerId(user)) throw new HttpError(403, "본인 세션이 아닙니다");
}
export async function killSession(user: LivelyUser, id: string): Promise<void> {
  await assertOwner(user, id);
  await tmux(["kill-session", "-t", id]);
}
export async function renameSession(user: LivelyUser, id: string, label: string): Promise<void> {
  await assertOwner(user, id);
  const clean = (label || "").trim().slice(0, 80);
  if (!clean) throw new HttpError(400, "이름이 필요합니다");
  await tmux(["set-option", "-t", id, "@box_label", clean]);
}

// WS 브리지용 — 소유자/작업디렉터리 조회(id 형식 검증 포함).
export async function sessionOwner(id: string): Promise<string | null> {
  if (!ID_RE.test(id)) return null;
  return (await getOpt(id, "@box_owner")) || null;
}
export async function sessionDir(id: string): Promise<string> {
  return (await getOpt(id, "@box_dir")) || os.homedir();
}
