// 앱 서버 빌더의 약속(#4484 앱 v2-5) — 게이트웨이와 세션 안 빌더(app-server-builder.ts builderMain)가 주고받는 것: 판 · 표식 · 시작 스크립트 이름 ·
//  입력 머리(BuildHeader) · 결과(BuildResult)와 그 읽고 쓰기. builderMain 은 바깥 이름을 못 쓰는 함수라 같은 값을 안에 따로 둔다(시험이 둘이 같은지 본다).

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
