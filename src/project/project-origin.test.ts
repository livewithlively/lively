// project-origin — git origin URL → 크로스멤버 정규 신원 키(#905 P1-③). 순수함수라 DB/git/fs 없이 검증.
//  실행: npm run build && node dist/project/project-origin.test.js
import assert from "node:assert/strict";
import { originKey, sameOrigin } from "./project-origin.js";

let pass = 0;
const ok = (name: string) => { pass++; console.log(`ok  ${name}`); };

function main(): void {
  // ── 핵심 요구: 멤버마다 클론 방식이 달라도 같은 레포는 같은 키 ──
  //  이게 깨지면 두 번째 멤버의 init 이 기존 프로젝트를 못 찾고 '중복 생성'으로 폴백한다(P1-③ 의 존재 이유).
  {
    const forms = [
      "git@github.com:livewithlively/context-ontology.git",
      "https://github.com/livewithlively/context-ontology.git",
      "https://github.com/livewithlively/context-ontology",
      "https://github.com/livewithlively/context-ontology/",
      "ssh://git@github.com/livewithlively/context-ontology.git",
      "https://ghp_secrettoken@github.com/livewithlively/context-ontology.git",
      "https://user:pass@github.com/livewithlively/context-ontology.git",
      "GIT@GitHub.com:livewithlively/context-ontology.git",
    ];
    const keys = forms.map(originKey);
    const want = "github.com/livewithlively/context-ontology";
    forms.forEach((f, i) => assert.equal(keys[i], want, `같은 레포는 같은 키여야 함 — ${f} → ${keys[i]}`));
    ok("프로토콜·자격·표기(.git·트레일링·대소문자 호스트)가 달라도 같은 레포 = 같은 키");
  }

  // ── 시크릿이 키에 새지 않는다 — 키는 DB·로그·비교에 쓰이므로 토큰이 섞이면 유출이다 ──
  {
    const k = originKey("https://ghp_verysecrettoken@github.com/o/r.git");
    assert.equal(k, "github.com/o/r");
    assert.ok(!String(k).includes("ghp_"), "키에 토큰이 남으면 안 됨");
    ok("자격(PAT·user:pass·git@)은 키에서 제거 — 시크릿 미유출");
  }

  // ── 포트 제거: 같은 서비스의 ssh(2222)·https(443)가 갈리면 정상 케이스가 전부 깨진다 ──
  {
    assert.equal(originKey("ssh://git@git.example.com:2222/g/r.git"), "git.example.com/g/r");
    assert.equal(originKey("https://git.example.com/g/r.git"), "git.example.com/g/r");
    assert.ok(sameOrigin("ssh://git@git.example.com:2222/g/r.git", "https://git.example.com/g/r"),
      "포트만 다른 같은 레포는 같은 origin");
    ok("포트는 신원이 아니다 — ssh:2222 와 https 가 같은 키");
  }

  // ── 셀프호스팅 중첩 그룹 경로(GitLab) 보존 — 그룹 구조가 신원의 일부 ──
  {
    assert.equal(originKey("git@git.example.com:acme-dev/backend/example-one.git"), "git.example.com/acme-dev/backend/example-one");
    assert.equal(originKey("https://git.example.com/acme-dev/backend/example-one.git"), "git.example.com/acme-dev/backend/example-one");
    ok("중첩 그룹 경로(GitLab) 보존 + scp·https 동일 키");
  }

  // ── 경로 대소문자는 보존 — 소문자화하면 서로 다른 레포가 같은 키가 되어(false positive) 오바인딩 위험 ──
  {
    assert.equal(originKey("https://github.com/Org/Repo.git"), "github.com/Org/Repo");
    assert.ok(!sameOrigin("https://github.com/Org/Repo", "https://github.com/org/repo"),
      "경로 대소문자가 다르면 같다고 단정하지 않는다(오바인딩 금지 — 중복후보는 사람이 판단)");
    ok("경로 대소문자 보존(호스트만 소문자) — 되돌릴 수 없는 오바인딩보다 중복후보가 낫다");
  }

  // ── fail-closed: 해석 불가·레포 미특정이면 null. 신원 없이 바인딩하지 않는다 ──
  {
    assert.equal(originKey("not a url"), null);
    assert.equal(originKey(""), null);
    assert.equal(originKey("   "), null);
    assert.equal(originKey(null), null);
    assert.equal(originKey(undefined), null);
    assert.equal(originKey(42), null);
    assert.equal(originKey("https://github.com"), null, "호스트만으론 레포를 특정 못 함");
    assert.equal(originKey("https://github.com/"), null, "빈 경로도 특정 불가");
    ok("해석 불가·레포 미특정 → null(fail-closed)");
  }

  // ── sameOrigin: 모르면 '같다'고 하지 않는다 ──
  {
    assert.equal(sameOrigin("not a url", "not a url"), false, "둘 다 해석 불가여도 '같다'가 아니다");
    assert.equal(sameOrigin(null, null), false);
    assert.equal(sameOrigin("https://github.com/o/a", "https://github.com/o/b"), false, "같은 호스트·다른 레포");
    assert.equal(sameOrigin("https://github.com/o/r", "https://gitlab.com/o/r"), false, "호스트가 다르면 다른 레포");
    ok("sameOrigin — 해석 불가·상이는 전부 false");
  }

  // ── 로컬 경로 리모트(테스트·미러 클론)는 신원 키가 아니다 ──
  {
    assert.equal(originKey("/Users/me/repos/thing"), null, "로컬 파일경로는 멤버 간 공유 신원이 아님");
    assert.equal(originKey("../sibling"), null);
    ok("로컬 파일경로 리모트 → null(멤버 간 동일값이 아니므로 신원 키 불가)");
  }

  console.log(`\n${pass} passed`);
}

main();
