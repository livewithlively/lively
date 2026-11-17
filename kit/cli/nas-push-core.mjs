// 이 기계의 파일·폴더를 NAS 로 올린다 — lively-mcp-local.mjs 의 lively_local_nas_push 본체.
//  게이트웨이의 올리기(PUT /api/ui/me/nas/upload)·nas_manage(mkdir)·nas_list 를 그 구성원 토큰으로 부른다. 올릴 수 있는 자리는
//  게이트웨이가 그 구성원 본인 FTP 계정 권한으로 정한다 — 여기선 권한을 판단하지 않는다.
//
//  · 같은 이름이 NAS 에 있으면 기본은 덮지 않는다(overwrite:true 일 때만). 크기가 같으면 «이미 올림»으로 세고, 다르면 conflicts 로 알린다.
//  · budgetMs 를 넘기면 새 파일을 시작하지 않고 멈춘다(nas-pull-core.mjs 와 같은 이유·같은 상한 — 예산 + 파일 하나의 FILE_TIMEOUT_MS).
//    다시 부르면 이미 올린 것은 같은 크기로 건너뛰어 이어 올린다.
//  · 올릴 수 있는 자리는 홈 아래만이다(받기는 그보다 좁은 ~/NAS사본 아래만 — 받기는 사람 확인 없는 자동승인 도구라 쓰는 자리를 좁혔다,
//    nas-pull-core.mjs resolveDest). 숨김 마디(.ssh·.aws·.git·.env …)와 운영체제 비밀 자리는 거부하고,
//    폴더를 펼칠 때도 숨김 항목은 건너뛴다 — NAS 문서에 심은 지시가 자격 증명을 올리게 하지 못하게(이 도구는 사람 확인을 받지만 겹으로 막는다).
//  · 로컬 링크는 따라가지 않는다 — 폴더 링크가 고리를 만들거나 의도하지 않은 자리(홈 밖)를 통째로 올리지 않게.
import { lstatSync, readdirSync, createReadStream, realpathSync } from "node:fs";
import { join, resolve, basename, relative, isAbsolute, sep } from "node:path";
import { homedir } from "node:os";
import { Readable } from "node:stream";
import { modeHeader } from "./nas-pull-core.mjs";

export const DEFAULT_BUDGET_MS = 50_000;
export const MAX_FILES = 3000;
export const FILE_TIMEOUT_MS = 10 * 60_000;

/** 부모 폴더의 p 아래 이름 하나의 p — 원본 바이트에 «/이름(UTF-8)» 을 잇는다(새 이름은 UTF-8 로 만든다). */
export function childP(parentP, name) {
  const parent = Buffer.from(String(parentP), "base64url");
  const sep = parent.length === 1 && parent[0] === 0x2f ? "" : "/";
  return Buffer.concat([parent, Buffer.from(sep + String(name).normalize("NFC"), "utf8")]).toString("base64url");
}

/** 사람이 읽는 경로(UTF-8)를 p 로(nas-pull-core.mjs pOfPath 와 같은 꼴). */
export const pOfPath = (path) => Buffer.from(String(path).startsWith("/") ? String(path) : `/${path}`, "utf8").toString("base64url");

// 홈 바로 아래에서 운영체제가 자격·키체인·브라우저 쿠키를 두는 자리(숨김이 아니라 숨김 규칙에 안 걸리는 것만). 대소문자 무시.
const SECRET_TOP_DIRS = new Set(["library", "appdata"]);
const isHidden = (name) => name.startsWith(".");

/**
 * 올릴 로컬 경로(실제 경로)를 정한다. 홈 아래만 되고 홈 자체·숨김 마디·운영체제 비밀 자리는 Error.
 *  링크는 실제 경로로 풀어 판정한다 — 홈 안의 링크가 ~/.aws 나 홈 밖을 가리켜도 막힌다. src 자체가 링크면 그것도 Error(종전 규칙).
 */
export function resolveSrc(src, { cwd, home }) {
  const given = resolve(cwd, String(src));
  if (lstatSync(given).isSymbolicLink()) throw new Error(`링크는 올리지 않습니다: ${given}`);
  const homeReal = realpathSync(home);
  const real = realpathSync(given);
  const rel = relative(homeReal, real);
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error(`올릴 파일·폴더는 홈(${homeReal}) 아래만 됩니다(홈 자체는 안 됩니다): ${given}`);
  }
  const segs = rel.split(sep);
  if (segs.some(isHidden)) throw new Error(`숨김 파일·폴더(. 으로 시작하는 이름)는 올리지 않습니다 — 자격 증명이 흔히 거기 있습니다: ${given}`);
  if (SECRET_TOP_DIRS.has(segs[0].toLowerCase())) throw new Error(`운영체제 설정·자격 자리(~/${segs[0]})는 올리지 않습니다: ${given}`);
  return real;
}

/**
 * 로컬 src 를 펼쳐 올릴 계획을 만든다. 폴더면 그 폴더 이름부터 구조를 유지한다. 링크는 건너뛰고 links 로, 숨김 항목은 들어가지 않고 hidden 으로 센다.
 *  → { dirs: [[마디...]] (만들 원격 폴더, 얕은 것부터), files: [{ local, rel: [마디...], size }], links, hidden, truncated }
 */
