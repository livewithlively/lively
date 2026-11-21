// #5598(2026-11-22) — 세션 대화 읽기(…/transcript · …/outbox)는 세션을 볼 수 있는 사람만(#1876: 주인 · 초대받은 사람, 관리자 예외 없음).
//
//  사고: chat-routes.ts gateRead 가 «주인 · 관리자 · 프로젝트에 묶인 세션(project_id>0)» 이면 통과시켰다(#452 공동 세션 잔재).
//   세션 화면(canAttach)은 막는데 이 주소로는 초대받지 않은 구성원이 프로젝트 세션의 대화 전체를, 관리자는 모든 세션의 대화를 읽었다.
//   세션 id 는 태스크 상세의 sessions 에 그대로 나온다. 그 프로젝트가 나에게 감춰져 있어도 통과했다.
//  재현(격리 게이트웨이 · 임시 DB, 2026-11-22): 고치기 전 v-other/v-admin 의 outbox 200 · transcript 404(게이트 통과 뒤 파일 없음)
//   → 고친 뒤 둘 다 403 · 주인 그대로 · 초대받은 사람은 초대받은 세션만.
//
//  사양 · 엣지 표
//   G1  ★게이트가 관리자 스코프를 보지 않는다(관리자 예외 없음)
//   G2  ★게이트가 project_id 로 통과시키지 않는다(프로젝트에 묶였다는 것은 열람 근거가 아니다)
//   G3  끝난 세션도 목록 · 입장과 같은 술어(sessionVisible)로 잰다 · 주인은 감춘 프로젝트 판정 없이 통과
//   G4  감춘 프로젝트 판정을 못 하면(hiddenProjects 실패) 초대자에겐 닫는다 — undefined 를 넘긴다(sessionVisible 이 fail-closed)
//   G5  대화를 내는 두 주소(transcript · outbox)가 모두 이 게이트를 지난다
//   M1  끝난 세션 메타도 같은 자 — routes.ts 의 세 호출이 «프로젝트 폴더에서 돌았나»(sharedByFolder)를 더는 쓰지 않는다
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync("src/terminal/chat-routes.ts", "utf8");
const gate = src.slice(src.indexOf("async function gateRead("), src.indexOf("export async function deadSessionReadable("));
const dead = src.slice(src.indexOf("export async function deadSessionReadable("), src.indexOf("// #2116 — 지금 이 세션을 보고 있는 사람"));

test("G1 ★게이트가 관리자 스코프를 보지 않는다", () => {
  assert.ok(gate.length > 200, "gateRead 를 찾지 못했다 — 이름이 바뀌었나");
  assert.doesNotMatch(gate, /admin/, "관리자는 대화를 읽지 않는다(#1876) — 메타와 멈추기 · 회수만");
  assert.doesNotMatch(dead, /admin/);
});

test("G2 ★게이트가 project_id 로 통과시키지 않는다", () => {
  assert.doesNotMatch(gate, /project_id/, "프로젝트에 묶였다는 것은 대화를 읽을 근거가 아니다");
  assert.match(gate, /if \(await canAttach\(id, uid\)\) return null;/);
  assert.match(gate, /if \(st && await deadSessionReadable\(st, uid\)\) return null;\n\s*throw new HttpError\(403/);
});

test("G3 끝난 세션도 목록 · 입장과 같은 술어 · 주인은 바로 통과", () => {
  assert.match(dead, /if \(st\.owner === uid\) return true;/);
  assert.match(dead, /return sessionVisible\(\{ owner: st\.owner, invites: st\.invites, dir: st\.dir, projectId: st\.project_id \}, uid, hidden\);/);
  assert.match(src, /import \{ sessionVisible \} from "\.\/write-cap\.js";/);
});

test("G4 감춘 프로젝트 판정 실패 → 초대자에겐 닫는다(undefined 를 넘긴다)", () => {
  assert.match(dead, /const hidden = await hiddenProjects\(uid\)\.catch\(\(\) => undefined\);/);
});

test("G5 대화를 내는 두 주소가 모두 게이트를 지난다", () => {
  const transcript = src.slice(src.indexOf('app.get("/api/ui/terminal/sessions/:id/transcript"'), src.indexOf('app.get("/api/ui/terminal/sessions/:id/transcript"') + 600);
  assert.match(transcript, /await gateRead\(id, req, true\)/);
  const outbox = src.slice(src.indexOf('app.get("/api/ui/terminal/sessions/:id/outbox"'), src.indexOf('app.get("/api/ui/terminal/sessions/:id/outbox"') + 400);
  assert.match(outbox, /await gateRead\(id, req\)/);
});

test("M1 끝난 세션 메타도 같은 자", () => {
  const routes = readFileSync("src/terminal/routes.ts", "utf8");
  assert.doesNotMatch(routes, /deadSessionMeta\([^)]*sharedByFolder/, "«프로젝트 폴더에서 돌았나» 만으로 남에게 이름 · 프로젝트를 내주지 않는다");
  assert.equal((routes.match(/deadSessionMeta\(id, st, uid, isAdmin, await viewerSeesFor\(uid\)\)/g) || []).length, 3);
  assert.match(routes, /sessionVisible\(\{ owner: st\.owner, invites: st\.invites, dir: st\.dir, projectId: st\.project_id \}, uid, hidden\)/);
});
