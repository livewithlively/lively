// #1881 L1 로컬 업로드 브리지 — 순수 부분 회귀(좌표·분류·채널·링크·스텁 계약·디코드). DB/FS 불요.
//   실행: npm run build && node dist/ingest/local-file-core.test.js
import assert from "node:assert/strict";
import {
  localExternalId, parseLocalExternalId, classifyLocalPath, localChannelOf, localFileUrl, buildLocalBinaryStub,
  decodeLocalText, looksLikeText, localMimeOf, STUB_NOTE_VISION,
} from "./local-file-core.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

t("좌표: root/rel 왕복 — personal·project·shared, 역슬래시·선행 슬래시 정규화, .. 거부", () => {
  const p = localExternalId({ kind: "personal", member: "yoon" }, "uploads\\회의록\\0812.md");
  assert.equal(p, "personal:yoon/uploads/회의록/0812.md");
  assert.deepEqual(parseLocalExternalId(p), { root: { kind: "personal", member: "yoon" }, rel: "uploads/회의록/0812.md" });
  assert.equal(localExternalId({ kind: "project", id: 1881 }, "/docs/a.pdf"), "project:1881/docs/a.pdf");
  assert.deepEqual(parseLocalExternalId("project:1881/docs/a.pdf"), { root: { kind: "project", id: 1881 }, rel: "docs/a.pdf" });
  assert.deepEqual(parseLocalExternalId("shared/팀/규정.docx"), { root: { kind: "shared" }, rel: "팀/규정.docx" });
  assert.equal(parseLocalExternalId("project:x/a"), null);
  assert.equal(parseLocalExternalId("personal:/a"), null);
  assert.equal(parseLocalExternalId("shared/../etc/passwd"), null);
  assert.equal(parseLocalExternalId("nope"), null);
});

t("분류: 텍스트·OOXML(+hwpx)·vision·unreadable·skip·sniff", () => {
  assert.equal(classifyLocalPath("회의록/0812.md").kind, "text");
  assert.equal(classifyLocalPath("보고서.docx").kind, "ooxml");
  assert.equal(classifyLocalPath("계약.hwpx").kind, "ooxml");
  assert.equal(classifyLocalPath("스캔.PDF").kind, "vision");
  assert.equal(classifyLocalPath("사진.jpeg").kind, "vision");
  assert.equal(classifyLocalPath("계약.hwp").kind, "unreadable");
  assert.equal(classifyLocalPath("옛문서.doc").kind, "unreadable");
  assert.equal(classifyLocalPath("app.dmg").kind, "skip");
  assert.equal(classifyLocalPath("음성.m4a").kind, "skip");
  assert.equal(classifyLocalPath(".DS_Store").reason, "dotfile");
  assert.equal(classifyLocalPath("repo/.git/config").reason, "dotfile");
  assert.equal(classifyLocalPath("site/node_modules/x/README.md").reason, "dependency-dir");
  assert.equal(classifyLocalPath("~$보고서.docx").reason, "office-lock");
  assert.equal(classifyLocalPath("메모").kind, "sniff");
  assert.equal(classifyLocalPath("data.unknownext").kind, "sniff");
});

t("채널 = 최상위 폴더 — 개인 폴더의 uploads/ 한 겹은 벗긴다, 단일 파일은 fallback", () => {
  const personal = { kind: "personal", member: "yoon" } as const;
  assert.equal(localChannelOf(personal, "uploads/회의록/0812.md", "uploads"), "회의록");
  assert.equal(localChannelOf(personal, "uploads/0812.md", "uploads"), "uploads");
  assert.equal(localChannelOf({ kind: "project", id: 1 }, "docs/a.md", "프로젝트A"), "docs");
  assert.equal(localChannelOf({ kind: "project", id: 1 }, "a.md", "프로젝트A"), "프로젝트A");
});

t("원본 링크(#1436 root+path) — 프로젝트는 shared 루트의 project/<id>/… 로", () => {
  assert.equal(localFileUrl({ kind: "personal", member: "yoon" }, "uploads/a b.md"), "#/f?root=personal&path=uploads%2Fa%20b.md");
  assert.equal(localFileUrl({ kind: "project", id: 1881 }, "docs/a.pdf", "project/1881"), "#/f?root=shared&path=project%2F1881%2Fdocs%2Fa.pdf");
  assert.equal(localFileUrl({ kind: "project", id: 1881 }, "docs/a.pdf", null), "#/projects/1881");
  assert.equal(localFileUrl({ kind: "shared" }, "팀/규정.docx"), "#/f?root=shared&path=%ED%8C%80%2F%EA%B7%9C%EC%A0%95.docx");
});

t("[BINARY] 스텁 — gdrive 와 같은 계약(마커·filename·mime·size·url·modified) + 안내 줄", () => {
  const s = buildLocalBinaryStub({ filename: "스캔.pdf", mime: "application/pdf", size: 1234, url: "#/f?root=personal&path=x", modified: "2026-08-25T00:00:00.000Z", note: STUB_NOTE_VISION });
  const [head, note] = s.split("\n");
  assert.ok(head.startsWith("[BINARY] filename=스캔.pdf "));
  assert.ok(head.includes(" mime=application/pdf "));
  assert.ok(head.includes(" size=1234 "));
  assert.ok(head.includes(" url=#/f?root=personal&path=x "));
  assert.ok(head.endsWith("modified=2026-08-25T00:00:00.000Z"));
  assert.ok(note.includes("source_artifact(source_id)"));
  assert.equal(localMimeOf("계약.HWP"), "application/x-hwp");
  assert.equal(localMimeOf("x.bin"), "application/octet-stream");
});

t("텍스트 디코드 — UTF-8 BOM 제거·UTF-16LE BOM·EUC-KR 폴백(윈도 메모장)", () => {
  assert.equal(decodeLocalText(Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from("안녕")])), "안녕");
  const u16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("안녕", "utf16le")]);
  assert.equal(decodeLocalText(u16), "안녕");
  const euckr = Buffer.from([0xc7, 0xd1, 0xb1, 0xdb]);   // "한글" EUC-KR
  const out = decodeLocalText(euckr);
  assert.ok(out === "한글" || out.includes("�"), out);   // ICU 있는 빌드면 정확히 "한글"
  assert.equal(decodeLocalText(Buffer.from("plain")), "plain");
});

t("sniff — NUL 바이트면 바이너리, 읽히면 텍스트", () => {
  assert.equal(looksLikeText(Buffer.from("메모 내용\n두 줄")), true);
  assert.equal(looksLikeText(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00])), false);
  assert.equal(looksLikeText(Buffer.alloc(0)), false);
});

console.log(`\n${pass} passed (local-file-core: 좌표·분류·채널·링크·스텁·디코드)`);
