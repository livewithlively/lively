// «남은 삭제 길도 전부 휴지통을 지난다» (#3778 3차, 원준 2026-09-21 "남은 것도 이어서 다 해줘") — 값과 배선으로 지킨다.
//
//  약속:
//   ① 어떤 화면도 세션을 그 자리에서 영영 지우지 않는다 — 도는 세션은 터미널만 내리고(reclaim), 멈춘 세션은 휴지통으로. 완전 삭제는 휴지통 안에서만.
//   ② 프로젝트는 어디서 지워도 휴지통으로 간다(리스트를 «프로젝트도 함께» 지울 때도).
//   ③ 개인·공유 폴더의 파일도 프로젝트 파일과 같은 규칙으로 보관된다 — 되살리는 길은 그 폴더의 것.
//   ④ 사이드바 「휴지통 N」 = 휴지통 화면 네 탭의 합.
//   ⑤ 주입 섹션 삭제는 지식 휴지통에 선다(«휴지통에서 되살릴 수 있어요» 가 참이 된다).
//  잣대(값)는 web/lib/trash-tabs.ts, 배선(W*)은 «그 잣대를 화면·서버가 실제로 쓴다» 를 소스로 확인한다.
import { strict as assert } from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
let pass = 0;
const ok = (cond, what) => { assert.ok(cond, what); pass++; };
const eq = (got, want, what) => { assert.deepEqual(got, want, what); pass++; };

const {
  trashBadgeN, extraCountsOf, fileTrashRootOf, fileTrashUrl, srcItems, knowItems, auditProjItems,
} = await import(join(root, "public/app/lib/trash-tabs.js"));

// ── 배지 (B1~B5) ───────────────────────────────────────────────────────────
eq(trashBadgeN(3, null), 3, "B1 서버 몫을 아직 모르면 아는 절반만 — 배지를 비우지도, 모르는 것을 더하지도 않는다");
eq(trashBadgeN(3, { knowledge: 1, project: 2, source: 3, files: 4 }), 13, "B2 아는 절반 + 서버가 센 나머지");
eq([trashBadgeN(-1, null), trashBadgeN(NaN, null), trashBadgeN(2.9, null)], [0, 0, 2], "B3a 음수·NaN 은 0, 소수는 내림");
eq(trashBadgeN(0, { knowledge: -5, project: NaN, source: "7", files: 1.9 }), 8, "B3b 서버 값도 같은 규칙(숫자 문자열은 수로)");

const D = (entity, key, at, over = {}) => ({ entity, key, label: `${entity}-${key}`, at, actor: "a", ...over });
const F = (id, at, over = {}) => ({ id, title: `f${id}.docx`, path: `docs/f${id}.docx`, ext: "docx", bytes: 10, project_id: 7, at, by: "a", has_knowledge: false, ...over });
const deleted = [
  D("knowledge", "k1", "2026-09-20T05:00:00Z"), D("knowledge", "k2", "2026-09-19T05:00:00Z"), D("knowledge", "k-locked", "2026-09-18T05:00:00Z", { locked: true }),
  D("project", "41", "2026-09-18T05:00:00Z", { level: "task" }), D("project", "43", "2026-09-17T05:00:00Z", { locked: true }),
  D("source", "9", "2026-09-16T05:00:00Z", { kind: "minutes" }), D("source", "abc", "2026-09-15T05:00:00Z"), D("source", "10", "2026-09-14T05:00:00Z", { locked: true }),
  D("category", "5", "2026-09-13T05:00:00Z"),
];
const files = [F(1, "2026-09-20T01:00:00Z"), F(2, "2026-09-19T01:00:00Z", { root: "personal", project_id: null }), F(0, "2026-09-18T01:00:00Z"), F(3, "2026-09-17T01:00:00Z", { root: "shared", project_id: null })];
eq(extraCountsOf(deleted, files), { knowledge: 2, project: 1, source: 1, files: 3 }, "B4 탭과 같은 잣대 — 잠긴 줄·깨진 id(abc·0)·카테고리는 안 센다");
{
  //  ★불변식 — 배지의 모집단 = 탭 숫자의 모집단. 화면이 그리는 탭 숫자를 같은 재료로 다시 세어 맞춘다.
  const sess = 4, trashedProj = 2;
  const tabs = { sess, proj: trashedProj + auditProjItems(deleted).length, src: srcItems(deleted, files).length, know: knowItems(deleted).length };
  eq(trashBadgeN(sess + trashedProj, extraCountsOf(deleted, files)), tabs.sess + tabs.proj + tabs.src + tabs.know, "B5 ★배지 = 네 탭의 합");
}

