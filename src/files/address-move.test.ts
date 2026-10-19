// 옛 주소 → 지금 자리(#4822)의 판정 순서 — moved-address.pg-test 의 U·P 행 중 순수로 가를 수 있는 것. DB·FS 불요.
//  규칙: 공유 자리만 · 옛 주소를 지금 볼 수 있어야 · 옛 자리에 무엇이 있으면 그것이 이긴다 · 판정 불가면 따라가지 않는다 ·
//  닿은 자리는 다시 판정(그 사람 · 주소가 될 수 있는 자리 · 그리고 부르는 쪽이 더 건 판정 — file_path 의 «그 세션에서 보이나»).
//  순서: 판정 → 기록 → 디스크 — 기록이 없으면 디스크를 보지 않는다(A11 · 받기 주소마다 불리는 자리라서).
//  실제 판정 · 디스크 · 기록으로 끝까지 도는 것은 src/files/moved-address.pg-test.mjs 가 잰다.
//   실행: npm run build && node --test dist/files/address-move.test.js
import { strict as assert } from "node:assert";
import test from "node:test";
import { movedAddress, type AddressMoveDeps } from "./address-move.js";
import type { FileAddress } from "./address.js";
import type { MoveRecord } from "./file-move-core.js";

const S = (rel: string): FileAddress => ({ root: "shared", rel });

/** 가짜 배관 — 기록(옛 → 새) · 지금 있는 자리 · 이 사람이 못 보는 자리 · 판정 불가 자리. 부른 것을 적는다(관측 장치). */
function deps(o: { records?: Array<[string, string]>; present?: string[]; hidden?: string[]; unknown?: string[] } = {}) {
  const calls = { canRead: [] as string[], exists: [] as string[], lookup: [] as string[] };
  const d: AddressMoveDeps = {
    canRead: async (a) => { calls.canRead.push(a.rel); return !(o.hidden ?? []).includes(a.rel); },
    exists: async (a) => {
      calls.exists.push(a.rel);
      if ((o.unknown ?? []).includes(a.rel)) return null;
      return (o.present ?? []).includes(a.rel);
    },
    lookup: async (rel): Promise<MoveRecord | null> => {
      calls.lookup.push(rel);
      //  가장 긴 접두(실제 저장소 findFileMove 와 같은 규칙)
      const segs = rel.split("/");
      for (let i = segs.length; i >= 1; i--) {
        const cand = segs.slice(0, i).join("/");
        const hit = (o.records ?? []).find(([from]) => from === cand);
        if (hit) return { from: hit[0], to: hit[1] };
      }
      return null;
    },
  };
  return { d, calls };
}

test("A1 옮긴 파일의 옛 주소 → 지금 자리(U1)", async () => {
  const { d } = deps({ records: [["project/7/a.md", "project/7/b.md"]], present: ["project/7/b.md"] });
  assert.deepEqual(await movedAddress(S("project/7/a.md"), d), S("project/7/b.md"));
});

test("A2 담은 폴더를 옮겼다(접두 · U2)", async () => {
  const { d } = deps({ records: [["project/7/docs", "project/7/문서"]], present: ["project/7/문서/a.md"] });
  assert.deepEqual(await movedAddress(S("project/7/docs/a.md"), d), S("project/7/문서/a.md"));
});

test("A3 옛 자리에 지금 파일이 있으면 그것이 이긴다 — 기록이 있어도(U3 · P2)", async () => {
  const { d, calls } = deps({ records: [["a.md", "b.md"]], present: ["a.md", "b.md"] });
  assert.equal(await movedAddress(S("a.md"), d), null);
  assert.ok(calls.exists.includes("a.md"), "기록이 있으면 옛 자리를 봐야 한다(배선)");
});

test("A4 옛 주소를 이 사람이 못 보면 null — 디스크도 기록도 보지 않는다(U5 · P5)", async () => {
  const { d, calls } = deps({ records: [["locked/a.md", "open/a.md"]], present: ["open/a.md"], hidden: ["locked/a.md"] });
  assert.equal(await movedAddress(S("locked/a.md"), d), null);
  assert.deepEqual([calls.exists.length, calls.lookup.length], [0, 0], "못 보는 옛 주소는 아무것도 새지 않게 — 판정에서 멈춘다");
});

