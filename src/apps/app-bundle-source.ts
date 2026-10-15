// 판 묶음의 입구·출구(#4481 앱 v2-2) — 세션 프로젝트 폴더 ⇄ 설치 스테이지, 그리고 지문으로 가리킨 파일(ref) 풀기.
//
//  왜: 여러 파일 앱은 세션에서 빌드한다(`npm run build` → dist/). 압축된 JS 를 AI 가 도구 호출 본문에 옮겨 적을 수는 없다(수십만 토큰 ·
//   한 글자만 틀려도 깨진다) — 그래서 app_save {dir} 이면 게이트웨이가 **그 세션의 프로젝트 폴더를 직접** 읽는다. 매니지드는 게이트웨이가
//   CP 박스에 있어 세션 폴더가 로컬이 아니다 — 프로젝트 저장소(project-storage)가 고르는 그 사람의 멤버 경계(테넌트 파일 op 중계)로 읽는다.
//   반대로 app_pull {dir} 은 판을 그 폴더에 풀어 준다(남의 큰 앱으로 사본을 뜰 때).
//  읽는 규칙: 그 폴더 아래 일반 파일 전부 — 숨김(점으로 시작: .git · .env …)·node_modules·심링크는 뺀다. lively-app.json 이 폴더 맨 위에 있어야 한다.
//   멤버 쪽에서 도는 node 한 줄(WALK_JS · READ_JS)은 우리 코드의 고정 리터럴이고 값은 전부 stdin JSON 이다(terminal-member-fs memberNodeJson 규약).
//   로컬(저장소가 게이트웨이에 붙은 배포)도 **같은 한 줄**을 게이트웨이의 node 로 돌린다 — 두 구현이 갈라지지 않게.
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HttpError } from "../http-error.js";
import { memberNodeJson } from "../terminal/terminal-member-fs.js";
import type { StagedSource } from "./install-source.js";
import { getBlob, SHA256_RE, defaultBlobStoreKind } from "./app-blob-store.js";
import { normalizeBundlePath, type AppBundle } from "./app-bundle.js";
import { bundleLimitDenial, policyBytes, type AppBundlePolicy } from "./app-bundle-policy.js";
import type { BlobStoreKind } from "./app-blob-store.js";

/**
 * 세션 폴더 걷기(멤버 쪽 한 줄) — 입력 {base, maxFiles, maxBytes} · 출력 {files:[[상대경로, 크기]], skipped:[상대경로], err}. 상한을 넘으면 그 자리에서 멈춘다.
 *  빼는 것: 숨김(점으로 시작 — .git · .env …) · node_modules · 심링크 · 비밀 열쇠 꼴 파일(*.pem · *.key · *.p12 · *.pfx · *.jks · id_rsa …).
 *  ⓘ 입력은 utf8 로 받는다(한글 경로가 64KB 조각 경계에 걸려도 안 깨지게 — project-storage stdinJs 와 같은 규칙).
 */
export const WALK_JS = "const fs=require('fs'),P=require('path');let i='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>i+=c).on('end',()=>{const a=JSON.parse(i);" +
  "const out=[],skipped=[];let total=0,err=null;" +
  "const secret=n=>/\\.(pem|key|p12|pfx|jks|keystore)$/i.test(n)||/^id_(rsa|dsa|ecdsa|ed25519)(\\.pub)?$/.test(n);" +
  "const w=(d,r,depth)=>{if(err)return;if(depth>32){err='too_deep';return}let es;try{es=fs.readdirSync(d,{withFileTypes:true})}catch(e){err='unreadable:'+(r||'.');return}" +
  "es.sort((x,y)=>x.name<y.name?-1:x.name>y.name?1:0);" +
  "for(const e of es){if(err)return;if(e.name.startsWith('.')||e.name==='node_modules')continue;const rr=r?r+'/'+e.name:e.name;const ab=P.join(d,e.name);" +
  "let st;try{st=fs.lstatSync(ab)}catch{continue}if(st.isSymbolicLink())continue;if(st.isDirectory()){w(ab,rr,depth+1);continue}if(!st.isFile())continue;" +
  "if(secret(e.name)){if(skipped.length<50)skipped.push(rr);continue}" +
  "out.push([rr,st.size]);total+=st.size;if(out.length>a.maxFiles){err='too_many';return}if(total>a.maxBytes){err='too_big';return}}};" +
  "let st;try{st=fs.statSync(a.base)}catch{process.stdout.write(JSON.stringify({files:[],skipped,err:'missing'}));return}" +
  "if(!st.isDirectory()){process.stdout.write(JSON.stringify({files:[],skipped,err:'not_dir'}));return}" +
  "w(a.base,'',0);process.stdout.write(JSON.stringify({files:out,skipped,err}))})";