// ── 어느 폴더의 파일인가 (R1~R6) ────────────────────────────────────────────
eq([undefined, "", "project", "zzz", null].map(fileTrashRootOf), ["project", "project", "project", "project", "project"], "R1 모르는 값·빈 값은 project — 옛 서버·옛 도장은 프로젝트 파일뿐이었다");
eq(["personal", "shared"].map(fileTrashRootOf), ["personal", "shared"], "R2 내 폴더·공유 폴더는 그대로");
eq([fileTrashUrl({ root: "project", projectId: 7 }, "restore"), fileTrashUrl({ root: "project", projectId: 7 }, "purge")],
  ["/api/ui/v6/projects/7/file-trash/restore", "/api/ui/v6/projects/7/file-trash/purge"], "R3 프로젝트 파일은 그 프로젝트의 길");
eq([fileTrashUrl({ root: "project", projectId: null }, "restore"), fileTrashUrl({ root: "project", projectId: 0 }, "purge")], [null, null], "R4 프로젝트 번호를 모르면 주소를 지어내지 않는다");
eq([fileTrashUrl({ root: "personal", projectId: null }, "restore"), fileTrashUrl({ root: "shared", projectId: 9 }, "purge")],
  ["/api/ui/terminal/browse/trash/restore", "/api/ui/terminal/browse/trash/purge"], "R5 내 폴더·공유 폴더는 브라우즈의 길(프로젝트 번호는 안 본다)");
{
  const items = srcItems([], files);
  eq(items.map((x) => [x.id, x.root]), [[1, "project"], [2, "personal"], [3, "shared"]], "R6a 파일 줄이 제 폴더를 들고 다닌다(깨진 id 0 은 빠진다)");
  eq(items.map((x) => x.sub), ["docs/f1.docx", "내 폴더 · docs/f2.docx", "공유 폴더 · docs/f3.docx"], "R6b 어느 폴더였는지 한 줄로 — 프로젝트는 종전대로 경로만");
}

// ── 배선 ───────────────────────────────────────────────────────────────────
const walk = (dir) => readdirSync(join(root, dir)).flatMap((n) => {
  const p = dir + "/" + n;
  return statSync(join(root, p)).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
});
const webFiles = walk("web");
ok(webFiles.length > 200, "W0 웹 소스를 실제로 훑었다(경로가 죽으면 아래 단언이 빈손으로 통과한다)");

