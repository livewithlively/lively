// OOXML(Office Open XML: .docx/.pptx/.xlsx) 텍스트 추출 — 커넥터 공용 유틸(#541, zero-dep: zlib only).
//  왜 공용: gdrive·slack(+향후) 모두 업로드된 Office 파일이 나오는데, 본문이 XML 에 실제 유니코드로 저장돼
//   결정적으로 뽑힌다(한글 포함). ⚠ Claude Read 는 PDF·이미지만 네이티브 파싱 — docx/xlsx 는 zip 바이너리라
//   Read 로 못 뽑는다(vision 버킷에 넣으면 내용 유실). 그래서 OOXML 은 sync 시점 결정적 추출이 정답 → 여기로 공용화.
//  경계: 이 모듈은 '순수'(네트워크/DB/FS 무관). 커넥터가 바이트를 받아 extractOoxml 로 텍스트만 얻는다.
//  🔒 zip-bomb 방어 내장(unzipEntries): 필요한 파트만 압축해제 + 엔트리별/누적 maxOutputLength 캡.
import { inflateRawSync } from "node:zlib";

export type OoxmlKind = "docx" | "pptx" | "xlsx" | "hwpx";

// 업로드된 OOXML mimeType → 추출기 종류. (Google 네이티브 Docs/Sheets/Slides 는 여기 아님 — 그건 export API 로 텍스트화.)
const OOXML_KIND: Record<string, OoxmlKind> = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/hwp+zip": "hwpx",   // 한글 hwpx(OWPML) — zip+XML, 본문은 Contents/section*.xml 의 <hp:t>(#1881)
};
// mimeType 이 업로드된 OOXML 이면 종류, 아니면 undefined. 커넥터가 "이 파일을 extractOoxml 로 처리할지" 판정에 사용.
export function ooxmlKindFromMime(mime: string | undefined): OoxmlKind | undefined {
  return mime ? OOXML_KIND[mime] : undefined;
}
// 파일명(확장자)으로 판정 — 브라우저 업로드엔 신뢰할 MIME 이 없다(라우트가 octet-stream 으로 받는다, #1881 로컬 자료).
const OOXML_EXT: Record<string, OoxmlKind> = { docx: "docx", pptx: "pptx", xlsx: "xlsx", hwpx: "hwpx" };
export function ooxmlKindFromName(name: string | undefined): OoxmlKind | undefined {
  const m = /\.([A-Za-z0-9]+)$/.exec(name ?? "");
  return m ? OOXML_EXT[m[1].toLowerCase()] : undefined;
}

// zip-bomb 방어 상한 — Node inflate 는 기본 무제한(kMaxLength)이라 작은 압축본이 GB로 폭증→OOM. 엔트리별+누적 캡.
const MAX_INFLATE_ENTRY = 128_000_000; // 엔트리 1개 압축해제 상한(~128MB) — 초과 시 Node throw → 해당 엔트리 skip
const MAX_INFLATE_TOTAL = 256_000_000; // zip 전체 누적 압축해제 상한(~256MB) — 초과 시 이후 엔트리 압축해제 중단

// 종류별로 실제 읽는 문서 파트만 압축해제(zip-bomb 노출 축소 + 미디어/폰트 불필요 해제 방지).
const OOXML_WANTED: Record<OoxmlKind, (name: string) => boolean> = {
  docx: (n) => n === "word/document.xml",
  pptx: (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n),
  xlsx: (n) => n === "xl/sharedStrings.xml" || /^xl\/worksheets\/sheet\d+\.xml$/.test(n),
  hwpx: (n) => /^Contents\/section\d+\.xml$/.test(n),
};

// 최소 ZIP 리더 — Map<name, 압축해제 Buffer>. deflate(8)/stored(0)만, 그 외 압축법·암호화 엔트리는 skip.
//  🔒 zip-bomb 방어: (a) wanted(name) 로 실제 읽을 엔트리만 압축해제(미디어/폰트 등 불필요분 미해제),
//    (b) 엔트리별 maxOutputLength=MAX_INFLATE_ENTRY(초과 시 Node throw → 해당 엔트리 skip),
//    (c) 누적 MAX_INFLATE_TOTAL 초과 시 이후 엔트리 압축해제 중단(전체 메모리 상한).
function unzipEntries(buf: Buffer, wanted: (name: string) => boolean): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  // End Of Central Directory(0x06054b50) 를 뒤에서 탐색(가변 코멘트 대응, 최대 64KB).
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 0x10000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("EOCD 없음(zip 아님/손상)");
  const cdCount = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16); // central directory 시작 오프셋
  let total = 0; // 누적 압축해제 바이트(전체 상한 가드)
  for (let n = 0; n < cdCount; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break; // central file header sig
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42); // local header offset
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    // 필요한 엔트리만 압축해제(zip-bomb 노출 축소 + 성능). 누적 상한 초과 시 이후 전부 skip.
    if (wanted(name) && total < MAX_INFLATE_TOTAL && lho + 30 <= buf.length && buf.readUInt32LE(lho) === 0x04034b50) {
      const lNameLen = buf.readUInt16LE(lho + 26);
      const lExtraLen = buf.readUInt16LE(lho + 28);
      const ds = lho + 30 + lNameLen + lExtraLen;
      const comp = buf.subarray(ds, ds + compSize);
      try {
        // maxOutputLength: 엔트리 1개가 이 상한 넘게 팽창하면 Node 가 throw → catch 로 skip(메타 폴백).
        const data = method === 0 ? Buffer.from(comp)
          : method === 8 ? inflateRawSync(comp, { maxOutputLength: MAX_INFLATE_ENTRY }) : undefined;
        if (data) { out.set(name, data); total += data.length; }
      } catch { /* 엔트리 하나 실패(상한 초과·손상)는 무시(부분 추출) */ }
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// XML 엔티티 디코드 + 잔여 태그 제거.
function decodeXmlText(s: string): string {
  return s.replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, "&");
}