/**
 * 파일 몇 개 읽기(멤버 쪽 한 줄) — 입력 {base, paths} · 출력 {files:[[상대경로, base64]], err}.
 *  ★ 실제 경로(realpath)가 폴더 안이어야 읽는다 — 글자로만 보면 중간 폴더가 심링크일 때 폴더 밖 파일을 읽는다(격리 리뷰 B4 ·
 *   자가호스팅 로컬 길은 게이트웨이 권한으로 돈다). 마지막 조각이 심링크·파일 아님이면 읽지 않는다.
 */
export const READ_JS = "const fs=require('fs'),P=require('path');let i='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>i+=c).on('end',()=>{const a=JSON.parse(i);" +
  "const base=P.resolve(a.base);let real;try{real=fs.realpathSync(base)}catch{process.stdout.write(JSON.stringify({files:[],err:'missing:.'}));return}" +
  "const inside=p=>p===real||p.startsWith(real+P.sep);const out=[];let err=null;for(const r of a.paths){const ab=P.resolve(base,r);" +
  "if(!ab.startsWith(base+P.sep)){err='outside:'+r;break}let st;try{st=fs.lstatSync(ab)}catch{err='missing:'+r;break}" +
  "if(st.isSymbolicLink()||!st.isFile()){err='not_file:'+r;break}let rp;try{rp=fs.realpathSync(ab)}catch{err='missing:'+r;break}" +
  "if(!inside(rp)){err='outside:'+r;break}out.push([r,fs.readFileSync(ab).toString('base64')])}" +
  "process.stdout.write(JSON.stringify({files:out,err}))})";

/**
 * 판 파일 몇 개 쓰기(멤버 쪽 한 줄) — 입력 {base, files:[[상대경로, base64]]} · 출력 {written, err}. 폴더 밖·이미 있는 파일은 쓰지 않는다.
 *  ★ 만들 폴더의 «있는 가장 깊은 조상» 과 만든 뒤의 폴더가 실제 경로로 폴더 안이어야 쓴다 — 미리 심어 둔 심링크 하위 폴더로
 *   폴더 밖에 쓰지 못하게(격리 리뷰 B4). 파일은 wx(있으면 실패 · 심링크 이름도 «있음» 이다).
 */
export const WRITE_JS = "const fs=require('fs'),P=require('path');let i='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>i+=c).on('end',()=>{const a=JSON.parse(i);" +
  "const base=P.resolve(a.base);let n=0,err=null;let real;try{fs.mkdirSync(base,{recursive:true});real=fs.realpathSync(base)}catch(e){process.stdout.write(JSON.stringify({written:0,err:'base:'+(e&&e.code)}));return}" +
  "const inside=p=>p===real||p.startsWith(real+P.sep);" +
  "for(const [r,b] of a.files){const ab=P.resolve(base,r);if(!ab.startsWith(base+P.sep)){err='outside:'+r;break}" +
  "try{let anc=P.dirname(ab);while(anc!==base&&!fs.existsSync(anc))anc=P.dirname(anc);if(!inside(fs.realpathSync(anc))){err='outside:'+r;break}" +
  "fs.mkdirSync(P.dirname(ab),{recursive:true});if(!inside(fs.realpathSync(P.dirname(ab)))){err='outside:'+r;break}" +
  "fs.writeFileSync(ab,Buffer.from(b,'base64'),{flag:'wx'});n++}catch(e){err=(e&&e.code==='EEXIST'?'exists:':'write:')+r;break}}" +
  "process.stdout.write(JSON.stringify({written:n,err}))})";

