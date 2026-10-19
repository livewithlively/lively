// 경로 이름 꼴(#4847) — 파일 시스템이 담을 수 없는 이름 · 웹이 다루지 않는 글자를 판정 전에 거르는 순수 검사.
//
// 사양: 제어 문자(U+0000~U+001F · U+007F)가 든 경로 · 한 이름(`/` 사이)이 상한을 넘는 경로 · 경로 전체가 상한을 넘는 경로는 틀린 꼴이다.
//  상한은 그 서버의 파일 시스템 것 — 리눅스 한 이름 255바이트 · 경로 4095바이트, 맥 한 이름 255 UTF-16 단위 · 경로 1023바이트.
//  그 밖(빈 경로 · 공백 · 한글 · 역슬래시가 든 이름 · C1 글자)은 통과한다. 거절 문장에는 받은 경로가 들어가지 않는다
//  (볼 수 있는 자리 · 없는 자리에서 같은 몸이어야 한다 — 경로가 들면 몸이 자리마다 달라진다).
//  끝단(라우트마다 같은 400 · 판정보다 먼저)은 src/terminal/browse-answers.pg-test.mjs 가 잰다.
//
// 실행: npm run build && node --test dist/terminal/path-form.test.js
import { strict as assert } from "node:assert";
import test from "node:test";

import { pathFormProblem, nameFormProblem, pathFormLimits, pathFormMessage, PATH_FORM_CODE, type PathFormLimits } from "./path-form.js";

const LINUX = pathFormLimits("linux");
const MAC = pathFormLimits("darwin");
const at = (rel: string): string => "/srv/shared/" + rel;   // 판정에 쓰는 절대경로(경로 전체 길이 행만 그 값을 본다)

test("P1 이 서버의 상한 — 리눅스(그 밖 포함)는 255바이트 · 4095바이트, 맥은 255 UTF-16 · 1023바이트", () => {
  assert.deepEqual(LINUX, { nameMax: 255, nameUnit: "utf8", pathMax: 4095 });
  assert.deepEqual(pathFormLimits("win32"), LINUX, "맥이 아니면 리눅스 상한");
  assert.deepEqual(MAC, { nameMax: 255, nameUnit: "utf16", pathMax: 1023 });
});

test("P2 통과 — 빈 경로(자리 자신) · 공백 · 한글 · 역슬래시가 든 이름 · C1 글자 · 이모지", () => {
  for (const rel of ["", "a.md", "project/12/회의록 최종.md", "a\\b\\c.md", "x\u0085y.md", "x y", "😀.png", "a/b/c/d"]) {
    assert.equal(pathFormProblem(rel, at(rel), LINUX), null, JSON.stringify(rel));
    assert.equal(pathFormProblem(rel, at(rel), MAC), null, JSON.stringify(rel));
  }
});

test("P3 제어 문자 — NUL · U+0001 · 줄바꿈 · CR · U+001F · DEL 은 어느 마디에 있어도 control", () => {
  for (const c of ["\u0000", "\u0001", "\n", "\r", "\t", "\u001f", "\u007f"]) {
    for (const rel of [`a${c}b.md`, `${c}`, `dir${c}/x.md`, `a/b/${c}`]) {
      assert.equal(pathFormProblem(rel, at(rel), LINUX), "control", JSON.stringify(rel));
      assert.equal(pathFormProblem(rel, at(rel), MAC), "control", JSON.stringify(rel));
    }
  }
});

test("P4 리눅스 한 이름 — 바이트로 잰다: ASCII 255 통과 · 256 name · 한글 85자(255B) 통과 · 86자(258B) name", () => {
  assert.equal(pathFormProblem("a".repeat(255), at("a".repeat(255)), LINUX), null);
  assert.equal(pathFormProblem("a".repeat(256), at("a".repeat(256)), LINUX), "name");
  assert.equal(pathFormProblem("가".repeat(85), at("가".repeat(85)), LINUX), null);
  assert.equal(pathFormProblem("가".repeat(86), at("가".repeat(86)), LINUX), "name");
  assert.equal(pathFormProblem(`ok/${"b".repeat(256)}/ok`, at(`ok/${"b".repeat(256)}/ok`), LINUX), "name", "가운데 마디도 잰다");
});

