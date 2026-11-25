// vsftpd LIST 파싱·이름 디코드·경로 안전성·PASV 포트·경로 토큰 왕복의 사양 검증(순수 함수).
// 실행: npm run build && node dist/net/ftp/ftp-list.test.js
import assert from "node:assert/strict";
import {
  parseListLine, parseListing, displayName, displayPath, isSafeRawPath, parsePasvPort, encodeRawPath, decodeRawPath,
  rawOfDisplayPath, childRawPath, parentRawPath,
} from "./ftp-list.js";

let pass = 0;
const failed: string[] = [];
const t = (name: string, fn: () => Promise<void> | void): Promise<void> =>
  Promise.resolve().then(fn).then(
    () => { pass++; console.log(`ok  ${name}`); },
    (e) => { failed.push(name); console.log(`FAIL ${name}\n     ${String(e?.message ?? e).split("\n").join("\n     ")}`); },
  );

const latin1 = (b: Buffer | number[]): string => Buffer.from(b as any).toString("latin1");
const utf8Raw = (s: string): string => Buffer.from(s, "utf8").toString("latin1");
const EUCKR_MUNSEO = latin1([0xb9, 0xae, 0xbc, 0xad]); // "문서" in EUC-KR
const EUCKR_HANGUL = latin1([0xc7, 0xd1, 0xb1, 0xdb]); // "한글" in EUC-KR
const NOW = new Date("2026-06-15T12:00:00Z");

await t("parseListLine: 종류 문자별 type (d→dir, -→file, l→link, 그 밖→other)", () => {
  const cases: [string, string][] = [["d", "dir"], ["-", "file"], ["l", "link"], ["p", "other"], ["c", "other"]];
  for (const [ch, type] of cases) {
    const e = parseListLine(`${ch}rwxr-xr-x    1 1000     1000         4096 Jan 05  2024 x`, NOW);
    assert.equal(e?.type, type, `type for ${ch}`);
  }
});

await t("parseListLine: 크기·이름·연도형 mtime 을 읽는다", () => {
  const e = parseListLine("-rw-r--r--    1 1000     1000         1234 Jan 05  2024 report.pdf", NOW);
  assert.deepEqual(e, { type: "file", name: "report.pdf", size: 1234, mtime: "2024-01-05" });
});

await t("parseListLine: 공백을 포함한 이름은 끝까지 이름이다", () => {
  const e = parseListLine("-rw-r--r--    1 1000     1000           10 Jan 05  2024 my  file name.txt", NOW);
  assert.equal(e?.name, "my  file name.txt");
});

await t("parseListLine: 링크는 ' -> 대상' 을 떼고 이름만", () => {
  const e = parseListLine("lrwxrwxrwx    1 1000     1000            9 Jan 05  2024 cur link -> target dir", NOW);
  assert.equal(e?.type, "link");
  assert.equal(e?.name, "cur link");
});

await t("parseListLine: 줄 끝 \\r 무시", () => {
  const e = parseListLine("-rw-r--r--    1 1000     1000           10 Jan 05  2024 a.txt\r", NOW);
  assert.equal(e?.name, "a.txt");
});

await t("parseListLine: 못 읽는 줄·이름이 . / .. 인 줄은 null", () => {
  const lines = [
    "total 12",
    "",
    "garbage line",
    "drwxr-xr-x    2 1000     1000         4096 Jan 05  2024 .",
    "drwxr-xr-x    2 1000     1000         4096 Jan 05  2024 ..",
  ];
  for (const l of lines) assert.equal(parseListLine(l, NOW), null, JSON.stringify(l));
});