/** 폴더를 보는 자리 — 멤버 경계(osUser) 또는 게이트웨이 로컬. */
export interface DirAccess { base: string; osUser: string | null }

/** 같은 한 줄을 멤버 경계 또는 게이트웨이 node 로 돌린다. */
export async function runDirJs<T>(acc: DirAccess, js: string, input: unknown): Promise<T> {
  if (acc.osUser) return memberNodeJson<T>(acc.osUser, js, input);
  return new Promise<T>((resolve, reject) => {
    const c = spawn(process.execPath, ["-e", js], { stdio: ["pipe", "pipe", "pipe"] });
    //  글자로 받는다 — 조각마다 바이트를 글로 풀면 한글 이름이 조각 경계에서 깨진다(격리 리뷰 재검토 4 · 멤버 경계 길은 collectText 가 같은 일).
    c.stdout.setEncoding("utf8");
    c.stderr.setEncoding("utf8");
    let out = "", err = "";
    c.stdout.on("data", (d) => { out += d; });
    c.stderr.on("data", (d) => { err += d; });
    c.on("error", reject);
    c.on("close", (code) => {
      if (code !== 0) return reject(new Error(err.trim() || `node exit ${code}`));
      try { resolve(JSON.parse(out || "null") as T); } catch (e) { reject(e as Error); }
    });
    c.stdin.end(JSON.stringify(input));
  });
}

/** 걷기 결과의 err → 사람에게 보일 까닭. */
function walkError(err: string, dirShown: string, p: AppBundlePolicy): string {
  if (err === "missing") return `폴더가 없습니다: ${dirShown}`;
  if (err === "not_dir") return `폴더가 아닙니다: ${dirShown}`;
  if (err === "too_many") return `파일이 너무 많습니다(> ${p.files_max}개) — node_modules 같은 큰 폴더가 섞이지 않았는지 보세요(숨김 폴더와 node_modules 는 이미 뺍니다)`;
  if (err === "too_big") return `폴더가 너무 큽니다(> ${p.version_max_mb}MB) — 판 상한(app_bundle_limits version_max_mb)`;
  if (err === "too_deep") return "폴더가 너무 깊습니다(32단 초과)";
  return `폴더를 읽지 못했습니다(${err})`;
}

/** 읽기 묶음 크기 — 한 번에 base64 로 이만큼씩(멤버 경계 왕복을 줄이되 메모리를 붙들지 않게). */
const READ_BATCH_BYTES = 8 * 1024 * 1024;

/**
 * 세션 폴더 → 설치 스테이지(임시 폴더). 판 상한(판 하나 · 파일 하나 · 파일 수)을 걷는 자리에서 먼저 본다.
 *  dirShown — 오류 문구에 보일 경로(사람이 준 그대로).
 */
