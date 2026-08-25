// 소스 트리에서는 setup 구현을 재수출한다. 설치 번들에서는 user-install.mjs가 같은 이름의
// 실제 구현을 ~/.lively/lib/host-effects.mjs 로 복사하므로 CLI 조각의 상대 import가 양쪽에서 같다.
export * from "../setup/host-effects.mjs";
