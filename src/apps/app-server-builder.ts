// 앱 서버 빌더(#4484 앱 v2-5) — 게시한 사람의 세션 컨테이너 **안에서** 도는 프로그램. 게이트웨이는 이 글을 `node -e` 로 보낸다.
//
//  왜 세션 안인가(설계 §3-C · §12 ⑤-5, 상민 2026-10-14): `npm ci` 의 설치 스크립트는 남이 쓴 임의 코드다 — 게이트웨이(전 고객이 같이 쓰는
//   호스트 프로세스)에서는 돌리지 않는다. 사람 세션 컨테이너는 gVisor 라 «격리된 곳» 조건을 만족하고, 앱을 만드는 세션은 이미 npm 을 돌린다.
//   ★ 그 판을 **저장한 사람**의 세션에서만 돈다(상민 2026-10-15) — 남이 저장한 판을 관리자 세션에서 빌드하면 그 코드가 관리자의 토큰·구독에 닿는다.
//  하는 일: 판 묶음(stdin)을 /tmp 임시 폴더에 푼다(세션 폴더는 건드리지 않는다) → 의존성 설치(npm ci · 잠금 파일이 없으면 npm install) →
//   빌드(web.server.build 또는 package.json scripts.build) → 개발용 의존성 빼기(npm prune --omit=dev) → 시작 스크립트 두 개를 더한다 →
//   zip(결정적 — 시각 고정 · 이름순 · 실행 권한 · 심링크 보존) → 게이트웨이가 준 S3 서명 주소로 **직접** 올린다(250MB 를 게이트웨이로 흘리지 않는다).
//  ★ 메모리 감시: 운영 세션은 상한(2,560MB)에 닿는 순간 gVisor 본체가 죽어 **세션이 통째로 사라진다**(지식 session-swap-memory-high-node-test-3825).
//   그래서 0.25초마다 세션 안 남은 메모리(/proc/meminfo)를 보고 바닥(mem_floor_mb) 밑이면 빌드 프로세스 묶음만 죽인다. node 힙도 heap_mb 로 묶는다.
//
//  입력(stdin) — 세션 경계 중계는 stdin 의 끝(EOF)을 전하지 않는다(terminal-member-fs ExecAt 머리말). 그래서 길이를 아는 틀로 받는다:
//   첫 줄 = BuildHeader JSON + "\n", 그 뒤 = header.files 순서대로 파일 바이트를 이어 붙인 것(크기는 header 에). 다 받으면 더 읽지 않는다.
//  출력: 진행 기록(npm 출력 포함)은 stderr, 결과는 stdout 의 마지막 줄 `@@lively-build-result@@ {BuildResult}`. 종료 코드 0 = 성공.
//
//  ⚠ builderMain 은 `.toString()` 으로 글이 되어 다른 프로세스에서 돈다 — **바깥 이름(import · 이 파일의 상수)을 쓰면 안 된다.**
//   필요한 모듈은 안에서 require 하고, 상수(BUILD_RESULT_MARK 등)는 안에 같은 값을 둔다(시험이 둘이 같은지 본다).
import type { ChildProcess } from "node:child_process";

declare const require: (id: string) => unknown;   // builderMain 이 `node -e` 로 돌 때의 CommonJS require — 이 모듈(ESM) 자체는 부르지 않는다

/** 빌더 판 — 빌드 지문에 들어간다(빌더가 바뀌면 같은 코드라도 다시 빌드한다). */
export const BUILDER_VERSION = 2;   // 2 = 올릴 폴더(dir) · /tmp 링크(시작할 때 그 자리를 만든다)
/** 결과 줄 표식 — builderMain 안의 MARK 와 같아야 한다(app-server-builder.test 가 본다). */
export const BUILD_RESULT_MARK = "@@lively-build-result@@ ";
/** zip 에 우리가 더하는 시작 스크립트 — Lambda 핸들러 이름이 RUN_SCRIPT 다(AWS_LAMBDA_EXEC_WRAPPER=/opt/bootstrap 이 그 파일을 실행한다). */
export const RUN_SCRIPT = "lively-run.sh";
export const START_SCRIPT = "lively-start.sh";
/** zip 에 담지 않는 파일 — 매니페스트는 빌드 지문에서도 뺀다(이름·설명만 바꾼 판이 같은 zip 을 쓰게). */
export const ZIP_EXCLUDE = ["lively-app.json"];

