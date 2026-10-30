// 자가호스팅 앱 서버 실행면(#4487 앱 v2-8)의 디스크 — 함수 · 판 · 별칭을 박스 폴더에 적고 읽는다(app-server-local 이 쓴다 · 컨테이너는 모른다).
//  자리: fn/<워크스페이스>/<함수>/meta.json($LATEST 설정 · 태그 · 별칭 · 동시 실행 · 판 번호) · latest.zip · v/<판>/(code/ · version.json) · zips/<zip 키>.
//  판은 «판 폴더» 다 — version.json 이 있어도 code/ 가 없으면 그 판은 없다(상태 점검 #4887 이 같은 빌드로 다시 올린다).
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { AwsError } from "../net/aws/aws-json.js";
import type * as lam from "../net/aws/lambda-lite.js";
import { blobTenant } from "./app-blob-store.js";

/** 함수 코드 자리의 «버킷» 이름(FnCode.S3Bucket) — 로컬 zip 저장소. */
export const LOCAL_BUCKET = "lively-local";
export const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ZIP_KEY_RE = /^(?:[A-Za-z0-9._-]+\/){1,8}[A-Za-z0-9._-]+\.zip$/;

export interface FnMeta {
  v: 1;
  name: string;
  tenant: string;
  config: lam.FnConfiguration;
  tags: Record<string, string>;
  aliases: Record<string, { version: string; description: string }>;
  concurrency: number | null;
  seq: number;
}
export interface VersionMeta { v: 1; version: string; config: lam.FnConfiguration; published_at: string; failed?: { at: string; reason: string } | null }

export const notFound = (what: string): AwsError => new AwsError(404, "ResourceNotFoundException", `Function not found: ${what}`);
export const fnPath = (root: string, fn: string): string => {
  if (!NAME_RE.test(fn)) throw new AwsError(400, "InvalidParameterValueException", `함수 이름 꼴이 틀렸습니다: ${fn.slice(0, 80)}`);
  return path.join(root, "fn", blobTenant(), fn);
};
export const versionPath = (root: string, fn: string, v: string): string => {
  if (!/^\d{1,9}$/.test(v)) throw notFound(`${fn}:${v.slice(0, 20)}`);
  return path.join(fnPath(root, fn), "v", v);
};
/** zip 저장소 안 경로 — 키는 정해진 꼴만(.. · 절대 경로가 들어갈 수 없다). */
export function zipPathOf(root: string, key: string): string {
  if (!ZIP_KEY_RE.test(key) || key.split("/").some((s) => s === "." || s === "..")) throw new AwsError(400, "InvalidParameterValueException", `zip 키 꼴이 틀렸습니다: ${key.slice(0, 120)}`);
  return path.join(root, "zips", ...key.split("/"));
}

export async function readJson<T>(file: string): Promise<T | null> {
  try { return JSON.parse(await fsp.readFile(file, "utf8")) as T; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
}
export async function writeJson(file: string, obj: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${crypto.randomBytes(4).toString("hex")}`;
  await fsp.writeFile(tmp, JSON.stringify(obj), { mode: 0o600 });
  await fsp.rename(tmp, file);
}
export const readMeta = (root: string, fn: string): Promise<FnMeta | null> => readJson<FnMeta>(path.join(fnPath(root, fn), "meta.json"));
export const writeMeta = (root: string, m: FnMeta): Promise<void> => writeJson(path.join(fnPath(root, m.name), "meta.json"), m);
export const readVersion = async (root: string, fn: string, v: string): Promise<VersionMeta | null> => {
  const dir = versionPath(root, fn, v);
  const vm = await readJson<VersionMeta>(path.join(dir, "version.json"));
  //  판 폴더의 코드가 없으면 그 판은 없는 것이다(지워졌거나 덜 만들어짐).
  return vm && fs.existsSync(path.join(dir, "code")) ? vm : null;
};

/** 같은 함수의 디스크 고치기는 한 줄로(이 게이트웨이 안) — 배포는 앱 잠금을 쥐지만 멈춤 · 정리 · 점검이 같은 함수를 만질 수 있다. */
const fnLocks = new Map<string, Promise<unknown>>();
export async function withFnLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = fnLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => { release = r; });
  const chained = prev.then(() => mine);
  fnLocks.set(key, chained);
  await prev.catch(() => undefined);
  try { return await fn(); } finally { release(); if (fnLocks.get(key) === chained) fnLocks.delete(key); }
}

/** zip 저장소의 zip 을 함수 폴더로 복사하고 지문(sha256 base64 — Lambda CodeSha256 꼴) · 크기를 잰다. 없으면 Lambda COPY 와 같은 글(배포가 그 빌드를 무효로 적는다). */
export async function copyZipIn(root: string, code: lam.FnCode, dir: string): Promise<{ sha: string; size: number }> {
  if (code.S3Bucket !== LOCAL_BUCKET) throw new AwsError(400, "InvalidParameterValueException", `로컬 실행면은 ${LOCAL_BUCKET} 의 zip 만 읽습니다`);
  const src = zipPathOf(root, code.S3Key);
  if (!fs.existsSync(src)) throw new AwsError(400, "InvalidParameterValueException", "Error occurred while GetObject. S3 Error Code: NoSuchKey. S3 Error Message: The specified key does not exist.");
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `latest.zip.tmp-${crypto.randomBytes(4).toString("hex")}`);
  await fsp.copyFile(src, tmp, fs.constants.COPYFILE_FICLONE);
  const h = crypto.createHash("sha256");
  let size = 0;
  for await (const c of fs.createReadStream(tmp)) { h.update(c as Buffer); size += (c as Buffer).length; }
  await fsp.rename(tmp, path.join(dir, "latest.zip"));
  return { sha: h.digest("base64"), size };
}

export const layersOf = (arns: string[] | undefined): string[] => [...(arns ?? [])];
export const cfgOf = (m: FnMeta): lam.FnConfiguration => JSON.parse(JSON.stringify(m.config)) as lam.FnConfiguration;
/** 판을 새로 고정할지 가르는 설정(코드 · 실행 설정) — Lambda 처럼 마지막 판과 같으면 그 판을 돌려준다. */
export const versionKeyOf = (c: lam.FnConfiguration): string => JSON.stringify({
  sha: c.CodeSha256, role: c.Role, handler: c.Handler, runtime: c.Runtime, mem: c.MemorySize, timeout: c.Timeout, tmp: c.EphemeralStorage?.Size ?? 512,
  layers: (c.Layers ?? []).map((l) => l.Arn), env: c.Environment?.Variables ?? {},
});
