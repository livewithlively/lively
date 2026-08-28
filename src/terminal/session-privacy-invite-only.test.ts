// #1876 D1 — **세션은 소유자와 그가 초대한 사람만 본다.** 프로젝트 폴더 예외 없음.
//
// ── 왜 이 파일이 있나 ───────────────────────────────────────────────────────
// 결정은 2026-08-25 에 났는데(장원준, 코드 실측 대조 후) 코드엔 안 들어가 있었다. 2026-08-28 재점검 실측:
//
//   라이브 세션 377건 중 **224건(59%)** 이 프로젝트 공유폴더에 있어 로그인한 전원에게 열려 있었고,
//   실제로 초대가 걸린 세션은 **0건**이었다. `yoon` 토큰으로 `jang` 의 세션 44건이 목록에 잡혔고
//   `canAttach` 게이트도 통과했다(입장·프롬프트·파일). 대화록만 403 이었다 — 축이 서로 달랐다.
//
// 즉 가장 나쁜 조합이었다: **들어가서 조작은 되는데 지난 기록만 못 보는** 상태. 입장이 훨씬 강한 권한이다.
//
// ── 잠그는 명제 ─────────────────────────────────────────────────────────────
// 이 규칙은 "빠지면 조용히 남의 대화·파일이 열리는" 종류라 술어를 **한 벌**로 두고 그 한 벌을 여기서 고정한다.
// 세 축(목록·입장·대화록)이 각자 구현하면 "목록엔 없는데 링크로는 들어가지는" 비대칭이 생기고,
//  그게 이 기능의 원래 신고였다.
//
// ── 엣지 표(입력 × 기대) ────────────────────────────────────────────────────
//   E1 개인폴더 · 소유자                    → 보인다
//   E2 개인폴더 · 남                        → 안 보인다        (종전에도 맞았다)
//   E3 개인폴더 · 초대받음                  → 보인다
//   E4 **프로젝트폴더 · 남**                → **안 보인다**    ★신고의 핵심(종전엔 보였다)
//   E5 프로젝트폴더 · 소유자                → 보인다
//   E6 프로젝트폴더 · 초대받음              → 보인다           (「공유」가 여는 문)
//   E7 프로젝트폴더 · 초대받음 · 감춰진 프로젝트 → 안 보인다   (#1291 은 초대 위에 얹힌다)
//   E8 프로젝트폴더 · 초대받음 · 판정불가    → 안 보인다        (fail-closed)
//   E9 신원 미상                            → 아무것도 안 보인다
//   E10 소유자는 판정불가에도 자기 세션을 본다 (자해 방지)
import { strict as assert } from "node:assert";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { sessionVisible, canSeeSession } from "./write-cap.js";
import { PROJECT_SHARED_BASE } from "../project/project-fs.js";

const PROJ = path.join(PROJECT_SHARED_BASE, "project", "714", "repo");
const PRIV = path.join(os.homedir(), "box", "work");
const NONE = { ids: new Set<number>(), folders: new Set<string>() };

test("★ E1~E10 세션 가시성 — 소유자 + 명시 초대만(프로젝트 예외 없음)", () => {
  const S = (dir: string, invites: string[] = [], projectId = 0) => ({ dir, owner: "mike", invites, projectId });

  assert.equal(sessionVisible(S(PRIV), "mike", NONE), true, "E1 개인폴더 소유자");
  assert.equal(sessionVisible(S(PRIV), "haru", NONE), false, "E2 개인폴더는 남에게 안 보인다");
  assert.equal(sessionVisible(S(PRIV, ["haru"]), "haru", NONE), true, "E3 개인폴더 초대자");

  // ★ 여기가 이번 변경의 본체다.
  assert.equal(sessionVisible(S(PROJ), "haru", NONE), false,
    "E4 ★프로젝트 폴더 세션이 초대 없이 남에게 보인다 — #452 예외가 되살아났다");
  assert.equal(sessionVisible(S(PROJ), "mike", NONE), true, "E5 프로젝트 세션 소유자");
  assert.equal(sessionVisible(S(PROJ, ["haru"]), "haru", NONE), true, "E6 프로젝트 세션도 초대하면 보인다");

  assert.equal(sessionVisible(S(PROJ, ["haru"], 714), "haru", { ids: new Set([714]), folders: new Set<string>() }),
    false, "E7 감춰진 프로젝트(#1291)는 초대 위에 얹힌다");
  assert.equal(sessionVisible(S(PROJ, ["haru"]), "haru", undefined), false,
    "E8 판정 재료가 없으면 초대자에겐 닫는다(fail-closed)");

  assert.equal(sessionVisible(S(PROJ, ["haru"]), "", NONE), false, "E9 신원 미상");
  assert.equal(sessionVisible(S(PROJ), "mike", undefined), true,
    "E10 소유자는 판정 불가에도 자기 세션을 본다 — 여기서 막으면 유출이 아니라 자해다");
});