await t("parseListLine: 시각형 mtime 은 now(UTC) 연도, 하루 넘게 미래면 전년도", () => {
  const cases: [string, Date, string][] = [
    ["Mar 03 10:20", NOW, "2026-03-03 10:20"],
    // now 와 같은 날 조금 뒤 시각 — 하루 넘게 미래 아님
    ["Jun 15 18:00", NOW, "2026-06-15 18:00"],
    // 한참 미래 → 전년도
    ["Dec 25 09:05", NOW, "2025-12-25 09:05"],
    // UTC 연초 경계: now 가 UTC 로 2027-01-01 이면 연도 2027 기준, 12월 날짜는 전년도
    ["Dec 31 23:00", new Date("2027-01-01T00:30:00Z"), "2026-12-31 23:00"],
    ["Jan 01 00:10", new Date("2027-01-01T00:30:00Z"), "2027-01-01 00:10"],
  ];
  for (const [stamp, now, want] of cases) {
    const e = parseListLine(`-rw-r--r--    1 1000     1000           10 ${stamp} a.txt`, now);
    assert.equal(e?.mtime, want, stamp);
  }
});

await t("parseListing: CRLF/LF 섞인 본문에서 읽히는 항목만", () => {
  const body = [
    "total 3",
    "drwxr-xr-x    2 1000     1000         4096 Jan 05  2024 .",
    "drwxr-xr-x    2 1000     1000         4096 Jan 05  2024 docs",
    "-rw-r--r--    1 1000     1000           10 Jan 05  2024 a.txt",
  ].join("\r\n") + "\n-rw-r--r--    1 1000     1000           20 Feb 06  2023 b.txt\n";
  const names = parseListing(body, NOW).map((e) => e.name);
  assert.deepEqual(names, ["docs", "a.txt", "b.txt"]);
});

await t("displayName: UTF-8 바이트면 UTF-8, 아니면 EUC-KR, 결과는 NFC", () => {
  const cases: [string, string][] = [
    ["plain.txt", "plain.txt"],
    [utf8Raw("한글.txt"), "한글.txt"],
    [EUCKR_HANGUL + ".txt", "한글.txt"],
    [utf8Raw("한글".normalize("NFD")), "한글"],
  ];
  for (const [raw, want] of cases) {
    const got = displayName(raw);
    assert.equal(got, want, JSON.stringify(raw));
    assert.equal(got, got.normalize("NFC"));
  }
});

await t("displayPath: 마디마다 따로 디코드(UTF-8·EUC-KR 혼재)", () => {
  assert.equal(displayPath(`/${utf8Raw("문서")}/${EUCKR_HANGUL}.txt`), "/문서/한글.txt");
  assert.equal(displayPath(`/${EUCKR_MUNSEO}/${utf8Raw("한글")}`), "/문서/한글");
});

await t("isSafeRawPath: / 시작·CR/LF/NUL 거부·정확히 .. 인 마디만 거부", () => {
  const cases: [string, boolean][] = [
    ["/", true],
    ["/a/b.txt", true],
    ["/a/..b", true],
    ["/a/b..", true],
    [`/${EUCKR_MUNSEO}`, true],
    ["a/b", false],
    ["", false],
    ["/a\rb", false],
    ["/a\nb", false],
    ["/a\0b", false],
    ["/..", false],
    ["/a/../b", false],
    ["/a/..", false],
  ];
  for (const [raw, want] of cases) assert.equal(isSafeRawPath(raw), want, JSON.stringify(raw));
});

await t("parsePasvPort: p1*256+p2, 255 초과·형식 없음은 null", () => {
  const cases: [string, number | null][] = [
    ["227 Entering Passive Mode (192,168,1,2,19,137)", 19 * 256 + 137],
    ["227 Entering Passive Mode (10,9,9,9,0,21).", 21],
    ["227 Entering Passive Mode (192,168,1,2,256,1)", null],
    ["227 Entering Passive Mode (192,168,1,2,1,300)", null],
    ["227 Entering Passive Mode (300,168,1,2,1,1)", null],
    ["227 Entering Passive Mode", null],
    ["227 (1,2,3,4,5)", null],
  ];
  for (const [text, want] of cases) assert.equal(parsePasvPort(text), want, text);
});

