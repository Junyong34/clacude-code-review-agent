# 코드리뷰 동작 이해하기

PR에서 바뀐 함수의 diff만으로는 다른 파일의 기존 호출자가 새 계약을 만족하는지 알기 어렵습니다. 이 서비스는 diff 주변 문맥과 PR 설명을 제공하고, CRG가 준비되면 참조 파일과 호출부 코드도 Claude 입력에 넣습니다. Claude의 리뷰 결과와 CRG의 참조 안내는 Bitbucket 댓글로 남깁니다.

이 문서 모음은 현재 코드의 동작을 설명합니다. CRG는 선택 기능이며 모든 호출부를 검증하지 않습니다. 리뷰 품질 향상 수치는 측정하지 않았으므로, 어떤 판단 근거를 추가하는지와 그 한계를 함께 다룹니다.

## 읽기 순서

| 순서 | 문서 | 설명 |
|---|---|---|
| 1 | [PR부터 댓글까지](pr-to-comments.md) | 웹훅부터 데이터 조회, CRG, Claude 호출, 댓글 게시까지 전체 흐름 |
| 2 | [CRG가 보완하는 맥락](crg-context.md) | 변경 함수의 기존 사용처를 찾고 리뷰 입력에 넣는 과정 |
| 3 | [Claude 입력과 스트리밍](claude-input-and-streaming.md) | JSON diff를 청크로 바꾸고 프롬프트와 결합하는 방식 |
| 4 | [리뷰 출력과 댓글](review-output-and-comments.md) | 응답 JSON을 파싱하고 Bitbucket 댓글로 변환하는 과정 |
| 5 | [제한과 실패 처리](limits-and-failure-handling.md) | 일부만 제공되는 증거, 누락 가능성, 오류 처리 |

이벤트별 알림과 관리 API의 분기를 확인하려면 [엔드포인트별 흐름](endpoint-flows.md)을 참고하세요. PR 생성·수정, 댓글 재리뷰, 상태 알림과 예약 작업을 도식으로 정리했습니다.

예제는 `src/users.ts`의 `getUser(id)`에 필수 인자 `tenantId`를 추가했지만 `src/profile.ts`의 `loadProfile()` 호출은 바뀌지 않은 가상 상황을 사용합니다. 파일과 라인 번호는 설명용이며 이 저장소의 실제 리뷰 결과가 아닙니다.

## 주체별 역할

| 주체 | 역할 |
|---|---|
| Bitbucket | PR 이벤트, diff와 활동 제공, 댓글 저장 |
| 리뷰 서비스 | 조건 판단, 입력 가공, 인터페이스 판정, Claude 호출과 결과 게시 |
| CRG | 로컬 master 소스의 심볼과 참조 관계를 그래프로 제공 |
| Claude | 제공된 diff와 서버 증거를 읽고 구조화된 리뷰 작성 |

참조 관계가 있다는 사실만으로 버그를 확정하지 않습니다. CRG 댓글은 확인할 파일을 안내하고, Claude는 변경 라인과 제공된 호출부에서 구체적인 실패를 확인한 경우에 의견을 남기도록 지시받습니다.

## 설정과 운영 문서

- [프로젝트 README](../../README.md): 설치, 환경변수, 웹훅 연결
- [운영 가이드](../ai-code-review-agent-guide.md): 자동 리뷰와 수동 재리뷰, 알림, 실패 대응
- [개발자 파이프라인](../ai-code-review-pr-flow.md): 구현 책임과 검증 경계
- [CRG 설정 가이드](../crg-symbol-reference.md): CLI, clone, 워크트리와 Docker 구성
- [용어집](../../CONTEXT.md): 리뷰 입력, 서버 증거, 앵커 등의 정의
- [서버 증거 주입 설계](../adr/0004-server-computed-evidence-over-tool-use.md): 결정 당시 배경. 현재 수치와 동작은 코드와 현행 가이드 기준
