// 위키링크 문법층(#907) 단위 체크 — DB 불요(순수 함수). 실행: npm run build && node dist/v6/wikilink.test.js
//
// 케이스는 대부분 실데이터에서 왔다(활성 지식 본문의 [[…]] 939건 실측):
//  · 설계문서가 문법 자체를 설명하며 [[name]]·[[링크]] 를 적는다 → 코드/펜스 안이면 엣지가 되면 안 된다.
//  · 터미널 문서의 [[27,13]] 같은 이스케이프 시퀀스가 링크로 오인되면 그래프가 오염된다.
//  · 지식 이름의 71건이 한글이라 문법층이 문자셋을 건드리면 안 된다(해소는 knowledge-store.slugify 몫).
import assert from "node:assert/strict";
import { extractWikiLinkTargets, mapProseSegments } from "./wikilink.js";

let pass = 0;
const t = (name: string, fn: () => void): void => {
  fn();
  pass++;
};

t("기본 [[name]] — 등장순 추출", () => {
  assert.deepEqual(extractWikiLinkTargets("앞 [[alpha]] 중간 [[beta]] 뒤"), ["alpha", "beta"]);
});

t("Obsidian: [[name|표시글]] → '|' 뒤는 표시 텍스트라 대상은 name (relation 아님)", () => {
  assert.deepEqual(extractWikiLinkTargets("[[deployment-flow|배포 흐름]]"), ["deployment-flow"]);
  // 통제 어휘를 label 자리에 적어도 relation 으로 해석하지 않는다 — 자동 엣지는 전부 related(#907 결정).
  assert.deepEqual(extractWikiLinkTargets("[[alpha|refines]]"), ["alpha"]);
});

t("Obsidian: [[name#헤딩]] → 엣지 대상은 노트(앵커 절단)", () => {
  assert.deepEqual(extractWikiLinkTargets("[[alpha#설치-절차]] 참고"), ["alpha"]);
  assert.deepEqual(extractWikiLinkTargets("[[alpha#^block-id|딴이름]]"), ["alpha"]);
});

t("Obsidian: [[#헤딩]](자기 문서 앵커)은 엣지가 아니다", () => {
  assert.deepEqual(extractWikiLinkTargets("위로 [[#요약]]"), []);
});

t("Obsidian: ![[name]] 임베드도 링크로 센다(그래프 동일)", () => {
  assert.deepEqual(extractWikiLinkTargets("![[alpha]]"), ["alpha"]);
});

t("코드펜스(```) 안의 [[…]] 는 예시 — 무시", () => {
  const md = "본문 [[real]]\n```\n예시: [[name]] 이렇게 씁니다\n```\n뒤 [[after]]";
  assert.deepEqual(extractWikiLinkTargets(md), ["real", "after"]);
});

t("~~~ 펜스도 동일", () => {
  assert.deepEqual(extractWikiLinkTargets("~~~\n[[name]]\n~~~\n[[real]]"), ["real"]);
});

t("인라인코드 안의 [[…]] 는 문법 설명 — 무시", () => {
  assert.deepEqual(extractWikiLinkTargets("문법은 `[[name]]` 입니다. 예: [[real]]"), ["real"]);
});

t("이스케이프 \\[\\[…\\]\\] 는 링크가 아니다('[[' 가 없다)", () => {
  assert.deepEqual(extractWikiLinkTargets("본문의 \\[\\[name\\]\\] 는 표기 예시"), []);
});

t("중복 대상은 1건으로 접는다(엣지는 쌍이 유일 — knowledge_link_uq)", () => {
  assert.deepEqual(extractWikiLinkTargets("[[alpha]] 그리고 또 [[alpha]] 또 [[alpha#h]]"), ["alpha"]);
});

t("한글 이름은 문법층이 건드리지 않는다(해소는 slugify 몫)", () => {
  assert.deepEqual(
    extractWikiLinkTargets("[[런북-dev-8080-게이트웨이-빌드-재시작-context-ontology]]"),
    ["런북-dev-8080-게이트웨이-빌드-재시작-context-ontology"]);
});

t("이름이 '-' 로 끝나는 실재 지식도 원형 보존(재슬러그화는 해소 단계에서만)", () => {
  assert.deepEqual(extractWikiLinkTargets("[[배포-장애-수정-어니스트-]]"), ["배포-장애-수정-어니스트-"]);
});

t("빈 본문·링크 없음 → 빈 배열(폴더 등)", () => {
  assert.deepEqual(extractWikiLinkTargets(""), []);
  assert.deepEqual(extractWikiLinkTargets("링크 없는 본문"), []);
});

t("[[27,13]] 같은 코드 조각도 펜스 밖이면 대상으로 나온다(해소에서 미매칭 경고로 걸린다)", () => {
  // 문법층은 문법만 본다 — '실재하는 지식인가'는 해소층(resolveWikiLinkTargets)의 책임이라는 계약을 잠근다.
  assert.deepEqual(extractWikiLinkTargets("[[27,13]]"), ["27,13"]);
});

t("mapProseSegments: 펜스·인라인코드는 원형, 산문만 변환", () => {
  const md = "prose\n```\ncode\n```\n`inline` prose2";
  assert.equal(mapProseSegments(md, (s) => s.toUpperCase()), "PROSE\n```\ncode\n```\n`inline` PROSE2");
});

console.log(`\n${pass} passed`);