await t("encodeRawPath/decodeRawPath: 원본 바이트 왕복, 토큰은 base64url 문자만", () => {
  const all = latin1(Array.from({ length: 256 }, (_, i) => i));
  for (const raw of ["/", `/${EUCKR_MUNSEO}/${utf8Raw("한글")}.txt`, "/" + all]) {
    const tok = encodeRawPath(raw);
    assert.match(tok, /^[A-Za-z0-9_-]+$/);
    assert.equal(decodeRawPath(tok), raw);
  }
});

await t("decodeRawPath: 빈 문자열·base64url 밖 문자 섞이면 null", () => {
  for (const tok of ["", "ab+c", "ab/c", "ab c", "ab!c", "한글"]) assert.equal(decodeRawPath(tok), null, JSON.stringify(tok));
});

await t("rawOfDisplayPath: UTF-8 바이트를 latin1 로, 앞뒤 공백 제거, 빈 값은 /, / 없으면 붙인다", () => {
  const cases: [string, string][] = [
    ["/문서/한글.txt", utf8Raw("/문서/한글.txt")],
    ["/a/b.txt", "/a/b.txt"],
    ["  /a b  ", "/a b"],
    ["a/b", "/a/b"],
    ["", "/"],
    ["   ", "/"],
  ];
  for (const [input, want] of cases) assert.equal(rawOfDisplayPath(input), want, JSON.stringify(input));
});

await t("childRawPath: 부모 아래 UTF-8(NFC) 이름 하나 — 부모가 / 면 /이름, 끝 / 는 하나로, 부모 원본 바이트는 그대로", () => {
  const cases: [string, string, string][] = [
    ["/", "a.txt", "/a.txt"],
    ["/x", "a.txt", "/x/a.txt"],
    ["/x/", "a.txt", "/x/a.txt"],
    ["/x", "한글", `/x/${utf8Raw("한글")}`],
    ["/x", "한글".normalize("NFD"), `/x/${utf8Raw("한글")}`],
    [`/${EUCKR_MUNSEO}`, "한글.txt", `/${EUCKR_MUNSEO}/${utf8Raw("한글.txt")}`],
    ["/x", "a".repeat(255), `/x/${"a".repeat(255)}`],
    ["/x", "가".repeat(85), `/x/${utf8Raw("가".repeat(85))}`], // 255 바이트
  ];
  for (const [parent, name, want] of cases) assert.equal(childRawPath(parent, name), want, `${JSON.stringify(parent)} + ${JSON.stringify(name)}`);
});

await t("childRawPath: 이름이 비거나 . / .. 이거나 / CR LF NUL 포함·255바이트 초과, 부모가 안전하지 않으면 null", () => {
  const cases: [string, string][] = [
    ["/x", ""],
    ["/x", "."],
    ["/x", ".."],
    ["/x", "a/b"],
    ["/x", "a\rb"],
    ["/x", "a\nb"],
    ["/x", "a\0b"],
    ["/x", "a".repeat(256)],
    ["/x", "가".repeat(86)], // 258 바이트
    ["x", "a"],
    ["", "a"],
    ["/x\ry", "a"],
    ["/x\ny", "a"],
    ["/x\0y", "a"],
    ["/x/..", "a"],
    ["/../x", "a"],
  ];
  for (const [parent, name] of cases) assert.equal(childRawPath(parent, name), null, `${JSON.stringify(parent)} + ${JSON.stringify(name)}`);
});

await t("parentRawPath: 부모 원본 경로, 맨 위 바로 아래·/ 는 /, 끝 / 무시", () => {
  const cases: [string, string][] = [
    ["/", "/"],
    ["/a", "/"],
    ["/a/", "/"],
    ["/a/b", "/a"],
    ["/a/b/", "/a"],
    ["/a/b/c.txt", "/a/b"],
    [`/${EUCKR_MUNSEO}/x`, `/${EUCKR_MUNSEO}`],
  ];
  for (const [raw, want] of cases) assert.equal(parentRawPath(raw), want, JSON.stringify(raw));
});

console.log(`\n${pass} passed, ${failed.length} failed`);
if (failed.length) process.exitCode = 1;