test("A5 닿은 자리를 이 사람이 못 보면 null(U6 · P3)", async () => {
  const { d } = deps({ records: [["open/a.md", "locked/a.md"]], present: ["locked/a.md"], hidden: ["locked/a.md"] });
  assert.equal(await movedAddress(S("open/a.md"), d), null);
});

test("A6 부르는 쪽이 더 건 판정(그 세션에서 보이나)에 떨어지면 null(P4) · 붙으면 지금 자리", async () => {
  const { d } = deps({ records: [["project/7/a.md", "project/8/a.md"]], present: ["project/8/a.md"] });
  const inSession = (to: FileAddress) => to.rel.startsWith("project/7/");
  assert.equal(await movedAddress(S("project/7/a.md"), d, inSession), null, "작업 폴더 밖으로 옮겨진 것은 따라가지 않는다");
  assert.deepEqual(await movedAddress(S("project/7/a.md"), d, () => true), S("project/8/a.md"), "대조군 — 판정을 안 걸면 닿는다");
});

test("A7 기록도 파일도 없으면 null(U7)", async () => {
  const { d } = deps();
  assert.equal(await movedAddress(S("nothing/a.md"), d), null);
});

test("A8 앱 폴더 · 자리 자신은 따라가지 않는다 — 판정도 묻지 않는다(U8)", async () => {
  const { d, calls } = deps({ records: [["files-app/a.md", "files-app/b.md"]], present: ["files-app/b.md"] });
  assert.equal(await movedAddress({ root: "apps", rel: "files-app/a.md" }, d), null);
  assert.equal(await movedAddress(S(""), d), null);
  assert.equal(calls.canRead.length + calls.exists.length + calls.lookup.length, 0);
});

test("A9 옛 자리를 판정할 수 없으면(자리 밖 링크 등) 따라가지 않는다 · 닿은 자리의 판정 불가는 없는 것과 같다", async () => {
  const a = deps({ records: [["a.md", "b.md"]], present: ["b.md"], unknown: ["a.md"] });
  assert.equal(await movedAddress(S("a.md"), a.d), null, "옛 자리가 판정 불가면 따라가지 않는다");
  const b = deps({ records: [["a.md", "b.md"]], unknown: ["b.md"] });
  assert.equal(await movedAddress(S("a.md"), b.d), null, "닿은 자리가 판정 불가면 거기 없는 것");
});

test("A10 기록은 디스크 이름(NFD), 주소는 NFC 로 적어도 따라간다(U9)", async () => {
  const nfc = "회의록".normalize("NFC"), nfd = "회의록".normalize("NFD");
  const { d } = deps({ records: [[`d/${nfd}.md`, "d/b.md"]], present: ["d/b.md"] });
  assert.deepEqual(await movedAddress(S(`d/${nfc}.md`), d), S("d/b.md"));
});

test("A11 ★기록이 없으면 디스크를 보지 않는다 — 받기 주소마다 불리는 자리의 비용(판정 1 · 기록 조회 · 디스크 0)", async () => {
  const { d, calls } = deps({ present: ["docs/a.md"] });
  assert.equal(await movedAddress(S("docs/a.md"), d), null);
  assert.deepEqual([calls.canRead.length, calls.exists.length], [1, 0], JSON.stringify(calls));
  assert.ok(calls.lookup.length >= 1, "기록은 물어야 한다(배선)");
});

test("A12 주소가 될 수 없는 자리(점으로 시작하는 마디)로 옮겨졌으면 따라가지 않는다 · 대조군은 따라간다", async () => {
  const hidden = deps({ records: [["x/a.md", "x/.hidden/a.md"]], present: ["x/.hidden/a.md"] });
  assert.equal(await movedAddress(S("x/a.md"), hidden.d), null);
  const shown = deps({ records: [["x/a.md", "x/shown/a.md"]], present: ["x/shown/a.md"] });
  assert.deepEqual(await movedAddress(S("x/a.md"), shown.d), S("x/shown/a.md"));
});
