// 결정론적 '사실(facts)' 추출기 — 레포 클론을 걷어 부트스트랩 런북이 LLM 에 먹일 ground-truth 를 만든다.
//
// 배경(제품 갭·설계 결정, 지식: domainmap-is-initial-bootstrap-gap-and-scanner):
//  도메인맵 is 의 '최초 탐색'에서 결정론이 담당할 것과 LLM 이 담당할 것의 경계를 —
//    · 결정론(코드 사실): 어떤 '파일'이 있나(무손실). 여기가 이 모듈의 일.
//    · 판단(LLM): 무엇이 '한 유닛'인가(경계/거칠기) · 어느 '도메인'인가. code_unit 경계는 도메인이 어디서
//      갈리는지에 달린 '판단'이라, 결정론 규칙으로 미리 못박으면(모듈 단위 등) 다도메인 모듈이 하나로 뭉개져
//      정보가 손실된다. 그래서 유닛 생성/매핑은 이 모듈이 '안' 하고, LLM 이 이 사실을 읽고 판단해 ingest 로 쓴다.
//  ⇒ 이 모듈은 파일목록(무손실)·모듈'힌트'·스택을 뽑아줄 뿐, DB 에 쓰지 않는다(PURE-ish: git/fs 만).
//  module_hints 는 유닛 경계를 '강제'하는 게 아니라 LLM 에 주는 참고 — 받아들이든 쪼개든 LLM 최종권한.
//
// 자기완결: node 빌트인만 import. deriveModules 는 PURE(단독 테스트 가능).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const execFileP = promisify(execFile);
const SHA_RE = /^[0-9a-f]{7,40}$/;

// 모듈 루트 마커 — 이 basename(소문자 비교)을 '직접' 담은 디렉터리가 모듈 루트.
const MARKER_NAMES = new Set([
  "build.gradle", "build.gradle.kts", "pom.xml", // JVM
  "package.json",                                 // node
  "pyproject.toml", "setup.py",                   // python
  "go.mod",                                       // go
  "cargo.toml",                                   // rust
  "composer.json",                                // php
  "gemfile",                                      // ruby
  "cmakelists.txt",                               // c/c++
]);
function markerKind(base: string): string | null {
  const b = base.toLowerCase();
  if (b.endsWith(".csproj") || b.endsWith(".fsproj")) return "dotnet";
  if (!MARKER_NAMES.has(b)) return null;
  if (b.startsWith("build.gradle")) return "gradle";
  if (b === "pom.xml") return "maven";
  if (b === "package.json") return "npm";
  if (b === "go.mod") return "go";
  if (b === "cargo.toml") return "cargo";
  if (b === "pyproject.toml" || b === "setup.py") return "python";
  if (b === "composer.json") return "composer";
  if (b === "gemfile") return "ruby";
  if (b === "cmakelists.txt") return "cmake";
  return "other";
}

function dirOf(p: string): string { const i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); }
function baseOf(p: string): string { const i = p.lastIndexOf("/"); return i < 0 ? p : p.slice(i + 1); }
function extOf(p: string): string { const b = baseOf(p); const i = b.lastIndexOf("."); return i <= 0 ? "" : b.slice(i + 1).toLowerCase(); }

export interface DeriveOpts { fallbackDepth?: number }
export interface DetectedStack { markers: Record<string, number>; languages: Record<string, number>; files: number }
export interface DeriveResult { units: string[]; detected_stack: DetectedStack }

// PURE — 파일 path 목록(repo-루트 상대) → 모듈 유닛 집합 + detected_stack. DB·IO 무접촉(단독 테스트 가능).
//  입력 path 는 posix('/')·windows('\\') 모두 허용(정규화). 선행 './' 제거. 중복 제거.
export function deriveModules(files: unknown, opts: DeriveOpts = {}): DeriveResult {
  const fallbackDepth = Math.max(1, Math.floor(opts.fallbackDepth ?? 2));
  const list = Array.isArray(files) ? files : [];
  const paths = [...new Set(
    list.filter((f): f is string => typeof f === "string" && f !== "")
      .map((f) => f.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "")),
  )].filter((f) => f !== "");

  // 1) 비-루트 마커 디렉터리 수집(루트 마커 dir='' 은 제외 — 전 레포 뭉침 방지) + 마커 종류 카운트.
  const markerDirs = new Set<string>();
  const markers: Record<string, number> = {};
  for (const f of paths) {
    const kind = markerKind(baseOf(f));
    if (!kind) continue;
    markers[kind] = (markers[kind] ?? 0) + 1;
    const d = dirOf(f);
    if (d !== "") markerDirs.add(d);
  }
  const markerByLen = [...markerDirs].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));

  // 2) 각 파일 → 모듈: 비-루트 마커 소유(longest-prefix) 우선, 없으면 fallback depth 디렉터리.
  const ownerMarker = (f: string): string | null => {
    for (const d of markerByLen) if (f === d || f.startsWith(d + "/")) return d;
    return null;
  };
  const fallbackModule = (f: string): string => {
    const segs = f.split("/");
    if (segs.length === 1) return f; // top-level 파일 = 자기 유닛(aggregate.ts 의 top-level 관례와 일치)
    return segs.slice(0, Math.min(fallbackDepth, segs.length - 1)).join("/");
  };

  const units = new Set<string>();
  const languages: Record<string, number> = {};
  for (const f of paths) {
    const e = extOf(f);
    if (e) languages[e] = (languages[e] ?? 0) + 1;
    units.add(ownerMarker(f) ?? fallbackModule(f));
  }
  return {
    units: [...units].sort(),
    detected_stack: { markers, languages, files: paths.length },
  };
}

