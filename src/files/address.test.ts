import { strict as assert } from "node:assert";
import test from "node:test";
import {
  parseAddress, formatAddress, parseAddressInput, addressLinkHash, appOfAddress, AddressError, ADDRESS_MAX, ADDRESS_APP_ID_RE,
  sessionPathToAddress, addressToSessionPath, type SessionView,
} from "./address.js";
import { APP_ID_RE } from "../apps/manifest.js";

// 파일 주소(#4673) — 사양 표 A(주소 글자) · B(입력 꼴) · C(세션 경로 → 주소) · D(주소 → 세션 경로). 행마다 시험 하나.
const bad = (raw: unknown, re: RegExp): void => {
  assert.throws(() => parseAddress(raw), (e: unknown) => e instanceof AddressError && re.test((e as Error).message), `${String(raw)} — ${re}`);
};

// ── A. 주소 글자 ─────────────────────────────────────────────────────────────────
test("A1 프로젝트 파일 주소 — shared · project/<번호>/<경로>", () => {
  assert.deepEqual(parseAddress("shared/project/4670/설계.md"), { root: "shared", rel: "project/4670/설계.md" });
});
test("A2 앞 / 하나 · 끝 / 하나는 받는다", () => {
  assert.deepEqual(parseAddress("/shared/x/"), { root: "shared", rel: "x" });
});
test("A3 앱 폴더 주소 — apps · <앱>/<경로>", () => {
  assert.deepEqual(parseAddress("apps/crm/out/a.png"), { root: "apps", rel: "crm/out/a.png" });
});
test("A4·A5 자리만 — apps · shared (rel 빈 값)", () => {
  assert.deepEqual(parseAddress("apps"), { root: "apps", rel: "" });
  assert.deepEqual(parseAddress("shared"), { root: "shared", rel: "" });
});
test("A6 개인 폴더는 주소가 없다", () => { bad("personal/x", /개인 폴더/); });
test("A7 모르는 자리", () => { bad("foo/x", /모르는 자리/); bad("project/4670/x", /모르는 자리/); });
test("A8 빈 마디", () => { bad("shared/a//b", /빈 마디/); });
test("A9 . · .. 마디", () => { bad("shared/../etc", /\.\./); bad("shared/./x", /\.\./); bad("apps/crm/..", /\.\./); });
test("A10 점으로 시작하는 마디(.lively · .git) — 예약 · 숨김 자리는 주소가 없다", () => {
  bad("shared/project/1/.lively/trash/x", /점으로 시작/);
  bad("apps/crm/.git", /점으로 시작/);
  bad("shared/.env", /점으로 시작/);
});
test("A11 apps 의 둘째 마디는 앱 id", () => {
  bad("apps/Bad_App/x", /앱 id/);
  bad("apps/a/x", /앱 id/);   // 1자 — 앱 id 는 2~32자
  bad("apps/-x/y", /앱 id/);
});
test("A12 역슬래시 · NUL · 줄바꿈", () => {
  bad("shared/a\\b", /쓸 수 없는 글자/);
  bad("shared/a\u0000b", /쓸 수 없는 글자/);
  bad("shared/a\nb", /쓸 수 없는 글자/);
});
test("A13 길이 경계 — 1024 받음 · 1025 거절", () => {
  const head = "shared/";
  const ok = head + "a".repeat(ADDRESS_MAX - head.length);
  assert.equal(ok.length, ADDRESS_MAX);
  assert.equal(parseAddress(ok).rel.length, ADDRESS_MAX - head.length);
  bad(ok + "b", /너무 깁니다/);
});
test("A14 문자열 아님 · 빈 글 · 공백뿐", () => {
  bad(42, /비었습니다/); bad("", /비었습니다/); bad("   ", /비었습니다/); bad(null, /비었습니다/);
});
test("A15 왕복 — format(parse(x)) 는 정규형 · NFD 이름을 바꾸지 않는다", () => {
  assert.equal(formatAddress(parseAddress("/apps/crm/a b/c.txt/")), "apps/crm/a b/c.txt");
  assert.equal(formatAddress(parseAddress("shared")), "shared");
  const nfd = "shared/" + "한글".normalize("NFD") + ".md";
  assert.equal(parseAddress(nfd).rel, ("한글".normalize("NFD") + ".md"));
  assert.notEqual(parseAddress(nfd).rel, ("한글.md"));
});
test("A 앱 id 규칙은 매니페스트 APP_ID_RE 와 같은 자", () => {
  assert.equal(ADDRESS_APP_ID_RE.source, APP_ID_RE.source);
});
test("A 링크 해시 · 앱 조각", () => {
  assert.equal(addressLinkHash({ root: "apps", rel: "crm/a b.png" }), "#/f?root=apps&path=crm%2Fa%20b.png");
  assert.deepEqual(appOfAddress({ root: "apps", rel: "crm/x/y" }), { app: "crm", rest: "x/y" });
  assert.deepEqual(appOfAddress({ root: "apps", rel: "crm" }), { app: "crm", rest: "" });
  assert.equal(appOfAddress({ root: "apps", rel: "" }), null);
  assert.equal(appOfAddress({ root: "shared", rel: "crm/x" }), null);
});

