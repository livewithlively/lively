// 중앙 박스 — tmux 세션 매니저 + 큐레이트 설정(허용 루트·하네스 플래그 카탈로그).
// 모든 tmux 호출은 execFile argv(셸 미경유) — 인젝션 차단. 세션은 box-<userSlug>-* 네임스페이스.
// 메타는 tmux @box_* user-option 에 저장(재기동 생존, tmux SoT — DB 미사용).
// 접근 모델(#1015): 두 축이 직교한다. ① 가시성(목록) — 기본 '공개'(모든 멤버가 보고 무슨 작업인지 앎), @box_private=1 이면
//  '비공개'(소유자·초대자만 목록에 뜸). ② 입장·조작·대화열람 — 항상 소유자 + 초대된 멤버(@box_invites)만(공개여도 입장 제한);
//  프로젝트 폴더 세션은 로그인 전원(#452). 판정은 sessionVisibleTo / sessionAttachableBy(순수 함수) 참조.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import type { LivelyUser } from "./context.js";
import { HttpError } from "./capabilities/rest-util.js";
import { dirToProjectFolder } from "./project-fs.js";
import { recordSessionProject } from "./v6/project-store.js";
import { listMembers, getMember, mintToken, listTokens, revokeToken, getRuntimeConfig } from "./org/store.js";
// 공유 빌드 캐시(#813 T3) — 세션이 의존성을 워크트리마다 새로 받지 않게 박스 전역 캐시를 가리킨다.
import { sessionCacheEnv } from "./session-cache.js";
import { effectiveStoragePolicy } from "./org/storage-policy.js";
// 디스크 가드(#813 T5) — 세션은 워크트리·의존성으로 디스크를 크게 먹는다. 꽉 찬 뒤엔 DB 가 죽어 복구가 수동이라,
//  차기 **전에** 신규 세션을 막는다(기존 세션·읽기는 안 막는다).
import { assertDiskWritable } from "./disk-guard.js";
import { orgTimezone } from "./org/timezone.js"; // #778 pane TZ = 조직 시간대
import { SESSION_ID_RE } from "./org/agent-identity.js"; // #852 세션 id 형식 — 게이트웨이 헤더 판정과 같은 자
import { DANGEROUS_SCOPES, isScope } from "./capabilities/scopes.js";
import { resolveMemberOsUser, wrapAsMember, osUsername, isolationInfraReady, osUserExists } from "./terminal-isolation.js";
import { memberMkdir } from "./terminal-member-fs.js";
import { materializeMemberGit, ensureGitSafeDirectory } from "./org/git-credential-materialize.js";

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

// pane(세션 안 shell/Claude) 로케일 — 한글(멀티바이트·더블폭) 편집 정상화(#633). ⚠ TMUX_ENV(위)는 tmux **CLI**
//  호출에만 UTF-8 을 준다 — 그 값은 pane 까지 전달되지 않는다. tmux 는 LANG/LC_* 를 update-environment 기본
//  목록에 넣지 않아, pane 프로세스는 **tmux 서버**의 env 를 상속하는데 서버가 launchd/nohup 로 LANG 없이 뜨면
//  pane 이 C/POSIX 로케일이 된다(실측: 라이브 box- 세션의 claude/zsh pane 은 LANG/LC_* 가 전혀 없음 = C).
//  C 로케일에선 zsh/readline 이 한글을 바이트폭으로 오산(글자당 1이 아닌 3열 등)해, 평범한 타이핑은 멀쩡해 보여도
//  단어이동(Option+←/→ = Meta-b/f)·중간삽입 시 커서 열이 어긋나 줄이 뒤섞이고 같은 글자가 반복 입력된다(#633).
//  → new-session 에 **세션스코프 -e** 로 UTF-8 로케일을 pane 에 직접 주입한다(전역/타세션 누수 없음 — 기존
//  -e CLAUDE_CONFIG_DIR 패턴과 동일). 값: 게이트웨이 env 의 UTF-8 로케일을 재사용(호스트에 실재하는 유효값),
//  없으면 플랫폼 기본 — macOS=en_US.UTF-8, Linux=C.UTF-8(glibc 에 항상 존재. en_US.UTF-8 은 미생성일 수 있음).
//  (⚠ 이미 떠 있는 pane 의 env 는 exec 시점에 고정 → 이 수정은 **새 세션**에만 적용. 옛 세션은 재생성 시 정상화.)
export const PANE_LOCALE: string = (() => {
  const cur = process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || "";
  if (/utf-?8/i.test(cur)) return cur;
  return process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8";
})();

// ── 큐레이트 허용 루트 ──
export interface Root { key: string; label: string; base: string; perUser?: boolean; }
export const ROOTS: Root[] = [
  { key: "shared", label: "공유 워크스페이스", base: process.env.TERMINAL_ROOT_SHARED || path.join(os.homedir(), "workspace") },  // 폴백 = deploy 관례($HOME/workspace)
  { key: "personal", label: "개인 폴더", base: process.env.TERMINAL_ROOT_PERSONAL || path.join(os.homedir(), "box"), perUser: true },
];

// 공유 워크스페이스 루트 — 공유 빌드 캐시(#813)가 이 아래 `.cache` 로 산다.
//  그 디렉터리의 그룹·setgid 권한을 물려받아야 멤버별 격리 OS 유저(#524)들이 캐시를 함께 쓸 수 있다.
export const SHARED_ROOT: Root = ROOTS.find((r) => r.key === "shared") ?? ROOTS[0];