test("P5 맥 한 이름 — UTF-16 단위로 잰다: 한글 255자(765B) 통과 · 256자 name · 이모지 127개(254) 통과 · 128개(256) name", () => {
  assert.equal(pathFormProblem("가".repeat(255), at("x"), MAC), null);
  assert.equal(pathFormProblem("가".repeat(256), at("x"), MAC), "name");
  assert.equal(pathFormProblem("😀".repeat(127), at("x"), MAC), null);
  assert.equal(pathFormProblem("😀".repeat(128), at("x"), MAC), "name");
});

test("P6 역슬래시는 이름 안의 글자 — 길이는 '/' 사이로 잰다(두 쪽이 각각 200 이어도 한 이름 401바이트)", () => {
  const n = `${"c".repeat(200)}\\${"c".repeat(200)}`;
  assert.equal(pathFormProblem(n, at(n), LINUX), "name");
  assert.equal(pathFormProblem(`${"c".repeat(200)}/${"c".repeat(200)}`, at("x"), LINUX), null);
});

test("P7 경로 전체 — 절대경로 바이트: 정확히 상한 통과 · 상한+1 path (리눅스 · 맥)", () => {
  for (const lim of [LINUX, MAC]) {
    const abs = (n: number): string => "/" + Array.from({ length: Math.ceil(n / 201) }, () => "d".repeat(200)).join("/").slice(0, n - 1);
    assert.equal(Buffer.byteLength(abs(lim.pathMax)), lim.pathMax);
    assert.equal(pathFormProblem("x", abs(lim.pathMax), lim), null, `${lim.pathMax}`);
    assert.equal(pathFormProblem("x", abs(lim.pathMax + 1), lim), "path", `${lim.pathMax + 1}`);
  }
  //  한글은 바이트로 센다 — 맥 1023바이트는 한글 약 340자
  assert.equal(pathFormProblem("x", "/" + "가".repeat(341), MAC), "path");
});

test("P8 까닭의 순서 — 제어 문자가 길이보다 먼저 · 이름이 경로보다 먼저", () => {
  const lim: PathFormLimits = { nameMax: 10, nameUnit: "utf8", pathMax: 20 };
  assert.equal(pathFormProblem("a\u0000".repeat(30), "/" + "z".repeat(100), lim), "control");
  assert.equal(pathFormProblem("y".repeat(11), "/" + "z".repeat(100), lim), "name");
  assert.equal(pathFormProblem("y".repeat(10), "/" + "z".repeat(100), lim), "path");
});

test("P9 새 이름 하나(nameFormProblem) — 같은 규칙(제어 문자 · 길이), 경로 전체 상한은 보지 않는다", () => {
  assert.equal(nameFormProblem("새 이름.md", LINUX), null);
  assert.equal(nameFormProblem("a\u0001b", LINUX), "control");
  assert.equal(nameFormProblem("n".repeat(256), LINUX), "name");
  assert.equal(nameFormProblem("n".repeat(255), LINUX), null);
});

test("P10 거절 문장 — 까닭마다 다르고, 받은 경로를 되풀이하지 않는다 · 응답 code 는 하나", () => {
  const msgs = (["control", "name", "path"] as const).map((p) => pathFormMessage(p, LINUX));
  assert.equal(new Set(msgs).size, 3);
  for (const m of msgs) assert.ok(m.length > 0 && !m.includes("undefined"), m);
  assert.match(pathFormMessage("name", LINUX), /255바이트/);
  assert.match(pathFormMessage("name", MAC), /255자/);
  assert.match(pathFormMessage("path", MAC), /1023바이트/);
  assert.equal(PATH_FORM_CODE, "path_name_invalid");
});

test("P11 이미 있는 이름(existing) — 제어 문자 가운데 NUL 만 거른다 · 길이 상한은 그대로", () => {
  for (const rel of ["dir/Icon\r", "a\u0001b.md", "x\ny", "z\u007f"]) assert.equal(pathFormProblem(rel, at(rel), LINUX, { existing: true }), null, JSON.stringify(rel));
  assert.equal(pathFormProblem("a\u0000b", at("a"), LINUX, { existing: true }), "control");
  assert.equal(pathFormProblem("n".repeat(256), at("x"), LINUX, { existing: true }), "name");
  assert.equal(pathFormProblem("x", "/" + "d".repeat(4095), LINUX, { existing: true }), "path");
  assert.equal(pathFormProblem("a\u0001b.md", at("a"), LINUX), "control", "기본(만들기 · 열기)은 그대로 거른다");
});
