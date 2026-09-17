import test from 'node:test';
import assert from 'node:assert/strict';

import {
    parseClaudeReviewResponse,
    prepareDiffForReview,
    extractUserWrittenPrDescription,
    GuardrailPolicyError,
} from '../src/services/codeReview/codeReview.js';

test('prepareDiffForReview masks sensitive values without logging raw matches', () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));

    try {
        const raw = [
            'user@example.com',
            'Bearer abcdefghijklmnopqrstuvwxyz',
            'sk-abcdefghijklmnopqrstuvwxyz'
        ].join('\n');

        const diff = prepareDiffForReview(raw);

        assert.match(diff, /\[EMAIL\]/);
        assert.match(diff, /\[TOKEN\]/);
        assert.match(diff, /\[API_KEY\]/);
        assert.doesNotMatch(diff, /user@example\.com/);
        assert.doesNotMatch(diff, /Bearer abcdefghijklmnopqrstuvwxyz/);
        assert.doesNotMatch(diff, /sk-abcdefghijklmnopqrstuvwxyz/);

        const logOutput = logs.join('\n');
        assert.match(logOutput, /\[TOKEN\]/);
        assert.doesNotMatch(logOutput, /user@example\.com/);
        assert.doesNotMatch(logOutput, /Bearer abcdefghijklmnopqrstuvwxyz/);
        assert.doesNotMatch(logOutput, /sk-abcdefghijklmnopqrstuvwxyz/);
    } finally {
        console.log = originalLog;
    }
});

test('parseClaudeReviewResponse parses fenced JSON review output', () => {
    const { reviewData, isOutputTruncated } = parseClaudeReviewResponse(`\`\`\`json
{
  "changeSummary": "PR 댓글 흐름을 정리합니다.",
  "flowRisks": [],
  "testPoints": ["수동 재리뷰 요청을 확인합니다."],
  "comments": [
    {
      "file": "src/routes/pr/comment.ts",
      "line": 12,
      "lineType": "ADDED",
      "severity": "P2",
      "text": "🟠 중복 호출 위험"
    }
  ]
}
\`\`\``);

    assert.equal(isOutputTruncated, false);
    assert.equal(reviewData.changeSummary, 'PR 댓글 흐름을 정리합니다.');
    assert.deepEqual(reviewData.testPoints, ['수동 재리뷰 요청을 확인합니다.']);
    assert.equal(reviewData.comments.length, 1);
});

test('extractUserWrittenPrDescription drops an unfilled Bitbucket PR template entirely', () => {
    const unfilledTemplate = [
        '🛠 변경 내용',
        '이 PR 에서 수행한 변경 사항을 가능하면 목록으로 작성해주세요. 리뷰어에게 도움이 될 것입니다.',
        '✨ 변경 사항의 배경',
        '변경 사항과 관련된 이슈나 풀 리퀘스트가 있나요? (있다면 이슈넘버나 링크를 추가해주세요)',
        '📑 추가 리뷰 요청 (선택 사항)',
        '리뷰어가 꼭 봐줬으면 하는 부분이 있다면 해당 부분을 정리해주세요.',
        '📸 스크린샷 (선택 사항)',
        'UI 변경 사항이 있다면 이전과 이후의 스크린샷을 제공하세요. 스크린샷은 변경 사항의 시각적인 영향을 리뷰어가 이해하는 데 도움이 될 수 있습니다.',
    ].join('\n');

    assert.equal(extractUserWrittenPrDescription(unfilledTemplate), '');
});

test('extractUserWrittenPrDescription keeps only the sections the user actually filled in', () => {
    const partiallyFilledTemplate = [
        '🛠 변경 내용',
        '- diff 청크 분할 로직에서 lockfile 우선순위를 조정했습니다.',
        '✨ 변경 사항의 배경',
        '변경 사항과 관련된 이슈나 풀 리퀘스트가 있나요? (있다면 이슈넘버나 링크를 추가해주세요)',
        '📑 추가 리뷰 요청 (선택 사항)',
        '리뷰어가 꼭 봐줬으면 하는 부분이 있다면 해당 부분을 정리해주세요.',
        '📸 스크린샷 (선택 사항)',
        'UI 변경 사항이 있다면 이전과 이후의 스크린샷을 제공하세요. 스크린샷은 변경 사항의 시각적인 영향을 리뷰어가 이해하는 데 도움이 될 수 있습니다.',
    ].join('\n');

    const result = extractUserWrittenPrDescription(partiallyFilledTemplate);

    assert.match(result, /🛠 변경 내용/);
    assert.match(result, /lockfile 우선순위/);
    assert.doesNotMatch(result, /✨ 변경 사항의 배경/);
    assert.doesNotMatch(result, /📑 추가 리뷰 요청/);
    assert.doesNotMatch(result, /📸 스크린샷/);
});

test('extractUserWrittenPrDescription checks every section independently — a different pair of edited sections also survives', () => {
    const templateWithBackgroundAndReviewNoteFilled = [
        '🛠 변경 내용',
        '이 PR 에서 수행한 변경 사항을 가능하면 목록으로 작성해주세요. 리뷰어에게 도움이 될 것입니다.',
        '✨ 변경 사항의 배경',
        'JIRA-1234 이슈의 diff 청크 분할 회귀를 해결하기 위한 작업입니다.',
        '📑 추가 리뷰 요청 (선택 사항)',
        'diffFormatter.ts의 라인 경계 분할 로직을 특히 봐주세요.',
        '📸 스크린샷 (선택 사항)',
        'UI 변경 사항이 있다면 이전과 이후의 스크린샷을 제공하세요. 스크린샷은 변경 사항의 시각적인 영향을 리뷰어가 이해하는 데 도움이 될 수 있습니다.',
    ].join('\n');

    const result = extractUserWrittenPrDescription(templateWithBackgroundAndReviewNoteFilled);

    assert.doesNotMatch(result, /🛠 변경 내용/);
    assert.doesNotMatch(result, /📸 스크린샷/);
    assert.match(result, /✨ 변경 사항의 배경/);
    assert.match(result, /JIRA-1234/);
    assert.match(result, /📑 추가 리뷰 요청/);
    assert.match(result, /diffFormatter\.ts/);
});

