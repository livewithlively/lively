// 트레이 아이콘 생성기 (#1541 T2) — 실행: node desktop/tools-gen-icon.mjs
// 트레이 아이콘 PNG 생성 → base64. 레포에 바이너리 자산을 안 두려고 코드에 임베드한다.
import zlib from "node:zlib";
import { writeFileSync } from "node:fs";

function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;                                  // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const crcTable = [...Array(256)].map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;   // 8bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0)),
  ]);
}

// 22x22 — 속이 빈 원(라이블리 'ㅇ' 느낌). macOS 템플릿 이미지 규약: 검정 + 알파만.
function ring(size, scale) {
  const S = size * scale;
  const buf = Buffer.alloc(S * S * 4);
  const cx = (S - 1) / 2, cy = (S - 1) / 2;
  const rOut = S * 0.42, rIn = S * 0.24;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const d = Math.hypot(x - cx, y - cy);
      // 안티에일리어싱 — 경계 1px 를 알파로 부드럽게(작은 크기에서 계단이 심하다).
      const aOut = Math.min(1, Math.max(0, rOut - d + 0.5));
      const aIn = Math.min(1, Math.max(0, d - rIn + 0.5));
      const a = Math.round(255 * Math.min(aOut, aIn));
      const i = (y * S + x) * 4;
      buf[i] = 0; buf[i + 1] = 0; buf[i + 2] = 0; buf[i + 3] = a;
    }
  }
  return png(S, S, buf);
}

/**
 * 앱 아이콘 — **트레이 아이콘과 다른 물건이다.**
 *
 * 트레이는 macOS 템플릿 규약(검정+알파만)을 지켜야 다크/라이트 메뉴바에서 자동 반전된다. 그런데 그걸 그대로
 * 512px 로 키워 앱 아이콘으로 쓰면 **투명 배경에 검정 링**이라, 독·시작메뉴·작업표시줄의 어두운 배경에서
 * 사실상 보이지 않고 제품이 뭔지도 말하지 않는다(그 상태로 있었다).
 *
 * 그래서 앱 아이콘은 제품 브랜드 마크를 쓴다 — 웹 UI 파비콘과 같은 초록(#16C79A) 바탕에 흰 링.
 * 둥근 사각형 + 여백은 macOS/Windows 양쪽의 관례다(꽉 찬 정사각형은 독에서 혼자 커 보인다).
 * ⚠ 이건 **디자이너 자산의 자리표시자**다 — 정식 로고가 나오면 이 함수 대신 그 PNG 를 넣으면 된다.
 */
const BRAND = [0x16, 0xc7, 0x9a];               // 제품 초록 — public/index.html 파비콘과 같은 값
function appIcon(S) {
  const buf = Buffer.alloc(S * S * 4);
  const pad = S * 0.08;                          // 캔버스 여백(독·시작메뉴 관례)
  const half = S / 2 - pad;                      // 타일 반폭
  const corner = S * 0.225;                      // 모서리 반경
  const cx = (S - 1) / 2, cy = (S - 1) / 2;
  const rOut = S * 0.30, rIn = S * 0.175;        // 흰 링
  const aa = (v) => Math.min(1, Math.max(0, v + 0.5));
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      // 둥근 사각형까지의 부호거리 — 경계 1px 를 알파로 부드럽게(작은 크기에서 계단이 심하다).
      const qx = Math.abs(x - cx) - (half - corner), qy = Math.abs(y - cy) - (half - corner);
      const sd = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - corner;
      const tile = aa(-sd);
      if (tile <= 0) continue;
      const d = Math.hypot(x - cx, y - cy);
      const ringA = Math.min(aa(rOut - d), aa(d - rIn));     // 흰 링(바탕 위에 합성)
      const i = (y * S + x) * 4;
      for (let c = 0; c < 3; c++) buf[i + c] = Math.round(BRAND[c] * (1 - ringA) + 255 * ringA);
      buf[i + 3] = Math.round(255 * tile);
    }
  }
  return png(S, S, buf);
}

const b1 = ring(22, 1), b2 = ring(22, 2);
// 앱 아이콘 — electron-builder 가 512px PNG 하나로 macOS icns·Windows ico 를 만든다.
//  레포엔 안 담는다(생성물): desktop/build/ 는 gitignore. 빌드 스크립트가 매번 만든다.
import { mkdirSync } from "node:fs";
mkdirSync(new URL("./build/", import.meta.url), { recursive: true });
writeFileSync(new URL("./build/icon.png", import.meta.url), appIcon(512));
const out = `// ⚠ **생성물이다** — 손으로 고치지 마라. 재생성: scratchpad/gen-icon.mjs (22x22 링, 검정+알파).
// 레포에 바이너리 자산을 두지 않으려고 data URL 로 임베드한다(electron-builder files 목록도 단순해진다).
// macOS 템플릿 이미지 규약(검정+알파만)을 지켜 다크/라이트 메뉴바 양쪽에서 자동 반전된다.
export const TRAY_ICON_1X = "data:image/png;base64,${b1.toString("base64")}";
export const TRAY_ICON_2X = "data:image/png;base64,${b2.toString("base64")}";
`;
writeFileSync(new URL("./main/tray-icon.mjs", import.meta.url), out);
console.log("1x", b1.length, "B · 2x", b2.length, "B → desktop/main/tray-icon.mjs");
