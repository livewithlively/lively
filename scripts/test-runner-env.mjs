// 기본 테스트 자식의 capability 경계. 별도 모듈로 둬 부모 env가 무엇이든 deny로 수렴함을 단위 검증한다.
export const testChildEnv = (parent = process.env) => ({
  ...parent,
  LIVELY_HOST_EFFECTS: "deny",
  LIVELY_HOST_EFFECTS_TEST_MODE: "sandbox",
  LIVELY_NO_BROWSER: "1",
});