test("E11 canSeeSession 은 sessionVisible 의 별칭이다(두 벌로 갈리지 않는다)", () => {
  for (const [me, inv] of [["haru", [] as string[]], ["haru", ["haru"]], ["mike", []]] as const) {
    const s = { dir: PROJ, owner: "mike", invites: inv as string[], projectId: 0 };
    assert.equal(canSeeSession(s, me, NONE), sessionVisible(s, me, NONE), `별칭이 갈렸다: me=${me} invites=${inv}`);
  }
});

// ── 구조: 세 축이 **같은 술어**를 지나는가 ──────────────────────────────────
function repoRoot(): string {
  let d = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) { if (existsSync(path.join(d, "package.json"))) return d; d = path.dirname(d); }
  throw new Error("레포 뿌리를 찾지 못했다");
}
const read = (rel: string): string => readFileSync(path.join(repoRoot(), rel), "utf8");

test("★★ E12 입장(canAttach)이 목록과 같은 규칙이다 — 프로젝트 전원공개 분기가 없다", () => {
  const src = read("src/terminal/sessions.ts");
  const at = src.indexOf("export async function canAttach");
  assert.ok(at > 0, "canAttach 가 없다");
  const body = src.slice(at, src.indexOf("\nasync function assertManage", at));
  assert.match(body, /if \(m\.owner === userId\) return true;/, "소유자 통과가 없다");
  assert.match(body, /if \(!m\.invites\.includes\(userId\)\) return false;/,
    "★초대 검사가 없다 — 프로젝트 세션이 다시 전원에게 열린다");
  // 종전 분기의 화석: 폴더를 먼저 보고 초대를 안 보는 모양이 되살아나면 잡는다.
  const inviteAt = body.indexOf("m.invites.includes(userId)");
  const folderAt = body.indexOf("dirToProjectFolder(");
  assert.ok(inviteAt > 0 && inviteAt < folderAt,
    "★폴더 판정이 초대 검사보다 앞이다 — 프로젝트 폴더면 통과시키던 종전 구조로 되돌아갔다");
});

test("★★ E13 대화록(checkViewGate)도 초대 축이다 — 프로젝트 멤버십이 아니다", () => {
  const src = read("src/sessions/session-log-routes.ts");
  assert.match(src, /viewPolicy === "attach" && g\.invited/,
    "★대화록이 아직 프로젝트 멤버십으로 판정한다 — 세 축이 갈린다");
  assert.doesNotMatch(src, /isProjectMember:\s*(await\s*)?sessionBoundToMemberProject/,
    "checkViewGate 호출부가 아직 멤버십을 넘긴다");
  assert.match(src, /sessionInvitesMember\(/, "초대 판정기를 쓰지 않는다");
});

test("★ E14 프로젝트 세션기록 목록이 내 것만 준다(제목·존재도 프라이빗)", () => {
  const src = read("src/v6/session-log-store.ts");
  const at = src.indexOf("export async function listSessionsForProject");
  assert.ok(at > 0, "listSessionsForProject 가 없다");
  const body = src.slice(at, at + 1600);
  assert.match(body, /s\.owner = \$3 OR EXISTS\(/,
    "★프로젝트 멤버에게 남의 세션 기록 목록이 통째로 나간다");
  assert.match(body, /org_session_state[\s\S]{0,200}invites @> to_jsonb/, "초대 미러를 안 본다");
});

test("★ E15 질문 통합검색이 술어를 따로 두지 않는다", () => {
  const src = read("src/terminal/routes.ts");
  assert.doesNotMatch(src, /!isProjectSessionDir\(s\.dir\) \|\| s\.owned/,
    "검색이 자기만의 필터를 갖고 있다 — 목록 술어와 갈린다(초대받은 세션이 검색에서 빠진다)");
});

test("★ E16 세션 스코프 거부는 존재를 확인해 주지 않는다(404 통일)", () => {
  const src = read("src/terminal/routes.ts");
  assert.doesNotMatch(src, /HttpError\(403, "세션에 접근할 수 없습니다"\)/,
    "★403 이 남아 있다 — 그 세션이 존재한다는 사실을 알려 준다(id 열거)");
  assert.match(src, /const SESSION_NOT_FOUND = "없거나 접근할 수 없는 세션입니다";/, "통일 문구가 없다");
  assert.match(src, /HttpError\(404, SESSION_NOT_FOUND\)/, "404 통일이 안 됐다");
});

test("E17 초대 창구가 살아 있다 — 「공유」가 invites 를 쓴다(잠그기만 하고 열 길이 없으면 안 된다)", () => {
  const src = read("web/v2/share-session.ts");
  assert.match(src, /const b: Record<string, unknown> = \{ invites \}/, "공유가 invites 를 저장하지 않는다");
  assert.match(src, /\/api\/ui\/terminal\/sessions\/' \+ encodeURIComponent\(s\.id\)/, "저장 경로가 바뀌었다");
  // 프로젝트 세션을 제외하는 분기가 생기면 그 세션들은 **초대할 방법이 없는 채로 잠긴다.**
  assert.doesNotMatch(read("web/v2/share-session.ts"), /isProjectSessionDir|projectId\s*\?\s*null/,
    "공유 버튼이 프로젝트 세션을 제외한다 — 잠긴 세션을 열 길이 사라진다");
});
