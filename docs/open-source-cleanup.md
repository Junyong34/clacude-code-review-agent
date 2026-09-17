# 공개 준비 정리 내역

## 삭제·통합

| 삭제 파일 | 이유 | 내용 이관 |
|---|---|---|
| `error.md` | 내부 오류 응답 원문 | 운영 가이드의 guardrail 대응 |
| `CONTEXT.md` | 중복 용어·오래된 청크 수치 | 개발 가이드 용어, CRG 생명주기 |
| `docs/plans/2026-07-24-001-streaming-chunked-code-review-plan.md` | 완료된 구현 계획 | 개발 가이드 처리 순서, ADR-0002 |
| `start.sh` | 셸 스크립트가 아닌 오래된 Dockerfile 복사본 | 현재 Dockerfile과 README |
| `verify_cron.js` | 현재 필터와 맞지 않는 mock | 기존 characterization 단위 테스트 |

세 ADR은 역사적 배경으로 유지한다. 운영 가이드·개발 흐름·CRG 가이드의 역할을 구분하고 README를 문서 진입점으로 사용한다.

## 설정과 동작 변경

- 대상 프로젝트 전용 식별자·주소·프롬프트 규칙을 일반화했다. 예제 저장소는 `example-app`, 예제 이슈는 `DEMO`를 사용한다.
- CRG 경로 변수는 `CODE_REVIEW_CONTEXT_CLONE_PATH`, `CODE_REVIEW_MASTER_WORKTREE_DIR`이며 이전 이름의 호환 별칭은 제공하지 않는다. 기존 운영 환경은 새 변수로 값을 옮겨야 한다.
- `JIRA_BASE_URL`, `DEPLOY_CHECKLIST_URL`이 없으면 해당 링크를 생략한다. `CLAUDE_MODEL`로 모델을 선택한다.
- Daily PR·주간 블로그 자동 시작은 각각 활성화 플래그가 `true`인 경우만 수행한다. 기존 운영 환경에서 예약을 유지하려면 명시적으로 켜야 한다.
- TLS 검증을 기본으로 사용한다. 사설 CA는 `NODE_EXTRA_CA_CERTS`로 신뢰시킨다.
- 두 레거시 디버그 API를 제거했다. 지원 API는 README에 기재했다.
- 라이선스를 MIT로 통일하고 공개 제외 규칙, env 예제, Node 버전 설정을 추가했다.

## 공개 범위

소스·테스트·문서·lockfile·공개 설정이 대상이다. 의존성, 빌드 결과, 개인 도구 설정, 실제 env 파일, CRG 그래프와 워크트리는 제외한다. 제외 파일은 로컬에서 삭제하지 않는다.

GitHub 공개·push, 자격증명 발급, 실제 외부 서비스 연동은 이 정리 작업에 포함하지 않는다. 웹훅·관리 API 인증, 분산 잠금, 여러 저장소·대상 브랜치 지원은 현재 구현의 범위 밖이다.