// ── 하네스 플래그 카탈로그(보수적 화이트리스트) ──
export interface FlagDef { name: string; label: string; desc: string; type: "select" | "bool" | "text"; choices?: string[]; default?: string; }
export interface Harness { key: string; label: string; bin: string; autoApproveFlag?: string; flags: FlagDef[]; }
export const HARNESSES: Harness[] = [
  {
    key: "claude", label: "Claude Code", bin: "claude",
    autoApproveFlag: "--dangerously-skip-permissions",
    flags: [
      { name: "--model", label: "모델", desc: "비우면 기본 모델", type: "select", choices: ["", "opus", "sonnet", "haiku"] },
      { name: "--effort", label: "effort(추론 강도)", desc: "비우면 기본. 판단 무거운 작업(부트스트랩·분류)은 high+ 권장", type: "select", choices: ["", "low", "medium", "high", "xhigh", "max"] },
    ],
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
  private?: boolean;     // #1015 비공개면 소유자·초대자만 목록에서 봄. 기본(미설정)=공개=모든 멤버가 목록에서 봄.
  attachable?: boolean;  // #1015 이 뷰어가 입장·조작 가능한가(=canAttach: 소유자·초대자, 프로젝트 세션은 전원). 공개-남의세션이면 false → 프론트가 '보기 전용'.
  invites: string[]; // 초대된 멤버 id(@box_invites). 초대자는 입장·조작 가능. (가시성은 private 플래그가 결정 — 초대 여부와 별개, #1015)
  flags: Record<string, string>; // 생성 시 적용된 하네스 플래그(@box_flags, 예: {"--model":"opus"}). 수정 팝업의 비활성 표시용.
  projectId?: number; // 프로젝트 세션이면 그 프로젝트 id(@box_project). 보드의 '내 세션' 칼럼 활성 판단용.
  // 에이전트 실행 상태(#req 4단계) — busy=프로세스그룹 CPU 큼(작업중, 접속 무관), waiting=접속중+화면에 사용자 선택/승인 대기(확인 필요),
  //  idle=접속중+CPU~0+대기프롬프트없음(대기중), offline=브라우저 미접속(유휴) 또는 포그라운드가 셸(하네스 종료).
  agentState?: "busy" | "waiting" | "idle" | "offline";
  // 실시간 작업 요약(#req) — Claude Code 가 pane_title 에 써두는 '지금 하는 일' 요약(상태 글리프 제거). 없으면 빈 문자열 → 프론트가 label 로 폴백.
  title?: string;
  // 마지막 '작업(busy)' 시각(epoch초) — 클로드가 마지막으로 턴을 돌리고 있던(또는 끝낸) 때. 정렬·카드 시간 표시용.
  //  ⚠ '내가 열어본(브라우저 접속)' 시각은 섞지 않는다(#853) — 열어보기는 작업이 아니다.
  //  @box_last_busy(tmux 세션 옵션)로 영속 → 게이트웨이가 재기동해도 유지(tmux 서버가 더 오래 산다).
  lastActive?: number;
}
export interface CreateInput { label: string; rootKey: string; subpath: string; harness: string; flags: Record<string, unknown>; autoApprove: boolean; invites?: unknown; projectId?: number; projectSrc?: "v6" | "org"; loginProfile?: boolean; resume?: string; readOnly?: boolean; incognito?: boolean; private?: boolean; }

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "user";
const userSlug = (u: LivelyUser): string => slug(u.userId || u.email || "user");
const ownerId = (u: LivelyUser): string => u.userId || u.email || "";
export const sessionPrefix = (u: LivelyUser): string => `box-${userSlug(u)}-`;
const ID_RE = SESSION_ID_RE;   // 세션 id 형식의 단일 진실원천 — 게이트웨이가 헤더로 받은 세션도 같은 자로 잰다(#852)
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

// 격리(#524) 루트 베이스 — 세션이 멤버 uid 로 돌면 작업 디렉터리도 그 uid 로 접근가능해야 한다.
//  personal = 멤버 홈 하위(box_<slug> 소유), shared = lively-shared 그룹 공유 dir(게이트웨이·멤버 공동 rw).
const MEMBER_HOME_BASE = process.env.LIVELY_MEMBER_HOME_BASE || "/home";              // useradd -m -d /home/box_<slug>
const PERSONAL_SUBDIR = "box";                                                        // 멤버 홈/box = '개인 폴더'
const SHARED_ISOLATED_BASE = process.env.LIVELY_SHARED_DIR || "/srv/lively/shared";   // root:lively-shared 2775(setgid)

// 허용 루트 기준 경로 해소(+봉쇄). subpath 의 .. 탈출은 거부.
//  격리+프로비저닝된 멤버면 멤버-접근가능 베이스로(세션 spawn 과 동일 게이트 = resolveMemberOsUser),
//  아니면 게이트웨이 홈 기준(종전, perUser=base/<userSlug>). 세션 생성·생성폼 폴더 탐색이 공유한다.
export async function resolveRootPath(user: LivelyUser, rootKey: string, subpath: string, osUser?: string | null): Promise<{ base: string; abs: string }> {
  const root = ROOTS.find((r) => r.key === rootKey);
  if (!root) throw new HttpError(400, "허용되지 않은 루트입니다");
  // osUser: 호출자가 격리 여부를 강제한다(프로젝트 공동 세션은 null 로 격리 제외 — cwd 가 게이트웨이 소유라). undefined 면 여기서 파생.
  const iso = osUser === undefined ? await resolveMemberOsUser(userSlug(user)) : osUser;
  let base: string;
  if (iso) {
    base = root.perUser ? path.join(MEMBER_HOME_BASE, iso, PERSONAL_SUBDIR) : SHARED_ISOLATED_BASE;
  } else {
    base = root.base;
    if (root.perUser) base = path.join(base, userSlug(user));
  }
  base = path.resolve(base);
  const sub = String(subpath || "").replace(/^[/\\]+/, "");
  const abs = path.resolve(base, sub);
  if (abs !== base && !abs.startsWith(base + path.sep)) throw new HttpError(400, "허용 루트를 벗어난 경로입니다");
  return { base, abs };
}

// ── 멀티프로필 / 프로필별 Claude 계정(#346) ──
//  M1: 프로필 = 세션 owner(멤버). 프로필별 격리된 CLAUDE_CONFIG_DIR(=config·자격증명·MCP)로 claude 를 띄운다.
//  각 프로필 dir 은 1회 로그인(CLAUDE_CONFIG_DIR=<dir> claude)으로 프로비저닝된다(+키트로 lively MCP·훅 주입).
//  ⚠ 신원 불변식(#1014): 멀티프로필이 켜진 한(기본), 세션은 **항상 이 멤버 전용 CLAUDE_CONFIG_DIR** 로 뜬다 —
//    로그인 전이어도. 예전엔 미로그인이면 CLAUDE_CONFIG_DIR 을 안 줘 호스트 공유 ~/.claude 로 폴백했는데, 그
//    공유 config 엔 설치 때 구워진 **특정 멤버의 lively 토큰**이 있어 신규/미로그인 프로필이 조용히 그 사람으로
//    인증되는 구멍이었다(fail-open 임퍼스네이션). 그래서 공유 폴백을 폐기했다: 자기 dir 을 가리키면 claude /login
//    자격도 lively MCP(멤버 토큰, provisionProfile 이 구움)도 이 멤버 dir 에만 격리된다.
//    LIVELY_MULTIPROFILE=0 이면 전면 비활성(항상 공유) — 단일-유저 박스 전용 kill-switch(계정이 하나라 임퍼스네이션 위험 0).
const PROFILES_ROOT = process.env.LIVELY_PROFILES_ROOT || path.join(os.homedir(), ".lively", "profiles");
export function profileConfigDir(user: LivelyUser): string {
  return path.join(PROFILES_ROOT, userSlug(user), "claude");
}
// 프로필이 로그인된 자격증명(.credentials.json)을 가졌으면 그 CLAUDE_CONFIG_DIR, 아니면 null.
//  ⚠ null 의 의미는 호출자가 정한다 — createSession(웹터미널)은 #1014 이후 null 이어도 공유로 폴백하지 않고
//    항상 자기 dir 을 만들어 쓴다(profileConfigDir). 이 함수는 위탁 러너 node/tasks.ts 의 노드-로컬 폴백 판정에만 쓰인다.
export async function resolveProfileConfigDir(user: LivelyUser): Promise<string | null> {
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
//
//  ⭐ per-member lively 신원: 프로필 .claude.json 의 lively MCP 를 '공용 agent' 가 아니라 '이 멤버' 토큰으로 굽는다.
//   → 그 프로필로 뜬 세션의 MCP 쓰기(knowledge_save 등)가 멤버로 귀속(updated_by=멤버)·토큰탭 표시·회수가능.
//   멤버 DB 토큰(lvk_)을 발급 → LIVELY_TOKEN 으로 넘김(register-clients 가 프로필 .claude.json 에 구움).
//   유효권한 = verifyDbToken 이 '라이브 멤버 스코프'와 매 호출 교집합(퇴사·강등 즉시 무효). admin/runtime 은 기본 제외(세션 최소권한) — 관리탭에서 admin 이 명시 opt-in(includeControlPlane) 시에만 포함(#549 후속).
//   ⚠ KIT_PROFILE_ONLY=1 — install-kit 이 공유 ~/.lively/token(훅 fetch·전 세션 공유)을 멤버 토큰으로 덮지 않게(프로필 .claude.json 만).
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");   // dist/ → 리포 루트

// 중앙박스 프로필/OS 유저 토큰 발급 — 기존 central-box 토큰 회수 후 새로 굽는다(평문은 못 되찾으니 매번 새로).
//  기본은 admin/runtime 제외(세션 최소권한). includeControlPlane=true(관리탭에서 admin 이 '관리 권한 포함'을 명시
//  opt-in)면 멤버 scope 의 admin/runtime 도 싣는다 — 에이전트가 관리 기능(MCP org_*)을 세션에서 쓰게(#549 후속).
//  멤버 scope 가 상한이라 멤버에 admin 없으면 자연히 안 실리고, 멤버 scope 하향 시 매 호출 intersection 으로 즉시
//  무효(회수의 진짜 지점 = 멤버 scope지 발급 경로가 아니다). 발급은 org_content_audit 에 남는다(누가 어느 에이전트에 관리권한 실었나).
async function mintCentralBoxToken(memberId: string, memberScopes: string[], slug: string, includeControlPlane: boolean): Promise<string> {
  // 재프로비저닝 누적 방지 — 이 멤버의 기존 central-box 토큰 회수(평문은 못 되찾으니 매번 새로 굽는다).
  for (const t of await listTokens()) {
    if (t.member_id === memberId && !t.revoked_at && (t.label || "").startsWith("central-box:")) {
      await revokeToken(t.token_hash, "provisionCentralBox", "terminal-sessions");
    }
  }
  const dangerous = DANGEROUS_SCOPES as ReadonlySet<string>;
  // 기본: admin/runtime 제외. opt-in: 멤버 scope 그대로(admin/runtime 포함 — 멤버가 그 권한을 가질 때만 실제로 실림).
  const scopes = (memberScopes || []).filter((s) => isScope(s) && (includeControlPlane || !dangerous.has(s)));
  const { token } = await mintToken(
    { userId: memberId, memberId, scopes, label: `central-box:${slug}${includeControlPlane ? " +admin" : ""}` },
    "provisionCentralBox", "terminal-sessions",
  );
  return token;
}

export async function provisionProfile(memberId: string, opts?: { includeControlPlane?: boolean }): Promise<{ slug: string; dir: string }> {
  const u = { userId: memberId } as LivelyUser;
  const member = await getMember(memberId);
  if (!member) throw new HttpError(404, `구성원 없음: ${memberId}`);
  const slug = userSlug(u);
  const token = await mintCentralBoxToken(memberId, member.scopes || [], slug, !!opts?.includeControlPlane);

  const script = path.join(REPO_ROOT, "deploy", "provision-profile.sh");
  // 게이트웨이 env 상속 + 멤버 토큰(프로필 .claude.json 에 구움) + KIT_PROFILE_ONLY(공유 ~/.lively 보존). 최대 3분(키트 다운로드+등록).
  await execFileAsync("bash", [script, memberId], {
    timeout: 180_000,
    env: { ...process.env, LIVELY_TOKEN: token, KIT_PROFILE_ONLY: "1" },
    cwd: REPO_ROOT, maxBuffer: 4 * 1024 * 1024,
  });
  return { slug, dir: profileConfigDir(u) };
}

// 웹 OS-유저 프로비저닝(#524) — 관리자 버튼이 이 함수로 멤버의 OS 유저(box_<slug>)를 프로비저닝한다.
//  root 가 필요한 useradd 등은 **root 소유 고정 스크립트**(PROVISION_BIN, install-isolation.sh 가 설치)만
//  잠긴 sudoers 로 실행(게이트웨이 비-root). 게이트웨이가 쓰기 가능한 레포 경로를 sudo 대상으로 두면 위험하므로
//  반드시 /opt/lively/libexec 의 root 소유본을 쓴다. 멤버 토큰은 provisionProfile 과 동일하게 민팅해 넘긴다
//  (sudoers env_keep=LIVELY_TOKEN/MEMBER_NAME/MEMBER_EMAIL 로 통과 — PATH 는 미보존이라 secure_path). admin 게이트는 라우트가.
const PROVISION_BIN = process.env.LIVELY_PROVISION_BIN || "/opt/lively/libexec/provision-member";
export async function provisionMemberOs(memberId: string, opts?: { includeControlPlane?: boolean }): Promise<{ slug: string; osUser: string }> {
  const u = { userId: memberId } as LivelyUser;
  const member = await getMember(memberId);
  if (!member) throw new HttpError(404, `구성원 없음: ${memberId}`);
  const slug = userSlug(u);
  const token = await mintCentralBoxToken(memberId, member.scopes || [], slug, !!opts?.includeControlPlane);
  await execFileAsync("sudo", ["-n", PROVISION_BIN, memberId], {
    timeout: 180_000,
    env: { ...process.env, LIVELY_TOKEN: token, MEMBER_NAME: member.display_name || slug, MEMBER_EMAIL: member.email || "" },
    cwd: REPO_ROOT, maxBuffer: 4 * 1024 * 1024,
  });
  return { slug, osUser: osUsername(slug) };
}

// box_ claude 로그인 여부 — ⚠ 게이트웨이(lively)는 멤버 700 홈을 '읽지' 못한다(격리의 본질). 대신 box_ 로 drop-priv 해서
//  creds 파일 '존재'만 확인(내용은 안 봄). exit0=있음=로그인됨. 미프로비저닝/에러=false. UI 로그인 배너 숨김 판정용.
async function memberClaudeLoggedIn(osUser: string): Promise<boolean> {
  try {
    const w = wrapAsMember(osUser, ["sh", "-c", 'test -f "$HOME/.claude/.credentials.json"']);
    await execFileAsync(w[0], w.slice(1), { timeout: 5000 });
    return true;
  } catch { return false; }
}
// OS 격리 상태(#524) — UI 표시용. ready=인프라 준비(활성+Linux+box-spawn), provisioned=이 멤버 box_<slug> 존재,
//  loggedIn=box_ 홈에 claude 자격증명 있음(drop-priv 확인). loggedIn 이면 UI 로그인 버튼 숨김.
export async function memberOsStatus(memberId: string): Promise<{ ready: boolean; provisioned: boolean; osUser: string; loggedIn: boolean }> {
  const osUser = osUsername(userSlug({ userId: memberId } as LivelyUser));
  const provisioned = await osUserExists(osUser);
  return { ready: isolationInfraReady(), provisioned, osUser, loggedIn: provisioned ? await memberClaudeLoggedIn(osUser) : false };
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
// pane_current_command(포그라운드 프로세스)·pane_pid(=포그라운드 pid, CPU 판정용)를 label 앞에 추가(label 은 탭 포함 가능해 ...rest 로 받으므로 뒤에 오면 삼켜짐).
// @box_last_busy = 마지막 작업(스피너 관측) 시각 epoch초 — 게이트웨이 재기동에도 살아남게 tmux 세션에 영속(#853).
const LIST_FMT = "#{session_name}\t#{session_created}\t#{session_attached}\t#{@box_owner}\t#{@box_harness}\t#{@box_dir}\t#{@box_auto}\t#{@box_flags}\t#{@box_invites}\t#{@box_project}\t#{@box_private}\t#{pane_current_command}\t#{session_last_attached}\t#{@box_last_busy}\t#{pane_title}\t#{@box_label}";

// pane_title(=Claude Code 가 써두는 '지금 하는 일' 요약) → 표시용 제목. 상태 글리프(✳/스피너 등) 제거, 기본 셸 타이틀(user@host:path)·셸 세션은 무시.
function sessionActivityTitle(paneTitle: string, harness: string): string {
  if (!paneTitle || harness === "shell") return "";
  const raw = paneTitle.trim();
  if (/^[\w.-]+@[\w.-]+:/.test(raw)) return "";           // 기본 셸 프롬프트 타이틀 → 무시
  return raw.replace(/^[^\p{L}\p{N}]+/u, "").trim();       // 앞의 상태 글리프·스피너·공백 제거 → 첫 글자(문자/숫자)부터
}

// 에이전트 실행 상태 판정(#req). busy 는 Claude Code 가 pane_title 앞에 그리는 '스피너 글리프'로 본다.
//  ⚠ CPU·session_activity 는 신뢰 불가 — CPU 는 API 왕복 중 0 으로 떨어져 작업중↔대기중 깜빡이고, activity 는 스피너를 활동으로 안 잡음.
//  Claude Code 는 턴 진행 내내 브라유 스피너(U+2801~28FF, ⠂⠙⣾…)를 타이틀에 애니메이션하고, 끝나 프롬프트로 돌아가면 정적 별 '✳'(U+2733) 로 바꾼다 → 이게 '진짜 작동중' 신호.
const SHELL_CMDS = new Set(["sh", "-sh", "bash", "-bash", "zsh", "-zsh", "fish", "-fish", "dash", "-dash", "tcsh", "-tcsh", "ksh", "-ksh", "csh", "-csh", "login", "-login"]);
// 타이틀 첫 글자가 브라유(스피너)면 작업중. 공백 브라유(U+2800)는 제외. 정적 별(✳ U+2733)·문자면 아님.
function isSpinning(paneTitle: string): boolean {
  const c = (paneTitle || "").replace(/^\s+/, "").codePointAt(0);
  return c !== undefined && c > 0x2800 && c <= 0x28ff;
}
// AI 미실행 = 포그라운드가 셸(하네스 종료)이거나 셸 하네스 세션 → offline.
function isAgentOffline(harness: string, paneCmd: string): boolean {
  return !harness || harness === "shell" || SHELL_CMDS.has((paneCmd || "").trim());
}
// 세션별 마지막 'busy(작업중)' 관측 시각(epoch초). 폴링 관측 기반 — '최근 작업순' 정렬용. 서버 재기동 시 리셋(도그푸드 OK).
const lastBusyAt = new Map<string, number>();
// pane 화면 내용으로 '사용자 선택/승인 대기'(확인 필요) 감지. 2.5초 캐시(폴링 버스트 공유).
//
// ⚠ 화면 전체를 grep 하면 안 된다(#853 오탐). Claude Code 는 **과거 사용자 메시지도 '❯ ' 프리픽스로**
//   전사(transcript)에 그린다 → 사용자가 번호목록을 붙여넣은 세션엔 화면에 "❯ 1. 최근에 위키를…" 이
//   남아, 승인 메뉴 커서("❯ 1. Yes")와 구별되지 않아 이미 끝난 대화가 계속 '확인 필요' 빨강으로 떴다.
//
// 판정은 **하단 라이브 UI 영역**만 본다. 불변식: 다이얼로그(모달)가 뜨면 입력창이 감춰진다.
//   - 대기 아님(입력창 살아있음): "───" 틀 + "❯ " 입력줄 + 모드 푸터("⏵⏵ auto mode on …" / "⏸ manual mode on · ? for shortcuts")
//   - 승인 대기:  " Do you want to create hello.txt?" · " ❯ 1. Yes" · " Esc to cancel · Tab to amend"
//   - 질문 대기:  " ❯ 1. Red" · " Enter to select · ↑/↓ to navigate · Esc to cancel"
//   (승인 문구는 툴마다 다르다 — "Do you want to create X?" — 문구만 매칭하면 놓친다. 커서·힌트가 주신호.)
const _paneWaitCache = new Map<string, { at: number; waiting: boolean }>();
const TAIL_LINES = 14;                                      // 하단 라이브 UI 영역(입력창 또는 다이얼로그). 전사는 이 위에 있다.
const INPUT_BOX = /\b(auto|manual|plan|accept edits|bypass permissions) mode on\b|\? for shortcuts|shift\+tab to cycle/i;
const MENU_CURSOR = /^\s*[│┃|]?\s*❯\s*\d+[.)]\s/;           // 번호 선택지 위의 커서(다이얼로그 테두리 안일 수 있다)
const MENU_HINT = /Enter to select|↑\/↓ to navigate|Esc to cancel/i;
const APPROVE_PHRASE = /Do you want to |Would you like to proceed|Select (an|the) option|Choose an option/i;
export function detectAwaiting(pane: string): boolean {
  const lines = pane.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim() !== "");
  const tail = lines.slice(-TAIL_LINES);
  if (tail.some((l) => INPUT_BOX.test(l))) return false;    // 입력창이 떠 있다 = 모달 없음 = 대기 아님
  const tailText = tail.join("\n");
  return tail.some((l) => MENU_CURSOR.test(l)) || MENU_HINT.test(tailText) || APPROVE_PHRASE.test(tailText);
}
async function paneAwaitingInput(sessionId: string): Promise<boolean> {
  const now = Date.now();
  const c = _paneWaitCache.get(sessionId);
  if (c && now - c.at < 2500) return c.waiting;
  let waiting = false;
  try { waiting = detectAwaiting(await tmux(["capture-pane", "-t", sessionId, "-p"])); } catch { /* 무시 → idle 취급 */ }
  _paneWaitCache.set(sessionId, { at: now, waiting });
  return waiting;
}

export async function listSessions(user: LivelyUser): Promise<SessionInfo[]> {
  return collectSessions(ownerId(user));
}

// 노드 에이전트용(#869) — 뷰어 필터 없이 이 호스트의 전 box-* 세션+메타를 반환한다. 가시성 판정(정책)은
//  게이트웨이가 소유하므로(F7 정책/실행 분리) 노드는 원자료만 상태 push 하고, 게이트웨이가 뷰어별로 거른다.
//  게이트웨이 로컬 경로에선 쓰지 말 것 — listSessions(user)가 정문.
export async function listSessionsRaw(): Promise<SessionInfo[]> {
  return collectSessions(null);
}

// 빈 tmux 서버 정리(#869 노드 자가치유) — 세션이 0개면 서버를 죽인다. 노드 데몬(launchd/systemd)이 과거 최소 PATH 로
//  띄운 tmux 서버가 남아 있으면 새 세션 pane 이 harness(claude 등)를 못 찾아 즉사한다(tmux 는 서버 프로세스의 PATH 로만
//  명령을 해석 — set-environment/-e 로 안 고쳐진다, 실측). 빈 서버를 죽여 다음 new-session 이 데몬의 현재 PATH(로그인 PATH
//  baked)로 새 서버를 띄우게 한다. 세션이 있으면 보존(무손실 — 데몬 재시작 간 세션 지속 불변식).
export async function killEmptyTmuxServer(): Promise<void> {
  try {
    if ((await listSessionsRaw()).length === 0) await tmuxQuiet(["kill-server"]);
  } catch { /* 서버 없음 등 — 무시 */ }
}

// #1015 세션 접근 모델(순수 판정 — tmux 무관, 단위테스트 대상). 두 축이 직교한다:
//  · 가시성(목록에 뜨나): 공개면 모든 멤버가 봄 / 비공개면 소유자·초대자만. 프로젝트 폴더 세션은 항상 보임(공동 세션).
//  · 입장(열기·조작·대화열람): 소유자·초대자만(프로젝트 세션은 로그인 전원, #452) — private 여부와 무관하게 항상 이 규칙.
// 즉 '공개'는 남이 목록에서 보고 무슨 작업인지 아는 것까지고, 들어가 제어하는 건 여전히 소유자·초대자만이다.
export interface SessionAcl { owner: string; invites: string[]; private: boolean; projectFolder: boolean; }
export function sessionVisibleTo(me: string | null, s: SessionAcl): boolean {
  if (me === null) return true;                 // 노드 raw 수집(#869) — 가시성은 게이트웨이가 뷰어별로 재판정
  if (s.projectFolder) return true;             // 프로젝트 공동 세션 — 항상 보임(멤버십 게이트는 소비자 측)
  if (me && (s.owner === me || s.invites.includes(me))) return true; // me truthy 가드: 빈 신원이 빈 owner("")와 오매칭 방지
  return !s.private;                            // 남의 개인 세션: 공개면 보이고, 비공개면 숨김
}
export function sessionAttachableBy(me: string | null, s: SessionAcl): boolean {
  if (s.projectFolder) return true;             // 프로젝트 세션은 로그인 전원 입장(#452)
  if (!me) return false;                        // 미식별(null·빈 신원) → 개인 세션 입장 불가
  return s.owner === me || s.invites.includes(me); // 개인 세션: 소유자·초대자만(공개여도 입장 제한)
}

// me=null 이면 필터 없이 전부(owned=false 고정 — 뷰어별 owned 는 소비자가 재계산).
async function collectSessions(me: string | null): Promise<SessionInfo[]> {
  let out = "";
  try { out = await tmux(["list-sessions", "-F", LIST_FMT]); } catch { return []; }
  const nowSec = Math.floor(Date.now() / 1000);
  // 1차: 파싱 + 전역 lastBusy 갱신(스피너 기반, 뷰어 무관 — 정렬 recency 일관성). 보이는 세션만 rows 로.
  const rows: Array<Record<string, any>> = [];
  for (const line of out.split("\n")) {
    if (!line.startsWith("box-")) continue;
    const [name, created, attached, owner, harness, dir, auto, flagsRaw, invitesRaw, projectRaw, privateRaw, paneCmdRaw, _lastAttachedRaw, lastBusyRaw, paneTitleRaw, ...labelParts] = line.split("\t");
    const owned = me !== null && !!owner && owner === me;
    const invites = parseInvites(invitesRaw);
    const isPrivate = (privateRaw || "").trim() === "1";                 // #1015 기본(미설정)=공개
    const projectFolder = !!dirToProjectFolder(dir || "");
    const acl: SessionAcl = { owner: owner || "", invites, private: isPrivate, projectFolder };
    const offline = isAgentOffline(harness, paneCmdRaw);
    const busy = !offline && isSpinning(paneTitleRaw);
    // 마지막 작업 시각 = max(이번 프로세스 관측, tmux 에 영속된 값). busy 면 지금으로 갱신.
    const persisted = Number(lastBusyRaw) || 0;
    let lastBusy = Math.max(lastBusyAt.get(name) || 0, persisted);
    if (busy) {
      lastBusy = nowSec;
      lastBusyAt.set(name, nowSec);
      if (nowSec - persisted >= 30) void tmuxQuiet(["set-option", "-t", name, "@box_last_busy", String(nowSec)]); // 30초 스로틀 — 폴링마다 쓰지 않는다
    }
    // #1015 가시성 = sessionVisibleTo: 공개 개인세션은 전원, 비공개는 소유자·초대자, 프로젝트 세션은 항상.
    //  me=null(노드 raw 수집 #869)은 필터 없이 전부 — 가시성은 게이트웨이가 판정.
    if (!sessionVisibleTo(me, acl)) continue;
    rows.push({ name, created, attached, owner, owned, harness, dir, auto, flagsRaw, invites, projectRaw, isPrivate, attachable: sessionAttachableBy(me, acl), paneTitleRaw, labelParts, offline, busy, lastBusy });
  }
  // 2차: '확인 필요' 감지 — 비offline & 비busy 세션 전부 capture-pane(병렬). #req 접속 안 해도 떠야 하므로 접속 게이트 제거(알림 성격).
  const waitingIds = new Set<string>();
  await Promise.all(rows.filter((r) => !r.offline && !r.busy).map(async (r) => { if (await paneAwaitingInput(r.name)) waitingIds.add(r.name); }));
  const sessions: SessionInfo[] = [];
  for (const r of rows) {
    let flags: Record<string, string> = {};
    try { if (r.flagsRaw) flags = JSON.parse(r.flagsRaw) as Record<string, string>; } catch { /* 구버전 세션 — 플래그 메타 없음 */ }
    // #req 우선순위: 셸종료 > 작업중 > 확인필요(접속 무관 — 사용자 결정 대기 알림) > 접속중이면 대기중 > 미접속이면 오프라인.
    const state: SessionInfo["agentState"] = r.offline ? "offline"
      : r.busy ? "busy"
      : waitingIds.has(r.name) ? "waiting"
      : Number(r.attached) > 0 ? "idle"
      : "offline";
    sessions.push({
      id: r.name, label: (r.labelParts.join("\t") || r.name), harness: r.harness || "shell", dir: r.dir || "",
      autoApprove: r.auto === "1", owner: r.owner || "", owned: r.owned,
      created: Number(r.created) || 0, attached: Number(r.attached) > 0, invites: r.invites, flags,
      private: r.isPrivate, attachable: r.attachable, // #1015 가시성·입장 플래그(프론트 카드가 '보기 전용' 판정에 사용)
      projectId: Number(r.projectRaw) || 0,
      agentState: state, title: sessionActivityTitle(r.paneTitleRaw, r.harness),
      lastActive: r.lastBusy || undefined, // 마지막 작업 시각. 한 번도 작업 안 했으면 undefined → 프론트가 created 로 폴백.
    });
  }
  sessions.sort((a, b) => (a.owned === b.owned ? b.created - a.created : a.owned ? -1 : 1));
  return sessions;
}

// 구성원 OS 유저 lazy 프로비저닝(#524) — 격리 인프라가 준비됐는데 이 멤버 box_ 가 아직 없으면 '첫 세션'에서 자동 생성.
//  → 멤버추가 시 일괄 자동(터미널 안 쓰는 멤버·에이전트까지 생성)이 아니라, 실제 세션 열 때만(과프로비저닝 방지·수동버튼 불요).
//  실패·비멤버(에이전트=getMember null)·인프라미설치 = 비격리 폴백(무회귀·secure-by-default 3중 게이트 그대로).
//  동시 세션 레이스는 in-flight 프로미스로 dedupe(한 멤버 provision 1회). #346 멀티프로필(CLAUDE_CONFIG_DIR)을 흡수 — UI 프로필 버튼 은퇴.
const inflightProvision = new Map<string, Promise<string | null>>();
export async function ensureMemberOsUser(user: LivelyUser): Promise<string | null> {
  const existing = await resolveMemberOsUser(userSlug(user));
  if (existing) return existing;                          // 이미 프로비저닝됨 → 빠른 경로(대부분)
  if (!isolationInfraReady()) return null;                // 인프라 미설치/off/비-Linux → 비격리 폴백
  const memberId = ownerId(user);
  if (!memberId) return null;
  let p = inflightProvision.get(memberId);
  if (!p) {
    p = (async (): Promise<string | null> => {
      try {
        if (!(await getMember(memberId))) return null;    // 에이전트/비-멤버 → 프로비저닝 안 함(비격리)
        await provisionMemberOs(memberId);                // useradd·홈700·그룹·키트(첫 세션만; 수 초)
        return await resolveMemberOsUser(userSlug(user)); // 이제 box_ 존재 → 격리
      } catch (e) {
        console.warn(`[terminal] 구성원 OS 유저 lazy 프로비저닝 실패(${memberId}) — 비격리 폴백:`, (e as Error)?.message ?? e);
        return null;
      } finally { inflightProvision.delete(memberId); }
    })();
    inflightProvision.set(memberId, p);
  }
  return p;
}

// 세션 워크트리(#675)는 #918 에서 제거됐다 — '고른 폴더가 git 저장소면 격리 워크트리에서 돌린다'는 기능이었으나
//  생성 조건(`input.worktree && !osUser && !projectId`)이 이 조직에선 영영 거짓이었다: 멤버는 전원 OS 격리(box_)라
//  osUser 가 항상 있고, 프로젝트 세션은 'project-provision 이 따로 준다'는 이유로 제외였다(그 provision 도 #918 에서
//  제거). 실측 49세션 중 0건 · <repo>-worktrees/ 가 생긴 적 없음. 그런데 UI 는 '기본 켜짐·권장'으로 약속하고 미적용을
//  "폴더가 git 저장소가 아니라서"로 **오진**했다(진짜 이유는 격리). 코드 작업면은 lively_local_repo_worktree
//  셀프서비스가 환경·격리 무관하게 만든다 — 세션 생성은 워크트리를 만들지 않는다.

export async function createSession(user: LivelyUser, input: CreateInput): Promise<SessionInfo> {
  // 디스크 가드(#813 T5) — **맨 앞**에서 막는다. 세션은 워크트리 체크아웃 + 의존성 설치로 디스크를 크게 먹는데,
  //  꽉 차면 Postgres 가 죽어 전 기능이 500 이 되고 공간을 비워도 수동 재시작이 필요하다(2026-07-13 실증).
  //  기존 세션·읽기는 막지 않는다 — 더 붓지만 못하게 할 뿐이다. 임계치는 관리탭 저장소 정책.
  {
    const sp = await effectiveStoragePolicy(() => getRuntimeConfig().then((c) => c.storage_policy)).catch(() => null);
    await assertDiskWritable(
      "새 세션",
      ROOTS.map((r) => r.base),
      sp ? { warnPct: sp.disk_warn_pct, criticalPct: sp.disk_critical_pct } : undefined,
    );
  }
  // 격리 게이트(#524) — spawn·cwd·mkdir 전부 이 값으로 분기(한 번만). 프로젝트 세션도 개인 세션과 '동일하게'
  //  생성자 box_<멤버> 로 격리 실행한다(#524 인증 프로필 단위화): claude 자격증명이 각 box_ 홈(700)에 커널 격리
  //  → 공유 lively 로 띄우면 멤버 간 인증이 안 갈리고 재로그인을 요구했다. 공유 프로젝트 폴더는 lively-shared 그룹으로
  //  box_ 가 접근(project 폴더 2770 group rwx). 입장(초대·프로젝트멤버십)은 터미널탭 초대와 '완전히 동일' —
  //  게이트웨이 중계 attach 라 pane uid 와 무관(그래서 공동 입장은 그대로 됨). 과거 '폴더 접근 불가→500' 이유는
  //  폴더를 그룹접근가능으로 만들며 해소. 미프로비저닝 멤버는 여기서 '첫 세션 lazy provision'(ensureMemberOsUser) →
  //  자동 격리(수동 버튼 불요). 인프라미설치/off/비멤버 = null 반환 = 비격리 폴백(무회귀).
  const osUser = await ensureMemberOsUser(user);
  const id = `${sessionPrefix(user)}${crypto.randomBytes(4).toString("hex")}`;
  let { abs: target } = await resolveRootPath(user, input.rootKey, input.subpath, osUser);
  // 작업 디렉터리 확보. 격리면 멤버 uid 로 만든다 — 게이트웨이(비-멤버)는 멤버 700 홈 안에 mkdir 못 함(개인 폴더 세션 버그).
  if (osUser) await memberMkdir(osUser, target);
  else await fsp.mkdir(target, { recursive: true, mode: 0o700 });

  // git 자격 materialize(#540, Slice 2) — 격리 세션이면 그 멤버의 등록 git 자격을 홈(~/.ssh·~/.lively)에 뿌려
  //  세션 안 shell/Claude 의 git 이 멤버 자격으로 되게 한다. best-effort·비파괴(실패해도 세션 생성 안 막음). DB 미등록이면 no-op.
  if (osUser) {
    // 공유 레포 dubious-ownership 방지(#522) — 자격 유무와 무관하게 항상(게이트웨이-소유 클론을 멤버 git 이 거부 않게). best-effort.
    await ensureGitSafeDirectory(osUser).catch((e) => console.warn("[terminal] safe.directory 설정 실패 — 세션은 계속:", (e as Error)?.message ?? e));
    const mid = ownerId(user);
    if (mid) await materializeMemberGit(osUser, mid).catch((e) => console.warn(`[terminal] git 자격 materialize 실패(${mid}) — 세션은 계속:`, (e as Error)?.message ?? e));
  }

  const harness = HARNESSES.find((h) => h.key === input.harness);
  if (!harness) throw new HttpError(400, "허용되지 않은 하네스입니다");

  const cmd: string[] = [];
  const appliedFlags: Record<string, string> = {}; // 생성 시 적용한 플래그 — @box_flags 로 저장(수정 팝업 표시용).
  if (harness.bin) {
    cmd.push(harness.bin);
    // 이어받기(#905 C1) — claude 하네스에 한해 --resume <sid> 주입(그 세션 대화를 이어서 연다). sid 형식 검증.
    if (input.resume && harness.key === "claude") {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(input.resume)) throw new HttpError(400, "resume 세션 id 형식이 잘못되었습니다");
      cmd.push("--resume", input.resume);
    }
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
  const args = ["new-session", "-d", "-s", id];
  // 한글(멀티바이트) 편집 정상화 — pane 에 UTF-8 로케일 주입(#633). 세션스코프 -e 라 전역/타세션 누수 없음.
  //  격리(box-spawn=sudo)·비격리 두 분기 공통으로 먼저 넣는다(sudo 기본 env_keep 이 LANG/LC_* 를 보존). 근거는 PANE_LOCALE 주석.
  args.push("-e", `LANG=${PANE_LOCALE}`, "-e", `LC_CTYPE=${PANE_LOCALE}`, "-e", `LC_ALL=${PANE_LOCALE}`);
  // 시간대(#778) — pane(셸·클로드코드 등)이 **조직 시간대**의 로컬 시각을 보게 한다. 박스 OS TZ 는 대개 UTC 라
  //  안 주면 클로드코드의 크레딧 리셋 안내 등이 UTC 로 뜬다(클로드코드는 Intl.DateTimeFormat().resolvedOptions()
  //  .timeZone = TZ env 를 읽는다 — 바이너리 실측). OS 전역 TZ(timedatectl)를 바꾸지 않고 세션스코프로만 푼다:
  //  게이트웨이는 비-root 서비스 유저고, 박스의 OS 전역 상태는 고객 소유라 침습하지 않는다.
  //  ⚠ 격리(sudo → box-spawn) 분기는 sudo 의 env_reset 이 env 를 털 수 있어 sudoers 가 TZ 를 명시 보존한다
  //   (deploy/linux/sudoers-lively). 구 sudoers 면 미보존 → 시스템 TZ 폴백 = 종전 동작(무회귀).
  //  ⚠ pane env 는 exec 시점 고정 → **새 세션**부터 적용(#633 과 동일 — 옛 세션은 재생성 시 정상화).
  args.push("-e", `TZ=${await orgTimezone()}`);
  // 세션 신원(#852) — 이 pane 안에서 도는 AI 가 작업(activity)을 기록할 때 **어느 세션에서 한 일인지**를
  //  게이트웨이가 스스로 알게 한다. 지금까진 session_id 를 AI 자기보고에만 맡겨 아무도 안 넘겼고(전 기간 box- 형식 1건),
  //  그래서 "그 작업을 한 터미널에 바로 들어가기"도 "프로젝트 타임라인의 세션 추론"(org/store.ts)도 죽어 있었다.
  //  경로: 이 env → 하네스 MCP 설정 헤더 `x-lively-session: ${LIVELY_SESSION_ID}` → org/agent-identity.sessionFromHeaders.
  //  author_agent 를 접속 헤더로 식별하는 것(#182)과 같은 자리·같은 원리 — 자기보고가 아니라 게이트웨이 권위.
  //  ⚠ pane env 는 exec 시점 고정 → **새 세션부터** 적용(LANG #633·TZ #778 과 동일 성질. 옛 세션은 재생성 시 정상화).
  //  ⚠ 격리(sudo → box-spawn) 분기는 env_reset 이 털어가므로 sudoers 가 명시 보존해야 한다(deploy/linux/sudoers-lively).
  //   구 sudoers 면 미보존 → 헤더 빈 값 → 미기록 = 종전 동작(무회귀).
  args.push("-e", `LIVELY_SESSION_ID=${id}`);
  // 읽기전용 세션(#1007) — 이 pane 의 하네스만 읽기전용으로. MCP 헤더 `x-lively-readonly: ${LIVELY_READONLY:-}` 가 이 env 를 확장해
  //  게이트웨이가 이 세션의 요청에만 쓰기 툴을 소거한다. **per-session env 라 동시 실행 세션 중 이것만 읽기전용, 나머지는 정상**(사용자 요구).
  //  ⚠ pane env 는 exec 시점 고정 → **새 세션부터** 적용(LANG #633·TZ #778·SESSION_ID #852 와 동일 성질).
  //  ⚠ 격리(sudo → box-spawn) 분기는 env_reset 이 털어가므로 sudoers 가 LIVELY_READONLY 를 명시 보존해야 한다(deploy/linux/sudoers-lively).
  //  인코그니토(#1007+)는 읽기전용보다 강함(lively 전체 차단 + 훅 off) — 둘 다면 incognito 가 이긴다.
  if (input.incognito) args.push("-e", "LIVELY_INCOGNITO=1", "-e", "LIVELY_OFF=1");
  else if (input.readOnly) args.push("-e", "LIVELY_READONLY=1");
  // 공유 빌드 캐시(#813 T3) — 생태계별 다운로드/의존성 캐시를 박스 전역 한 곳으로. LANG/TZ 와 같은 세션스코프 -e
  //  (전역/타세션 누수 없음). 목적은 부피 감소가 아니라 **회수를 싸게 만드는 것**: 워크트리 파생물을 회수해도
  //  캐시가 warm 이라 재설치가 금방 끝난다. 부수로 멤버 격리(#524)로 갈린 홈들의 캐시 중복도 하나로 접는다.
  //  ⚠ pane env 는 exec 시점 고정 → **새 세션**부터 적용(LANG·TZ 와 같은 성질).
  //  ⚠ 셸 rc 가 같은 변수를 다시 설정하면 rc 가 이긴다 = 고객의 명시 설정이 우선(비파괴).
  //  관리탭에서 끌 수 있다(저장소·로그 → 공유 빌드 캐시). 꺼져 있으면 빈 객체 = 아무것도 안 바꾼다(무회귀).
  try {
    const sp = await effectiveStoragePolicy(() => getRuntimeConfig().then((c) => c.storage_policy));
    const cacheEnv = sessionCacheEnv(SHARED_ROOT.base, {
      enabled: sp.shared_cache_enabled,
      relocateHome: sp.shared_cache_relocate_home,
    });
    for (const [k, v] of Object.entries(cacheEnv)) args.push("-e", `${k}=${v}`);
  } catch (err) {
    // 정책을 못 읽어도 세션 생성을 막지 않는다 — 캐시 공유는 최적화지 필수 기능이 아니다.
    console.warn(`[terminal] 공유 캐시 env 주입 생략(비치명): ${err instanceof Error ? err.message : String(err)}`);
  }
  // 구성원 격리(#524): 프로비저닝된 멤버면 셸/하네스를 그 멤버 OS 계정으로 내린다(drop-priv, osUser 는 위에서 구함).
  //  → 자격증명이 멤버 홈(700)에 uid 경계로 격리. CLAUDE_CONFIG_DIR 주입 불요(멤버 자기 $HOME/.claude 로 네이티브 격리 — #346 흡수).
  //  미프로비저닝/off = 아래 else(기존 단일-유저 + #346 멀티프로필). seam 한 곳에서만 분기(무회귀).
  if (osUser) {
    // ⚠ tmux -c 를 안 쓴다: -c 는 게이트웨이 권한으로 chdir 해 멤버 700 홈에 못 들어간다('chdir(2) failed: Permission denied' 반복).
    //  대신 box-spawn 이 --cwd 로 멤버 uid 에서 cd 한다. cmd 빈 배열(셸)이어도 wrapper 가 로그인 셸을 띄운다.
    args.push(...wrapAsMember(osUser, cmd, target));
  } else {
    args.push("-c", target);
    // 멀티프로필(#346·#1014): 비격리 경로에서도 **항상 이 멤버 전용 CLAUDE_CONFIG_DIR** 을 준다(공유 폴백 폐기).
    //  왜(#1014): CLAUDE_CONFIG_DIR 을 안 주면 claude 는 호스트 공유 $HOME/.claude.json 을 읽고, 거기 설치 때
    //   구워진 **남의 lively 토큰으로 인증**된다 — 신규/미로그인 프로필이 조용히 타인 계정이 되는 fail-open 구멍.
    //  이제 로그인 전이어도 자기 dir 을 가리킨다: 그 안에서 claude /login 하면 자격이 이 멤버 dir 에만 떨어지고
    //   (닭-달걀 없음), lively MCP(멤버 토큰)는 provisionProfile 이 이 dir 에 굽는다. 절대 남의 신원으로 안 샌다.
    //  ⚠ 세션스코프 -e 만(persistent tmux 서버라 global set-environment 는 세션 간 누수).
    //  유일한 예외 = 단일-유저 kill-switch(LIVELY_MULTIPROFILE=0): 그 박스는 계정이 하나라 공유 config 가 곧 본인이다.
    //  (input.loginProfile 은 이제 기본 동작에 흡수됨 — 항상 dir 을 만들어 주므로 별도 강제 분기 불요.)
    if (process.env.LIVELY_MULTIPROFILE !== "0") {
      const profileDir = profileConfigDir(user);
      await fsp.mkdir(profileDir, { recursive: true, mode: 0o700 });
      args.push("-e", `CLAUDE_CONFIG_DIR=${profileDir}`);
    }
    if (cmd.length) args.push(...cmd);
  }
  // 웹터미널은 xterm.js 로 렌더된다 — pane TERM 을 xterm-256color 로 통일(색 일관성: 격리 세션은 box-spawn 이
  //  강제, 비격리(프로젝트·managed)는 여기 default-terminal 로. 서버 전역이나 '새 pane' 에만 적용=기존 세션 무영향, 멱등).
  await tmuxQuiet(["set-option", "-g", "default-terminal", "xterm-256color"]);
  await tmux(args);
  const label = cleanLabel(input.label) || id;
  await tmux(["set-option", "-t", id, "@box_owner", ownerId(user)]);
  await tmux(["set-option", "-t", id, "@box_label", label]);
  await tmux(["set-option", "-t", id, "@box_harness", harness.key]);
  await tmux(["set-option", "-t", id, "@box_dir", target]);
  await tmux(["set-option", "-t", id, "@box_auto", input.autoApprove ? "1" : "0"]);
  await tmux(["set-option", "-t", id, "@box_flags", JSON.stringify(appliedFlags)]);
  await tmux(["set-option", "-t", id, "@box_invites", JSON.stringify(invites)]);
  if (input.private) await tmux(["set-option", "-t", id, "@box_private", "1"]); // #1015 생성 시 비공개 선택(기본=공개=미설정)
  // 프로젝트 세션엔 프로젝트 id 를 박아둔다 — listSessions 의 projectId(프론트 세션 귀속·카운트) + 작업 타임라인 귀속용.
  //  (#452 이후 입장 게이트 canAttach 는 멤버십을 안 봄 — 이 id 는 표시·귀속 목적으로만 남는다.)
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
  return { id, label, harness: harness.key, dir: target, autoApprove: !!input.autoApprove, owner: ownerId(user), owned: true, created: Math.floor(Date.now() / 1000), attached: false, invites, flags: appliedFlags, private: !!input.private, attachable: true }; // #1015 생성 직후 낙관적 UI 가 공개여부·입장가능을 바로 반영
}

interface OwnerMeta { owner: string; invites: string[]; }
async function ownerMeta(id: string): Promise<OwnerMeta | null> {
  if (!ID_RE.test(id)) return null;
  const owner = await getOpt(id, "@box_owner");
  if (!owner) return null; // box 세션이지만 메타 없음(우리 것 아님) → 거부
  return { owner, invites: parseInvites(await getOpt(id, "@box_invites")) };
}
// attach·파일접근 = 소유자 OR 초대된 멤버. 프로젝트 폴더 세션은 로그인한 누구나(어사이니 무관, #452). kill/edit = 소유자만.
export async function canAttach(id: string, userId: string): Promise<boolean> {
  const m = await ownerMeta(id);
  if (!m) return false;
  // 프로젝트 폴더 세션은 '공동 세션' — 어사이니/멤버십과 무관하게 로그인한 누구나 입장·조작·파일접근 가능(#452).
  //  (이전엔 프로젝트 멤버십으로 게이트했으나, 비멤버가 프로젝트 세션을 못 봐 '권한 없음'으로 안 보이는 문제가 있어 전면 개방.)
  if (dirToProjectFolder(await sessionDir(id))) return true;
  // 개인(비프로젝트) 세션: 소유자 또는 초대된 멤버만.
  return m.owner === userId || m.invites.includes(userId);
}
// ── '이 세션은 진짜 끝났다'의 확답 판정(#835) ──
// canAttach=false 는 두 가지가 섞여 있다: ⓐ 권한 없음 ⓑ 세션이 아예 없음(종료됨) ⓒ tmux 가 답을 못 줌(과부하·타임아웃).
//  웹터미널이 '세션 종료됨'을 띄우려면 ⓑ여야 한다 — ⓒ를 종료로 오인하면 살아있는 세션을 죽었다고 알리게 되는데,
//  그게 #687 이 막으려던 바로 그 오인이다(그래서 그때 프론트를 '계속 재연결'로 바꿨고, 이번엔 그 반대급부인
//  '진짜 닫혔는데 영원히 재접속중'을 고친다). 따라서 tmux 가 **응답해서 "그런 세션 없음"이라고 말할 때만** true.
export function isSessionGoneError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { killed?: boolean; signal?: string | null; stderr?: unknown };
  if (e.killed || e.signal) return false; // 타임아웃(SIGTERM 으로 kill)·시그널 종료 → 판정 불가
  // tmux 응답: "can't find session: <id>". 소켓 접속불가("error connecting to …", "no server running")는
  //  tmux 서버가 죽었거나 못 붙은 것 = 판정 불가로 둔다(일시장애일 수 있음 → 재연결 유지).
  return /can't find session|session not found/i.test(String(e.stderr ?? ""));
}
export async function sessionGone(id: string): Promise<boolean> {
  if (!ID_RE.test(id)) return false; // 형식 자체가 틀림 = '종료'가 아니라 잘못된 요청
  try { await tmux(["has-session", "-t", id]); return false; } // 살아있음
  catch (err) { return isSessionGoneError(err); }
}
async function assertManage(user: LivelyUser, id: string): Promise<void> {
  const m = await ownerMeta(id);
  if (!m || m.owner !== ownerId(user)) throw new HttpError(403, "본인 세션이 아닙니다");
}
export async function killSession(user: LivelyUser, id: string): Promise<void> {
  await assertManage(user, id);
  await tmux(["kill-session", "-t", id]);
}
export async function editSession(user: LivelyUser, id: string, patch: { label?: string; invites?: unknown; private?: boolean }): Promise<void> {
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
  if (patch.private !== undefined) { // #1015 공개/비공개 토글 — 소유자만(assertManage 위에서 강제)
    await tmux(["set-option", "-t", id, "@box_private", patch.private ? "1" : "0"]);
  }
}

