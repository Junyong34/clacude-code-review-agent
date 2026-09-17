# 작업 지침

한글로 답변한다.

## 프로젝트

Bitbucket Server / Data Center의 단일 저장소 PR을 Claude로 리뷰하는 TypeScript 서비스다. Slack 알림과 선택적 Daily PR·Confluence cron을 포함한다. 실제 라우터는 `src/app.ts`, 서버 시작과 종료 처리는 `src/server.ts`가 담당한다.

## 변경 시 참고

- 설치·설정·공개 API를 변경할 때 [README](README.md)와 `.env.example`을 함께 갱신한다.
- 리뷰 조건, 실패 처리, 코멘트 게시를 변경할 때 [개발 가이드](docs/ai-code-review-pr-flow.md)를 확인한다. 사용자 동작이 바뀌면 [운영 가이드](docs/ai-code-review-agent-guide.md)도 갱신한다.
- CRG의 Git 작업·그래프 조회·인터페이스 판정을 변경할 때 [CRG 가이드](docs/crg-symbol-reference.md)를 확인한다. 컨텍스트 클론의 작업 파일을 보존하고 강제 동기화는 봇 전용 워크트리에서만 수행한다.
- 설계 배경은 `docs/adr/`에 있다. 과거 결정 시점의 수치를 현재 동작으로 간주하지 않는다.

## 검증

Node 24 이상, 25 미만에서 `npm run typecheck`, `npm test`, `npm run build`를 실행한다. 실제 Bitbucket·Slack·Confluence·Claude 요청 대신 mock과 임시 Git fixture를 사용한다. CRG CLI가 없으면 통합 테스트 일부가 skip될 수 있으며 결과에 표시한다.

## 유지할 동작

- 자동 리뷰: master 대상 non-draft, 기존 완료 시그니처 확인. 수동 재리뷰: top-level 봇 멘션과 재리뷰 키워드, 횟수 제한 없음.
- PR별 실행 잠금과 Claude 전역 동시성 제한은 프로세스 내부 범위다.
- 자동·수동 모두 CRG 힌트를 사용하며 로컬 인라인 위치 검증은 현재 수동 재리뷰에서만 켜진다.
- cron 플래그는 서버 자동 시작만 제어한다. 수동 관리 API는 별도로 유지한다.
- 공개 예제는 가상 주소와 계정만 사용하며 비밀정보·내부 운영 주소를 커밋하지 않는다.
