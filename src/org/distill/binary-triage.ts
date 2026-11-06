// [BINARY] 자료를 어떻게 볼지 — 두 증류 프롬프트(레인 · 전체 배치)가 같은 규칙을 쓴다.
//  파일명만으로 버리면 `IMG_1234.jpg` 속 화이트보드가 영영 안 열린다. 반대로 AI 세션이 만든 캡처까지 열면 비용만 든다(실측 3,464건).
export const BINARY_TRIAGE_RULE =
  "스텁의 filename·mime·channel 로 볼 가치부터 판단한다. 이름에서 노이즈(밈·로고·아이콘·UI캡처 등)가 분명하거나 머리줄에 «AI 세션이 만든 파일» 이 붙은 그림은 fetch 없이 skip. "
  + "사람이 올린 그림인데 이름이 내용을 말해 주지 않으면(image.png · IMG_1234 · KakaoTalk_… · 숫자 · UUID) 이름만으로 skip 하지 말고 "
  + "source_artifact(source_id, preview:true)로 작게 받아 그 path 를 Read 해 한 번 본다. 회의 판서·문서·표·장표처럼 내용이 있으면 "
  + "source_artifact(source_id)로 원본을 받아 Read 하고, 화면 캡처·일상 사진이면 skip 한다. 값이 보이는 파일과 PDF 는 처음부터 원본을 받는다"
  + "(unavailable=삭제/이동이면 skip).";