export async function stageFromDir(acc: DirAccess, dirShown: string, policy: AppBundlePolicy): Promise<StagedSource> {
  const b = policyBytes(policy);
  const walk = await runDirJs<{ files: Array<[string, number]>; skipped?: string[]; err: string | null }>(acc, WALK_JS, { base: acc.base, maxFiles: b.files, maxBytes: b.version });
  if (walk.err) throw new HttpError(walk.err === "missing" || walk.err === "not_dir" ? 404 : 413, walkError(walk.err, dirShown, policy));
  const files = walk.files.map(([p, s]) => ({ path: p, size: s }));
  if (!files.some((f) => f.path === "lively-app.json")) throw new HttpError(400, `그 폴더 맨 위에 lively-app.json 이 없습니다: ${dirShown} — 앱 폴더(매니페스트가 있는 곳)를 주세요`);
  const deny = bundleLimitDenial(policy, files);
  if (deny) throw new HttpError(413, deny);
  const tmp = await mkdtemp(path.join(os.tmpdir(), "lively-app-dir-"));
  const cleanup = async (): Promise<void> => { await rm(tmp, { recursive: true, force: true }).catch(() => { /* noop */ }); };
  try {
    let batch: string[] = [], bytes = 0;
    const flush = async (): Promise<void> => {
      if (!batch.length) return;
      const r = await runDirJs<{ files: Array<[string, string]>; err: string | null }>(acc, READ_JS, { base: acc.base, paths: batch });
      if (r.err) throw new HttpError(409, `읽는 사이 폴더가 바뀌었습니다(${r.err}) — 빌드가 끝난 뒤 다시 저장하세요`);
      for (const [rel, b64] of r.files) {
        const norm = normalizeBundlePath(rel);
        if (!norm) throw new HttpError(400, `파일 경로가 틀렸습니다: ${rel}`);
        const abs = path.resolve(tmp, norm);
        if (!abs.startsWith(tmp + path.sep)) throw new HttpError(400, `파일 경로가 폴더 밖을 가리킵니다: ${rel}`);
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, Buffer.from(b64, "base64"), { flag: "wx" });
      }
      batch = []; bytes = 0;
    };
    for (const f of files) {
      if (batch.length && bytes + f.size > READ_BATCH_BYTES) await flush();
      batch.push(f.path); bytes += f.size;
    }
    await flush();
  } catch (e) { await cleanup(); throw e; }
  const total = files.reduce((n, f) => n + f.size, 0);
  //  뺀 비밀 열쇠 꼴 파일은 이름만 남긴다(내용은 안 읽었다) — 저장 응답의 app.source 로 사람이 무엇이 빠졌는지 안다.
  const skipped = walk.skipped ?? [];
  return { dir: tmp, meta: { kind: "inline", files: files.length, bytes: total, from: "dir", ...(skipped.length ? { skipped } : {}) }, cleanup };
}

/**
 * 스테이지 meta 에서 뺀 비밀 열쇠 꼴 파일 이름을 걷어 낸다(순수 · meta 를 고친다) — 그 이름은 저장 응답에만 싣는다.
 *  meta 는 설치가 앱 행의 source 로 남기므로(앱을 보는 모두에게 보인다) 거기엔 두지 않는다.
 */
export function takeSkipped(meta: object): string[] {
  const m = meta as { skipped?: unknown };
  const out = Array.isArray(m.skipped) ? m.skipped.map(String) : [];
  delete m.skipped;
  return out;
}

/** 쓸 파일 하나 — 경로 · 크기 · 내용을 읽는 길(판 묶음은 저장소에서, 옛 판은 손에 쥔 내용에서). */
export interface FileToWrite { p: string; s: number; read: () => Promise<Buffer> }

/** 판 묶음의 파일 → 쓸 파일(저장소에서 읽는다). */
export function bundleFilesToWrite(kind: BlobStoreKind, bundle: AppBundle): FileToWrite[] {
  return bundle.files.map((f) => ({ p: f.p, s: f.s, read: async () => {
    const b = await getBlob(kind, f.h);
    if (!b) throw new HttpError(503, `판 파일을 저장소에서 찾지 못했습니다: ${f.p}`);
    return b;
  } }));
}

/** 판 파일 → 세션 폴더(app_pull {dir}). 그 폴더는 없거나 비어 있어야 한다(남의 파일을 덮지 않는다). 반환 = 쓴 파일 수. */
export async function writeFilesToDir(acc: DirAccess, dirShown: string, items: ReadonlyArray<FileToWrite>): Promise<number> {
  const walk = await runDirJs<{ files: Array<[string, number]>; skipped?: string[]; err: string | null }>(acc, WALK_JS, { base: acc.base, maxFiles: 1, maxBytes: Number.MAX_SAFE_INTEGER });
  if (walk.err && walk.err !== "missing") {
    throw new HttpError(409, walk.err === "not_dir" ? `그 자리에 폴더가 아닌 것이 있습니다: ${dirShown}` : `그 폴더가 비어 있지 않습니다: ${dirShown} — 새 폴더 이름을 주세요`);
  }
  if (walk.files.length) throw new HttpError(409, `그 폴더가 비어 있지 않습니다: ${dirShown} — 새 폴더 이름을 주세요`);
  let written = 0;
  let batch: Array<[string, string]> = [], bytes = 0;
  const flush = async (): Promise<void> => {
    if (!batch.length) return;
    const r = await runDirJs<{ written: number; err: string | null }>(acc, WRITE_JS, { base: acc.base, files: batch });
    written += r.written;
    if (r.err) throw new HttpError(409, `세션 폴더에 쓰지 못했습니다(${r.err}) — ${written}개를 쓴 뒤 멈췄습니다`);
    batch = []; bytes = 0;
  };
  for (const f of items) {
    const b = await f.read();
    if (batch.length && bytes + f.s > READ_BATCH_BYTES) await flush();
    batch.push([f.p, b.toString("base64")]); bytes += f.s;
  }
  await flush();
  return written;
}

