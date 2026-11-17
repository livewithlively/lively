// NAS 올리기 순서 — 같은 이름 409·임시 이름 정리·덮기·선언 바이트 대조.
// 실행: npm run build && node dist/net/nas/nas-upload.test.js
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { uploadAtomically, type UploadOps } from "./nas-upload.js";

let pass = 0;
const failed: string[] = [];
const t = (name: string, fn: () => Promise<void> | void): Promise<void> =>
  Promise.resolve().then(fn).then(
    () => { pass++; console.log(`ok  ${name}`); },
    (e) => { failed.push(name); console.log(`FAIL ${name}\n     ${String(e?.message ?? e).split("\n").join("\n     ")}`); },
  );

// 가짜 NAS — files: 이름 → 크기. stor 는 받은 바이트 수만큼 임시 파일을 만든다(또는 지정한 실패).
function fakeNas(files: Record<string, number>, fail: { stor?: "before-150" | "mid-transfer"; rename?: boolean; sizeAfter?: Record<string, number> } = {}) {
  const calls: string[] = [];
  const ops: UploadOps = {
    async size(raw) { calls.push(`SIZE ${raw}`); return raw in files ? files[raw]! : null; },
    async stor(raw, body) {
      calls.push(`STOR ${raw}`);
      if (fail.stor === "before-150") throw Object.assign(new Error("553 거절"), { code: 553 });
      let n = 0;
      for await (const c of body) n += (c as Buffer).length;
      files[raw] = n; // 150 뒤엔 서버에 파일이 생긴다
      if (fail.stor === "mid-transfer") throw new Error("데이터 연결 끊김");
      return n;
    },
    async rename(a, b) {
      calls.push(`RNTO ${a}->${b}`);
      if (fail.rename) throw new Error("rename 실패");
      files[b] = files[a]!; delete files[a];
    },
  };
  return { ops, files, calls };
}
const body = (s: string) => Readable.from([Buffer.from(s)]);

await t("같은 이름이 있고 덮기가 아니면 올리지 않고 그 크기를 돌려준다", async () => {
  const n = fakeNas({ "/d/a.txt": 7 });
  let cleaned = 0;
  const r = await uploadAtomically(n.ops, { temp: "/d/.t", target: "/d/a.txt", overwrite: false, body: body("xyz"), declared: 3 }, async () => { cleaned++; });
  assert.deepEqual(r, { kind: "exists", size: 7 });
  assert.ok(!n.calls.some((c) => c.startsWith("STOR")));
  assert.equal(cleaned, 0);
});

await t("성공하면 임시 이름으로 받아 제 이름으로 옮기고 정리는 부르지 않는다", async () => {
  const n = fakeNas({});
  let cleaned = 0;
  const r = await uploadAtomically(n.ops, { temp: "/d/.t", target: "/d/a.txt", overwrite: false, body: body("xyz"), declared: 3 }, async () => { cleaned++; });
  assert.deepEqual(r, { kind: "stored", bytes: 3, overwritten: false });
  assert.deepEqual(n.files, { "/d/a.txt": 3 });
  assert.equal(cleaned, 0);
});

await t("덮기면 기존 파일을 대신하고 overwritten 을 알린다", async () => {
  const n = fakeNas({ "/d/a.txt": 9 });
  const r = await uploadAtomically(n.ops, { temp: "/d/.t", target: "/d/a.txt", overwrite: true, body: body("xy"), declared: 2 }, async () => {});
  assert.deepEqual(r, { kind: "stored", bytes: 2, overwritten: true });
  assert.equal(n.files["/d/a.txt"], 2);
});

await t("전송 도중 끊기면 서버에 생긴 임시 파일을 정리한다", async () => {
  // 회귀: 정리 표시가 stor 성공 뒤에만 서서, 150 뒤 끊긴 반쪽 임시 파일이 NAS 에 남았다
  const n = fakeNas({}, { stor: "mid-transfer" });
  let cleaned = 0;
  await assert.rejects(uploadAtomically(n.ops, { temp: "/d/.t", target: "/d/a.txt", overwrite: false, body: body("xyz"), declared: 3 }, async () => { cleaned++; }));
  assert.equal(cleaned, 1);
});

await t("STOR 가 거절되거나 옮기기가 실패하거나 바이트가 선언과 다르면 실패하고 정리한다", async () => {
  const cases: Array<[string, Parameters<typeof fakeNas>[1], number | null]> = [
    ["150 전 거절", { stor: "before-150" }, 3],
    ["옮기기 실패", { rename: true }, 3],
    ["선언보다 짧음", {}, 10],
  ];
  for (const [label, fail, declared] of cases) {
    const n = fakeNas({}, fail);
    let cleaned = 0;
    await assert.rejects(uploadAtomically(n.ops, { temp: "/d/.t", target: "/d/a.txt", overwrite: false, body: body("xyz"), declared }, async () => { cleaned++; }), label);
    assert.equal(cleaned, 1, label);
    assert.ok(!("/d/a.txt" in n.files), `${label}: 제 이름으로 남지 않는다`);
  }
});

await t("받는 사이 같은 이름이 생기면(덮기 아님) 옮기지 않고 그 크기를 돌려주며 임시 파일을 정리한다", async () => {
  const n = fakeNas({});
  const sizeOrig = n.ops.size.bind(n.ops);
  let first = true;
  n.ops.size = async (raw) => { if (!first && raw === "/d/a.txt") return 5; first = false; return sizeOrig(raw); };
  let cleaned = 0;
  const r = await uploadAtomically(n.ops, { temp: "/d/.t", target: "/d/a.txt", overwrite: false, body: body("xyz"), declared: 3 }, async () => { cleaned++; });
  assert.deepEqual(r, { kind: "exists", size: 5 });
  assert.ok(!n.calls.some((c) => c.startsWith("RNTO")));
  assert.equal(cleaned, 1);
});

console.log(`\n${pass} passed, ${failed.length} failed`);
if (failed.length) process.exitCode = 1;
