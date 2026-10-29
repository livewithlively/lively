// 작업별 앱 지시(#5082) — 매니페스트 ai.instructions 를 «부른 사람(주소)의 판» 에서 읽는다.
//  판 고르기는 진짜 규칙(visibility.appViewFor · app-view.asPublished)으로 하고, 판 행 읽기만 가짜로 바꿔 끼운다(격리 리뷰 N10 — 가짜가 규칙을 흉내 내지 않게).
//  엣지 표 행: P(경로 읽기) · D(선언 여부) · T(글 판정) · R1~R9.
import assert from "node:assert/strict";
import { AI_INSTRUCTIONS_MAX_BYTES, appFileBytes, declaresAiInstructions, instructionsPathOf, instructionsText, resolveJobInstructions, type InstructionsDeps } from "./app-job-instructions.js";
import { appViewFor, type Viewer } from "./visibility.js";
import { asPublished } from "./app-view.js";
import type { OrgApp } from "../org/store/apps.js";
import { HttpError } from "../http-error.js";

let pass = 0;
const t = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
  try { await fn(); } catch (e) { console.log(`not ok  ${name}`); throw e; }
  pass++;
  console.log(`ok  ${name}`);
};

const manifestWith = (file: string | null) => ({ id: "policy", title: "정책", ai: { jobs: [{ name: "answer" }], ...(file ? { instructions: { answer: file } } : {}) } });

/**
 * 공개 앱 «policy» — 공개 판 2(ai/answer.md = «공개 지시») · alice 가 고친 초안 = 설치된 상태 3(«초안 지시»).
 *  판 행: 2 · 3 이 각자의 내용 해시와 파일을 가진다. 설치된 상태의 해시는 판 3 과 같다(o.installedHash 로 어긋나게 할 수 있다).
 */
function world(o: {
  draftFile?: string | null; pubFile?: string | null; installedHash?: string | null; currentNo?: number | null; visibility?: "all" | "me"; noDraft?: boolean;
  files?: Record<string, { content: string; encoding?: "utf8" | "base64" } | undefined>;
} = {}) {
  const reads: Array<[number, string]> = [];
  let views = 0;
  const heads: Record<number, { manifest: unknown; content_hash: string }> = {
    2: { manifest: manifestWith(o.pubFile === undefined ? "ai/answer.md" : o.pubFile), content_hash: "h2" },
    3: { manifest: manifestWith(o.draftFile === undefined ? "ai/answer.md" : o.draftFile), content_hash: "h3" },
  };
  const app = {
    id: "policy", title: "정책", version: "0.3.0", manifest: heads[3]!.manifest, content_hash: o.installedHash === undefined ? "h3" : o.installedHash,
    current_version_no: o.currentNo === undefined ? 3 : o.currentNo, visibility: o.visibility ?? "all", owner_member: "owner",
    draft_by: o.noDraft ? null : "alice", published_version_no: o.noDraft ? null : 2, source: { kind: "inline" }, installed_at: new Date(0),
  } as unknown as OrgApp;
  const files = o.files ?? { "3:ai/answer.md": { content: "초안 지시" }, "2:ai/answer.md": { content: "공개 지시" } };
  const d: InstructionsDeps = {
    viewAppFor: async (a, who) => {
      views++;
      const view = appViewFor(a, who);
      if (view !== "published") return { view, app: a };
      const h = heads[a.published_version_no as number]!;
      return { view, app: asPublished(a, { version_no: a.published_version_no as number, version: "0.2.0", manifest: h.manifest, content_hash: h.content_hash }) };
    },
    versionFile: async (_id, v, file) => {
      reads.push([v, file]);
      const h = heads[v];
      return h ? { contentHash: h.content_hash, file: files[`${v}:${file}`] ?? null } : null;
    },
  };
  return { app, d, reads, views: () => views };
}
const who = (userId: string, address?: "pub" | "draft"): Viewer => ({ userId, scopes: [], ...(address ? { address } : {}) });
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

await t("D 지시 파일을 하나라도 선언했나 — 판 묶음을 남겨야 하는 앱인가", () => {
  assert.equal(declaresAiInstructions(manifestWith("ai/answer.md")), true);
  for (const no of [manifestWith(null), null, {}, { ai: { instructions: {} } }, { ai: { instructions: { a: "" } } }, { ai: { instructions: { a: 3 } } }, { ai: { instructions: ["x"] } }]) {
    assert.equal(declaresAiInstructions(no), false, JSON.stringify(no));
  }
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
  const { app, d, reads, views } = world();
  assert.equal(await resolveJobInstructions(app, who("bob"), null, d), null);
  assert.equal(await resolveJobInstructions(app, who("bob"), "", d), null);
  assert.deepEqual(reads, []); assert.equal(views(), 0);
});

