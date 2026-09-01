// ★구조 게이트 — **가드를 죽였는데 초록인 시험은 시험이 아니다** (#2518)
//
//  ── 왜 이 파일이 있나 ────────────────────────────────────────────────────────
//  이 조직이 가장 자주 밟는 함정은 「고장」이 아니라 **「초록불인데 안 돈다」** 다(실측 계열 10건 —
//   지식 `false-green-self-check`). 그중 가장 악성이 **없어서 통과하는 시험**이다:
//    · `deploy_gate_merged()` 가 **통째로 지워졌는데**(136줄) CI 가 통과했다 — 함수가 사라진 것은
//      문법 오류가 아니고 `bash -n` 도 `shellcheck` 도 그걸 오류로 보지 않는다(lvly-cloud PR #107).
//    · `pgrep` 자기참조 결함은 테스트가 **구현 문자열을 그대로 요구**해 결함을 고정하고 있었다(#2055).
//   둘 다 「테스트가 있다」가 「테스트가 문다」로 읽혔다.
//
//  사람은 이미 이걸 손으로 한다 — `spec-failfirst-test` 의 red 입증이 그것이다.
//  **다만 스킬은 부르면 돌고, 이 게이트는 안 불러도 돈다.** 그 차이가 존재 이유다.
//
//  ── 계약 ─────────────────────────────────────────────────────────────────────
//  소스의 `// GUARD: <테스트파일> — <설명>` 표식마다, 바로 아래 `if (조건)` 의 조건을 `false` 로
//  바꿔 **가드를 죽이고** 지정 테스트를 돌린다. 그 테스트는 **반드시 빨개져야 한다.**
//
//  ⚠ **공용 dist 를 제자리에서 고치지 않는다.** 러너가 -j 8 로 병렬 실행하므로 공용 dist 를 건드리면
//   남의 테스트를 깨뜨린다 — 그 자체가 false-green 을 만든다. 그래서 사본에서 한다.
//   사본은 **레포 안**에 둔다(밖에 두면 node 가 `node_modules` 를 못 찾는다).
//  ⚠ **표식이 0개면 실패한다.** 검사할 것이 없어서 통과하는 게이트가 정확히 이 파일이 막으려는 것이다.
//  ⚠ 이 게이트는 **코드를 고치지 않는다.** 소스도 공용 dist 도 읽기만 한다.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** `// GUARD: <spec> — <note>` 한 줄을 읽는다(**순수**). 아니면 null. */
export function parseMarker(line) {
  const m = /^\s*\/\/\s*GUARD:\s*([A-Za-z0-9._-]+)\s*(?:—|--|-)?\s*(.*)$/.exec(line ?? "");
  if (!m) return null;
  const spec = m[1].trim();
  if (!spec) return null;                       // spec 이 비면 무엇을 돌릴지 모른다 → 표식으로 안 본다
  return { spec, note: (m[2] ?? "").trim() };
}

/** 가드 줄에서 조건식을 뽑는다(**순수**). `if (…)` 가 아니면 null. */
export function parseCond(line) {
  const m = /^\s*if\s*\((.+)\)\s*(?:\{|\S)/.exec(line ?? "");
  return m ? m[1].trim() : null;
}

/** 소스 트리를 훑어 표식을 모은다. 표식 바로 아래 줄이 가드여야 한다(떨어져 있으면 모호하다). */
export function collectGuards(srcDir, out = []) {
  for (const e of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const p = path.join(srcDir, e.name);
    if (e.isDirectory()) { collectGuards(p, out); continue; }
    if (!e.name.endsWith(".ts") || e.name.endsWith(".d.ts")) continue;
    const lines = fs.readFileSync(p, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const mk = parseMarker(lines[i]);
      if (!mk) continue;
      out.push({ file: p, line: i + 1, ...mk, cond: parseCond(lines[i + 1]) });
    }
  }
  return out;
}

/** 사본 dist 안에서 `<spec>.js` 를 찾는다. 정확히 하나가 아니면 null(모호함을 통과로 접지 않는다). */
export function findSpecFile(distDir, spec) {
  const want = spec.endsWith(".test") ? `${spec}.js` : `${spec}.test.js`;
  const found = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === want || e.name === `${spec}.js`) found.push(p);
    }
  };
  walk(distDir);
  return found.length === 1 ? found[0] : null;
}

/**
 * 게이트를 돌린다. **판정만 하고 아무것도 고치지 않는다.**
 * @returns {{ guards: number, findings: string[] }} findings 가 비면 통과.
 */
export function runGuardGate({ srcDir, distDir, workDir, cwd, runner }) {
  const findings = [];
  const guards = collectGuards(srcDir);

  // ★ 0 건이면 실패다 — 「검사할 게 없어서 통과」가 정확히 이 게이트가 막으려는 모양이다.
  if (guards.length === 0) {
    findings.push("GUARD 표식이 하나도 없다 — 이 게이트가 vacuous 하다(표식을 달거나 게이트를 지워라)");
    return { guards: 0, findings };
  }

  const workDist = path.join(workDir, "dist");
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });
  fs.cpSync(distDir, workDist, { recursive: true });

  try {
    for (const g of guards) {
      const at = `${path.relative(cwd, g.file)}:${g.line}`;
      if (!g.cond) { findings.push(`${at} — 표식 바로 아래 줄이 \`if (...)\` 가 아니다(무엇을 죽일지 모호하다)`); continue; }

      const js = path.join(workDist, path.relative(srcDir, g.file).replace(/\.ts$/, ".js"));
      if (!fs.existsSync(js)) { findings.push(`${at} — 대응 dist 파일이 없다(빌드 누락?)`); continue; }

      const before = fs.readFileSync(js, "utf8");
      // tsc 가 줄을 재포맷하므로 «줄 번호»가 아니라 **조건식 자체**로 찾는다.
      const needle = `if (${g.cond})`;
      if (!before.includes(needle)) { findings.push(`${at} — dist 에서 \`${needle}\` 를 못 찾았다(컴파일로 바뀌었나)`); continue; }

      const specFile = findSpecFile(workDist, g.spec);
      if (!specFile) { findings.push(`${at} — 테스트 \`${g.spec}\` 를 하나로 특정하지 못했다`); continue; }

      fs.writeFileSync(js, before.replace(needle, "if (false)"));
      let rc;
      try { rc = runner(specFile, cwd); } finally { fs.writeFileSync(js, before); }   // 반드시 원복

      if (rc === 0) findings.push(`${at} — 가드(\`${g.cond}\`)를 죽였는데 ${g.spec} 가 **초록이다**. 그 가드는 아무도 안 지킨다`);
    }
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });   // 성공·실패·예외 모두 사본을 남기지 않는다
  }
  return { guards: guards.length, findings };
}

/** 기본 러너 — 테스트 파일 하나를 돌려 종료코드를 낸다(0 = 초록). */
export const nodeRunner = (file, cwd) => {
  try { execFileSync(process.execPath, [file], { stdio: "pipe", cwd }); return 0; }
  catch (e) { return e.status ?? 1; }
};