export function planLocal(src, { maxFiles = MAX_FILES } = {}) {
  const st = lstatSync(src);
  if (st.isSymbolicLink()) throw new Error(`링크는 올리지 않습니다: ${src}`);
  if (st.isFile()) return { dirs: [], files: [{ local: src, rel: [basename(src)], size: st.size }], links: 0, hidden: 0, truncated: null };
  if (!st.isDirectory()) throw new Error(`파일이나 폴더가 아닙니다: ${src}`);
  const dirs = [[basename(src)]], files = [];
  let links = 0, hidden = 0, truncated = null;
  const queue = [{ local: src, rel: [basename(src)] }];
  while (queue.length && !truncated) {
    const d = queue.shift();
    let names;
    try { names = readdirSync(d.local).sort(); } catch { continue; }
    for (const n of names) {
      if (isHidden(n)) { hidden++; continue; }
      const local = join(d.local, n);
      let s;
      try { s = lstatSync(local); } catch { continue; }
      if (s.isSymbolicLink()) { links++; continue; }
      if (s.isDirectory()) { dirs.push([...d.rel, n]); queue.push({ local, rel: [...d.rel, n] }); }
      else if (s.isFile()) {
        if (files.length >= MAX_FILES || files.length >= maxFiles) { truncated = `파일 ${Math.min(maxFiles, MAX_FILES)}개 상한`; break; }
        files.push({ local, rel: [...d.rel, n], size: s.size });
      }
    }
  }
  return { dirs, files, links, hidden, truncated };
}

/**
 * MCP 도구 본체. ctx 는 lively-mcp-local.mjs makeCtx 의 것(api·gateway·token·cwd), fetchImpl 은 그 파일의 fetch.
 *  args: { src: 로컬 경로(cwd 상대 가능), dest_p?: NAS 폴더 p, dest_path?: NAS 폴더 경로, overwrite?: boolean }
 */