export interface BuildHeader {
  v: 1;
  /** 이 시각(epoch ms)이 지나면 빌드를 멈춘다. */
  deadline_ms: number;
  /** [경로, 크기] — 이 순서로 바이트가 header 줄 뒤에 이어진다. */
  files: Array<[string, number]>;
  /** 빌드 명령(sh -c) — null 이면 package.json scripts.build 가 있을 때만 `npm run build`. */
  build: string | null;
  /** 시작 명령(sh) — null 이면 package.json scripts.start. 둘 다 없으면 실패. */
  start: string | null;
  /** 올릴 폴더(앱 폴더 안 상대 경로) — 빌드 뒤 이 폴더만 zip 의 맨 위로 올리고 시작 명령도 여기서 돈다. null · 빈 글 · '.' 이면 앱 폴더 전체. */
  dir?: string | null;
  /** 풀린 크기 상한(바이트) — Lambda 상한 250MB 에서 레이어 몫을 뺀 값. */
  unzipped_max: number;
  /** 세션 안 남은 메모리 바닥(MB) — 이 밑이면 빌드를 멈춘다. */
  mem_floor_mb: number;
  /** 빌드 자식 node 힙 상한(MB) — NODE_OPTIONS --max-old-space-size. 0 이면 걸지 않는다. */
  heap_mb: number;
  /** zip 을 올릴 S3 서명 주소(PUT). */
  upload_url: string;
  /** 시험용 — /proc/meminfo 대신 읽을 파일(세션에선 쓰지 않는다). */
  meminfo_path?: string;
}

export interface BuildStep { name: string; ms: number; code: number | null; signal: string | null }
export interface BuildResult {
  ok: boolean;
  /** 실패한 단계 — input · detect · dir · install · build · prune · start · size · zip · upload · memory · time */
  stage?: string;
  error?: string;
  steps: BuildStep[];
  warnings: string[];
  ms?: number;
  /** 쓴 명령(사람이 무엇이 돌았는지 보게) */
  install?: "ci" | "install" | "none";
  build_cmd?: string | null;
  start_cmd?: string | null;
  /** 올린 폴더(web.server.dir) — 앱 폴더 전체면 없음. */
  dir?: string;
  zip?: { bytes: number; sha256_hex: string; sha256_b64: string; entries: number; unzipped: number };
  /** 세션 안 남은 메모리(MB) — 시작 · 가장 낮았던 때. 빌드가 쓴 양 ≈ 시작 − 최저. */
  mem?: { start_mb: number | null; min_mb: number | null; floor_mb: number };
}

