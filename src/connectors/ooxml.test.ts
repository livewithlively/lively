// #541 OOXML 공용 추출기 골든 테스트 — 순수 함수(DB/네트워크 불요). gdrive·slack 공용.
//   실행: npm run build && node dist/connectors/ooxml.test.js
//   목적: docx/pptx/xlsx 에서 텍스트가 조용히 손실되지 않음을 회귀로 잠근다(한글 유니코드 보존·sharedStrings 인덱스
//        해소·zip-bomb 노출 축소·printableRatio 가드). ⚠ Claude Read 는 docx/xlsx 를 못 뽑으므로 이 결정적 추출이 정답.
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { extractOoxml, printableRatio, ooxmlKindFromMime, ooxmlKindFromName } from "./ooxml.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

// ── 최소 ZIP 저작(deflate + central directory) — 테스트 fixture 생성용(unzipEntries 를 실제 zip 으로 검증). ──
function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    let c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function makeZip(entries: { name: string; data: string }[]): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = Buffer.from(e.data, "utf8");
    const comp = deflateRawSync(data);
    const crc = crc32(data);
    const nameB = Buffer.from(e.name, "utf8");
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameB.length, 26);
    locals.push(lh, nameB, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameB.length, 28); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameB);
    offset += lh.length + nameB.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

// ── ooxmlKindFromMime — 업로드된 OOXML 만 종류 판정, 그 외는 undefined. ──
t("ooxmlKindFromMime: OOXML mime만 종류, 그 외 undefined", () => {
  assert.equal(ooxmlKindFromMime("application/vnd.openxmlformats-officedocument.wordprocessingml.document"), "docx");
  assert.equal(ooxmlKindFromMime("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"), "xlsx");
  assert.equal(ooxmlKindFromMime("application/vnd.openxmlformats-officedocument.presentationml.presentation"), "pptx");
  assert.equal(ooxmlKindFromMime("application/pdf"), undefined);
  assert.equal(ooxmlKindFromMime("text/plain"), undefined);
  assert.equal(ooxmlKindFromMime(undefined), undefined);
});

// ── docx: 문단(<w:p>) 경계로 개행 유지, <w:t> 런 이어붙임. 한글+영문+엔티티. ──
t("docx: 한글+영문 본문 추출·문단 개행·엔티티 디코드", () => {
  const doc = `<?xml version="1.0"?><w:document><w:body>`
    + `<w:p><w:r><w:t>투자계약서 </w:t></w:r><w:r><w:t>초안 v3</w:t></w:r></w:p>`
    + `<w:p><w:r><w:t xml:space="preserve">고객사 AAI &amp; 투자자</w:t></w:r></w:p>`
    + `</w:body></w:document>`;
  const zip = makeZip([{ name: "word/document.xml", data: doc }]);
  const text = extractOoxml("docx", zip);
  assert.equal(text, "투자계약서 초안 v3\n고객사 AAI & 투자자");
  assert.ok(printableRatio(text) > 0.99);
});

// ── pptx: 슬라이드 순서대로 <a:t> 수집, 슬라이드 사이 빈 줄. slide10 정렬(사전식 아님) 확인. ──
t("pptx: 슬라이드 텍스트 순서 추출(수치 정렬)", () => {
  const s1 = `<p:sld><a:t>1분기</a:t><a:t> 로드맵</a:t></p:sld>`;
  const s2 = `<p:sld><a:t>고객사 A 파일럿</a:t></p:sld>`;
  const s10 = `<p:sld><a:t>마지막 슬라이드</a:t></p:sld>`;
  const zip = makeZip([
    { name: "ppt/slides/slide10.xml", data: s10 },
    { name: "ppt/slides/slide2.xml", data: s2 },
    { name: "ppt/slides/slide1.xml", data: s1 },
  ]);
  const text = extractOoxml("pptx", zip);
  assert.equal(text, "1분기 로드맵\n\n고객사 A 파일럿\n\n마지막 슬라이드");
});