// <tag ...>…</tag> 안의 텍스트들을 순서대로 수집(태그명 정확 일치). ⚠ tag 는 항상 내부 리터럴(외부 입력 아님).
function collectTagText(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  const parts: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) parts.push(decodeXmlText(m[1]));
  return parts;
}

// 문자열의 '읽을 수 있는' 문자 비율(ASCII 인쇄가능·개행·한글·CJK 등). 깨진 추출물 폐기 가드에 사용(caller 가 임계 판단).
export function printableRatio(s: string): number {
  if (!s) return 0;
  const chars = [...s];
  let ok = 0;
  for (const ch of chars) {
    const c = ch.codePointAt(0)!;
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127) || c >= 0x3000) ok++;
  }
  return ok / chars.length;
}

// OOXML 종류별 텍스트 추출(순수). 반환이 비었거나 대부분 깨졌으면(printableRatio 낮음) caller 가 폐기(메타 폴백).
//  caller 책임: 길이 절단(MAX_BODY_CHARS 등)·printableRatio 임계 판정. 여기선 순수 추출만.
export function extractOoxml(kind: OoxmlKind, buf: Buffer): string {
  const zip = unzipEntries(buf, OOXML_WANTED[kind]);
  if (kind === "docx") {
    const xml = zip.get("word/document.xml");
    if (!xml) return "";
    // 문단(<w:p>) 경계로 개행 유지: 문단마다 <w:t> 런을 이어붙이고 사이에 \n.
    return xml.toString("utf8").split(/<\/w:p>/)
      .map((para) => collectTagText(para, "w:t").join(""))
      .filter(Boolean).join("\n");
  }
  if (kind === "pptx") {
    const slides = [...zip.keys()].filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
      .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
    // 문단(<a:p>) 경계로 개행 유지: 문단 내 <a:t> 런은 빈문자 이어붙임(런 자체 공백 보존), 슬라이드 사이 빈 줄.
    return slides.map((k) => zip.get(k)!.toString("utf8").split(/<\/a:p>/)
      .map((para) => collectTagText(para, "a:t").join("")).filter(Boolean).join("\n"))
      .filter(Boolean).join("\n\n");
  }
  if (kind === "hwpx") {
    // 한글 hwpx — 구역(section) 순서대로, 문단(<hp:p>) 경계로 개행, 문단 안 <hp:t> 런은 이어붙임.
    const secs = [...zip.keys()].filter((k) => /^Contents\/section\d+\.xml$/.test(k))
      .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
    return secs.map((k) => zip.get(k)!.toString("utf8").split(/<\/hp:p>/)
      .map((para) => collectTagText(para, "hp:t").join("")).filter(Boolean).join("\n"))
      .filter(Boolean).join("\n\n");
  }
  // xlsx — sharedStrings(공유 문자열 풀) + 각 시트의 셀 값(t="s"면 풀 인덱스, 아니면 <v> 리터럴/<t> 인라인).
  const shared = zip.has("xl/sharedStrings.xml")
    ? collectTagText(zip.get("xl/sharedStrings.xml")!.toString("utf8"), "t") : [];
  const sheets = [...zip.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  const lines: string[] = [];
  for (const k of sheets) {
    const xml = zip.get(k)!.toString("utf8");
    for (const rowM of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const cM of rowM[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        const isStr = /\bt="s"/.test(cM[1]);
        const inlineM = cM[2].match(/<t[^>]*>([\s\S]*?)<\/t>/);
        const vM = cM[2].match(/<v>([\s\S]*?)<\/v>/);
        if (inlineM) cells.push(decodeXmlText(inlineM[1]));
        else if (vM) cells.push(isStr ? (shared[Number(vM[1])] ?? "") : vM[1]);
        else cells.push("");
      }
      if (cells.some((c) => c !== "")) lines.push(cells.join("\t"));
    }
  }
  return lines.join("\n");
}