// --- IO: 레포 파일 열거(tracked 우선, 실패 시 fs walk) ---------------------------------------
// -z(NUL 구분) 필수 — git 은 기본적으로 유니코드/특수문자 path 를 C-스타일로 "따옴표+8진 이스케이프" 하는데(example-one
//  한글 파일명 등), 그러면 path 에 리터럴 따옴표·이스케이프가 섞여 모듈 도출이 깨진다. -z 는 인용을 끄고 NUL 로 나눈다.
async function gitFileList(rootPath: string, args: string[]): Promise<string[] | null> {
  try {
    const { stdout } = await execFileP("git", ["-C", rootPath, ...args, "-z"], { timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
    const files = stdout.split("\0").map((s) => s.trim()).filter(Boolean);
    return files.length ? files : null;
  } catch { return null; }
}
// ref 가 주어지면 그 커밋의 트리를 정확히 나열(ls-tree) — 워킹트리 체크아웃 상태와 무관하게 head 기준으로 스캔한다.
const listAtRef = (rootPath: string, ref: string) => gitFileList(rootPath, ["ls-tree", "-r", "--name-only", ref]);
const listTracked = (rootPath: string) => gitFileList(rootPath, ["ls-files"]);

// git 이 아닌(또는 ls-files 실패) 경우의 폴백 워크 — 흔한 비소스 디렉터리는 제외(결정론·정렬).
const WALK_IGNORE = new Set([".git", "node_modules", "dist", "build", "target", ".gradle", "vendor", ".idea", ".venv", "__pycache__", "out", "bin", "obj", ".next", "coverage"]);
async function walkFiles(rootPath: string): Promise<string[]> {
  const acc: string[] = [];
  const rec = async (dir: string): Promise<void> => {
    let ents;
    try { ents = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.isDirectory()) { if (WALK_IGNORE.has(e.name)) continue; await rec(join(dir, e.name)); }
      else if (e.isFile()) acc.push(relative(rootPath, join(dir, e.name)).split(sep).join("/"));
    }
  };
  await rec(rootPath);
  return acc.sort();
}

export async function listRepoFiles(rootPath: string, ref?: string | null): Promise<string[]> {
  if (ref) { const atRef = await listAtRef(rootPath, ref); if (atRef) return atRef; }
  return (await listTracked(rootPath)) ?? (await walkFiles(rootPath));
}

async function headSha(rootPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP("git", ["-C", rootPath, "rev-parse", "HEAD"], { timeout: 30_000 });
    const h = stdout.trim();
    return SHA_RE.test(h) ? h : null;
  } catch { return null; }
}

export interface RepoFacts {
  repo: string;
  head: string | null;
  files: string[];        // tracked 파일(무손실 사실 바닥) — LLM 이 grep 해 유닛경계를 판단
  module_hints: string[]; // deriveModules 결과 — 유닛경계 '힌트'(강제 아님; LLM 이 최종 결정·쪼개기)
  stack: DetectedStack;
}

// 결정론적 사실 수집(DB·판단 무접촉) — 부트스트랩 런북이 LLM 에 먹일 ground-truth.
//  파일목록(무손실)·모듈힌트·스택·head. LLM 은 이 JSON 을 grep/슬라이스해서 유닛경계+매핑을 '판단'하고
//  그 결과를 ingest(domainmap_ingest 표면)로 '한 번에' 쓴다 — 이 함수는 유닛을 만들지도 매핑하지도 않는다.
export async function collectFacts(repoName: string, rootPath: string, opts: DeriveOpts = {}): Promise<RepoFacts> {
  const head = await headSha(rootPath);
  const files = await listRepoFiles(rootPath, head); // head 알면 그 트리 기준(워킹트리 체크아웃 무관)
  const { units, detected_stack } = deriveModules(files, opts);
  return { repo: repoName, head, files, module_hints: units, stack: detected_stack };
}