// (#869 노드 에이전트 전용) 게이트웨이가 이미 구성원 디렉터리로 검증한 초대 목록을 그대로 기록한다.
//  노드엔 DB 가 없어 validInvites(listMembers)를 못 돌리므로 검증은 게이트웨이 라우트가, 기록만 노드가.
//  게이트웨이 로컬 경로에선 쓰지 말 것 — editSession(검증 포함)이 정문. 소유자 확인은 동일하게 강제.
export async function applyValidatedInvites(user: LivelyUser, id: string, invites: unknown): Promise<void> {
  await assertManage(user, id);
  const clean = Array.isArray(invites) ? invites.filter((x): x is string => typeof x === "string" && x !== ownerId(user)) : [];
  await tmux(["set-option", "-t", id, "@box_invites", JSON.stringify(clean)]);
}

// (#869) 노드 세션 생성 전에 게이트웨이 라우트가 초대 후보를 검증할 수 있게 공개(구성원 실재·소유자 제외·중복 제거).
export async function validateInvites(ids: unknown, ownerUid: string): Promise<string[]> {
  return validInvites(ids, ownerUid);
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

// 세션 owner 의 OS 계정(#524) — 파일 API 가 격리 홈(멤버 700)의 op 를 그 uid 로 내릴 때 쓴다.
//  @box_owner(세션 소유자 id) → slug → resolveMemberOsUser. 파일은 세션 셸과 같은 uid(=owner)로 만들어지므로,
//  누가 브라우징하든(초대 멤버 포함) op 는 owner osUser 로 수행해야 소유·권한이 맞다. off/미프로비저닝=null(게이트웨이 직접).
export async function sessionOsUser(id: string): Promise<string | null> {
  if (!ID_RE.test(id)) return null;
  const owner = await getOpt(id, "@box_owner");
  if (!owner) return null;
  return resolveMemberOsUser(slug(owner));
}

// 현재 사용자의 OS 계정(#524) — 세션 무관 파일 API(생성폼 폴더 피커 browse)가 그 uid 로 op 를 내릴 때.
export async function userOsUser(user: LivelyUser): Promise<string | null> {
  return resolveMemberOsUser(userSlug(user));
}

// 단일 세션의 현재 라벨(@box_label) — 단독 터미널 페이지가 id 로 '지금 이름'을 조회한다.
//  목록 API(/sessions)는 프로젝트 세션을 빼므로, 그 세션의 상단 제목이 생성 시점 ?label= 에 고정되던 문제를 푼다.
//  접근통제(canAttach)는 라우트에서 — 여기선 값만 읽는다.
export async function getSessionLabel(id: string): Promise<string> {
  if (!ID_RE.test(id)) return "";
  return (await getOpt(id, "@box_label")) || "";
}

// 단일 세션의 프로젝트 id(@box_project) — 단독 터미널 페이지가 상단 '프로젝트 페이지 열기' 버튼을 위해 id 로 조회.
//  프로젝트 세션이면 그 프로젝트 id, 개인 세션이면 0. 접근통제(canAttach)는 라우트에서 — 여기선 값만 읽는다.
export async function getSessionProject(id: string): Promise<number> {
  if (!ID_RE.test(id)) return 0;
  return Number(await getOpt(id, "@box_project")) || 0;
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