//  W1 — 세션 DELETE 는 전부 reclaim. 같은 줄에 없으면 앞 10줄 안의 쿼리 조립(q = '?reclaim=1' + …)을 본다.
{
  const bare = []; let seen = 0;
  for (const f of webFiles) {
    const lines = read(f).split("\n");
    lines.forEach((ln, i) => {
      if (!/terminal\/sessions\/'/.test(ln) || !/method: 'DELETE'/.test(ln)) return;
      seen++;
      if (!/reclaim=1/.test(lines.slice(Math.max(0, i - 10), i + 1).join("\n"))) bare.push(`${f}:${i + 1}`);
    });
  }
  ok(seen >= 4, `W1a 세션 DELETE 호출을 실제로 찾았다(${seen}건) — 찾는 눈이 살아 있다`);
  eq(bare, [], "W1 ★세션 DELETE 는 전부 reclaim=1 — 되살리기 좌표까지 그 자리에서 지우는 호출이 없다");
}
//  W2 — 세션 기록 완전 삭제는 휴지통 화면에서만.
{
  const users = webFiles.filter((f) => f !== "web/session-actions.ts" && /\b(purgeSessionRecord|confirmSessionPurge|confirmSessionPurgeMany|confirmSessionPurgeLocal)\(/.test(read(f)));
  eq(users, ["web/v2/bins.ts"], "W2 ★세션 완전 삭제를 부르는 화면은 휴지통 하나 — [⋯] 창·세션 이력 앱은 휴지통으로 보낸다");
  const sess = read("web/sessions.ts"), chat = read("web/session-chat.ts");
  ok(/sessionTrashOp\('trash', \[s\.session_id\]\)/.test(sess) && /sessionTrashOp\('trash', \[sid\]\)/.test(sess) && /sessionTrashOp\('trash', sessionNames\(/.test(chat), "W2b 그 두 화면은 휴지통 표식만 붙인다");
  ok(!/api\([^)]*\/api\/ui\/v6\/sessions\/[^)]*method: 'DELETE'/.test(sess + chat), "W2c 세션 기록 DELETE 를 직접 쏘지도 않는다");
}
//  W3·W4 — 프로젝트는 휴지통으로만.
{
  const hard = webFiles.filter((f) => /\/api\/ui\/v6\/projects\/'\s*\+[^;\n]*\+\s*'\/delete'/.test(read(f)));
  eq(hard, [], "W3 ★웹 어디서도 프로젝트 하드 삭제(/projects/:id/delete)를 부르지 않는다");
  const callers = ["web/projects/rows.ts", "web/projects/selection.ts", "web/projects/detail-sections.ts", "web/dash/widget-projects.ts", "web/v2/proj-settings.ts", "web/v2/bins.ts"];
  eq(callers.filter((f) => !/trashProjectFlow\(|trashProjectsFlow\(/.test(read(f))), [], "W3b 프로젝트를 지우던 여섯 입구가 전부 공용 휴지통 흐름을 탄다");
  ok(/fetchProjectTrashPreview\(/.test(read("web/session-actions.ts")) && !/liveN: 0, othersLive: 0/.test(read("web/v2/proj-settings.ts")), "W3c 확인창은 서버가 센 세션 수로 말한다 — 0 을 박아 두지 않는다");
  //  주석을 걷고 본다 — 이 파일은 «종전엔 deleteProject 였다» 고 이력을 적어 둔다(주석에 남은 이름에 걸리면 거짓 빨강이다).
  const code = (src) => src.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
  const lists = code(read("src/capabilities/lists-v6.ts"));
  ok(/trashProjectBundle\(/.test(lists) && !/\bdeleteProject\(/.test(lists), "W4 ★리스트를 «프로젝트도 함께» 지워도 프로젝트는 휴지통으로 — 하드 삭제를 부르지 않는다");
  ok(/trashed_projects/.test(lists) && /skipped_projects/.test(lists), "W4b 몇 개를 보냈고 몇 개를 건너뛰었는지 돌려준다(남의 도는 세션이 있는 프로젝트)");
  ok(/e instanceof HttpError && e\.status === 409\) skippedProjects\.push/.test(lists) && /else throw e;/.test(lists), "W4c ★건너뛰는 것은 예상한 거절(409) 하나뿐 — 모르는 실패를 «남의 세션 때문» 으로 뭉개지 않고 리스트를 지우기 전에 던진다");
  ok(lists.indexOf("else throw e;") < lists.indexOf("await deleteProjectList(input.id, wctx)"), "W4d 던지는 자리가 리스트 삭제보다 앞이다");
  ok(/res\.skipped_projects\[0\]\.why/.test(read("web/projects/sidebar.ts")), "W4e 화면은 서버가 말한 이유를 그대로 적는다");
}
//  W5·W11 — 휴지통에 있는 세션은 클래식 목록에 서지 않는다.
{
  ok(/const sessions = notTrashed<any>\(/.test(read("web/terminal/routes.ts")), "W5a AI 세션 탭");
  ok((read("web/dash/widget-sessions.ts").match(/notTrashed<any>\(/g) || []).length >= 2, "W5b 대시보드 위젯(첫 로드·다시 받기 둘 다)");
  ok(/trashed_at\?: string \| null \}\)\.trashed_at\)/.test(read("web/sessions.ts")), "W5c 세션 이력 앱");
  const pr = read("src/project/project-routes.ts");
  ok(/dropTrashedRows\(rows, await trashMapFor\(/.test(pr), "W11 프로젝트 상세의 세션 칸(서버가 걷는다)");
}
//  W6·W7 — 개인·공유 폴더 파일 휴지통.
{
  const tf = read("src/terminal/terminal-files.ts");
  const del = tf.slice(tf.indexOf('app.delete("/api/ui/terminal/browse"'), tf.indexOf("const trashedBrowseFile"));
  ok(del.length > 500, "W6a 삭제 라우트를 실제로 잘라 왔다");
  const iCount = del.indexOf("countActiveLocalUnder(loc.root, rel)"), iMove = del.indexOf("fsMove(osUser, abs, heldAbs)"), iStamp = del.indexOf("stampTrashedLocalPath(loc.root, rel, stamp)"), iBack = del.indexOf("fsMove(osUser, heldAbs, abs)");
  ok(iCount > 0 && iCount < iMove && iMove < iStamp && iStamp < iBack, "W6 ★자료가 달렸나 센다 → 옮긴다 → 도장 → (0건이면) 되돌린다 — 이 순서");
  ok(/rel\.split\("\/"\)\[0\] !== "\.lively"/.test(del), "W6b 보관 자리 자체는 휴지통으로 돌리지 않는다");
  ok(/loc\.root\.kind !== "personal"\) await grantSharedGroupWrite/.test(del), "W6c 개인 루트의 보관 폴더는 그룹에 열지 않는다(격리)");
  const back = tf.slice(tf.indexOf("const trashedBrowseFile"), tf.indexOf('app.get("/api/ui/terminal/browse/file"'));
  ok(/root\.kind === "project"\) throw gone\(\)/.test(back), "W7a 프로젝트 좌표는 이 길의 대상이 아니다(프로젝트 라우트가 다룬다)");
  ok(/localRootKey\(mine\.root\) !== localRootKey\(root\)\) throw gone\(\)/.test(back), "W7b ★남의 개인 폴더는 없는 것과 같은 404");
  ok(/canSeeSource\(sourceId, viewer\)/.test(back) && /assertBrowseVisible\(/.test(back) && /assertJailed\(base, heldAbs, osUser\)/.test(back), "W7c 자료 공개범위 · 폴더 공개범위 · 심링크 봉쇄를 다 지난다");
  ok(/browse\/trash\/restore/.test(back) && /browse\/trash\/purge/.test(back) && /fileTrashBatchCleanup\("restore"/.test(back) && /fileTrashBatchCleanup\("purge"/.test(back), "W7d 되살리기·완전 삭제 둘 다 묶음 치우기 판정을 지난다(되살리기는 아무것도 없애지 않는다)");
}
//  W8 — 목록과 개수는 같은 술어.
{
  const ss = read("src/v6/source-store.ts");
  ok((ss.match(/trashedFileWhere\(params, personalMember\)/g) || []).length === 2, "W8a 파일 목록·개수가 한 술어를 쓴다");
  ok(/NOT LIKE 'personal:%' OR s\.fields->'trash'->>'root' = \$/.test(ss), "W8b 남의 개인 폴더 것은 세우지도 세지도 않는다");
  const cap = read("src/capabilities/trash.ts");
  ok(/name: "trash_counts"[\s\S]{0,700}?mcp: false/.test(cap) && /paths: \["\/api\/ui\/deleted\/counts"\]/.test(cap), "W8c 개수 길은 화면 전용");
  ok(/personalRootMember\(_user/.test(cap) && /personalRootMember\(_user\)/.test(read("src/capabilities/source.ts")), "W8d 목록·개수가 같은 «내 개인 폴더» 키를 쓴다");
  const ts = read("src/v6/trash-store.ts");
  const cnt = ts.slice(ts.indexOf("export async function countDeleted"), ts.indexOf("// 복원용 스냅샷"));
  ok(/latest\.op = 'delete'/.test(cnt) && /latest\.before IS NOT NULL/.test(cnt) && /= ANY\(\$2\)/.test(cnt) && /<> 'members'/.test(cnt), "W8e 개수 SQL 이 목록의 조건(마지막 작업이 삭제 · 본문 있음 · 수집 자료 제외 · 대상 제한 제외)을 그대로 지난다");
  ok(!/SELECT[^;]*\bbefore\b[^;]*FROM \(/.test(cnt.split("FROM (")[0]), "W8f 개수 조회는 본문(before)을 바깥으로 끌어오지 않는다");
}
//  W9 — 주입 섹션.
{
  const sec = read("src/org/store/sections.ts");
  const fn = sec.slice(sec.indexOf("export async function deleteSection"));
  ok(/await deleteK6\(section, \{ actor: actor \?\? null, source \}\)/.test(fn) && /audit\("org_section", section, "delete"/.test(fn) && !/DELETE FROM knowledge/.test(fn), "W9 ★섹션 삭제는 지식과 같은 길 — 휴지통 ▸ 지식 탭에 선다(org_section 감사도 유지)");
  ok(/휴지통 ▸ 지식 탭/.test(read("web/admin-injection.ts")) && /휴지통 ▸ 지식 탭/.test(read("web/v2/me-auto.ts")), "W9b 두 화면이 어디서 되살리는지 말한다");
}
//  W10 — 사이드바 두 자리.
{
  const side = read("web/v2/side.ts");
  ok((side.match(/trashBadgeN\(/g) || []).length === 2 && (side.match(/, trashExtraCounts\(\)\)/g) || []).length === 2, "W10 ★발치 도크와 트리 행 둘 다 네 탭의 합을 그린다");
  ok(/watchTrashCounts\(redraw\)/.test(side), "W10b 서버 몫이 도착하면 다시 그린다");
  const bins = read("web/v2/bins.ts");
  ok(/if \(!filesFailed\) setTrashCounts\(extraCountsOf\(extras\.deleted, extras\.files\)\)/.test(bins) && /invalidateTrashCounts\(\)/.test(bins), "W10c 휴지통 화면이 제 목록으로 센 값을 배지에 준다 — 파일 목록을 못 받았으면 주지 않는다");
}
//  W12 — 클래식 다섯 화면이 공용 흐름을 탄다.
{
  const five = ["web/terminal/session-list.ts", "web/terminal/routes.ts", "web/dash/widget-sessions.ts", "web/dash/widget-sessions-popovers.ts", "web/projects/detail-terminal.ts"];
  eq(five.filter((f) => !/retireSessions?\(/.test(read(f))), [], "W12 클래식 다섯 화면의 [종료]·[지우기]가 retireSession(s) 를 탄다");
  ok(!/복원 목록에서 지우기/.test(five.map(read).join("\n")), "W12b 「복원 목록에서 지우기」라는 이름은 사라졌다 — 그 자리는 「휴지통으로」");
}

console.log(`trash-routes: ${pass} passed`);