// ── B. 입력 꼴 ───────────────────────────────────────────────────────────────────
test("B1 첨부 표시 [lively:project:12/a.png] → 프로젝트 좌표", () => {
  assert.deepEqual(parseAddressInput("[lively:project:12/a.png]"), { kind: "project-ref", projectId: 12, rel: "a.png" });
});
test("B2 자료 좌표 project:12/sub/a.png", () => {
  assert.deepEqual(parseAddressInput("project:12/sub/a.png"), { kind: "project-ref", projectId: 12, rel: "sub/a.png" });
});
test("B3 개인 폴더 좌표 · 개인 폴더 링크 → personal", () => {
  assert.deepEqual(parseAddressInput("personal:me/x.md"), { kind: "personal" });
  assert.deepEqual(parseAddressInput("#/f?root=personal&path=x"), { kind: "personal" });
});
test("B4 웹 링크(앞에 주소가 붙어도) → 주소", () => {
  assert.deepEqual(parseAddressInput("https://w.app.lvly.io/ui/#/f?root=apps&path=crm%2Fa.png"),
    { kind: "address", address: { root: "apps", rel: "crm/a.png" } });
});
test("B5 좌표에도 마디 규칙(.. · 점)이 선다", () => {
  assert.throws(() => parseAddressInput("project:12/../x"), AddressError);
  assert.throws(() => parseAddressInput("project:12/.lively/x"), AddressError);
});
test("B6 주소는 그대로", () => {
  assert.deepEqual(parseAddressInput("apps/crm/x"), { kind: "address", address: { root: "apps", rel: "crm/x" } });
});

// ── C. 세션 경로 → 주소 ──────────────────────────────────────────────────────────
const C: SessionView = {
  place: "container", dir: "/work/shared/project/4670",
  bases: { shared: "/work/shared", personal: "/home/box_me/box" }, attachedApps: ["crm"],
};
const addr = (v: SessionView, p: string): string | null => { const r = sessionPathToAddress(v, p); return r.address ? formatAddress(r.address) : null; };
const reason = (v: SessionView, p: string): string => sessionPathToAddress(v, p).reason ?? "";

test("C1 매니지드 — /work/ 를 떼면 주소", () => {
  assert.equal(addr(C, "/work/shared/project/4670/a.md"), "shared/project/4670/a.md");
});
test("C2 작업 폴더 밖의 공유 경로도 글자로는 주소가 된다", () => {
  assert.equal(addr(C, "/work/shared/project/9/x"), "shared/project/9/x");
});
test("C3 붙은 앱 폴더 → apps/<앱>/…", () => {
  assert.equal(addr(C, "/work/shared/project/4670/.lively/apps/crm/out/a.png"), "apps/crm/out/a.png");
});
test("C4 안 붙은 앱 자리 → 주소 없음(까닭)", () => {
  assert.equal(addr(C, "/work/shared/project/4670/.lively/apps/other/x"), null);
  assert.match(reason(C, "/work/shared/project/4670/.lively/apps/other/x"), /붙지 않은 앱/);
});
test("C5 붙은 앱 폴더 자신 → apps/<앱>", () => {
  assert.equal(addr(C, "/work/shared/project/4670/.lively/apps/crm"), "apps/crm");
});
test("C6 앱 자리 자신 · 다른 점 자리 → 없음", () => {
  assert.equal(addr(C, "/work/shared/project/4670/.lively/apps"), null);
  assert.equal(addr(C, "/work/shared/project/4670/.git/config"), null);
  assert.match(reason(C, "/work/shared/project/4670/.git/config"), /점으로 시작/);
});
test("C7 개인 자리 → 없음(개인)", () => {
  assert.equal(addr(C, "/home/box_me/box/notes.md"), null);
  assert.match(reason(C, "/home/box_me/box/notes.md"), /개인 폴더/);
});
test("C8 상대경로 → 없음", () => {
  assert.equal(addr(C, "shared/project/4670/a.md"), null);
  assert.match(reason(C, "a.md"), /절대경로/);
});
test("C9 이름이 겹치는 형제 디렉터리는 안이 아니다", () => {
  assert.equal(addr(C, "/work/shared-old/x"), null);
});
test("C10 중첩 기준 — 더 깊은 쪽(개인)이 이긴다", () => {
  const v: SessionView = { place: "host", dir: "/srv/ws/project/1", bases: { shared: "/srv/ws", personal: "/srv/ws/me" } };
  assert.equal(addr(v, "/srv/ws/me/x"), null);
  assert.equal(addr(v, "/srv/ws/project/1/x"), "shared/project/1/x");
});
test("C11 셀프호스트 — 앱 폴더 자리 그대로", () => {
  const v: SessionView = { place: "host", dir: "/srv/ws/project/1", bases: { shared: "/srv/ws", apps: "/srv/apps" } };
  assert.equal(addr(v, "/srv/apps/crm/a.txt"), "apps/crm/a.txt");
});
test("C12 셀프호스트 — 앱 자리 안이지만 앱 id 가 아닌 폴더", () => {
  const v: SessionView = { place: "host", dir: "/srv/ws", bases: { apps: "/srv/apps" } };
  assert.equal(addr(v, "/srv/apps/Bad_Dir/a.txt"), null);
});
test("C13 사람 컴퓨터 — 프로젝트 폴더 앞부분이 공유 자리", () => {
  const v: SessionView = { place: "node", dir: "/Users/a/ws/project/4670", projectId: 4670 };
  assert.equal(addr(v, "/Users/a/ws/project/4670/x.md"), "shared/project/4670/x.md");
  assert.equal(addr(v, "/Users/a/ws/docs/y.md"), "shared/docs/y.md");
});
test("C14 사람 컴퓨터(윈도우) — 역슬래시 경로", () => {
  const v: SessionView = { place: "node", dir: "C:\\u\\ws\\project\\4670\\sub", projectId: 4670 };
  assert.equal(addr(v, "C:\\u\\ws\\docs\\y.md"), "shared/docs/y.md");
});
test("C15 사람 컴퓨터 — 프로젝트가 안 맞거나 없으면 없음", () => {
  assert.equal(addr({ place: "node", dir: "/Users/a/ws/project/4670", projectId: 12 }, "/Users/a/ws/project/4670/x"), null);
  assert.equal(addr({ place: "node", dir: "/Users/a/ws/project/4670", projectId: null }, "/Users/a/ws/project/4670/x"), null);
  assert.equal(addr({ place: "node", dir: "/Users/a/box", projectId: 4670 }, "/Users/a/box/x"), null);
});
test("C16 .. 이 든 경로는 풀린 자리로 본다", () => {
  assert.equal(addr(C, "/work/shared/project/4670/sub/../a.md"), "shared/project/4670/a.md");
  assert.equal(addr(C, "/work/shared/project/4670/../../../etc/passwd"), null);
});

