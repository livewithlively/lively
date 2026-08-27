// #1791 — 노드 세션 desired-state 행 계산(nodeSessionStateInput)의 계약. 사양(행위)만 본다 — 노드가 돌려준 값과
//  요청값 중 무엇이 이기나, 재생성 좌표가 노드의 createSession 규칙과 같나, 빈 값·부재가 어떻게 접히나.
//  이 행이 틀리면 복원(restore)이 엉뚱한 폴더·하네스·소유자로 세션을 다시 띄운다 — 눈으로 보기 비싼 갈림길이라 표로 박는다.
import { strict as assert } from "node:assert";
import test from "node:test";
import { nodeSessionStateInput } from "./node-session-state.js";
import type { CreateInput, SessionInfo } from "./catalog.js";

const sess = (over: Partial<SessionInfo> = {}): SessionInfo => ({
  id: "box-yoon-0a1b2c3d", label: "노드 라벨", harness: "claude", dir: "C:\\Users\\y\\box\\yoon\\sessions\\box-yoon-0a1b2c3d",
  autoApprove: false, owner: "yoon", owned: true, created: 1_787_000_000, attached: false, invites: ["jang"], flags: { "--model": "opus" },
  ...over,
});
const req = (over: Partial<CreateInput> = {}): CreateInput => ({
  kind: "human", label: "요청 라벨", rootKey: "", subpath: "", harness: "codex", flags: {}, autoApprove: true, ...over,
});

test("B1·B2 workspace 좌표 — 빈 root는 personal, 지정 좌표는 그대로", () => {
  const a = nodeSessionStateInput(sess(), "hammurabi", req({ rootKey: "" }), "yoon");
  assert.equal(a.root_key, "personal");
  assert.equal(a.subpath, null);
  const b = nodeSessionStateInput(sess(), "hammurabi", req({ rootKey: "shared", subpath: "project/7" }), "yoon");
  assert.equal(b.root_key, "shared");
  assert.equal(b.subpath, "project/7");
});

test("B3·B4 일반 세션 — 요청 좌표 그대로, 빈 문자열(경계)은 null", () => {
  const a = nodeSessionStateInput(sess(), "n1", req({ rootKey: "shared", subpath: "proj/x" }), "yoon");
  assert.equal(a.root_key, "shared");
  assert.equal(a.subpath, "proj/x");
  const b = nodeSessionStateInput(sess(), "n1", req({ rootKey: "", subpath: "" }), "yoon");
  assert.equal(b.root_key, "personal");
  assert.equal(b.subpath, null);
});

test("C1·C2 라벨·하네스 — 노드 응답 우선, 비면 요청값, 그것도 비면 라벨은 null·하네스는 claude", () => {
  const a = nodeSessionStateInput(sess({ label: "" }), "n1", req({ label: "L" }), "yoon");
  assert.equal(a.label, "L");
  const b = nodeSessionStateInput(sess({ label: "" }), "n1", req({ label: "" }), "yoon");
  assert.equal(b.label, null);
  const c = nodeSessionStateInput(sess({ harness: "" }), "n1", req({ harness: "" }), "yoon");
  assert.equal(c.harness, "claude");
  const d = nodeSessionStateInput(sess({ harness: "shell" }), "n1", req({ harness: "codex" }), "yoon");
  assert.equal(d.harness, "shell", "응답이 이긴다");
});

test("C3·C4 새 헬퍼가 빈 값을 받는 경우 — created=0 은 지금, flags 부재는 {}, invites 비배열은 []", () => {
  const before = Math.floor(Date.now() / 1000);
  const a = nodeSessionStateInput(sess({ created: 0, flags: undefined as unknown as Record<string, string>, invites: undefined as unknown as string[] }), "n1", req(), "yoon");
  const after = Math.floor(Date.now() / 1000);
  assert.ok(a.created !== null && a.created >= before && a.created <= after, `created 가 지금이어야 한다(${a.created})`);
  assert.deepEqual(a.flags, {});
  assert.deepEqual(a.invites, []);
});

test("C5 자동승인 — 노드가 실제 적용한 값(응답)이 요청보다 우선", () => {
  const a = nodeSessionStateInput(sess({ autoApprove: false }), "n1", req({ autoApprove: true }), "yoon");
  assert.equal(a.auto_approve, false);
});

test("D1~D3 프로젝트 — 응답 우선·요청 폴백·출처는 있을 때만(v6 기본, org 요청 시 org)", () => {
  const a = nodeSessionStateInput(sess({ projectId: 7 }), "n1", req({ projectId: 3 }), "yoon");
  assert.equal(a.project_id, 7); assert.equal(a.project_src, "v6");
  const b = nodeSessionStateInput(sess({ projectId: undefined }), "n1", req({ projectId: 3, projectSrc: "org" }), "yoon");
  assert.equal(b.project_id, 3); assert.equal(b.project_src, "org");
  const c = nodeSessionStateInput(sess({ projectId: 0 }), "n1", req({}), "yoon");
  assert.equal(c.project_id, null); assert.equal(c.project_src, null);
});

test("A1 정체성 — node_id 는 노드, owner 는 요청자(응답의 owner 가 아니라), 모드·캡은 요청값", () => {
  const a = nodeSessionStateInput(sess({ owner: "someone-else" }), "hammurabi", req({ readOnly: true, incognito: false, writeVis: "private", restrictRead: true }), "yoon");
  assert.equal(a.node_id, "hammurabi");
  assert.equal(a.owner, "yoon");
  assert.equal(a.id, "box-yoon-0a1b2c3d");
  assert.equal(a.read_only, true); assert.equal(a.incognito, false);
  assert.equal(a.write_vis, "private"); assert.equal(a.restrict_read, true);
  assert.equal(a.dir, "C:\\Users\\y\\box\\yoon\\sessions\\box-yoon-0a1b2c3d");
  assert.deepEqual(a.invites, ["jang"]);
  assert.equal(a.last_busy, null);
});

test("A2 앱 세션 — app_id만 desired-state에 남고 원격 준비 봉투의 토큰은 저장 모델에 없다", () => {
  const a = nodeSessionStateInput(sess(), "n1", req({
    appId: "review-app",
    appSession: { appId: "review-app", token: "secret", gatewayUrl: "https://gw.example", assets: [] },
  }), "yoon");
  assert.equal(a.app_id, "review-app");
  assert.ok(!("appSession" in a));
  assert.doesNotMatch(JSON.stringify(a), /secret/);
});