await t("R2 어느 판 — 초안을 고친 사람은 초안(3) · 나머지는 공개 판(2) · 앱 주소면 그 주소의 판(초안을 고친 사람도 공개 주소면 공개 판 · 격리 리뷰 B1)", async () => {
  const { app, d, reads } = world();
  assert.equal(await resolveJobInstructions(app, who("alice"), "answer", d), "초안 지시");
  assert.equal(await resolveJobInstructions(app, who("bob"), "answer", d), "공개 지시");
  assert.equal(await resolveJobInstructions(app, who("alice", "pub"), "answer", d), "공개 지시", "공개 주소 · 공개 판 서버는 공개 판의 지시");
  assert.equal(await resolveJobInstructions(app, who("alice", "draft"), "answer", d), "초안 지시");
  assert.equal(await resolveJobInstructions(app, who("bob", "pub"), "answer", d), "공개 지시");
  assert.deepEqual(reads, [[3, "ai/answer.md"], [2, "ai/answer.md"], [2, "ai/answer.md"], [3, "ai/answer.md"], [2, "ai/answer.md"]]);
  await assert.rejects(resolveJobInstructions(app, who("bob", "draft"), "answer", d), httpErr(404), "남의 초안 주소는 없는 판");
});

await t("R3 그 사람의 판이 선언하지 않았으면 null — 파일을 읽지 않는다(초안만 선언했으면 공개 판을 보는 사람은 null · 공개 판만 선언했으면 초안을 고친 사람은 null)", async () => {
  const a = world({ pubFile: null });
  assert.equal(await resolveJobInstructions(a.app, who("bob"), "answer", a.d), null);
  assert.equal(await resolveJobInstructions(a.app, who("alice", "pub"), "answer", a.d), null);
  assert.deepEqual(a.reads, []);
  assert.equal(await resolveJobInstructions(a.app, who("alice"), "answer", a.d), "초안 지시");
  const b = world({ draftFile: null });
  assert.equal(await resolveJobInstructions(b.app, who("bob"), "answer", b.d), "공개 지시", "설치된 매니페스트가 선언하지 않아도 공개 판은 본다");
  assert.equal(await resolveJobInstructions(b.app, who("alice"), "answer", b.d), null);
});

await t("R4 선언이 어디에도 있을 수 없는 앱 — 판을 고르지도 읽지도 않는다(설치된 매니페스트가 선언하지 않았고 따로 볼 공개 판도 없다 · 격리 리뷰 N5)", async () => {
  const { app, d, reads, views } = world({ draftFile: null, noDraft: true });
  assert.equal(await resolveJobInstructions(app, who("bob"), "answer", d), null);
  assert.equal(await resolveJobInstructions(app, who("bob"), "other", d), null);
  assert.deepEqual(reads, []); assert.equal(views(), 0);
});

await t("R5 설치된 상태가 판 행과 맞지 않는다(내용 해시 · 판 번호 없음 · 판 행 없음) — 409(옛 판의 지시를 말없이 싣지 않는다 · 격리 리뷰 N3)", async () => {
  for (const o of [{ installedHash: "h-other" }, { installedHash: null }, { currentNo: null }, { currentNo: 9 }]) {
    const { app, d } = world(o);
    await assert.rejects(resolveJobInstructions(app, who("alice"), "answer", d), httpErr(409, /판이 없습니다/), JSON.stringify(o));
  }
  //  공개 판을 보는 사람은 공개 판 행 그대로라 영향이 없다.
  const { app, d } = world({ installedHash: "h-other" });
  assert.equal(await resolveJobInstructions(app, who("bob"), "answer", d), "공개 지시");
});

await t("R6 선언했는데 그 판에 파일이 없다 — 409(지시 없이 돌리지 않는다)", async () => {
  const { app, d } = world({ files: {} });
  await assert.rejects(resolveJobInstructions(app, who("bob"), "answer", d), httpErr(409, /ai\/answer\.md/));
});

await t("R7 앱을 볼 수 없다 — 404(나만 보는 앱 · 남)", async () => {
  const { app, d } = world({ visibility: "me", noDraft: true });
  await assert.rejects(resolveJobInstructions(app, who("bob"), "answer", d), httpErr(404));
  assert.equal(await resolveJobInstructions(app, who("owner"), "answer", d), "초안 지시", "책임자는 설치된 상태");
});

await t("R8 판의 파일이 상한을 넘거나 UTF-8 이 아니다 — 409", async () => {
  const big = { content: "a".repeat(AI_INSTRUCTIONS_MAX_BYTES + 1) };
  const broken = { content: Buffer.from([0xff, 0xfe]).toString("base64"), encoding: "base64" as const };
  for (const f of [big, broken]) {
    const { app, d } = world({ files: { "2:ai/answer.md": f } });
    await assert.rejects(resolveJobInstructions(app, who("bob"), "answer", d), httpErr(409, /UTF-8/));
  }
});

await t("R9 판의 파일이 비었거나 빈칸뿐이다 — 409(«지시를 실었다» 가 아니다 · 격리 리뷰 N1)", async () => {
  for (const content of ["", "   \n\t\n"]) {
    const { app, d } = world({ files: { "2:ai/answer.md": { content } } });
    await assert.rejects(resolveJobInstructions(app, who("bob"), "answer", d), httpErr(409, /비어 있습니다/), JSON.stringify(content));
  }
});

console.log(`# ${pass} pass`);
