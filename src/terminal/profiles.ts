// 중앙 박스 — 멤버 신원 파생(slug) + 멀티프로필(#346) + OS 유저 프로비저닝(#524) + AI 계정 상태/로그아웃(#1085).
//  terminal-sessions.ts 분할(#1313 R15). "이 멤버의 세션이 누구 계정·어느 홈으로 뜨나"의 단일 소유 모듈.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import type { LivelyUser } from "../context.js";
import { HttpError } from "../http-error.js";
import { getMember, mintToken, listTokens, revokeToken } from "../org/store.js";
import { SESSION_ID_RE } from "../org/auth/agent-identity.js"; // #852 세션 id 형식 — 게이트웨이 헤더 판정과 같은 자
import { DANGEROUS_SCOPES, isScope } from "../auth/scopes.js";
import { resolveMemberOsUser, osUsername, isolationInfraReady, osUserExists, memberSlug } from "./terminal-isolation.js";
import { memberSh } from "./terminal-member-fs.js";
import { roots, HARNESSES } from "./catalog.js";
import { getOpt } from "./tmux-exec.js";
import { loadDesiredOne } from "../sessions/session-desired.js";

const execFileAsync = promisify(execFile);
const ID_RE = SESSION_ID_RE;   // 세션 id 형식의 단일 진실원천 — 게이트웨이가 헤더로 받은 세션도 같은 자로 잰다(#852)

export const slug = memberSlug;   // 정본은 terminal-isolation.memberSlug — useradd 이름과 홈 경로가 같은 규칙을 쓰게 (#1884)
export const userSlug = (u: LivelyUser): string => slug(u.userId || u.email || "user");
export const ownerId = (u: LivelyUser): string => u.userId || u.email || "";
// 멤버 id → 그 사람의 OS 계정명. provision-member.sh 와 같은 규칙이어야 하므로 **여기가 유일한 파생지**다
//  (#1291 — os-acl 이 이 규칙을 손으로 다시 짰다가 `_` 처리·트림·비-ASCII 폴백 셋이 어긋났고, 그 결과
//   ACL 대상이 존재하지 않는 계정이 되어 **그룹 접근만 제거되고 대상은 못 들어가는** 상태가 될 뻔했다).
export const memberOsUser = (memberId: string): string => osUsername(slug(memberId));

// 격리(#524) 루트 베이스 — 세션이 멤버 uid 로 돌면 작업 디렉터리도 그 uid 로 접근가능해야 한다.
//  personal = 멤버 홈 하위(box_<slug> 소유), shared = lively-shared 그룹 공유 dir(게이트웨이·멤버 공동 rw).
const MEMBER_HOME_BASE = process.env.LIVELY_MEMBER_HOME_BASE || "/home";              // useradd -m -d /home/box_<slug>
const PERSONAL_SUBDIR = "box";                                                        // 멤버 홈/box = '개인 폴더'
const SHARED_ISOLATED_BASE = process.env.LIVELY_SHARED_DIR || "/srv/lively/shared";   // root:lively-shared 2775(setgid)

