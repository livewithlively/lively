// 작업별 앱 지시(#5082) — 매니페스트 ai.instructions 를 «부른 사람의 판» 에서 읽는다. 바깥 일(앱 · 판 고르기 · 판 파일)은 가짜로 바꿔 끼운다.
//  엣지 표 행: R1~R6 · P(경로 읽기) · T(글 판정).
import assert from "node:assert/strict";
import { AI_INSTRUCTIONS_MAX_BYTES, appFileBytes, instructionsPathOf, instructionsText, readJobInstructions, type InstructionsDeps } from "./app-job-instructions.js";
import type { OrgApp } from "../org/store/apps.js";
import { HttpError } from "../http-error.js";

let pass = 0;
const t = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
  try { await fn(); } catch (e) { console.log(`not ok  ${name}`); throw e; }
  pass++;
  console.log(`ok  ${name}`);
};

const manifestWith = (file: string | null) => ({ id: "policy", ai: { jobs: [{ name: "answer" }], ...(file ? { instructions: { answer: file } } : {}) } });

/** 공개 판(판 2 — ai/answer.md 가 «공개 지시») · 초안(판 3 — «초안 지시»)이 걸린 앱. 초안을 고친 사람은 alice. */
function world(o: { draftFile?: string | null; pubFile?: string | null; files?: Record<string, { content: string; encoding?: "utf8" | "base64" } | undefined>; visibleTo?: string[]; noApp?: boolean } = {}) {
  const reads: Array<[number, string]> = [];
  const draft = { id: "policy", manifest: manifestWith(o.draftFile === undefined ? "ai/answer.md" : o.draftFile), current_version_no: 3 } as unknown as OrgApp;
  const pub = { id: "policy", manifest: manifestWith(o.pubFile === undefined ? "ai/answer.md" : o.pubFile), current_version_no: 2 } as unknown as OrgApp;
  const files = o.files ?? { "3:ai/answer.md": { content: "초안 지시" }, "2:ai/answer.md": { content: "공개 지시" } };
  const d: InstructionsDeps = {
    getApp: async () => (o.noApp ? null : draft),
    viewer: async (member) => ({ userId: member, scopes: [] }),
    viewAppFor: async (_app, who) => {
      if (o.visibleTo && !o.visibleTo.includes(who.userId)) return { view: "none", app: draft };
      return who.userId === "alice" ? { view: "installed", app: draft } : { view: "published", app: pub };
    },
    versionFile: async (_id, v, file) => { reads.push([v, file]); return files[`${v}:${file}`] ?? null; },
  };
  return { d, reads };
}
const httpErr = (status: number, re?: RegExp) => (e: unknown) => e instanceof HttpError && e.status === status && (!re || re.test(e.message));

await t("P 작업 이름의 지시 경로 — 선언한 것만 · 없거나 모양이 틀리면 null(저장된 매니페스트를 읽는 자리라 던지지 않는다)", () => {
  assert.equal(instructionsPathOf(manifestWith("ai/answer.md"), "answer"), "ai/answer.md");
  assert.equal(instructionsPathOf(manifestWith("ai/answer.md"), "other"), null);
  assert.equal(instructionsPathOf(manifestWith("ai/answer.md"), null), null);
  assert.equal(instructionsPathOf(manifestWith(null), "answer"), null);
  for (const bad of [null, {}, { ai: null }, { ai: { instructions: [] } }, { ai: { instructions: { answer: 3 } } }, { ai: { instructions: { answer: "" } } }]) {
    assert.equal(instructionsPathOf(bad, "answer"), null, JSON.stringify(bad));
  }
  assert.equal(instructionsPathOf({ ai: { instructions: {} } }, "toString"), null, "객체 원형의 이름을 지시로 읽지 않는다");
  assert.equal(instructionsPathOf({ ai: { instructions: Object.create({ answer: "ai/inherited.md" }) } }, "answer"), null, "물려받은 칸은 선언이 아니다(자기 칸만)");
});

await t("T 지시 글 — 상한 이하 UTF-8 만(넘거나 깨진 글은 null) · base64 · utf8 둘 다 바이트로", () => {
  assert.equal(instructionsText(new TextEncoder().encode("한글 지시")), "한글 지시");
  assert.equal(instructionsText(new Uint8Array(AI_INSTRUCTIONS_MAX_BYTES).fill(0x61))?.length, AI_INSTRUCTIONS_MAX_BYTES, "상한과 같으면 받는다");
  assert.equal(instructionsText(new Uint8Array(AI_INSTRUCTIONS_MAX_BYTES + 1).fill(0x61)), null, "상한을 넘으면 거절");
  assert.equal(instructionsText(Uint8Array.from([0xff, 0xfe, 0x00])), null, "UTF-8 이 아니면 거절");
  assert.deepEqual([...appFileBytes({ content: Buffer.from("가").toString("base64"), encoding: "base64" })], [...Buffer.from("가")]);
  assert.deepEqual([...appFileBytes({ content: "가" })], [...Buffer.from("가")]);
});

await t("R1 작업 이름이 없으면 아무것도 읽지 않고 null", async () => {
  const { d, reads } = world();
  assert.equal(await readJobInstructions("policy", "bob", null, d), null);
  assert.equal(await readJobInstructions("policy", "bob", "", d), null);
  assert.deepEqual(reads, []);
});

await t("R2 그 사람의 판이 지시를 선언하지 않았으면 null — 파일을 읽지 않는다(초안만 선언했으면 공개 판을 보는 사람은 null)", async () => {
  const { d, reads } = world({ pubFile: null });
  assert.equal(await readJobInstructions("policy", "bob", "answer", d), null);
  assert.deepEqual(reads, []);
  assert.equal(await readJobInstructions("policy", "alice", "answer", d), "초안 지시", "초안을 고친 사람은 초안의 선언을 본다");
});

await t("R3 어느 판 — 초안을 고친 사람은 초안 판(3)의 파일 · 나머지는 공개 판(2)의 파일(표 · 도구 선언과 같은 규칙)", async () => {
  const { d, reads } = world();
  assert.equal(await readJobInstructions("policy", "alice", "answer", d), "초안 지시");
  assert.equal(await readJobInstructions("policy", "bob", "answer", d), "공개 지시");
  assert.deepEqual(reads, [[3, "ai/answer.md"], [2, "ai/answer.md"]]);
});

await t("R4 선언했는데 그 판에 파일이 없다 — 409(지시 없이 돌리지 않는다)", async () => {
  const { d } = world({ files: {} });
  await assert.rejects(readJobInstructions("policy", "bob", "answer", d), httpErr(409, /ai\/answer\.md/));
});

await t("R5 앱이 없다 · 그 사람이 앱을 볼 수 없게 됐다 — 404", async () => {
  await assert.rejects(readJobInstructions("policy", "bob", "answer", world({ noApp: true }).d), httpErr(404));
  await assert.rejects(readJobInstructions("policy", "bob", "answer", world({ visibleTo: ["alice"] }).d), httpErr(404));
});

await t("R6 판의 파일이 상한을 넘거나 UTF-8 이 아니다 — 409", async () => {
  const big = { content: "a".repeat(AI_INSTRUCTIONS_MAX_BYTES + 1) };
  const broken = { content: Buffer.from([0xff, 0xfe]).toString("base64"), encoding: "base64" as const };
  for (const f of [big, broken]) {
    await assert.rejects(readJobInstructions("policy", "bob", "answer", world({ files: { "2:ai/answer.md": f } }).d), httpErr(409, /UTF-8/));
  }
});

console.log(`# ${pass} pass`);