/* eslint-disable */
function builderMain(): void {
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const cp = require("node:child_process") as typeof import("node:child_process");
  const zlib = require("node:zlib") as typeof import("node:zlib");
  const crypto = require("node:crypto") as typeof import("node:crypto");
  const MARK = "@@lively-build-result@@ ";
  const RUN = "lively-run.sh";
  const START = "lively-start.sh";
  const EXCLUDE = new Set(["lively-app.json"]);
  const started = Date.now();
  const steps: Array<{ name: string; ms: number; code: number | null; signal: string | null }> = [];
  const warnings: string[] = [];
  const result: Record<string, unknown> = { ok: false, steps, warnings };
  let hdr: {
    deadline_ms: number; files: Array<[string, number]>; build: string | null; start: string | null; dir?: string | null; unzipped_max: number;
    mem_floor_mb: number; heap_mb: number; upload_url: string; meminfo_path?: string;
  } | null = null;
  let base = "";
  let app = "";
  let child: ChildProcess | null = null;
  let stopWhy: string | null = null;   // 감시가 빌드를 멈춘 까닭(memory:<MB> · time)
  let done = false;
  let memStart: number | null = null;
  let memMin: number | null = null;
  const timers: Array<ReturnType<typeof setInterval>> = [];

  const say = (s: string): void => { try { process.stderr.write(s.endsWith("\n") ? s : s + "\n"); } catch { /* 진행 기록은 버려도 된다 */ } };
  const killChild = (): void => {
    const c = child;
    if (!c || c.pid == null) return;
    try { process.kill(-c.pid, "SIGKILL"); } catch { try { c.kill("SIGKILL"); } catch { /* 이미 끝났다 */ } }
  };
  const finish = (extra: Record<string, unknown>): void => {
    if (done) return;
    done = true;
    for (const t of timers) clearInterval(t);
    killChild();
    if (base) { try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* 임시 폴더 — 세션이 끝나면 함께 사라진다 */ } }
    Object.assign(result, extra, { ms: Date.now() - started, mem: { start_mb: memStart, min_mb: memMin, floor_mb: hdr ? hdr.mem_floor_mb : null } });
    process.stdout.write("\n" + MARK + JSON.stringify(result) + "\n", () => process.exit(result.ok ? 0 : 3));
  };
  const fail = (stage: string, error: string): void => finish({ ok: false, stage, error });

  //  ── 메모리 · 시간 감시 ──
  const memAvail = (): number | null => {
    try {
      const t = fs.readFileSync(hdr && hdr.meminfo_path ? hdr.meminfo_path : "/proc/meminfo", "utf8");
      const m = /MemAvailable:\s+(\d+)\s*kB/.exec(t) || /MemFree:\s+(\d+)\s*kB/.exec(t);
      return m ? Math.floor(Number(m[1]) / 1024) : null;
    } catch { return null; }
  };
  const startWatch = (): void => {
    memStart = memAvail();
    memMin = memStart;
    timers.push(setInterval(() => {
      const a = memAvail();
      if (a != null && (memMin == null || a < memMin)) memMin = a;
      if (a != null && hdr && a < hdr.mem_floor_mb && !stopWhy) { stopWhy = "memory:" + a; killChild(); }
      if (hdr && Date.now() > hdr.deadline_ms && !stopWhy) { stopWhy = "time"; killChild(); }
    }, 250));
  };
  const stopError = (): [string, string] | null => {
    if (!stopWhy || !hdr) return null;
    if (stopWhy === "time") return ["time", `빌드가 시간 상한을 넘어 멈췄습니다(${Math.round((hdr.deadline_ms - started) / 1000)}초)`];
    return ["memory", `세션을 지키려고 빌드를 멈췄습니다 — 세션 안 남은 메모리가 ${stopWhy.slice(7)}MB 로 바닥(${hdr.mem_floor_mb}MB) 밑이었습니다. ` +
      "세션에서 다른 무거운 일을 멈추거나, 빌드가 쓰는 메모리를 줄이세요(예: 빌드 도구의 병렬 작업 수)"];
  };

  //  ── 단계 하나 = 자식 프로세스 하나(자기 프로세스 묶음 — 감시가 묶음째 죽인다) ──
  const run = (name: string, cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<number | null> => new Promise((resolve) => {
    say(`\n▶ ${name}: ${[cmd, ...args].join(" ")}`);
    const t = Date.now();
    let c: ChildProcess;
    try { c = cp.spawn(cmd, args, { cwd: app, env, stdio: ["ignore", "pipe", "pipe"], detached: true }); }
    catch (e) { steps.push({ name, ms: 0, code: null, signal: null }); say(`${name} 시작 실패: ${(e as Error).message}`); resolve(null); return; }
    child = c;
    c.stdout?.on("data", (d: Buffer) => { try { process.stderr.write(d); } catch { /* */ } });
    c.stderr?.on("data", (d: Buffer) => { try { process.stderr.write(d); } catch { /* */ } });
    c.on("error", (e) => say(`${name}: ${e.message}`));
    c.on("close", (code, signal) => {
      child = null;
      steps.push({ name, ms: Date.now() - t, code, signal: signal ?? null });
      resolve(signal ? null : code);
    });
  });

  //  ── zip(결정적) ──
  const CRC_TABLE = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
  const crc32 = (buf: Buffer, prev: number): number => {
    const z = zlib as unknown as { crc32?: (b: Buffer, p: number) => number };
    if (typeof z.crc32 === "function") return z.crc32(buf, prev) >>> 0;
    let c = (prev ^ -1) >>> 0;
    for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)) >>> 0;
    return (c ^ -1) >>> 0;
  };
  interface Ent { rel: string; abs: string; kind: "dir" | "file" | "link"; mode: number; size: number }
  //  /tmp 아래를 가리키는 링크 — Lambda 에서 쓸 수 있는 유일한 자리라(/var/task 는 읽기 전용) 허락한다(예 Next.js 의 .next/cache → /tmp/cache).
  //   그 자리는 Lambda 가 새로 뜰 때 비어 있으니 시작 스크립트가 시작 전에 만든다. 여기에 모은다.
  const tmpLinks = new Set<string>();
  const tmpTarget = (target: string): string | null => {
    if (!path.isAbsolute(target)) return null;
    const n = path.posix.normalize(target);
    return n === "/tmp" || n.startsWith("/tmp/") ? n : null;
  };
  const walk = (root: string): Ent[] => {
    const out: Ent[] = [];
    const go = (rel: string): void => {
      const dir = rel ? path.join(root, rel) : root;
      const names = fs.readdirSync(dir).sort();
      for (const n of names) {
        const r = rel ? rel + "/" + n : n;
        if (!rel && EXCLUDE.has(n)) continue;
        const abs = path.join(root, r);
        const st = fs.lstatSync(abs);
        if (st.isSymbolicLink()) {
          const target = fs.readlinkSync(abs);
          const to = path.resolve(path.dirname(abs), target);
          const tmp = tmpTarget(target);
          if (tmp) tmpLinks.add(tmp);
          else if (path.isAbsolute(target) || !(to === root || to.startsWith(root + path.sep))) {
            throw new Error(`zip 에 담을 수 없는 심링크입니다(올릴 폴더 밖을 가리킴 — /tmp 아래만 허락): ${r} → ${target}`);
          }
          out.push({ rel: r, abs, kind: "link", mode: 0o120777, size: Buffer.byteLength(target) });
        } else if (st.isDirectory()) {
          out.push({ rel: r, abs, kind: "dir", mode: 0o040755, size: 0 });
          go(r);
        } else if (st.isFile()) {
          out.push({ rel: r, abs, kind: "file", mode: 0o100000 | ((st.mode & 0o111) ? 0o755 : 0o644), size: st.size });
        }
        //  소켓 · FIFO 같은 것은 담지 않는다(빌드가 남긴 찌꺼기)
      }
    };
    go("");
    return out;
  };
  const writeZip = async (root: string, outFile: string, ents: Ent[]): Promise<number> => {
    const fd = fs.openSync(outFile, "w");
    let pos = 0;
    const central: Buffer[] = [];
    const put = (b: Buffer, at?: number): void => {
      if (at == null) { fs.writeSync(fd, b, 0, b.length, pos); pos += b.length; } else fs.writeSync(fd, b, 0, b.length, at);
    };
    const DOS_TIME = 0, DOS_DATE = (0 << 9) | (1 << 5) | 1;   // 1980-01-01 00:00 — 같은 내용이면 같은 zip
    try {
      for (const e of ents) {
        const name = Buffer.from(e.rel + (e.kind === "dir" ? "/" : ""), "utf8");
        if (pos > 0xfffffffe) throw new Error("zip 이 4GB 를 넘습니다");
        const at = pos;
        let method = 0, crc = 0, csize = 0, usize = 0;
        const lh = Buffer.alloc(30);
        lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
        lh.writeUInt16LE(DOS_TIME, 10); lh.writeUInt16LE(DOS_DATE, 12); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
        if (e.kind === "dir") {
          put(lh); put(name);
        } else if (e.kind === "link") {
          const data = Buffer.from(fs.readlinkSync(e.abs), "utf8");
          crc = crc32(data, 0); csize = usize = data.length;
          lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(csize, 18); lh.writeUInt32LE(usize, 22);
          put(lh); put(name); put(data);
        } else if (e.size <= 4 * 1024 * 1024) {
          const data = fs.readFileSync(e.abs);
          crc = crc32(data, 0); usize = data.length;
          const def = data.length ? zlib.deflateRawSync(data, { level: 6 }) : Buffer.alloc(0);
          const body = def.length < data.length ? def : data;
          method = body === def && data.length ? 8 : 0; csize = body.length;
          lh.writeUInt16LE(method, 8); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(csize, 18); lh.writeUInt32LE(usize, 22);
          put(lh); put(name); put(body);
        } else {
          //  큰 파일은 흘려서 압축한다(메모리에 통째로 올리지 않는다) — 머리의 crc · 크기는 다 쓴 뒤 제자리에 고친다.
          method = 8;
          lh.writeUInt16LE(method, 8);
          put(lh); put(name);
          await new Promise<void>((resolve, reject) => {
            const rs = fs.createReadStream(e.abs, { highWaterMark: 1024 * 1024 });
            const df = zlib.createDeflateRaw({ level: 6 });
            rs.on("data", (d) => { const b = d as Buffer; crc = crc32(b, crc); usize += b.length; });
            df.on("data", (d: Buffer) => { put(d); csize += d.length; });
            rs.on("error", reject); df.on("error", reject);
            df.on("end", () => resolve());
            rs.pipe(df);
          });
          const fix = Buffer.alloc(12);
          fix.writeUInt32LE(crc >>> 0, 0); fix.writeUInt32LE(csize, 4); fix.writeUInt32LE(usize, 8);
          put(fix, at + 14);
        }
        const ch = Buffer.alloc(46);
        ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE((3 << 8) | 20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
        ch.writeUInt16LE(method, 10); ch.writeUInt16LE(DOS_TIME, 12); ch.writeUInt16LE(DOS_DATE, 14);
        ch.writeUInt32LE(crc >>> 0, 16); ch.writeUInt32LE(csize, 20); ch.writeUInt32LE(usize, 24);
        ch.writeUInt16LE(name.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36);
        ch.writeUInt32LE(((e.mode << 16) | (e.kind === "dir" ? 0x10 : 0)) >>> 0, 38); ch.writeUInt32LE(at, 42);
        central.push(ch, name);
      }
      const cdAt = pos;
      for (const b of central) put(b);
      const cdSize = pos - cdAt;
      const n = ents.length;
      if (n > 0xffff) {
        //  Zip64 끝 기록 — 항목이 65,535 개를 넘는다(node_modules 가 크면 흔하다). 크기 · 위치는 4GB 안이라 항목별 Zip64 칸은 필요 없다.
        const z64At = pos;
        const z = Buffer.alloc(56);
        z.writeUInt32LE(0x06064b50, 0); z.writeBigUInt64LE(44n, 4); z.writeUInt16LE((3 << 8) | 45, 12); z.writeUInt16LE(45, 14);
        z.writeUInt32LE(0, 16); z.writeUInt32LE(0, 20); z.writeBigUInt64LE(BigInt(n), 24); z.writeBigUInt64LE(BigInt(n), 32);
        z.writeBigUInt64LE(BigInt(cdSize), 40); z.writeBigUInt64LE(BigInt(cdAt), 48);
        put(z);
        const loc = Buffer.alloc(20);
        loc.writeUInt32LE(0x07064b50, 0); loc.writeUInt32LE(0, 4); loc.writeBigUInt64LE(BigInt(z64At), 8); loc.writeUInt32LE(1, 16);
        put(loc);
      }
      const end = Buffer.alloc(22);
      end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
      end.writeUInt16LE(Math.min(n, 0xffff), 8); end.writeUInt16LE(Math.min(n, 0xffff), 10);
      end.writeUInt32LE(cdSize, 12); end.writeUInt32LE(cdAt, 16); end.writeUInt16LE(0, 20);
      put(end);
    } finally {
      fs.closeSync(fd);
    }
    return pos;
  };
  const sha256File = (file: string): Promise<Buffer> => new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(file).on("data", (d) => h.update(d as Buffer)).on("error", reject).on("end", () => resolve(h.digest()));
  });
  const upload = (url: string, file: string, size: number): Promise<void> => new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = (u.protocol === "http:" ? require("node:http") : require("node:https")) as typeof import("node:https");
    const rq = mod.request(u, { method: "PUT", headers: { "content-length": String(size) }, timeout: 120_000 }, (rs) => {
      let body = "";
      rs.setEncoding("utf8");
      rs.on("data", (d: string) => { if (body.length < 2000) body += d; });
      rs.on("end", () => {
        const st = rs.statusCode ?? 0;
        if (st >= 200 && st < 300) resolve();
        else { const e = new Error(`zip 올리기 실패(${st}): ${body.replace(/\s+/g, " ").slice(0, 300)}`) as Error & { status?: number }; e.status = st; reject(e); }
      });
    });
    rq.on("timeout", () => rq.destroy(new Error("zip 올리기 시간 초과")));
    rq.on("error", reject);
    fs.createReadStream(file).on("error", reject).pipe(rq);
  });

  //  ── 본 흐름 ──
  const build = async (): Promise<void> => {
    if (!hdr) return;
    const h = hdr;
    let pkg: { scripts?: Record<string, unknown>; dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> } = {};
    try { pkg = JSON.parse(fs.readFileSync(path.join(app, "package.json"), "utf8")); }
    catch { return fail("detect", "package.json 이 없거나 읽지 못했습니다 — 서버 앱은 package.json(과 start 명령 또는 매니페스트 web.server.start)이 필요합니다"); }
    const scripts = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
    const startCmd = h.start || (typeof scripts.start === "string" && scripts.start.trim() ? scripts.start.trim() : null);
    if (!startCmd) return fail("start", "시작 명령이 없습니다 — package.json 의 scripts.start 또는 매니페스트 web.server.start 에 서버를 띄우는 명령(예: node server.js)을 적으세요. 서버는 $PORT 에서 받아야 합니다");
    //  올릴 폴더 — 모양은 빌드 전에 본다(틀린 경로로 몇 분 빌드한 뒤 실패하지 않게).
    const dirRaw = h.dir == null ? "" : String(h.dir).trim().replace(/\/+$/, "");
    const dirRel = dirRaw === "" || dirRaw === "." ? null : safeRel(dirRaw);
    if (dirRaw !== "" && dirRaw !== "." && !dirRel) return fail("dir", `올릴 폴더(web.server.dir)는 앱 폴더 안 상대 경로여야 합니다(.. · 절대 경로 · 역슬래시 안 됨): ${dirRaw.slice(0, 200)}`);
    if (!dirRel) {
      for (const f of [RUN, START]) {
        if (fs.existsSync(path.join(app, f))) return fail("start", `앱 폴더 맨 위에 ${f} 가 있습니다 — 라이블리가 쓰는 이름이라 다른 이름으로 바꾸세요`);
      }
    }
    result.start_cmd = startCmd;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      npm_config_cache: "/tmp/.lively-npm-cache",   // 컨테이너 수명 동안 다시 쓰는 받기 캐시(세션 폴더 · JuiceFS 밖)
      npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false", npm_config_progress: "false",
      NO_COLOR: "1", FORCE_COLOR: "0",
    };
    if (h.heap_mb > 0) env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ? process.env.NODE_OPTIONS + " " : ""}--max-old-space-size=${h.heap_mb}`;
    const hasDeps = Object.keys(pkg.dependencies || {}).length + Object.keys(pkg.devDependencies || {}).length > 0;
    const lock = ["package-lock.json", "npm-shrinkwrap.json"].some((f) => fs.existsSync(path.join(app, f)));
    const install: "ci" | "install" | "none" = lock ? "ci" : hasDeps ? "install" : "none";
    result.install = install;
    if (install === "install") warnings.push("잠금 파일(package-lock.json)이 없어 npm install 로 설치했습니다 — 같은 판이라도 빌드마다 의존성 판이 달라질 수 있습니다");
    const step = async (name: string, args: string[], cmd = "npm"): Promise<boolean> => {
      const code = await run(name, cmd, args, env);
      const why = stopError();
      if (why) { fail(why[0], why[1]); return false; }
      if (code !== 0) { fail(name, `${name} 단계가 실패했습니다(종료 코드 ${code ?? "없음"}) — 아래 기록의 끝부분을 보세요`); return false; }
      return true;
    };
    if (install !== "none" && !(await step("install", install === "ci" ? ["ci", "--no-audit", "--no-fund"] : ["install", "--no-audit", "--no-fund"]))) return;
    const buildCmd = h.build || (typeof scripts.build === "string" && scripts.build.trim() ? "npm run build" : null);
    result.build_cmd = buildCmd;
    if (buildCmd && !(await step("build", ["-c", buildCmd], "sh"))) return;
    //  올릴 폴더면 그 폴더가 자기 완결이라 앱 폴더의 node_modules 는 올리지 않는다 — 정리(prune)도 필요 없다.
    if (install !== "none" && !dirRel && !(await step("prune", ["prune", "--omit=dev", "--no-audit", "--no-fund"]))) return;
    let root = app;
    if (dirRel) {
      root = path.join(app, dirRel);
      let st: import("node:fs").Stats | null = null;
      try { st = fs.lstatSync(root); } catch { /* 없다 */ }
      if (!st) return fail("dir", `빌드 뒤에 올릴 폴더(web.server.dir) ${dirRel} 가 없습니다 — 빌드가 그 폴더를 만드는지 보세요(예 Next.js 는 next.config 의 output:'standalone')`);
      if (!st.isDirectory()) return fail("dir", `올릴 폴더(web.server.dir) ${dirRel} 가 폴더가 아닙니다${st.isSymbolicLink() ? "(링크)" : ""}`);
      for (const f of [RUN, START]) {
        if (fs.existsSync(path.join(root, f))) return fail("start", `올릴 폴더 맨 위에 ${f} 가 있습니다 — 라이블리가 쓰는 이름이라 다른 이름으로 바꾸세요`);
      }
      result.dir = dirRel;
    }
    //  링크를 먼저 훑는다 — 폴더 밖 링크는 여기서 거부하고 /tmp 링크는 시작 스크립트가 만들 자리로 모은다.
    try { walk(root); } catch (e) { return fail("zip", (e as Error).message); }
    const q = (v: string): string => "'" + v.replace(/'/g, "'\\''") + "'";
    const mk = [...tmpLinks].sort().filter((t) => t !== "/tmp");
    //  시작 스크립트 — Lambda 의 핸들러(RUN)가 올릴 폴더(zip 맨 위)에서 START 를 sh 로 돌린다. PATH 에 node_modules/.bin 을 앞세운다(npm start 와 같게 —
    //   Lambda 런타임에 npm 이 있다고 기대하지 않는다).
    fs.writeFileSync(path.join(root, RUN),
      "#!/bin/sh\n# 라이블리가 더한 시작 스크립트(#4484) — 앱 서버는 $PORT 에서 받는다.\n" +
      "cd \"${LAMBDA_TASK_ROOT:-$(dirname \"$0\")}\" || exit 1\nPATH=\"$PWD/node_modules/.bin:$PATH\"\nexport PATH\n" +
      (mk.length ? "mkdir -p " + mk.map(q).join(" ") + "\n" : "") +
      "exec /bin/sh ./" + START + "\n", { mode: 0o755 });
    fs.writeFileSync(path.join(root, START), startCmd + "\n", { mode: 0o644 });
    let ents: Ent[];
    try { ents = walk(root); } catch (e) { return fail("zip", (e as Error).message); }
    const unzipped = ents.reduce((n, e) => n + e.size, 0);
    if (unzipped > h.unzipped_max) {
      const mb = (n: number): string => (n / 1048576).toFixed(1) + "MB";
      const big = new Map<string, number>();
      for (const e of ents) { const m = /^node_modules\/(@[^/]+\/[^/]+|[^/]+)/.exec(e.rel); if (m) big.set(m[1]!, (big.get(m[1]!) ?? 0) + e.size); }
      const top = [...big.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k} ${mb(v)}`).join(" · ");
      const standalone = big.has("next") ? " · Next.js 는 next.config 에 output:'standalone' 을 두고 매니페스트 web.server.dir 을 \".next/standalone\" 으로 하면 그 폴더만 올립니다" : "";
      return fail("size", `빌드 결과가 너무 큽니다(풀린 크기 ${mb(unzipped)} > ${mb(h.unzipped_max)}) — 개발용 도구가 dependencies 에 들어가 있지 않은지 보세요${top ? ` (큰 의존성: ${top})` : ""}` +
        `${standalone} · 빌드가 자기 완결 출력 폴더를 만들면 web.server.dir 로 그 폴더만 올릴 수 있습니다`);
    }
    const zipFile = path.join(base, "server.zip");
    let bytes: number;
    const tz = Date.now();
    try { bytes = await writeZip(root, zipFile, ents); } catch (e) { return fail("zip", `zip 을 만들지 못했습니다: ${(e as Error).message}`); }
    steps.push({ name: "zip", ms: Date.now() - tz, code: 0, signal: null });
    const why = stopError();
    if (why) return fail(why[0], why[1]);
    const digest = await sha256File(zipFile);
    const tu = Date.now();
    let lastErr: Error | null = null;
    for (let i = 0; i < 3; i++) {
      try { await upload(h.upload_url, zipFile, bytes); lastErr = null; break; }
      catch (e) {
        lastErr = e as Error;
        const st = (e as { status?: number }).status ?? 0;
        if (st >= 400 && st < 500) break;   // 서명 만료 · 권한 — 다시 해도 같다
        await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
      }
    }
    steps.push({ name: "upload", ms: Date.now() - tu, code: lastErr ? 1 : 0, signal: null });
    if (lastErr) return fail("upload", lastErr.message);
    finish({ ok: true, zip: { bytes, sha256_hex: digest.toString("hex"), sha256_b64: digest.toString("base64"), entries: ents.length, unzipped } });
  };

  //  ── 입력 받기(길이를 아는 틀 — EOF 를 기다리지 않는다) ──
  let buf: Buffer = Buffer.alloc(0);
  let fi = 0;
  let left = 0;
  let fdOut = -1;
  let lastData = Date.now();
  let reading = true;
  const safeRel = (raw: string): string | null => {
    const s = String(raw || "");
    if (!s || s.includes("\\") || s.includes("\0") || s.startsWith("/")) return null;
    const parts = s.split("/").filter((x) => x !== "" && x !== ".");
    if (!parts.length || parts.some((x) => x === "..")) return null;
    return parts.join("/");
  };
  const openNext = (): boolean => {
    while (hdr && fi < hdr.files.length && fdOut < 0) {
      const ent = hdr.files[fi]!;
      const rel = safeRel(ent[0]);
      if (!rel) { fail("input", `판 파일 경로가 틀렸습니다: ${String(ent[0]).slice(0, 200)}`); return false; }
      const abs = path.join(app, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fdOut = fs.openSync(abs, "wx");
      left = Number(ent[1]) || 0;
      if (left === 0) { fs.closeSync(fdOut); fdOut = -1; fi++; }
    }
    return true;
  };
  const endInput = (): void => {
    reading = false;
    process.stdin.removeAllListeners("data");
    process.stdin.pause();
    startWatch();
    void build().catch((e) => fail("build", `빌더 오류: ${(e as Error)?.stack ?? e}`));
  };
  const consume = (chunk: Buffer): void => {
    let off = 0;
    while (hdr && fi < hdr.files.length) {
      if (fdOut < 0 && !openNext()) return;
      if (fi >= hdr.files.length) break;
      if (off >= chunk.length) return;
      const take = Math.min(left, chunk.length - off);
      fs.writeSync(fdOut, chunk, off, take);
      left -= take; off += take;
      if (left === 0) { fs.closeSync(fdOut); fdOut = -1; fi++; }
    }
    if (hdr && fi >= hdr.files.length && reading) endInput();
  };
  process.stdin.on("data", (d: Buffer) => {
    if (done || !reading) return;
    lastData = Date.now();
    try {
      if (hdr) return consume(d);
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      const nl = buf.indexOf(10);
      if (nl < 0) { if (buf.length > 32 * 1024 * 1024) fail("input", "입력 머리가 너무 깁니다"); return; }
      hdr = JSON.parse(buf.subarray(0, nl).toString("utf8"));
      const rest = buf.subarray(nl + 1);
      buf = Buffer.alloc(0);
      if (!hdr || !Array.isArray(hdr.files) || typeof hdr.upload_url !== "string") return fail("input", "입력 머리 모양이 틀렸습니다");
      base = fs.mkdtempSync("/tmp/lively-build-");
      app = path.join(base, "app");
      fs.mkdirSync(app);
      say(`판 파일 ${hdr.files.length}개를 임시 폴더에 풉니다`);
      if (!openNext()) return;
      consume(rest);
    } catch (e) { fail("input", `입력을 풀지 못했습니다: ${(e as Error).message}`); }
  });
  process.stdin.on("error", (e) => { if (reading) fail("input", `입력 오류: ${e.message}`); });
  timers.push(setInterval(() => { if (reading && Date.now() - lastData > 120_000) fail("input", "입력이 2분 동안 멈췄습니다"); }, 5000));
  process.on("SIGTERM", () => fail(stopWhy ? "time" : "input", "빌더가 종료 신호를 받았습니다"));
}
/* eslint-enable */

/** 세션 컨테이너에서 `node -e` 로 돌릴 글. */
export const SERVER_BUILDER_JS = `"use strict";(${builderMain.toString()})()`;

/** stdout 전체 → 결과(마지막 표식 줄). 없으면 null(빌더가 결과를 못 남기고 죽었다). */
export function parseBuildResult(stdout: string): BuildResult | null {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (!l.startsWith(BUILD_RESULT_MARK)) continue;
    try {
      const r = JSON.parse(l.slice(BUILD_RESULT_MARK.length)) as BuildResult;
      if (r && typeof r === "object" && typeof r.ok === "boolean") return { ...r, steps: Array.isArray(r.steps) ? r.steps : [], warnings: Array.isArray(r.warnings) ? r.warnings : [] };
    } catch { /* 깨진 줄 — 앞을 더 본다 */ }
  }
  return null;
}

/** 입력 머리 한 줄(바이트) — 그 뒤에 header.files 순서대로 파일 바이트를 붙인다. */
export function encodeBuildHeader(h: BuildHeader): Buffer {
  return Buffer.from(JSON.stringify(h) + "\n", "utf8");
}