// ── D. 주소 → 세션 경로 ──────────────────────────────────────────────────────────
const path = (v: SessionView, a: string): string | null => addressToSessionPath(v, parseAddress(a)).path;
const why = (v: SessionView, a: string): string => addressToSessionPath(v, parseAddress(a)).reason ?? "";

test("D1 컨테이너 — 작업 폴더 아래", () => {
  assert.equal(path(C, "shared/project/4670/a.md"), "/work/shared/project/4670/a.md");
});
test("D2 컨테이너 — 작업 폴더 밖은 없음(file_url 안내)", () => {
  assert.equal(path(C, "shared/project/9/x"), null);
  assert.match(why(C, "shared/project/9/x"), /file_url/);
});
test("D3 컨테이너 — 작업 폴더 자신", () => {
  assert.equal(path(C, "shared/project/4670"), "/work/shared/project/4670");
});
test("D4 붙은 앱 → <작업 폴더>/.lively/apps/<앱>/…", () => {
  assert.equal(path(C, "apps/crm/out/a.png"), "/work/shared/project/4670/.lively/apps/crm/out/a.png");
  assert.equal(path(C, "apps/crm"), "/work/shared/project/4670/.lively/apps/crm");
});
test("D5 안 붙은 앱(컨테이너) → 없음", () => {
  assert.equal(path(C, "apps/other/x"), null);
  assert.match(why(C, "apps/other/x"), /붙어 있지 않습니다/);
});
test("D6 앱 자리 자신 → 없음", () => {
  assert.equal(path(C, "apps"), null);
});
test("D7 셀프호스트 — 공유는 작업 폴더 밖이어도 그 자리", () => {
  const v: SessionView = { place: "host", dir: "/srv/ws/project/1", bases: { shared: "/srv/ws", apps: "/srv/apps" } };
  assert.equal(path(v, "shared/project/9/x"), "/srv/ws/project/9/x");
});
test("D8 셀프호스트 — 안 붙은 앱도 앱 폴더 자리", () => {
  const v: SessionView = { place: "host", dir: "/srv/ws/project/1", bases: { shared: "/srv/ws", apps: "/srv/apps" } };
  assert.equal(path(v, "apps/crm/x"), "/srv/apps/crm/x");
});
test("D9 사람 컴퓨터 — 그 컴퓨터의 구분자로", () => {
  assert.equal(path({ place: "node", dir: "/Users/a/ws/project/4670", projectId: 4670 }, "shared/project/4670/x.md"), "/Users/a/ws/project/4670/x.md");
  assert.equal(path({ place: "node", dir: "C:\\u\\ws\\project\\4670", projectId: 4670 }, "shared/docs/y.md"), "C:\\u\\ws\\docs\\y.md");
});
test("D10 사람 컴퓨터 — 앱 폴더는 붙지 않는다", () => {
  assert.equal(path({ place: "node", dir: "/Users/a/ws/project/4670", projectId: 4670, attachedApps: ["crm"] }, "apps/crm/x"), null);
});
test("D11 컨테이너 — 공유 기준이 없으면 없음", () => {
  assert.equal(path({ place: "container", dir: "/home/box_me/box", bases: { personal: "/home/box_me/box" } }, "shared/x"), null);
});
