// 이름 바꾸기·옮기기의 자료 행 값(#4688) — 사양 표 M1~M11. DB·FS 불요(값 계산만 — 옮겨 적기·비켜 두기·SQL 본문 고치기는 file-move.pg-test).
//  사양: 같은 자료 번호 그대로 좌표가 담긴 칸만 새 자리를 말한다 — 좌표 · 링크 · 이름(파일 이름이었으면) · 경로 · 채널(맨 위 폴더) · 확장자 ·
//  바이너리 안내문의 이름·종류·주소 · 긴 본문 꼬리의 주소. 텍스트 본문(파일 내용)과 그 밖의 칸은 그대로.
//   실행: npm run build && node --test dist/ingest/local-file-move.test.js
import { strict as assert } from "node:assert";
import test from "node:test";
import { movedLocalRow, applyBodyEdits, type LocalMove, type LocalRowForMove } from "./local-file-core.js";

const P12 = { kind: "project" as const, id: 12 };
const projMove = (fromRel: string, toRel: string): LocalMove => ({ root: P12, fromRel, toRel, folder: "project/12", channelFallback: "주간 보고" });
const projRow = (rel: string, over: Partial<LocalRowForMove> = {}): LocalRowForMove => ({
  external_id: `project:12/${rel}`,
  external_url: `#/f?root=shared&path=${encodeURIComponent(`project/12/${rel}`)}`,
  title: rel.split("/").pop()!,
  fields: {
    path: rel, root: "project", ext: rel.split(".").pop(), bytes: 15, extracted: true, local_kind: "text", project_name: "주간 보고",
    entry: "upload", container_ref: "project:12", container_name: rel.includes("/") ? rel.split("/")[0] : "주간 보고",
    author_external_id: "m1", author_name: "m1@x", _item_type: "note",
  },
  ...over,
});
/** DB 가 옮길 행에서 읽어 주는 본문의 두 자리 — BODY_HEAD_SQL · BODY_TAIL_SQL 과 같은 규칙(그 꼴이 아니면 없음). */
const ends = (body: string): Pick<LocalRowForMove, "body_head" | "body_tail"> => ({
  body_head: body.startsWith("[BINARY] ") ? body.slice(0, 8000).split("\n")[0] : null,
  body_tail: body.endsWith("]") && body.slice(-4000).includes(" — 전문은 ") ? body.slice(-4000) : null,
});
/** 본문을 가진 행을 옮긴 뒤의 본문 */
const movedBody = (rel: string, body: string, m: LocalMove): string => {
  const r = movedLocalRow(projRow(rel, ends(body)), m);
  assert.ok(r, "옮긴 자리 안의 행인데 null");
  return applyBodyEdits(body, r);
};

test("M1 프로젝트 파일 이름 바꾸기 — 좌표·링크·이름·경로가 새 자리, 채널·그 밖의 칸(들어온 길·올린 사람·크기·프로젝트 이름)은 그대로", () => {
  const r = movedLocalRow(projRow("docs/a.md"), projMove("docs/a.md", "docs/b.md"));
  assert.ok(r);
  assert.equal(r.external_id, "project:12/docs/b.md");
  assert.equal(r.external_url, "#/f?root=shared&path=project%2F12%2Fdocs%2Fb.md");
  assert.equal(r.title, "b.md");
  assert.equal(r.fields.path, "docs/b.md");
  assert.equal(r.fields.container_name, "docs");
  assert.equal(r.fields.ext, "md");
  for (const k of ["entry", "author_external_id", "author_name", "bytes", "project_name", "container_ref", "root", "local_kind", "_item_type"]) {
    assert.deepEqual(r.fields[k], projRow("docs/a.md").fields![k], `fields.${k} 가 바뀌었다`);
  }
  assert.equal(movedBody("docs/a.md", "안녕하세요", projMove("docs/a.md", "docs/b.md")), "안녕하세요", "텍스트 본문(파일 내용)은 그대로여야 한다");
});

test("M2 맨 위 폴더 이름 바꾸기 — 하위 자료의 좌표·경로가 따라가고 채널이 새 폴더 이름, 제목(파일 이름)은 그대로", () => {
  const r = movedLocalRow(projRow("docs/sub/a.md"), projMove("docs", "notes"));
  assert.ok(r);
  assert.equal(r.external_id, "project:12/notes/sub/a.md");
  assert.equal(r.fields.path, "notes/sub/a.md");
  assert.equal(r.fields.container_name, "notes");
  assert.equal(r.title, "a.md");
  assert.equal(r.external_url, "#/f?root=shared&path=project%2F12%2Fnotes%2Fsub%2Fa.md");
});

test("M3 맨 위로 옮기면 채널은 대체값(업로드 때와 같은 값 — 프로젝트 이름)", () => {
  const r = movedLocalRow(projRow("docs/a.md"), projMove("docs/a.md", "a.md"));
  assert.ok(r);
  assert.equal(r.fields.container_name, "주간 보고");
  assert.equal(r.external_id, "project:12/a.md");
});

test("M4 개인 폴더 — uploads/ 한 겹은 채널에서 벗기고, 링크는 root=personal", () => {
  const row: LocalRowForMove = {
    external_id: "personal:m1/uploads/x/a.md", external_url: "#/f?root=personal&path=uploads%2Fx%2Fa.md", title: "a.md",
    fields: { path: "uploads/x/a.md", root: "personal", ext: "md", container_ref: "personal:m1", container_name: "x" },
  };
  const r = movedLocalRow(row, { root: { kind: "personal", member: "m1" }, fromRel: "uploads/x", toRel: "uploads/y", channelFallback: "uploads" });
  assert.ok(r);
  assert.equal(r.external_id, "personal:m1/uploads/y/a.md");
  assert.equal(r.external_url, "#/f?root=personal&path=uploads%2Fy%2Fa.md");
  assert.equal(r.fields.container_name, "y");
});