test('extractUserWrittenPrDescription keeps a heading followed directly by real content with no blank line', () => {
    const description = [
        '🛠 변경 내용',
        '리뷰시 필수 입력 P1~P5',
        'P1 = 🔴 꼭 반영해 주세요 (Request changes)',
        'P2 = 🟠 적극적으로 고려해 주세요 (Request changes)',
    ].join('\n');

    const result = extractUserWrittenPrDescription(description);

    assert.match(result, /🛠 변경 내용/);
    assert.match(result, /리뷰시 필수 입력 P1~P5/);
});

test('extractUserWrittenPrDescription keeps a markdown heading added after the unfilled template, and still drops the unfilled sections', () => {
    const description = [
        '## 🛠 변경 내용',
        '',
        '',
        '## ✨ 변경 사항의 배경',
        '',
        '변경 사항과 관련된 이슈나 풀 리퀘스트가 있나요? (있다면 이슈넘버나 링크를 추가해주세요)',
        '',
        '## 📑 추가 리뷰 요청 (선택 사항)',
        '',
        '리뷰어가 꼭 봐줬으면 하는 부분이 있다면 해당 부분을 정리해주세요.',
        '',
        '## 📸 스크린샷 (선택 사항)',
        '',
        'UI 변경 사항이 있다면 이전과 이후의 스크린샷을 제공하세요. 스크린샷은 변경 사항의 시각적인 영향을 리뷰어가 이해하는 데 도움이 될 수 있습니다.',
        '',
        '',
        '### 리뷰시 필수 입력 P1~P5',
        '- P1 = 🔴 꼭 반영해 주세요 (Request changes)',
        '- P2 = 🟠 적극적으로 고려해 주세요 (Request changes)',
        '- P3 = 🟡 웬만하면 반영해 주세요 (Comment)',
        '- P4 = 🔵 반영해도 좋고 넘어가도 좋습니다 (Approve)',
        '- P5 = 💬 그냥 사소한 의견입니다 (Approve)',
    ].join('\n');

    const result = extractUserWrittenPrDescription(description);

    assert.match(result, /리뷰시 필수 입력 P1~P5/);
    assert.match(result, /P1 = 🔴/);
    assert.doesNotMatch(result, /✨ 변경 사항의 배경/);
    assert.doesNotMatch(result, /📑 추가 리뷰 요청/);
    // 안 고친 스크린샷 안내문이 P1~P5 블록에 끌려와 함께 살아남으면 안 된다.
    assert.doesNotMatch(result, /UI 변경 사항이 있다면 이전과 이후의 스크린샷/);
});

test('extractUserWrittenPrDescription keeps free-form descriptions with no known template heading', () => {
    const freeform = '이번 PR은 리뷰 프롬프트에 PR 설명을 반영하는 로직을 수정합니다.';

    assert.equal(extractUserWrittenPrDescription(freeform), freeform);
});

test('GuardrailPolicyError is exported and carries parsed match/type pairs', () => {
    const rawMsg = `400: {'error': 'Violated guardrail policy', 'assessments': [{'policy': 'sensitiveInformationPolicy', 'matches': [{'category': 'piiEntities', 'type': 'CREDIT_DEBIT_CARD_NUMBER', 'match': '99999', 'action': 'BLOCKED'}]}]}`;

    const error = new GuardrailPolicyError('차단됨', {
        guardrailMatches: [{ match: '99999', type: 'CREDIT_DEBIT_CARD_NUMBER' }],
        rawMessage: rawMsg,
    });

    assert.equal(error.name, 'GuardrailPolicyError');
    assert.equal(error.guardrailMatches.length, 1);
    assert.equal(error.guardrailMatches[0].match, '99999');
    assert.equal(error.guardrailMatches[0].type, 'CREDIT_DEBIT_CARD_NUMBER');
    assert.ok(error instanceof GuardrailPolicyError);
    assert.ok(error instanceof Error);
});

test('parseClaudeReviewResponse does not expose raw truncated JSON as the review summary', () => {
    const raw = `{
  "changeSummary": "앱 리뷰 팝업 흐름을 추가합니다.",
  "flowRisks": [
    "Redux 반영 시점과 currentReviewItem 계산 시점이 어긋날 수 있습니다."
  ],
  "testPoints": [],
  "comments": [
    {
      "file": "src/main/front-app/src/components/item/ItemReviewForApp.tsx",
      "line": 150,
      "lineType": "ADDED",
      "severity": "P2",
      "text": "🟠 currentReviewItem 계산 시점이 Redux 업데이트보다 앞설 수 있습니다."
    },
    {
      "file`;

    const { reviewData, isOutputTruncated } = parseClaudeReviewResponse(raw, {
        stopReason: 'max_tokens'
    });

    assert.equal(isOutputTruncated, true);
    assert.match(reviewData.changeSummary, /출력 토큰 한도/);
    assert.doesNotMatch(reviewData.changeSummary, /"comments"/);
    assert.deepEqual(reviewData.comments, []);
});
