---
status: superseded by ADR-0002
---

> 이 문서는 결정 당시의 배경 기록입니다. 현재 실행 방법과 수치는 [README](../../README.md) 및 [개발 가이드](../ai-code-review-pr-flow.md)를 기준으로 합니다.

# AI 코드리뷰 파이프라인을 Message Batches API로 전면 전환

`runCodeReview()`는 현재 `noLimit: true`로 diff 전체를 단일 `messages.create()` 호출에 담는다. 변경 파일이 많은 PR에서는 입력이 무한정 커져 처리 지연/타임아웃, 또는 `MAX_OUTPUT_TOKENS` 초과로 인한 응답 잘림이 발생한다.

해결책으로 Anthropic Message Batches API 도입을 검토하며 두 방향을 고려했다:

- **조건부(하이브리드)**: diff가 클 때만 Batch로 보내고, 작은 PR은 기존 동기 호출 유지
- **전면 전환**: PR 크기와 무관하게 항상 Batch로 처리

Batch API는 처리 완료 시점을 보장하지 않는다(Anthropic 공식 계약: "최대 24시간 이내 완료", 통상 더 빠르지만 SLA 아님). 이 리스크를 인지한 상태에서, 코드 경로를 하나로 유지해 복잡도를 낮추고 운영 정책을 단순하게 가져가기 위해 **전면 전환**을 선택했다.

## Consequences

- PR 오픈/댓글 직후 "몇 초~몇십 초 내 리뷰 완료"라는 기존 UX는 더 이상 보장되지 않는다. 작은 PR도 동일한 비동기 대기 모델을 탄다.
- 결과 수신이 push가 아니라 polling 기반이므로, batch 상태를 주기적으로 확인하는 별도 메커니즘이 필요하다.
- `docs/ai-code-review-agent-guide.md`의 흐름도/설명은 이 전환 이후 다시 작성해야 한다.