export async function nasPush(ctx, args, { fetchImpl, budgetMs = DEFAULT_BUDGET_MS, now = Date.now, maxFiles = MAX_FILES, home = homedir(), env = process.env } = {}) {
  const started = now();
  const mode = modeHeader(env);
  // 게이트웨이도 올리기(PUT)를 막지만 폴더 만들기는 모드 머리글 없이 나가므로 여기서 먼저 멈춘다
  if (["readonly", "incognito"].includes(mode["x-lively-mode"])) throw new Error(`${mode["x-lively-mode"]} 세션에서는 NAS 에 올리지 않습니다(#1007)`);
  if (!args.src) throw new Error("올릴 로컬 파일·폴더(src)가 필요합니다");
  const destP = args.dest_p ? String(args.dest_p) : args.dest_path ? pOfPath(args.dest_path) : null;
  if (!destP) throw new Error("올릴 NAS 폴더(dest_p 또는 dest_path)가 필요합니다 — nas_find·nas_list 결과의 폴더 p 를 주세요");
  const src = resolveSrc(args.src, { cwd: ctx.cwd || process.cwd(), home });
  const plan = planLocal(src, { maxFiles });
  const pOf = (rel) => rel.reduce((p, seg) => childP(p, seg), destP);
  const out = { uploaded: [], skipped: 0, conflicts: [], failed: [], remaining: 0, bytes: 0 };

  // 원격 폴더는 올리기가 «폴더 없음»(403)으로 실패할 때만 만든다 — 이어받는 호출이 이미 있는 폴더를 매번 다시 만들러 가지 않게.
  const ensured = new Set([""]);
  const badDirs = new Set();
  const ensureDir = async (rel) => {
    for (let k = 1; k <= rel.length; k++) {
      const key = rel.slice(0, k).join("/");
      if (ensured.has(key)) continue;
      if (badDirs.has(key)) return false;
      try { await ctx.api("/api/ui/me/nas/manage", { method: "POST", body: { op: "mkdir", p: pOf(rel.slice(0, k - 1)), name: rel[k - 1] } }); }
      catch (e) {
        // 만들기 실패는 «이미 있음»일 수 있다 — 목록이 열리면 있는 것이다
        try { await ctx.api(`/api/ui/me/nas/list?p=${encodeURIComponent(pOf(rel.slice(0, k)))}`, { timeoutMs: 60_000 }); }
        catch { badDirs.add(key); out.failed.push({ path: key, error: `폴더를 만들지 못했습니다: ${String(e?.message ?? e)}` }); return false; }
      }
      ensured.add(key);
    }
    return true;
  };
  const put = (f, relDir) => fetchImpl(`${ctx.gateway}/api/ui/me/nas/upload?dir=${encodeURIComponent(pOf(relDir))}&name=${encodeURIComponent(f.rel[f.rel.length - 1].normalize("NFC"))}${args.overwrite ? "&overwrite=1" : ""}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${ctx.token}`, "content-type": "application/octet-stream", "content-length": String(f.size), ...mode },
    body: Readable.toWeb(createReadStream(f.local)),
    duplex: "half",
    signal: AbortSignal.timeout(FILE_TIMEOUT_MS),
  });

  // 원격 폴더의 파일 이름·크기 — 폴더마다 한 번 묻는다. 이어받는 호출이 이미 올린 파일의 본문을 다시 보내지 않게(409 는 본문을 다 보낸 뒤에 온다).
  const listings = new Map();
  const remoteSizes = async (relDir) => {
    const key = relDir.join("/");
    if (listings.has(key)) return listings.get(key);
    let sizes = null;
    try {
      const l = await ctx.api(`/api/ui/me/nas/list?p=${encodeURIComponent(pOf(relDir))}`, { timeoutMs: 60_000 });
      sizes = new Map((l?.items ?? []).filter((it) => it.type === "file").map((it) => [String(it.path).slice(String(it.path).lastIndexOf("/") + 1).normalize("NFC"), it.size]));
      ensured.add(key);
    } catch { /* 없는 폴더 — 올리기가 403 을 받으면 만든다 */ }
    listings.set(key, sizes);
    return sizes;
  };

  for (let i = 0; i < plan.files.length; i++) {
    if (now() - started > budgetMs) { out.remaining = plan.files.length - i; break; }
    const f = plan.files[i];
    const relDir = f.rel.slice(0, -1);
    const shown = f.rel.join("/");
    try {
      const have = (await remoteSizes(relDir))?.get(f.rel[f.rel.length - 1].normalize("NFC"));
      // 덮기를 요청했으면 크기가 같아도 올린다 — 길이만 같고 내용이 바뀐 파일이 조용히 옛 내용으로 남지 않게(그 대신 덮기 호출은 이어받기가 처음부터 다시 보낸다)
      if (have !== undefined && have === f.size && !args.overwrite) { out.skipped++; continue; }
      if (have !== undefined && !args.overwrite) { out.conflicts.push({ path: shown, local_size: f.size, nas_size: have }); continue; }
      let res = await put(f, relDir);
      if (res.status === 403 && !ensured.has(relDir.join("/"))) {
        await res.body?.cancel().catch(() => {});
        if (!(await ensureDir(relDir))) { out.failed.push({ path: shown, error: "상위 폴더를 만들지 못했습니다" }); continue; }
        res = await put(f, relDir);
      }
      const body = await res.json().catch(() => ({}));
      if (res.status === 409) {
        ensured.add(relDir.join("/"));
        if (body?.size === f.size) out.skipped++;
        else out.conflicts.push({ path: shown, local_size: f.size, nas_size: body?.size ?? null });
        continue;
      }
      if (!res.ok) { out.failed.push({ path: shown, error: body?.error ? `${res.status} ${body.error}` : `게이트웨이 ${res.status}` }); continue; }
      ensured.add(relDir.join("/"));
      out.uploaded.push(body?.path ?? shown);
      out.bytes += f.size;
    } catch (e) {
      out.failed.push({ path: shown, error: String(e?.message ?? e) });
    }
  }
  // 파일이 없는 폴더(빈 폴더)는 남은 시간에 만든다 — 다 올린 호출에서만
  let pendingDirs = 0;
  if (out.remaining === 0) {
    const withFiles = new Set(plan.files.map((f) => f.rel.slice(0, -1).join("/")));
    const empty = plan.dirs.filter((rel) => { const key = rel.join("/"); return !withFiles.has(key) && ![...withFiles].some((w) => w.startsWith(key + "/")); });
    for (let k = 0; k < empty.length; k++) {
      if (now() - started > budgetMs) { pendingDirs = empty.length - k; break; } // 다음 호출이 마저 만든다
      await ensureDir(empty[k]);
    }
  }

  const done = out.remaining === 0 && pendingDirs === 0 && !plan.truncated;
  return {
    src,
    done,
    planned: plan.files.length,
    uploaded: out.uploaded.length,
    skipped: out.skipped,
    conflicts: out.conflicts.slice(0, 50),
    remaining: out.remaining,
    pending_dirs: pendingDirs,
    bytes: out.bytes,
    skipped_links: plan.links,
    skipped_hidden: plan.hidden,
    truncated: plan.truncated,
    failed: out.failed.slice(0, 50),
    files: out.uploaded.slice(0, 100),
    note: out.remaining || pendingDirs
      ? `시간 한도로 파일 ${out.remaining}개·빈 폴더 ${pendingDirs}개가 남았습니다. 같은 호출을 다시 하면 올린 것은 건너뛰고 이어서 올립니다.`
      : out.conflicts.length
        ? `NAS 에 같은 이름·다른 크기 파일 ${out.conflicts.length}개가 있어 올리지 않았습니다. 덮으려면 사람에게 확인받고 overwrite:true 로 다시 부르세요.`
        : plan.truncated ? `${plan.truncated}에 걸려 일부만 올렸습니다. 하위 폴더로 나눠 올리세요.` : "다 올렸습니다.",
  };
}
