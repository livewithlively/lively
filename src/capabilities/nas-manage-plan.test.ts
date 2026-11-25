// nas_manage 입력 → 다룰 원본 경로 계획(planManage). 옛 EUC-KR 이름 바이트 보존·맨 위·자기 자신 거부·이름 검증.
// rename 이 같은 이름 대상을 말없이 덮지 않는지(renameUnlessExists)도 가짜 세션으로 본다.
// 실행: npm run build && node dist/capabilities/nas-manage-plan.test.js
import assert from "node:assert/strict";
import { planManage, renameUnlessExists } from "./nas-files.js";

let pass = 0;
const failed: string[] = [];
const t = (name: string, fn: () => void): void => {
  try { fn(); pass++; console.log(`ok  ${name}`); }
  catch (e) { failed.push(name); console.log(`FAIL ${name}\n     ${String((e as Error)?.message ?? e).split("\n").join("\n     ")}`); }
};
const p = (raw: string) => Buffer.from(raw, "latin1").toString("base64url");
const euc = Buffer.from([0xbc, 0xad, 0xb7, 0xf9]).toString("latin1"); // «서류» EUC-KR 바이트

t("받아들이는 입력 → raw·target", () => {
  const rows: Array<[string, Parameters<typeof planManage>[0], { raw: string; target: string; overwrite?: boolean }]> = [
    ["mkdir: 부모 아래 UTF-8 새 이름", { op: "mkdir", path: "/A", name: "새폴더" }, { raw: "/A", target: `/A/${Buffer.from("새폴더", "utf8").toString("latin1")}` }],
    ["mkdir: 맨 위", { op: "mkdir", path: "/", name: "x" }, { raw: "/", target: "/x" }],
    ["delete: 대상 그대로", { op: "delete", p: p("/A/f.txt") }, { raw: "/A/f.txt", target: "/A/f.txt" }],
    ["rmdir: 끝 / 무시", { op: "rmdir", path: "/A/B/" }, { raw: "/A/B", target: "/A/B" }],
    ["rename: 같은 폴더 새 이름", { op: "rename", path: "/A/f.txt", to_name: "g.txt" }, { raw: "/A/f.txt", target: "/A/g.txt", overwrite: false }],
    ["rename: overwrite 참이면 덮기 허용을 싣는다", { op: "rename", path: "/A/f.txt", to_name: "g.txt", overwrite: true }, { raw: "/A/f.txt", target: "/A/g.txt", overwrite: true }],
    ["rename: to_dir 만 → 원래 이름 바이트 그대로(EUC-KR)", { op: "rename", p: p(`/A/${euc}`), to_dir: p("/B") }, { raw: `/A/${euc}`, target: `/B/${euc}`, overwrite: false }],
    ["rename: to_dir_path + to_name", { op: "rename", path: "/A/f.txt", to_dir_path: "/C", to_name: "h.txt" }, { raw: "/A/f.txt", target: "/C/h.txt", overwrite: false }],
  ];
  for (const [label, input, want] of rows) assert.deepEqual(planManage(input), want, label);
});

t("거부하는 입력 → error", () => {
  const rows: Array<[string, Parameters<typeof planManage>[0]]> = [
    ["대상 없음", { op: "delete" }],
    ["대상에 줄바꿈", { op: "delete", path: "/A/x\r\nDELE y" }],
    ["대상에 ..", { op: "delete", path: "/A/../B" }],
    ["mkdir 이름 없음", { op: "mkdir", path: "/A" }],
    ["mkdir 이름에 /", { op: "mkdir", path: "/A", name: "b/c" }],
    ["mkdir 이름 ..", { op: "mkdir", path: "/A", name: ".." }],
    ["맨 위 지우기", { op: "rmdir", path: "/" }],
    ["맨 위 옮기기", { op: "rename", path: "/", to_name: "x" }],
    ["rename 목적지 없음", { op: "rename", path: "/A/f.txt" }],
    ["rename 같은 자리", { op: "rename", path: "/A/f.txt", to_name: "f.txt" }],
    ["rename 자기 안으로", { op: "rename", path: "/A", to_dir_path: "/A/B" }],
    ["rename 새 이름에 /", { op: "rename", path: "/A/f.txt", to_name: "x/y" }],
    ["overwrite 는 rename 에만", { op: "delete", path: "/A/f.txt", overwrite: true }],
  ];
  for (const [label, input] of rows) assert.ok("error" in planManage(input), label);
});

// 가짜 세션 — size 는 표의 값, rename 은 불린 순서를 남긴다.
const fakeOps = (sizes: Record<string, number | null>) => {
  const calls: string[] = [];
  return {
    calls,
    size: async (raw: string) => { calls.push(`SIZE ${raw}`); return sizes[raw] ?? null; },
    rename: async (from: string, to: string) => { calls.push(`RENAME ${from} ${to}`); },
  };
};

const pending: Array<Promise<void>> = [];
const ta = (name: string, fn: () => Promise<void>): void => {
  pending.push(fn().then(() => { pass++; console.log(`ok  ${name}`); }, (e) => { failed.push(name); console.log(`FAIL ${name}\n     ${String((e as Error)?.message ?? e)}`); }));
};

ta("rename: 같은 이름 대상이 있으면 옮기지 않고 그 크기를 돌려준다(overwrite 아님)", async () => {
  const ops = fakeOps({ "/A/g.txt": 7 });
  assert.deepEqual(await renameUnlessExists(ops, "/A/f.txt", "/A/g.txt", false), { kind: "exists", size: 7 });
  assert.deepEqual(ops.calls, ["SIZE /A/g.txt"], "RNFR/RNTO 를 보내지 않는다");
});
ta("rename: overwrite 참이면 같은 이름 대상을 덮고 overwritten 을 알린다", async () => {
  const ops = fakeOps({ "/A/g.txt": 7 });
  assert.deepEqual(await renameUnlessExists(ops, "/A/f.txt", "/A/g.txt", true), { kind: "renamed", overwritten: true });
  assert.deepEqual(ops.calls, ["SIZE /A/g.txt", "RENAME /A/f.txt /A/g.txt"]);
});
ta("rename: 대상이 없으면 옮긴다", async () => {
  const ops = fakeOps({});
  assert.deepEqual(await renameUnlessExists(ops, "/A/f.txt", "/A/g.txt", false), { kind: "renamed", overwritten: false });
  assert.deepEqual(ops.calls, ["SIZE /A/g.txt", "RENAME /A/f.txt /A/g.txt"]);
});

await Promise.all(pending);
console.log(`\n${pass} passed, ${failed.length} failed`);
if (failed.length) process.exitCode = 1;
