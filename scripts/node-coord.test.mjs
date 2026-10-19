// 세션 행의 노드 좌표가 «정말 다른 컴퓨터» 인가 — 판정 한 벌(web/lib/node-coord.ts, #4904).
//
// 왜 이 테스트가 있나: 살아 있는 매니지드 세션의 행엔 세션 호스트 좌표(`sesshost-<slug>-<node>`)가 실린다. 대화창이 그 좌표를
//  «그 컴퓨터(멤버 PC)» 로 읽어 멈춤 · 승인 단추를 막고 전달 큐를 안 물었다(매니지드 실측 2026-10-19). 서버는 같은 좌표를 이 게이트웨이의
//  세션으로 접는다(#3745 · #2600 T2 d6). 화면은 서버의 선언 값을 못 받아 이름으로 추론하므로, 이 표는 ① 세션 호스트 · 멤버 PC · 좌표 없음의
//  경계와 ② **서버가 실제로 만드는 세션 호스트 이름**(계약 — 서버가 접두를 바꾸면 여기서 빨개진다)을 잠근다.
// 실행: npm run build 뒤 — 러너 `node scripts/run-tests.mjs --build`(화면 모듈은 public/app, 서버 모듈은 dist 에서 읽는다).
import { strict as assert } from "node:assert";
import test from "node:test";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { SESSION_HOST_PREFIX, looksLikeSessionHost, remoteNodeOf } = await import(pathToFileURL(path.join(ROOT, "public/app/lib/node-coord.js")).href);
const { nodeLabel } = await import(pathToFileURL(path.join(ROOT, "public/app/projects/detail-hub-model.js")).href);
const { SESSION_HOST_NODE_PREFIX, sessionHostNodeId } = await import(pathToFileURL(path.join(ROOT, "dist/node/session-host-provision.js")).href);

test("세션 호스트 좌표는 다른 컴퓨터가 아니다 — 지금 축(sesshost-<slug>-<node>) · 옛 축(sesshost-<slug>) · 앞뒤 공백", () => {
  for (const id of ["sesshost-lively-46e3-i-08475c46f4bb19c32", "sesshost-46e3", "  sesshost-x  ", "sesshost-"]) {
    assert.equal(looksLikeSessionHost(id), true, id);
    assert.equal(remoteNodeOf(id), null, id);
  }
});

test("계약 — 서버가 만드는 세션 호스트 이름을 화면도 세션 호스트로 읽는다(접두 상수 · sessionHostNodeId)", () => {
  assert.equal(SESSION_HOST_PREFIX, SESSION_HOST_NODE_PREFIX);
  for (const [slug, node] of [["lively-46e3", "i-02addbf327f377c99"], ["acme", "i-0eb127b7f7bfe3d80"]]) {
    const id = sessionHostNodeId(slug, node);
    assert.ok(id, `${slug}/${node} — 서버가 이름을 만들었다(전제)`);
    assert.equal(looksLikeSessionHost(id), true, id);
    assert.equal(remoteNodeOf(id), null, id);
  }
});

test("멤버 PC 좌표는 다른 컴퓨터다 — 그 id 를 그대로(앞뒤 공백만 걷고) 돌려준다", () => {
  assert.equal(remoteNodeOf("laibeulliui-macmini"), "laibeulliui-macmini");
  assert.equal(remoteNodeOf(" hammurabi "), "hammurabi");
  assert.equal(looksLikeSessionHost("laibeulliui-macmini"), false);
});

test("접두가 아닌 «sesshost» 는 세션 호스트가 아니다 — 가운데 · 뒤에 든 것 · 대문자(서버는 소문자로만 만든다)", () => {
  for (const id of ["my-sesshost-x", "xsesshost-1", "SESSHOST-x", "Sesshost-lively-46e3-i-1", "sesshost_x"]) {
    assert.equal(looksLikeSessionHost(id), false, id);
    assert.equal(remoteNodeOf(id), id, id);
  }
});

test("좌표가 없으면(빈 값 · 공백뿐) 세션 호스트도 다른 컴퓨터도 아니다 — 멤버 PC 로 읽지 않는다", () => {
  for (const v of [null, undefined, "", "   "]) {
    assert.equal(looksLikeSessionHost(v), false, JSON.stringify(v));
    assert.equal(remoteNodeOf(v), null, JSON.stringify(v));
  }
});

test("프로젝트 허브의 «도는 자리» 이름표도 같은 판정을 쓴다 — 세션 호스트는 «서버»", () => {
  assert.equal(nodeLabel({ id: "sesshost-lively-46e3-i-08475c46f4bb19c32", name: "sesshost-lively-46e3-i-08475c46f4bb19c32" }), "서버");
  assert.equal(nodeLabel({ id: "laibeulliui-macmini", name: "laibeulliui-Macmini.local" }), "laibeulliui-Macmini");
  assert.equal(nodeLabel(null), "중앙");
});
