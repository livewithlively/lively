// Windows .ico 파일 만들기 (#4066) — 설치 도우미(installer-helper) exe 에 넣을 아이콘.
//
// 앱 아이콘은 electron-builder 가 512px PNG 하나로 알아서 .ico 를 만든다. 설치 도우미는 electron-builder 밖에서
//  (dotnet 으로) 빌드하므로 .ico 를 직접 줘야 한다. 레포에 바이너리를 두지 않는 규약(tools-gen-icon.mjs)을 따라 코드로 만든다.
//
// 형식(Microsoft Learn «Icons» · ICONDIR/ICONDIRENTRY):
//   ICONDIR(6B) = reserved 0 · type 1 · count
//   ICONDIRENTRY(16B) × count = 폭 · 높이(256 은 0) · 색 수 0 · 0 · planes 1 · bitCount 32 · 데이터 크기 · 데이터 위치
//   데이터 = 256px 은 PNG 그대로, 그보다 작은 것은 DIB(BITMAPINFOHEADER + 32bpp BGRA 아래→위 + 1bpp AND 마스크).
//  작은 크기를 DIB 로 두는 이유 — PNG 항목은 Vista 이후 셸만 읽는다. 리소스 컴파일러·옛 도구가 읽을 수 있게 관례를 따른다.

/**
 * RGBA(위→아래) 한 장 → DIB 아이콘 이미지.
 * @param {number} size
 * @param {Buffer} rgba  size*size*4
 */
export function dibImage(size, rgba) {
  if (!Buffer.isBuffer(rgba) || rgba.length !== size * size * 4) throw new Error(`RGBA 크기가 ${size}x${size} 와 맞지 않는다`);
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);             // biSize
  header.writeInt32LE(size, 4);            // biWidth
  header.writeInt32LE(size * 2, 8);        // biHeight — XOR + AND 두 장이라 두 배
  header.writeUInt16LE(1, 12);             // biPlanes
  header.writeUInt16LE(32, 14);            // biBitCount
  // biCompression 0(BI_RGB) · 나머지 0
  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const src = (size - 1 - y) * size * 4;   // DIB 는 아래 줄부터
    for (let x = 0; x < size; x++) {
      const s = src + x * 4, d = (y * size + x) * 4;
      xor[d] = rgba[s + 2]; xor[d + 1] = rgba[s + 1]; xor[d + 2] = rgba[s]; xor[d + 3] = rgba[s + 3];
    }
  }
  // AND 마스크 — 32bpp 는 알파가 투명도를 정하므로 전부 0(불투명 취급)으로 둔다. 줄마다 32비트 경계로 채운다.
  const maskRow = Math.ceil(size / 32) * 4;
  const and = Buffer.alloc(maskRow * size);
  return Buffer.concat([header, xor, and]);
}

/**
 * 이미지 여러 장 → .ico 파일.
 * @param {{ size: number, data: Buffer }[]} images  data = dibImage(...) 또는 PNG 바이트
 */
export function icoFile(images) {
  if (!Array.isArray(images) || !images.length) throw new Error("아이콘 이미지가 없다");
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const { size, data } of images) {
    if (!(size >= 1 && size <= 256)) throw new Error(`아이콘 크기 ${size} 는 1~256 이어야 한다`);
    const e = Buffer.alloc(16);
    e.writeUInt8(size === 256 ? 0 : size, 0);
    e.writeUInt8(size === 256 ? 0 : size, 1);
    e.writeUInt8(0, 2);                    // 색 수(팔레트 없음)
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);                 // planes
    e.writeUInt16LE(32, 6);                // bitCount
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
  }
  return Buffer.concat([dir, ...entries, ...images.map((i) => i.data)]);
}
