// 시험 픽스처용 tar.gz 만들기 — **시스템 tar 를 쓰지 않는다**(#4927, 2026-10-22).
//
//  왜: 새 Windows 러너 이미지(windows-2025-vs2026 20261018 · OS 26100.33650 · 내장 tar.exe = bsdtar/libarchive 3.8.9)의
//   tar.exe 가 키트 번들을 **만들 때** 0xC0000005(접근 위반)로 죽는다. 이전 이미지(3.8.4)는 정상이고, 같은 이미지에서도
//   **풀기(-xzf)는 정상**이다(진단 PR #1478 실측 — 어댑터 한 파일·ASCII 한 파일 묶기는 살고, 한글 이름 파일이 든 번들은 죽었다).
//   시험은 번들을 만들어 CLI·자가 업데이트가 «푸는» 경로를 재는 것이라, 만들기를 OS 에 맡기면 OS 회귀가 우리 시험을 막는다.
//  형식은 게이트웨이와 같은 계약이다(src/org/delivery/bundle-tar.ts — `--format=pax`): 비-ASCII·긴 경로는 pax 확장헤더의
//   `path=` 로 UTF-8 을 명시한다. 그래야 윈도우 tar.exe 가 활성 코드페이지(cp949 등)와 무관하게 이름을 복원한다.
//  범위: 일반 파일만(디렉터리 엔트리는 풀 때 자동 생성) · 심링크 없음 · 실행 비트는 stat 에서 옮긴다.
//  쓰는 곳: **윈도우에서만** 픽스처를 이걸로 만든다(lively.test · self-update.test). macOS 의 시스템 tar 는 만들 때 디스크의
//   `._*`(AppleDouble)를 묶음에서 빼고, 풀 때는 그런 항목을 메타데이터로 읽는다 — 이 함수는 그 파일을 평범한 파일로 넣으므로
//   macOS 에서 쓰면 픽스처의 뜻이 바뀐다(self-update.test ⑭ 실측).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { gzipSync } from "node:zlib";

const oct = (n, len) => n.toString(8).padStart(len - 1, "0") + "\0";
const pad = (n) => Buffer.alloc((512 - (n % 512)) % 512);
const isPlain = (s) => /^[\x20-\x7e]*$/.test(s) && Buffer.byteLength(s) <= 99;

function header(name, size, mtime, type, mode) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, "utf8");
  h.write(oct(mode, 8), 100); h.write(oct(0, 8), 108); h.write(oct(0, 8), 116);
  h.write(oct(size, 12), 124); h.write(oct(mtime, 12), 136);
  h.write("        ", 148); h.write(type, 156);
  h.write("ustar\0", 257); h.write("00", 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(oct(sum, 7) + " ", 148);
  return h;
}

// pax 레코드 "<길이> <키>=<값>\n" — 길이는 레코드 자신(자릿수 포함)의 바이트 수다.
export function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  const b = Buffer.byteLength(body);
  let n = b + 1;
  while (String(n).length + b !== n) n = String(n).length + b;
  return String(n) + body;
}

/** dir 아래 일반 파일 전부 → tar.gz 바이트(`tar -czf - -C dir .` 와 같은 모양 — 이름은 `./` 로 시작). */
export function tgzOf(dir) {
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) files.push(p);
    }
  };
  walk(dir);
  const out = [];
  for (const f of files) {
    const name = "./" + relative(dir, f).split(sep).join("/");
    const data = readFileSync(f);
    const st = statSync(f);
    const mtime = Math.floor(st.mtimeMs / 1000);
    const mode = st.mode & 0o111 ? 0o755 : 0o644;
    if (!isPlain(name)) {
      const rec = Buffer.from(paxRecord("path", name), "utf8");
      out.push(header("./PaxHeaders/" + name.replace(/[^\x20-\x7e]/g, "_").slice(-80), rec.length, mtime, "x", 0o644), rec, pad(rec.length));
    }
    const fallback = isPlain(name) ? name : name.replace(/[^\x20-\x7e]/g, "_").slice(-99);
    out.push(header(fallback, data.length, mtime, "0", mode), data, pad(data.length));
  }
  out.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(out));
}