test("M5 바이너리 안내문 + 확장자 바뀜(png→jpg) — 머리 줄의 이름·종류·주소가 새 값, size·modified·안내 줄은 그대로", () => {
  const note = "바이너리 파일(내용 미추출). 볼 가치가 있으면 source_artifact(source_id)로 원본을 받아 판단하세요.";
  const body = `[BINARY] filename=pic.png mime=image/png size=10 url=#/f?root=shared&path=project%2F12%2Fpic.png modified=2026-10-01T00:00:00.000Z\n${note}`;
  assert.equal(movedBody("pic.png", body, projMove("pic.png", "pic.jpg")),
    `[BINARY] filename=pic.jpg mime=image/jpeg size=10 url=#/f?root=shared&path=project%2F12%2Fpic.jpg modified=2026-10-01T00:00:00.000Z\n${note}`);
  assert.equal(movedLocalRow(projRow("pic.png", ends(body)), projMove("pic.png", "pic.jpg"))?.fields.ext, "jpg");
  //  modified 가 없는 안내문(올린 시각을 못 읽은 경우)도 같은 꼴로.
  assert.equal(movedBody("pic.png", "[BINARY] filename=pic.png mime=image/png size=10 url=#/f?root=shared&path=project%2F12%2Fpic.png\nx", projMove("pic.png", "그림.png")),
    `[BINARY] filename=그림.png mime=image/png size=10 url=#/f?root=shared&path=${encodeURIComponent("project/12/그림.png")}\nx`);
});

test("M6 긴 본문 — 꼬리의 «전문은 <주소>» 만 새 주소, 본문 중간에 사람이 적은 옛 주소는 그대로", () => {
  const old = "#/f?root=shared&path=project%2F12%2Fa.md";
  const body = `메모: 이 문서 링크는 ${old} 입니다.\n\n[… 본문이 길어 앞 1,000,000자까지만 실었습니다 — 전문은 ${old}]`;
  assert.equal(movedBody("a.md", body, projMove("a.md", "b.md")),
    `메모: 이 문서 링크는 ${old} 입니다.\n\n[… 본문이 길어 앞 1,000,000자까지만 실었습니다 — 전문은 #/f?root=shared&path=project%2F12%2Fb.md]`);
});

test("M7 옮긴 자리 밖의 행은 null — 이름이 겹치는 형제(docs vs docs2) · 다른 루트(다른 프로젝트)", () => {
  assert.equal(movedLocalRow(projRow("docs2/a.md"), projMove("docs", "notes")), null);
  assert.equal(movedLocalRow({ ...projRow("docs/a.md"), external_id: "project:13/docs/a.md" }, projMove("docs", "notes")), null);
  assert.equal(movedLocalRow({ ...projRow("docs/a.md"), external_id: "shared/project/12/docs/a.md" }, projMove("docs", "notes")), null);
});

test("M8 제목이 파일 이름이 아니면(가려 적힘) 그대로 · 제목이 없으면 없음", () => {
  assert.equal(movedLocalRow(projRow("a.md", { title: "[가려짐]" }), projMove("a.md", "b.md"))?.title, "[가려짐]");
  assert.equal(movedLocalRow(projRow("a.md", { title: null }), projMove("a.md", "b.md"))?.title, null);
});

test("M9 공유 루트(프로젝트 밖) — 링크는 root=shared 에 새 경로", () => {
  const row: LocalRowForMove = {
    external_id: "shared/팀/a.md", external_url: `#/f?root=shared&path=${encodeURIComponent("팀/a.md")}`, title: "a.md",
    fields: { path: "팀/a.md", root: "shared", ext: "md", container_ref: "shared", container_name: "팀" },
  };
  const r = movedLocalRow(row, { root: { kind: "shared" }, fromRel: "팀", toRel: "팀2", channelFallback: "shared" });
  assert.ok(r);
  assert.equal(r.external_id, "shared/팀2/a.md");
  assert.equal(r.external_url, `#/f?root=shared&path=${encodeURIComponent("팀2/a.md")}`);
  assert.equal(r.fields.container_name, "팀2");
});

test("M10 안내문 머리의 이름이 파일 이름과 다르거나(가려 적힘) 종류가 확장자 값이 아니면 그대로 — 주소만 새 값", () => {
  const body = "[BINARY] filename=[가려짐] mime=application/x-custom size=3 url=#/f?root=shared&path=project%2F12%2Fa.bin\nx";
  assert.equal(movedBody("a.bin", body, projMove("a.bin", "b.png")),
    "[BINARY] filename=[가려짐] mime=application/x-custom size=3 url=#/f?root=shared&path=project%2F12%2Fb.png\nx");
});

test("M11 본문 고치기는 그 자리가 글자 그대로 같을 때만 — 그새 본문이 바뀌었으면(머리·꼬리가 다르면) 손대지 않는다", () => {
  const body = "[BINARY] filename=pic.png mime=image/png size=10 url=#/f?root=shared&path=project%2F12%2Fpic.png\nx";
  const r = movedLocalRow(projRow("pic.png", ends(body)), projMove("pic.png", "pic.jpg"));
  assert.ok(r?.head, "안내문인데 머리 줄 고치기가 없다");
  assert.equal(applyBodyEdits("다른 글로 바뀐 본문\n…", r), "다른 글로 바뀐 본문\n…");
  //  본문을 넘기지 않았으면(안내문도 긴 꼬리도 아닌 행) 고칠 것이 없다.
  const plain = movedLocalRow(projRow("a.md"), projMove("a.md", "b.md"));
  assert.equal(plain?.head, null);
  assert.equal(plain?.tail, null);
});