/** app_save files 한 줄 — 내용(content) 또는 지문(sha256 — 이 워크스페이스에 이미 있는 파일을 가리킨다). */
export interface SaveFileInput { path: string; content?: string; encoding?: "utf8" | "base64"; sha256?: string }

/** files 에 지문으로 가리킨 줄이 하나라도 있나 — 없으면 종전 inline 길(옛 상한)을 그대로 탄다. */
export const hasRefFiles = (files: ReadonlyArray<SaveFileInput>): boolean => files.some((f) => typeof f.content !== "string" && typeof f.sha256 === "string");

/**
 * 내용 + 지문 섞인 files → 설치 스테이지. 내용이 있으면 내용이 이긴다(앱 만들기 화면이 내려받은 줄의 매니페스트만 고쳐 다시 올린다 —
 *  그 줄엔 옛 지문이 남아 있다). 내용 없는 줄의 지문은 이 워크스페이스 저장소에 있어야 한다(없으면 404). 판 상한으로 본다.
 */
export async function stageFromRefs(files: ReadonlyArray<SaveFileInput>, policy: AppBundlePolicy, kind: BlobStoreKind = defaultBlobStoreKind()): Promise<StagedSource> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "lively-app-refs-"));
  const cleanup = async (): Promise<void> => { await rm(tmp, { recursive: true, force: true }).catch(() => { /* noop */ }); };
  try {
    const seen = new Set<string>();
    const sizes: Array<{ path: string; size: number }> = [];
    for (const f of files) {
      const rel = normalizeBundlePath(f.path);
      if (!rel || rel.split("/").includes(".git")) throw new HttpError(400, `파일 경로가 틀렸습니다: ${String(f.path).slice(0, 200)}`);
      if (seen.has(rel)) throw new HttpError(400, `파일 경로가 중복입니다: ${rel}`);
      seen.add(rel);
      let bytes: Buffer;
      if (typeof f.content === "string") {
        bytes = Buffer.from(f.content, f.encoding === "base64" ? "base64" : "utf8");
      } else {
        const h = String(f.sha256 ?? "").toLowerCase();
        if (!SHA256_RE.test(h)) throw new HttpError(400, `파일 '${rel}' 에 content 도 sha256 도 없습니다`);
        const b = await getBlob(kind, h);
        if (!b) throw new HttpError(404, `파일 '${rel}' 이 가리킨 내용(${h.slice(0, 12)}…)이 이 워크스페이스에 없습니다 — content 로 올리세요`);
        bytes = b;
      }
      sizes.push({ path: rel, size: bytes.length });
      const deny = bundleLimitDenial(policy, sizes);
      if (deny) throw new HttpError(413, deny);
      const abs = path.resolve(tmp, rel);
      if (!abs.startsWith(tmp + path.sep)) throw new HttpError(400, `파일 경로가 묶음 밖을 가리킵니다: ${rel}`);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, bytes, { flag: "wx" });
    }
    if (!seen.has("lively-app.json")) throw new HttpError(400, "파일 묶음에 lively-app.json(매니페스트)이 없습니다");
    return { dir: tmp, meta: { kind: "inline", files: sizes.length, bytes: sizes.reduce((n, x) => n + x.size, 0) }, cleanup };
  } catch (e) { await cleanup(); throw e; }
}