// ── xlsx: sharedStrings 인덱스 해소(t="s") + 숫자 리터럴(<v>) + 탭/개행. ──
t("xlsx: sharedStrings 인덱스 해소·숫자 리터럴·행/셀 구분", () => {
  const sst = `<sst><si><t>항목</t></si><si><t>투자금액</t></si><si><t>고객사 AAI</t></si></sst>`;
  const sheet = `<worksheet><sheetData>`
    + `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>`
    + `<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>500000000</v></c></row>`
    + `</sheetData></worksheet>`;
  const zip = makeZip([
    { name: "xl/sharedStrings.xml", data: sst },
    { name: "xl/worksheets/sheet1.xml", data: sheet },
  ]);
  const text = extractOoxml("xlsx", zip);
  assert.equal(text, "항목\t투자금액\n고객사 AAI\t500000000");
});

// ── zip-bomb 노출 축소: 실제 읽는 문서 파트만 압축해제, 그 외 엔트리(미디어/폰트/임베딩)는 손대지 않음. ──
//  (엔트리별 maxOutputLength=128MB 캡은 코드로 보장 — 128MB 폭탄 실제 생성은 유닛테스트에 과해 스코핑만 검증.)
t("zip-bomb 방어: 비문서 엔트리(미디어 등)는 압축해제 대상 아님(스코핑)", () => {
  const doc = `<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>실제 본문</w:t></w:r></w:p></w:body></w:document>`;
  const junk = "￿".repeat(500) + "GARBAGE-SHOULD-NOT-APPEAR";
  const zip = makeZip([
    { name: "word/document.xml", data: doc },
    { name: "word/media/junk.bin", data: junk },
  ]);
  const text = extractOoxml("docx", zip);
  assert.equal(text, "실제 본문");
  assert.ok(!text.includes("GARBAGE"), "비문서 엔트리가 추출물에 새면 안 됨");
});

// ── 견고성: 문서 파트 부재/빈 zip → 빈 문자열(throw 아님, 상위가 메타로 폴백). ──
t("견고성: 문서 파트 없으면 빈 문자열(폴백)", () => {
  const zip = makeZip([{ name: "docProps/core.xml", data: "<x/>" }]);
  assert.equal(extractOoxml("docx", zip), "");
  assert.equal(extractOoxml("pptx", zip), "");
  assert.equal(extractOoxml("xlsx", zip), "");
});

// ── printableRatio 가드: 깨진 바이트(CID 글리프 흉내)는 낮은 비율 → caller 가 폐기. ──
t("printableRatio: 정상 한글/영문 high, 깨진 제어문자 low", () => {
  assert.ok(printableRatio("정상 텍스트 normal text 123") > 0.99);
  const garbage = "\x00\x01\x02\x03\x04\x05a\x06\x07\x08\x0b\x0c\x0e\x0f";
  assert.ok(printableRatio(garbage) < 0.6, `ratio=${printableRatio(garbage)}`);
  assert.equal(printableRatio(""), 0);
});

t("hwpx: Contents/section*.xml 의 <hp:t> 를 문단 개행으로 — 구역 순서 유지 (#1881 로컬 자료)", () => {
  const zip = makeZip([
    { name: "Contents/section1.xml", data: '<hs:sec><hp:p><hp:run><hp:t>둘째 구역</hp:t></hp:run></hp:p></hs:sec>' },
    { name: "Contents/section0.xml", data: '<hs:sec><hp:p><hp:run><hp:t>안녕</hp:t></hp:run><hp:run><hp:t>하세요</hp:t></hp:run></hp:p><hp:p><hp:run><hp:t>둘째 &amp; 문단</hp:t></hp:run></hp:p></hs:sec>' },
    { name: "BinData/image1.png", data: "\x89PNG" },
  ]);
  assert.equal(extractOoxml("hwpx", zip), "안녕하세요\n둘째 & 문단\n\n둘째 구역");
  assert.equal(ooxmlKindFromName("계약.HWPX"), "hwpx");
  assert.equal(ooxmlKindFromName("보고서.docx"), "docx");
  assert.equal(ooxmlKindFromName("메모.txt"), undefined);
});

console.log(`\n${pass} passed (ooxml 추출 골든 + zip-bomb 스코핑 + printableRatio 가드 + hwpx)`);