// 허용 루트 기준 경로 해소(+봉쇄). subpath 의 .. 탈출은 거부.
//  격리+프로비저닝된 멤버면 멤버-접근가능 베이스로(세션 spawn 과 동일 게이트 = resolveMemberOsUser),
//  아니면 게이트웨이 홈 기준(종전, perUser=base/<userSlug>). 세션 생성·생성폼 폴더 탐색이 공유한다.
export async function resolveRootPath(user: LivelyUser, rootKey: string, subpath: string, osUser?: string | null): Promise<{ base: string; abs: string }> {
  const root = roots().find((r) => r.key === rootKey);
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

// (순수 — 테스트 seam) 루트 base 목록 중 이 절대경로를 담는 것을 골라 좌표로. 담는 게 없으면 null.
//  ⭐ **가장 깊은(구체적인) base 가 이긴다.** 왜 순서가 아니라 깊이인가: 루트가 서로 **중첩**되게 설정될 수 있다
//   (예: TERMINAL_ROOT_PERSONAL 을 공유 루트 안에 둔 배포). 그때 얕은 쪽(shared)으로 잡으면 **개인 파일에
//   root=shared 링크**가 나오고, shared 는 perUser 가 아니므로 그 링크는 **전원에게 같은 파일**로 열린다 —
//   즉 설정 실수 하나가 "나만 보는 파일"을 조용히 전원 공개 링크로 바꾼다. 깊은 쪽(personal)을 택하면
//   링크가 개인 좌표로 남아 남이 열어도 자기 폴더를 보게 된다(fail-closed).
//  ⚠ 담김 판정은 `base + 구분자` 로 잰다 — startsWith(base) 만 쓰면 이름이 겹치는 **형제** 디렉터리
//   (`<base>-other`)가 루트 안으로 오검출되고, 그 좌표는 `../` 가 섞여 전혀 다른 파일을 가리킨다.
export function pickRootCoord(bases: Array<{ root: string; base: string }>, abs: string): { root: string; rel: string } | null {
  const target = path.resolve(abs);
  let best: { root: string; rel: string; depth: number } | null = null;
  for (const { root, base } of bases) {
    const b = path.resolve(base);
    if (target !== b && !target.startsWith(b + path.sep)) continue;
    if (best && b.length <= best.depth) continue;
    best = { root, rel: target === b ? "" : path.relative(b, target).split(path.sep).join("/"), depth: b.length };
  }
  return best ? { root: best.root, rel: best.rel } : null;
}

// resolveRootPath 의 **역함수** — 절대경로를 허용 루트 좌표({root, rel})로 되돌린다(#1436 공유 링크).
//  왜 필요한가: 공유 링크의 주소 축은 root+path 하나다(세션 id·프로젝트 id 를 주소에 넣으면 세션이 죽거나
//  프로젝트가 보관될 때 링크가 죽는다). 그런데 세션 파일 API 는 세션 작업폴더의 **절대경로**만 알고 있어,
//  그 화면이 링크를 만들려면 좌표로 되돌릴 자가 필요하다. 규칙(격리 여부·perUser 하위)이 갈라지면 좌표가
//  어긋나므로 정방향과 **같은 함수**(resolveRootPath)로 베이스를 구해 비교한다 — 파생지가 둘이 되지 않게.
//  ⚠ 판정은 요청자 기준이다. 남의 개인 폴더는 베이스가 달라 매칭되지 않고 null → 호출부는 '공유 링크 없음'으로
//   다룬다(그게 맞다 — 개인 폴더는 경로로 남에게 건넬 수 없다). 루트 밖 경로(원격 노드 등)도 null.
//  해소에 실패한 루트는 건너뛴다 — 좌표를 못 구하는 건 부가기능의 부재일 뿐이라, 여기서 던지면 그 폴더의
//  **파일 목록 응답 자체**가 깨진다(공유 링크가 없어도 목록은 떠야 한다).
export async function rootRelOf(user: LivelyUser, abs: string): Promise<{ root: string; rel: string } | null> {
  const bases: Array<{ root: string; base: string }> = [];
  for (const r of roots()) {
    try { bases.push({ root: r.key, base: (await resolveRootPath(user, r.key, "")).base }); } catch { /* 이 루트는 해소 불가 */ }
  }
  return pickRootCoord(bases, abs);
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
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");   // dist/terminal/ → 리포 루트

// 중앙박스 프로필/OS 유저 토큰 발급 — 기존 central-box 토큰 회수 후 새로 굽는다(평문은 못 되찾으니 매번 새로).
//  기본은 admin/runtime 제외(세션 최소권한). includeControlPlane=true(관리탭에서 admin 이 '관리 권한 포함'을 명시
//  opt-in)면 멤버 scope 의 admin/runtime 도 싣는다 — 에이전트가 관리 기능(MCP org_*)을 세션에서 쓰게(#549 후속).
//  멤버 scope 가 상한이라 멤버에 admin 없으면 자연히 안 실리고, 멤버 scope 하향 시 매 호출 intersection 으로 즉시
//  무효(회수의 진짜 지점 = 멤버 scope지 발급 경로가 아니다). 발급은 org_content_audit 에 남는다(누가 어느 에이전트에 관리권한 실었나).
export async function mintCentralBoxToken(memberId: string, memberScopes: string[], slug: string, includeControlPlane: boolean): Promise<string> {
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

// 세션 훅 신원(#1719 후속) — **비격리(공유 홈) 박스**의 세션 pane 에 실어 주는 '그 세션 소유자' 토큰.
//  왜: 훅(work-flag 등)은 토큰을 `LIVELY_TOKEN` env → 없으면 공유 `~/.lively/token` 에서 읽는다. 홈이 공유인 박스는
//   그 파일이 **키트를 설치한 사람 것**이라, 다른 멤버 세션이 보내는 보고(대화 uuid 매핑·활동/단계·정상종료)가 전부
//   남의 신원으로 나가 owner 게이트에 걸려 **조용히 버려졌다**(실측 2026-08-18 dev: yoon 아닌 살아있는 세션 24개
//   매핑 0건 → 그 세션들의 대화창이 영영 "기록 없음"). 격리(리눅스 OS유저) 박스는 provision-member.sh 가 멤버 홈에
//   각자 토큰을 심어 이미 옳으므로, 이 주입은 비격리 경로에서만 한다.
//  ⚠ 이건 격리가 아니라 **귀속**이다 — 같은 박스에서 서로 읽을 수 있다는 사실은 그대로다(맥=단일유저 공유, #1048).
//  MCP·CLI 신원은 안 바뀐다: 그쪽은 **파일이 정본이고 env 는 캐시**다(#916 — lively.mjs token()). env 를 우선하는 건
//   훅뿐이라 이 주입의 영향 범위가 정확히 '세션 보고'다. 훅이 부르는 나머지 엔드포인트(런너 훅·자산·runtime-config)는
//   scope null(인증된 멤버면 OK)이고, 오히려 per-member 타깃팅이 그 세션 주인 기준으로 맞아진다.
//  세션 스코프 자격이라 세션이 죽으면 회수한다(killSession). 같은 id 로 다시 뜨면 옛 것을 회수하고 새로 굽는다.
const SESSION_TOKEN_LABEL = "session-hooks:";
export async function revokeSessionHookToken(boxId: string): Promise<void> {
  const label = `${SESSION_TOKEN_LABEL}${boxId}`;
  for (const t of await listTokens()) {
    if (!t.revoked_at && t.label === label) await revokeToken(t.token_hash, "killSession", "terminal-sessions");
  }
}
export async function mintSessionHookToken(memberId: string, boxId: string): Promise<string | null> {
  const member = await getMember(memberId);
  if (!member) return null;                       // 멤버 디렉터리에 없는 소유자 — 종전대로 공유 토큰(무회귀)
  await revokeSessionHookToken(boxId);            // 같은 box id 재생성 — 옛 자격은 즉시 죽인다
  const dangerous = DANGEROUS_SCOPES as ReadonlySet<string>;
  const scopes = (member.scopes || []).filter((s) => isScope(s) && !dangerous.has(s));   // 세션 최소권한(admin/runtime 제외)
  const { token } = await mintToken(
    { userId: memberId, memberId, scopes, label: `${SESSION_TOKEN_LABEL}${boxId}` },
    "createSession", "terminal-sessions",
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

// 하네스별 자격증명 파일(홈 기준 상대경로) — 로그인 여부 판정·로그아웃 대상의 단일 출처.
//  ⚠ 값은 이 상수에서만 온다(사용자 입력이 셸 문자열에 들어가지 않는다).
// ⚠ #1695 판정: 세션 카탈로그에 opencode·antigravity 를 넣었지만 **이 표에는 넣지 않는다.**
//  여기 실리면 [연결된 AI 계정]이 '그 파일이 있나'로 로그인 여부를 말하는데, agy 는 자격을 keyring 에 두고
//  (~/.gemini 트리에 자격 파일이 없다 — 실측) opencode 는 제공자마다 자리가 갈린다. 없는 파일을 기준으로 하면
//  로그인돼 있는 사람에게 '연결 안 됨'이라고 **거짓말**을 한다(맥 claude 키체인에서 이미 겪은 실패 — 아래 참조).
//  표에 없으면 aiAccountStatus 가 그 하네스를 건너뛴다 = 목록에 안 나온다(정직한 침묵). 자격 위치를 실측하면 그때 연다.
const HARNESS_CRED: Record<string, string> = {
  claude: ".claude/.credentials.json",
  codex: ".codex/auth.json",
  // grok 은 자격이 **파일**이다(#1701 실측: `grok login` 이 ~/.grok/auth.json 0600 을 만든다 — agy 의 keyring 과 다름).
  grok: ".grok/auth.json",
};

// #1884 — 이 하네스에 '로그인'이라는 개념이 있나(= 위 표에 자격 위치가 실측돼 있나). 세션 폼의 [내 계정 로그인]이
//  어느 AI 를 고르게 할지 이걸로 정한다. 표에 없는 하네스(opencode·antigravity)는 로그인 여부를 정직하게 말할 수
//  없으므로 고르게 하지 않는다 — 위 ⚠ 주석과 같은 이유다.
export function harnessHasCredential(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(HARNESS_CRED, key);
}

// box_ 홈의 파일 존재 — ⚠ 게이트웨이(lively)는 멤버 700 홈을 '읽지' 못한다(격리의 본질). 대신 box_ 로 drop-priv 해서
//  '존재'만 확인(내용은 안 봄). exit0=있음. 미프로비저닝/에러=false.
//  memberSh(=memberSpawn seam)를 탄다 — 원격 중계 배포(LIVELY_MEMBER_EXEC)에서도 이 판정이 실행 노드에서
//  돌아야 한다(로그인 판정이 게이트웨이 로컬 fs 를 보면 항상 false = #1471 부류의 거짓 '미로그인').
//  경로는 $HOME 이 아니라 명시 /home/<osUser> — 중계 exec 환경엔 그 유저의 passwd 항목이 없어 $HOME 이 다르다.
async function memberFileExists(osUser: string, rel: string): Promise<boolean> {
  try {
    await memberSh(osUser, `test -f "/home/${osUser}/${rel}"`);
    return true;
  } catch { return false; }
}
// box_ 홈의 파일 삭제(로그아웃) — 같은 drop-priv 경계. rm -f 라 없는 파일에도 성공(멱등).
async function memberFileRemove(osUser: string, rel: string): Promise<void> {
  await memberSh(osUser, `rm -f "/home/${osUser}/${rel}"`);
}
// box_ 홈에 자격 파일이 있는 하네스들(#1884) — 종전 `memberClaudeLoggedIn` 은 claude 파일만 봐서, codex 로만 로그인한
//  멤버는 memberOsStatus.loggedIn=false → 컨트롤플레인 T9 관문(자율 파이프라인 가동)이 영영 안 열렸다. 표(HARNESS_CRED)의
//  하네스를 전부 본다(drop-priv 존재확인 n회 — 세션 생성 경로가 아니라 상태 조회라 비용은 무시할 만하다).
async function memberLoggedInHarnesses(osUser: string): Promise<string[]> {
  const out: string[] = [];
  for (const [key, rel] of Object.entries(HARNESS_CRED)) if (await memberFileExists(osUser, rel)) out.push(key);
  return out;
}
// box_ 홈 dir 존재 — **OS 유저와 별개**로 본다. 홈 부모(/home)는 755 라 게이트웨이가 stat 할 수 있고
//  (내용은 700 이라 여전히 못 읽는다), 이 한 비트가 아래 '고아 홈' 판정의 유일한 근거다.
async function memberHomeExists(osUser: string): Promise<boolean> {
  try { return (await fsp.stat(path.join(MEMBER_HOME_BASE, osUser))).isDirectory(); }
  catch { return false; }
}

// OS 격리 상태(#524) — UI 표시용 + 컨트롤플레인의 '이 멤버가 로그인했나' 판정 입력.
//  ready=인프라 준비(활성+Linux+box-spawn) · provisioned=이 멤버 box_<slug> 존재 · loggedIn=box_ 홈에
//  **어느 하네스든**(claude·codex·grok — HARNESS_CRED) 자격증명 있음(drop-priv 확인, #1884) · orphanHome=홈은 남았는데 OS 유저가 없음(아래).
export interface MemberOsStatus {
  ready: boolean;
  provisioned: boolean;
  osUser: string;
  /** null = **알 수 없음**(orphanHome). false 는 '확실히 미로그인'일 때만 — aiAccountStatus 와 같은 교리. */
  loggedIn: boolean | null;
  /** 자격 파일이 확인된 하네스 key 목록(#1884). loggedIn=true 면 ≥1개. 컨트롤플레인·화면이 "어느 AI 로 로그인됐나"를 말할 때 쓴다. */
  loggedInHarnesses: string[];
  /** 홈(/home/box_<slug>)은 실재하는데 그 OS 유저가 없다 = passwd 초기화 드리프트. 아래 판정 주석 참조. */
  orphanHome: boolean;
}

/**
 * (순수 — 테스트 seam) OS 격리 신호에서 로그인 판정. **미탐이 아니라 '모름'을 정직하게 낸다.**
 *
 * ⚠ 왜 세 갈래인가: 홈(/home/box_<slug>)과 OS 유저(/etc/passwd)의 수명이 **다를 수 있다**.
 *   컨테이너 배포(매니지드 테넌트)에서 /home 은 영속 볼륨이고 /etc/passwd 는 컨테이너 수명이라,
 *   컨테이너를 다시 만들면 **자격증명이 든 홈은 그대로인데 그 홈의 주인 유저만 사라진다**.
 *   그 상태에서 종전 코드는 `provisioned=false → loggedIn=false`(= '이 사람은 로그인 안 했다')로 단정했는데,
 *   그건 거짓말이다 — 자격은 디스크에 있고 다음 세션의 lazy provision(ensureMemberOsUser)이 되살린다.
 *   실측(#1471): 매니지드 테넌트에서 이 거짓 false 때문에 컨트롤플레인이 자율 파이프라인을 영영 안 켰다.
 *   드롭-프리브할 유저가 없어 **확인할 방법 자체가 없으므로** 답은 false 가 아니라 null(모름)이다.
 */
export function judgeMemberOs(i: { ready: boolean; provisioned: boolean; homeExists: boolean; credExists: boolean }): { loggedIn: boolean | null; orphanHome: boolean } {
  if (i.provisioned) return { loggedIn: i.credExists, orphanHome: false };   // drop-priv 로 실제 확인함
  const orphanHome = i.ready && i.homeExists;                                 // 홈만 남음 → 확인 불가
  return { loggedIn: orphanHome ? null : false, orphanHome };                 // 홈도 없으면 확실히 미로그인
}

export async function memberOsStatus(memberId: string): Promise<MemberOsStatus> {
  const osUser = osUsername(userSlug({ userId: memberId } as LivelyUser));
  const ready = isolationInfraReady();
  const provisioned = await osUserExists(osUser);
  const loggedInHarnesses = provisioned ? await memberLoggedInHarnesses(osUser) : [];
  const credExists = loggedInHarnesses.length > 0;
  const homeExists = provisioned ? true : await memberHomeExists(osUser);
  return { ready, provisioned, osUser, loggedInHarnesses, ...judgeMemberOs({ ready, provisioned, homeExists, credExists }) };
}

// ── 내 AI 계정(#1085) — 관리탭 [내 설정 ▸ 내 AI 계정] 카드. "내 AI 세션이 어느 AI(Claude Code·Codex)로,
//  누구 계정으로 뜨나" 를 한 자리에서 보고 로그인/로그아웃한다. 자격증명이 **어디 사는지**(scope)가 셋으로 갈리고,
//  로그아웃 가능 여부는 전적으로 거기서 결정된다:
//   · isolated — 멤버 OS 계정(box_) 홈(#524). 게이트웨이는 700 홈을 못 읽으니 drop-priv 로 존재확인·삭제만 한다.
//   · profile  — 비격리 박스의 멤버별 dir(~/.lively/profiles/<slug>/claude, #346·#1014). 게이트웨이 소유 → 직접.
//   · shared   — 호스트 공유 홈. **다른 구성원 세션이 쓰는 바로 그 자격**이라 로그아웃을 막는다(남의 세션이 끊긴다).
//  ⚠ Codex 는 비격리 경로에 멤버별 홈 주입(CODEX_HOME)이 없다 — claude 의 CLAUDE_CONFIG_DIR(#1014) 에 해당하는 게
//   아직 없어서다. 그래서 그 박스에서는 shared 로 **정직하게** 표시하고 로그아웃을 잠근다(있는 척하지 않는다).
export interface AiAccountStatus {
  key: string; label: string;
  scope: "isolated" | "profile" | "shared";
  loggedIn: boolean | null;   // null = **알 수 없음**(아래 키체인 한계). false 는 '확실히 미로그인'일 때만.
  canLogout: boolean;
  where: string;   // 자격증명이 사는 자리(사람이 읽는 설명)
}
// macOS 키체인의 Claude 자격 존재 확인 — Claude Code 는 **맥에서 자격을 파일이 아니라 키체인**
//  ("Claude Code-credentials")에 넣는다. 그래서 `.credentials.json` 부재를 '미로그인'으로 읽으면 거짓말이 된다
//  (실측: 키체인엔 로그인돼 있는데 파일은 없음 → 화면이 '연결 안 됨'으로 나와 사용자가 바로 잡아냈다).
//  ⚠ **비밀은 읽지 않는다** — `-g`(비밀 출력) 없이 항목 존재만 exit code 로 본다(토큰이 로그·응답에 안 실린다).
//  ⚠ 키체인은 **OS 유저 단위**다 → 프로필 dir(CLAUDE_CONFIG_DIR)로 갈리지 않는다. 그래서 맥에서 claude 는
//   구조적으로 '이 서버 공용'이다(아래 scope='shared' 강제). launchd 처럼 키체인에 못 닿는 맥락이면 실패 →
//   그 땐 알 수 없음(null)으로 남는다(종전 동작, 무회귀).
async function macClaudeKeychainHas(): Promise<boolean> {
  try {
    await execFileAsync("security", ["find-generic-password", "-s", "Claude Code-credentials"], { timeout: 5000 });
    return true;
  } catch { return false; }
}
//  osSt — 호출자가 방금 잰 OS 격리 상태를 넘기면 다시 재지 않는다(drop-priv 확인을 아낀다 — memberLoggedInHarnessesAny).
export async function aiAccountStatus(user: LivelyUser, osSt?: MemberOsStatus): Promise<AiAccountStatus[]> {
  osSt ??= await memberOsStatus(ownerId(user));
  const isolated = osSt.ready && osSt.provisioned;
  const darwin = process.platform === "darwin";
  const out: AiAccountStatus[] = [];
  for (const h of HARNESSES) {
    const rel = HARNESS_CRED[h.key];
    if (!rel) continue;   // 셸 등 — 로그인 개념이 없는 하네스
    let scope: AiAccountStatus["scope"]; let where: string;
    let loggedIn: boolean | null;
    if (isolated) {
      scope = "isolated"; where = `내 격리 계정(${osSt.osUser}) 홈의 ${rel}`;
      loggedIn = osSt.loggedInHarnesses.includes(h.key);   // memberOsStatus 가 같은 표(HARNESS_CRED)로 이미 drop-priv 확인했다
    } else if (h.key === "claude" && darwin) {
      // 맥 = 키체인(OS 유저 단위) → 멤버별로 갈릴 수 없다. 공용으로 **정직하게** 표시한다.
      scope = "shared"; where = "이 서버 macOS 키체인(Claude Code-credentials)";
      loggedIn = await macClaudeKeychainHas() ? true : null;   // 못 찾음 = 미로그인일 수도, 키체인 접근 불가일 수도
    } else if (h.key === "claude" && process.env.LIVELY_MULTIPROFILE !== "0") {
      const file = path.join(profileConfigDir(user), ".credentials.json");
      scope = "profile"; where = file;
      loggedIn = await fsp.access(file).then(() => true, () => false);
    } else {
      const file = path.join(os.homedir(), rel);
      scope = "shared"; where = file;
      loggedIn = await fsp.access(file).then(() => true, () => false);
    }
    // 지울 수 있을 때만 로그아웃을 연다 — 공용 계정(남의 세션까지 끊김)·미로그인·탐지불가는 잠근다.
    out.push({ key: h.key, label: h.label, scope, where, loggedIn, canLogout: loggedIn === true && scope !== "shared" });
  }
  return out;
}

// #1884 헤드리스 하네스 선택 입력 — 이 멤버가 **어느 하네스로든** 로그인돼 있나. 격리 홈(box_) drop-priv 확인과
//  비격리 프로필/공유 경로 판정을 aiAccountStatus 한 번으로 합친다(격리면 그 안에서 memberOsStatus 결과를 재사용).
//  loggedIn=null('모름' — 맥 키체인 접근 불가 등)은 넣지 않는다: 모르는 걸 로그인으로 치면 자격 없는 하네스로 잡이
//  나가 무출력 hang 이 된다(#1101 부류). 못 찾으면 [] — 호출자(node/headless-harness)가 claude 기본으로 접는다.
export async function memberLoggedInHarnessesAny(memberId: string): Promise<string[]> {
  const user = { userId: memberId, email: "", scopes: [], projects: [] } as LivelyUser;
  const osSt = await memberOsStatus(memberId);
  const accts = await aiAccountStatus(user, osSt);
  return [...new Set([...osSt.loggedInHarnesses, ...accts.filter((a) => a.loggedIn === true).map((a) => a.key)])];
}

// 로그아웃 = 자격증명 파일 삭제(재로그인으로 되돌릴 수 있다). **본인 것만** — 호출자(라우트)가 principal 을 넘긴다.
//  ⚠ 이미 떠 있는 세션의 하네스는 메모리에 인증을 들고 있을 수 있어 그 자리에서 끊기지 않는다(다음 로그인부터 적용).
export async function aiAccountLogout(user: LivelyUser, key: string): Promise<void> {
  const acct = (await aiAccountStatus(user)).find((a) => a.key === key);
  if (!acct) throw new HttpError(404, `모르는 AI: ${key}`);
  if (acct.loggedIn === false) throw new HttpError(409, `${acct.label} 은(는) 이미 로그인 전입니다.`);
  if (acct.loggedIn === null) {
    throw new HttpError(409, `${acct.label} 의 로그인 상태를 서버가 확인할 수 없습니다(자격이 이 서버 키체인에 있음) — 세션에서 ${key} 를 실행해 직접 로그아웃하세요.`);
  }
  if (!acct.canLogout) {
    throw new HttpError(409, `${acct.label} 은(는) 이 서버의 공유 계정으로 실행됩니다 — 로그아웃하면 다른 구성원의 세션까지 끊깁니다. 구성원 격리를 설치하면 계정이 분리됩니다.`);
  }
  const rel = HARNESS_CRED[key];
  if (acct.scope === "isolated") {
    await memberFileRemove(osUsername(userSlug(user)), rel);
    return;
  }
  await fsp.rm(path.join(profileConfigDir(user), ".credentials.json"), { force: true });
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

// 세션 owner 의 OS 계정(#524) — 파일 API 가 격리 홈(멤버 700)의 op 를 그 uid 로 내릴 때 쓴다.
//  @box_owner(세션 소유자 id) → slug → resolveMemberOsUser. 파일은 세션 셸과 같은 uid(=owner)로 만들어지므로,
//  누가 브라우징하든(초대 멤버 포함) op 는 owner osUser 로 수행해야 소유·권한이 맞다. off/미프로비저닝=null(게이트웨이 직접).
export async function sessionOsUser(id: string): Promise<string | null> {
  if (!ID_RE.test(id)) return null;
  // desired(DB) 우선 · tmux 폴백 — ownerMeta 와 같은 규율(파일 op 의 uid 도 소유자 판정이다).
  const db = await loadDesiredOne(id);
  const owner = db?.owner || (await getOpt(id, "@box_owner"));
  if (!owner) return null;
  return resolveMemberOsUser(slug(owner));
}

// 현재 사용자의 OS 계정(#524) — 세션 무관 파일 API(생성폼 폴더 피커 browse)가 그 uid 로 op 를 내릴 때.
export async function userOsUser(user: LivelyUser): Promise<string | null> {
  return resolveMemberOsUser(userSlug(user));
}
