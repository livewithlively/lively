// NAS 파일·폴더를 세션이 도는 기계의 폴더로 내려받는다 — lively-mcp-local.mjs 의 lively_local_nas_pull 본체.
//  게이트웨이의 nas_list(폴더 목록)·/api/ui/me/nas/file(내려받기)을 그 구성원 토큰으로 부른다. 볼 수 있는 범위는 게이트웨이가
//  그 구성원 본인 FTP 계정으로 정한다 — 여기선 권한을 판단하지 않는다.
//
//  · 받는 자리는 기본 폴더 ~/NAS사본 아래만이다(그 폴더 자체 포함 — resolveDest). 이 도구는 사람 확인 없이 도는 자동승인 도구이고
//    받는 자리(dest)와 파일 이름(target.path)을 AI 가 정한다. 홈 아래 아무 데나 받게 두면 NAS 문서에 심은 지시만으로
//    ~/.ssh/authorized_keys·~/.zshrc·~/Library/LaunchAgents 가 NAS 내용으로 덮인다. 웹 세션의 작업 폴더(프로젝트 공유폴더)도
//    같은 프로젝트의 다른 구성원이 보는 자리라 받지 않는다 — 거기에 받으면 그 사람의 NAS 권한 밖 파일이 넘어간다.
//  · 인코그니토 세션이면 아무 요청도 보내지 않는다(nasPull 첫머리).
//  · MCP 호출은 하네스를 붙잡는 동기 호출이라(lively-mcp-local.mjs 머리말) budgetMs 를 넘기면 새 파일을 시작하지 않고 멈춘다. 폴더 나열도 이 예산 안이다
//    — 예산은 파일 사이에서 본다. 이미 시작한 파일 하나는 끝나거나 FILE_TIMEOUT_MS 에 걸릴 때까지 가므로 한 호출의 상한은 budgetMs + FILE_TIMEOUT_MS 다
//    (파일을 예산에 맞춰 끊으면 반쪽 파일은 이어받지 않으므로 예산보다 오래 걸리는 큰 파일은 영영 못 받는다).
//    — 폴더 하나마다 게이트웨이가 FTP 로그인부터 다시 하므로 큰 폴더는 나열만 수 분이 걸린다. 끊긴 나열은 dest 의 .nas-pull-<키>.json 에
//    남겨 다음 호출이 이어서 나열하고, 받기는 같은 크기 파일을 건너뛰는 것으로 이어받는다. 다 받으면 그 파일을 지운다.
import { mkdirSync, statSync, lstatSync, renameSync, unlinkSync, createWriteStream, realpathSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, dirname, basename, isAbsolute, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const DEFAULT_BUDGET_MS = 50_000;
export const MAX_FILES = 3000;
export const MAX_DIRS = 2000;
export const DEFAULT_DEST_DIR = "NAS사본";
/** 파일 하나를 받는 최대 시간 — 예산(budgetMs)과 별개라 한 호출이 이만큼 더 걸릴 수 있다. 큰 스캔 묶음도 넉넉히 들어오되, 멈춘 전송이 호출을 영영 붙잡지 않게. */
export const FILE_TIMEOUT_MS = 10 * 60_000;
/** 끊긴 나열을 이어받는 기록의 수명 — 그보다 오래된 기록은 NAS 가 바뀌었을 수 있어 처음부터 다시 나열한다. */
const PLAN_CACHE_TTL_MS = 24 * 60 * 60_000;
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** 서버가 준 이름 한 마디를 이 기계의 파일 이름으로. 경로 구분자·윈도우 금지 문자·제어문자는 _ 로, . 과 .. 은 거부(null). */
export function safeSegment(name) {
  const s = String(name ?? "").normalize("NFC").replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_").replace(/[. ]+$/, "");
  if (!s || s === "." || s === "..") return null;
  // 윈도우 장치 이름(NUL.txt 등)은 파일 대신 장치로 열려 조용히 사라진다
  return WIN_RESERVED.test(s) ? `_${s}` : s;
}

const insideOrSame = (p, root) => p === root || p.startsWith(root + sep);

/** 아직 없을 수 있는 경로의 실제 경로 — 가장 가까운 존재 조상을 realpath 로 풀고 나머지를 붙인다(링크로 밖을 가리키는 조상을 잡는다). */
function realOfNearest(p) {
  let probe = p, tail = "";
  while (!existsSync(probe)) { const up = dirname(probe); if (up === probe) break; tail = tail ? join(basename(probe), tail) : basename(probe); probe = up; }
  return tail ? join(realpathSync(probe), tail) : realpathSync(probe);
}

/**
 * 죽은 호출이 남긴 그 파일의 임시 조각(.<이름>.nas-pull-<pid>.part)을 치운다. NAS 에서 온 정상 파일과 겹치지 않게 이 꼴만 본다. 이름에 pid 가 있어 다음 호출이 같은 이름을 덮지 않으므로
 *  스스로 치워야 한다. 살아 있는 전송은 계속 쓰여 수정 시각이 새로우니 FILE_TIMEOUT_MS 보다 오래된 것만 지운다.
 */
function sweepStaleParts(target, now) {
  const dir = dirname(target), base = basename(target);
  let names;
  try { names = readdirSync(dir); } catch { return; }
  for (const n of names) {
    if (!n.startsWith(`.${base}.`) || !/^\.nas-pull-\d+\.part$/.test(n.slice(base.length + 1))) continue;
    try { const st = lstatSync(join(dir, n)); if (now() - st.mtimeMs > FILE_TIMEOUT_MS) unlinkSync(join(dir, n)); } catch { /* 경합 — 무시 */ }
  }
}

/** 링크를 따라가지 않고 새로 만드는 쓰기 — 그 이름의 링크·잔해를 먼저 지우고 O_EXCL 로 연다(링크를 따라 밖의 파일을 덮지 않게). */
function exclusiveWriteStream(file) {
  try { unlinkSync(file); } catch { /* 없음 */ }
  return createWriteStream(file, { flags: "wx" });
}

/**
 * 세션 모드(#1007) — MCP 프록시와 같은 머리글(x-lively-mode)을 싣는다. 게이트웨이가 인코그니토 세션의 내려받기를 막는다.
 *  ⚠ 폴더 나열(ctx.api)에는 이 머리글이 실리지 않는다 — 인코그니토는 nasPull 이 첫 요청 전에 멈춘다.
 */
export const modeHeader = (env = process.env) => {
  const mode = String(env.LIVELY_MODE ?? "").trim().toLowerCase();
  return mode ? { "x-lively-mode": mode } : {};
};

/** 사람이 읽는 NAS 경로를 마디로. 빈 마디는 버린다. */
const segmentsOf = (displayPath) => String(displayPath ?? "").split("/").filter(Boolean);

/** 사람이 읽는 경로(UTF-8)를 게이트웨이의 p 로 — 서버 encodeRawPath(base64url of 원본 바이트)와 같은 꼴. */
export const pOfPath = (path) => Buffer.from(String(path).startsWith("/") ? String(path) : `/${path}`, "utf8").toString("base64url");

/**
 * 받을 자리를 정한다 — 기본 폴더(home/NAS사본) 아래만 된다(그 폴더 자체 포함). 상대 경로는 기본 폴더 기준, 절대 경로는 그대로 풀되
 *  실제 경로가 기본 폴더 아래일 때만 받는다(안의 링크가 밖을 가리키는 길도 여기서 막힌다). 그 밖이면 거부한다 — 머리말의 자동승인 까닭.
 *  기본 폴더 자체가 링크면(다른 디스크로 옮겨 둔 경우) 그 실제 경로가 기준이다.
 *  home 이 심볼릭 링크일 수 있어(맥 /var → /private/var) 실제 경로로 비교한다.
 */
export function resolveDest(dest, home) {
  const base = join(realpathSync(home), DEFAULT_DEST_DIR);
  const baseReal = realOfNearest(base);
  const raw = dest ? (isAbsolute(dest) ? resolve(dest) : resolve(base, dest)) : base;
  const real = realOfNearest(raw);
  if (!insideOrSame(real, baseReal)) {
    throw new Error(`받을 폴더는 ${baseReal} 아래만 됩니다(기본 ~/${DEFAULT_DEST_DIR}) — dest 는 그 안의 상대 경로(예: «프로젝트A»)로 주세요: ${raw}`);
  }
  return real;
}

/**
 * targets 를 펼쳐 받을 파일 목록을 만든다. 폴더는 그 폴더 이름부터 아래 구조를 그대로 둔다.
 *  listDir(p) → { items: [{ path, type, size, p }] } (게이트웨이 nas_list 응답). 폴더 하나를 못 읽어도 나머지는 계속한다.
 *  deadline(now() 기준)을 넘기면 나열을 멈추고 state 를 돌려준다 — 같은 targets 로 state 를 넘기면 그 자리부터 이어서 나열한다.
 */
export async function planFiles(targets, listDir, { maxFiles = MAX_FILES, maxDirs = MAX_DIRS, now = Date.now, deadline = Infinity, state = null } = {}) {
  const files = state?.files ?? [], failed = state?.failed ?? [];
  let truncated = null, dirs = state?.dirs ?? 0;
  for (let ti = state?.ti ?? 0; ti < targets.length; ti++) {
    const t = targets[ti];
    const rootSegs = segmentsOf(t.path);
    const keep = rootSegs.length ? rootSegs.length - 1 : 0; // 대상 자신의 이름부터 남긴다
    const rel = (path) => segmentsOf(path).slice(keep);
    if (t.type === "file") { files.push({ p: t.p, path: t.path, size: t.size ?? null, rel: rel(t.path) }); continue; }
    const queue = state && state.ti === ti && Array.isArray(state.queue) ? state.queue : [{ p: t.p, path: t.path }];
    state = null;
    while (queue.length) {
      if (dirs >= maxDirs) { truncated = `폴더 ${maxDirs}개 상한`; break; }
      if (now() > deadline) return { files, failed, truncated: "시간 한도(폴더 나열 중)", dirs, state: { ti, queue, files, failed, dirs } };
      const d = queue.shift();
      dirs++;
      let listing;
      try { listing = await listDir(d.p); }
      catch (e) { failed.push({ path: d.path, error: String(e?.message ?? e) }); continue; }
      for (const it of listing.items ?? []) {
        if (it.type === "dir") queue.push({ p: it.p, path: it.path });
        else if (it.type === "file") {
          if (files.length >= maxFiles) { truncated = `파일 ${maxFiles}개 상한`; break; }
          files.push({ p: it.p, path: it.path, size: it.size ?? null, rel: rel(it.path) });
        }
      }
      if (truncated) break;
    }
    if (truncated) break;
  }
  return { files, failed, truncated, dirs, state: null };
}

/**
 * 계획대로 받는다. download(p) → Response(본문 스트림). 같은 크기 파일이 있으면 건너뛰고, 받는 중엔 .part 에 쓰고 끝나면 옮긴다.
 *  now 는 시계(테스트 주입용). budgetMs 를 넘기면 남은 파일을 remaining 으로 돌려준다.
 */
export async function pullFiles(files, destRootIn, download, { budgetMs = DEFAULT_BUDGET_MS, now = Date.now } = {}) {
  const started = now();
  const destRoot = realOfNearest(destRootIn); // 아래 «밖인가» 비교는 실제 경로끼리라야 맞다
  const out = { downloaded: [], skipped: 0, failed: [], remaining: 0, bytes: 0 };
  for (let i = 0; i < files.length; i++) {
    if (now() - started > budgetMs) { out.remaining = files.length - i; break; }
    const f = files[i];
    const segs = f.rel.map(safeSegment);
    if (!segs.length || segs.some((s) => s === null)) { out.failed.push({ path: f.path, error: "이 기계에 쓸 수 없는 이름" }); continue; }
    const target = join(destRoot, ...segs);
    try {
      // 받는 폴더 안에 이미 있는 링크를 따라 그 밖에 쓰지 않는다 — 폴더는 실제 경로로, 파일 자리는 링크 여부로 본다
      if (lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) { out.failed.push({ path: f.path, error: "그 자리에 링크가 있어 받지 않음" }); continue; }
      const parent = dirname(target);
      if (!insideOrSame(realOfNearest(parent), destRoot)) { out.failed.push({ path: f.path, error: "받는 폴더 밖으로 이어지는 링크" }); continue; }
      const st = statSync(target, { throwIfNoEntry: false });
      if (st?.isFile() && f.size !== null && st.size === f.size) { out.skipped++; continue; }
      const res = await download(f.p);
      if (!res.ok || !res.body) {
        await res.body?.cancel().catch(() => {}); // 본문을 버려야 커넥션이 풀로 돌아간다
        out.failed.push({ path: f.path, error: `게이트웨이 ${res.status}` });
        continue;
      }
      mkdirSync(parent, { recursive: true });
      if (!insideOrSame(realpathSync(parent), destRoot)) { await res.body.cancel().catch(() => {}); out.failed.push({ path: f.path, error: "받는 폴더 밖으로 이어지는 링크" }); continue; }
      // pid: 같은 폴더로 동시에 받는 두 세션이 임시 파일을 섞지 않게. 점·nas-pull 표식: NAS 의 정상 파일 이름과 겹치지 않게(sweep 이 지운다)
      const part = join(dirname(target), `.${basename(target)}.nas-pull-${process.pid}.part`);
      sweepStaleParts(target, now);
      try {
        await pipeline(Readable.fromWeb(res.body), exclusiveWriteStream(part));
        renameSync(part, target);
      } catch (e) {
        try { unlinkSync(part); } catch { /* 이미 없음 */ }
        throw e;
      }
      const size = statSync(target).size;
      out.bytes += size;
      out.downloaded.push(target);
    } catch (e) {
      out.failed.push({ path: f.path, error: String(e?.message ?? e) });
    }
  }
  return out;
}

/**
 * MCP 도구 본체. ctx 는 lively-mcp-local.mjs makeCtx 의 것(api·gateway·token), fetchImpl 은 그 파일의 fetch. env 는 세션 모드를 읽는 자리(시험 주입용).
 *  args: { targets?: [{p, type?, path?, size?}], path?: string, dest?: string }
 */
export async function nasPull(ctx, args, { home, fetchImpl, budgetMs = DEFAULT_BUDGET_MS, now = Date.now, env = process.env } = {}) {
  // 인코그니토는 폴더 나열·내려받기 어느 요청도 보내기 전에 멈춘다(#1007). 게이트웨이는 모드 머리글이 실린 내려받기만 막고
  //  폴더 나열(ctx.api)엔 머리글이 없어 이름 목록이 나간다. 읽기전용은 받는다 — NAS 를 읽기만 한다.
  const mode = modeHeader(env);
  if (mode["x-lively-mode"] === "incognito") throw new Error("인코그니토 세션에서는 NAS 에서 받지 않습니다(#1007)");
  const started = now();
  const deadline = started + budgetMs;
  const destRoot = resolveDest(args.dest, home);
  const listDir = (p) => ctx.api(`/api/ui/me/nas/list?p=${encodeURIComponent(p)}`, { timeoutMs: 60_000 });
  let targets = Array.isArray(args.targets) ? args.targets.filter((t) => t && typeof t.p === "string" && t.p) : [];
  if (!targets.length && args.path) targets = [{ p: pOfPath(args.path), path: String(args.path) }];
  if (!targets.length) throw new Error("받을 대상이 없습니다 — nas_find·nas_list 결과의 p 를 targets 로, 또는 path 를 주세요");
  // type·path 를 모르면 폴더로 열어 보고(응답의 path 가 이름이 된다), 없는 폴더(404)면 파일로 본다.
  //  404 밖의 실패(로그인 만료 401 등)는 그대로 던진다 — 파일로 오인하면 처방이 사라진다.
  const typed = [];
  for (const t of targets) {
    if ((t.type === "file" || t.type === "dir") && t.path) { typed.push(t); continue; }
    try { const l = await listDir(t.p); typed.push({ ...t, type: "dir", path: t.path ?? l.path }); }
    catch (e) {
      if (!/게이트웨이 404\b/.test(String(e?.message ?? e))) throw e;
      typed.push({ ...t, type: "file", path: t.path ?? null });
    }
  }
  const named = typed.filter((t) => t.path);
  const unnamed = typed.length - named.length;

  mkdirSync(destRoot, { recursive: true });
  const key = createHash("sha256").update(JSON.stringify(named.map((t) => [t.p, t.type]))).digest("hex").slice(0, 16);
  const cacheFile = join(destRoot, `.nas-pull-${key}.json`);
  let cached = null;
  try {
    if (!lstatSync(cacheFile, { throwIfNoEntry: false })?.isSymbolicLink()) {
      const c = JSON.parse(readFileSync(cacheFile, "utf8"));
      if (typeof c?.at === "number" && started - c.at < PLAN_CACHE_TTL_MS) cached = c;
      else unlinkSync(cacheFile); // 오래된 기록은 지운다 — 남겨 두면 dest 에 영구히 쌓인다
    }
  } catch { /* 없음·깨짐 → 처음부터 */ }
  const plan = cached?.plan ?? await planFiles(named, listDir, { now, deadline, state: cached?.state ?? null });
  // 임시 파일에 쓰고 옮긴다 — 동시 호출이 반쪽 JSON 을 읽지 않고, 기록 자리의 링크도 따라가지 않는다
  const saveCache = (body) => {
    const tmp = `${cacheFile}.${process.pid}.tmp`;
    try {
      const ws = exclusiveWriteStream(tmp); ws.end(JSON.stringify({ at: cached?.at ?? started, ...body }));
      // WriteStream 은 error 뒤에도 close 를 낸다 — 오류였으면 옮기지 말고 지운다(반쪽 JSON 이 기록이 되지 않게)
      let broken = false;
      ws.on("error", () => { broken = true; });
      return new Promise((ok) => ws.on("close", () => {
        try { if (broken) unlinkSync(tmp); else renameSync(tmp, cacheFile); }
        catch { try { unlinkSync(tmp); } catch { /* 이미 없음 */ } }
        ok();
      }));
    } catch { return Promise.resolve(); /* 기록 실패는 다음 호출이 처음부터 나열할 뿐 */ }
  };

  const failedOf = (more) => [...plan.failed, ...more, ...(unnamed ? [{ path: null, error: `경로(path)를 모르는 대상 ${unnamed}개는 건너뜀` }] : [])];
  if (plan.state) {
    await saveCache({ state: plan.state });
    return {
      dest: destRoot, done: false, planned: plan.files.length, downloaded: 0, skipped: 0, remaining: null, bytes: 0,
      truncated: plan.truncated, listed_dirs: plan.dirs, failed: failedOf([]).slice(0, 50), files: [],
      note: `폴더 목록을 만드는 중입니다(지금까지 폴더 ${plan.dirs}개). 같은 호출을 다시 하면 이어서 나열한 뒤 받습니다.`,
    };
  }
  await saveCache({ plan: { files: plan.files, failed: plan.failed, truncated: plan.truncated, dirs: plan.dirs, state: null } });

  const download = (p) => fetchImpl(`${ctx.gateway}/api/ui/me/nas/file?p=${encodeURIComponent(p)}`, {
    headers: { authorization: `Bearer ${ctx.token}`, ...mode },
    signal: AbortSignal.timeout(FILE_TIMEOUT_MS),
  });
  const r = await pullFiles(plan.files, destRoot, download, { budgetMs: Math.max(0, deadline - now()), now });
  const done = r.remaining === 0 && !plan.truncated;
  if (r.remaining === 0) { try { unlinkSync(cacheFile); } catch { /* 이미 없음 */ } }
  const failed = failedOf(r.failed);
  return {
    dest: destRoot,
    done,
    planned: plan.files.length,
    downloaded: r.downloaded.length,
    skipped: r.skipped,
    remaining: r.remaining,
    bytes: r.bytes,
    truncated: plan.truncated,
    failed: failed.slice(0, 50),
    files: r.downloaded.slice(0, 100),
    note: r.remaining
      ? `시간 한도로 ${r.remaining}개가 남았습니다. 같은 호출을 다시 하면 받은 파일은 건너뛰고 이어서 받습니다.`
      : plan.truncated
        ? `${plan.truncated}에 걸려 일부만 받았습니다. 같은 호출을 반복하지 말고 하위 폴더로 나눠 받으세요.`
        : `받은 파일은 dest 아래에 NAS 폴더 구조 그대로 있습니다${failed.length ? `(실패 ${failed.length}건은 failed 참고)` : ""}. 내용은 그 파일을 직접 열어 보세요.`,
  };
}
