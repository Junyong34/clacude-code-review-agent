import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildReviewOverviewMarkdown,
    buildSlackReviewSummary,
    mergeChunkReviewData,
    normalizeReviewData
} from '../src/services/codeReview/reviewOutput.js';

test('normalizeReviewData normalizes the richer review schema', () => {
    const normalized = normalizeReviewData({
        changeSummary: '재리뷰 요청을 top-level comment로 제한합니다.',
        flowRisks: ['중복 호출 여부를 activities 조회로 다시 확인해야 합니다.', ''],
        testPoints: ['top-level comment에서만 재리뷰가 실행되는지 확인'],
        comments: [{ file: 'src/routes/pr/comment.ts', line: 12, lineType: 'ADDED', severity: 'P2', text: '🟠 중복 호출 위험' }]
    });

    assert.equal(normalized.summary, '재리뷰 요청을 top-level comment로 제한합니다.');
    assert.deepEqual(normalized.flowRisks, ['중복 호출 여부를 activities 조회로 다시 확인해야 합니다.']);
    assert.deepEqual(normalized.testPoints, ['top-level comment에서만 재리뷰가 실행되는지 확인']);
    assert.equal(normalized.comments.length, 1);
});

test('normalizeReviewData falls back to the legacy summary schema', () => {
    const normalized = normalizeReviewData({
        summary: '✅ 특이사항 없음',
        comments: []
    });

    assert.equal(normalized.changeSummary, '✅ 특이사항 없음');
    assert.deepEqual(normalized.flowRisks, []);
    assert.deepEqual(normalized.testPoints, []);
    assert.deepEqual(normalized.comments, []);
});

test('normalizeReviewData keeps only ADD/REM anchored comments', () => {
    const normalized = normalizeReviewData({
        changeSummary: 'CTX는 맥락으로만 사용합니다.',
        comments: [
            { file: 'src/App.tsx', line: 10, lineType: 'ADDED', severity: 'P2', text: '🟠 추가 라인 이슈' },
            { file: 'src/App.tsx', line: 11, lineType: 'REMOVED', severity: 'P3', text: '🟡 삭제 라인 이슈' },
            { file: 'src/App.tsx', line: 12, lineType: 'CONTEXT', severity: 'P2', text: '🟠 컨텍스트 라인 이슈' },
            { file: 'src/App.tsx', line: 13, lineType: 'UNCHANGED', severity: 'P2', text: '🟠 알 수 없는 라인 타입' }
        ]
    });

    assert.deepEqual(
        normalized.comments.map((comment) => comment.lineType),
        ['ADDED', 'REMOVED']
    );
});

test('buildReviewOverviewMarkdown renders overview sections for top-level PR comments', () => {
    const markdown = buildReviewOverviewMarkdown(normalizeReviewData({
        changeSummary: 'PR comment 이벤트에서 재리뷰 트리거를 정리합니다.',
        flowRisks: ['inline comment는 재리뷰를 다시 트리거하지 않아야 합니다.'],
        testPoints: ['두 번째 재리뷰 요청은 Claude를 다시 호출하지 않아야 합니다.'],
        comments: []
    }));

    assert.match(markdown, /변경 요약/);
    assert.match(markdown, /흐름상 체크할 점/);
    assert.match(markdown, /머지 전 확인 포인트/);
});

test('buildSlackReviewSummary keeps Slack text compact', () => {
    const summary = buildSlackReviewSummary(normalizeReviewData({
        changeSummary: 'master 대상 자동 리뷰 흐름을 유지합니다.',
        flowRisks: ['diff truncated 시 top-level 코멘트만 남깁니다.'],
        testPoints: ['Slack 요약은 한두 줄 수준으로 유지합니다.'],
        comments: []
    }));

    assert.match(summary, /^변경: master 대상 자동 리뷰 흐름을 유지합니다\./);
    assert.doesNotMatch(summary, /머지 전 확인 포인트/);
});

test('mergeChunkReviewData: 청크가 1개면 그대로 반환해 기존 출력과 동일하게 유지한다', () => {
    const single = normalizeReviewData({
        changeSummary: '단일 청크 요약',
        flowRisks: ['리스크 A'],
        testPoints: ['확인 A'],
        comments: [{ file: 'src/a.ts', line: 1, lineType: 'ADDED', severity: 'P2', text: '🟠 이슈' }]
    });

    const merged = mergeChunkReviewData([{ reviewData: single, includedFiles: [{ path: 'src/a.ts', priority: 0, lineCount: 1 }] }]);

    // 소제목 없이 원본 요약 그대로여야 한다.
    assert.equal(merged.changeSummary, '단일 청크 요약');
    assert.doesNotMatch(merged.changeSummary, /파일 그룹/);
    assert.deepEqual(merged.flowRisks, ['리스크 A']);
    assert.equal(merged.comments.length, 1);
});

test('mergeChunkReviewData: 청크가 여러 개면 변경 요약 본문만 이어붙이고 배열을 합친다 (파일 그룹/경로 소제목 없음)', () => {
    const merged = mergeChunkReviewData([
        {
            reviewData: normalizeReviewData({
                changeSummary: '그룹1 변경',
                flowRisks: ['리스크1'],
                testPoints: ['확인1'],
                comments: [{ file: 'src/a.ts', line: 10, lineType: 'ADDED', severity: 'P2', text: '🟠 a' }]
            }),
            includedFiles: [{ path: 'src/a.ts', priority: 0, lineCount: 5 }]
        },
        {
            reviewData: normalizeReviewData({
                changeSummary: '그룹2 변경',
                flowRisks: ['리스크2'],
                testPoints: [],
                comments: [{ file: 'src/b.ts', line: 20, lineType: 'REMOVED', severity: 'P3', text: '🟡 b' }]
            }),
            includedFiles: [{ path: 'src/b.ts', priority: 0, lineCount: 3 }]
        }
    ]);

    // 요약 본문만 문단으로 이어붙는다. 파일 그룹 소제목이나 파일 경로는 들어가지 않는다.
    assert.equal(merged.changeSummary, '그룹1 변경\n\n그룹2 변경');
    assert.doesNotMatch(merged.changeSummary, /파일 그룹/);
    assert.doesNotMatch(merged.changeSummary, /src\/a\.ts/);
    assert.deepEqual(merged.flowRisks, ['리스크1', '리스크2']);
    assert.deepEqual(merged.testPoints, ['확인1']);
    assert.equal(merged.comments.length, 2);
});

test('mergeChunkReviewData: 동일한 변경 요약이 여러 청크에서 반복되면 한 번만 남긴다', () => {
    const merged = mergeChunkReviewData([
        {
            reviewData: normalizeReviewData({ changeSummary: '실제 변경 요약', comments: [] }),
            includedFiles: [{ path: 'src/a.ts', priority: 0, lineCount: 5 }]
        },
        {
            reviewData: normalizeReviewData({ changeSummary: '✅ 특이사항 없음', comments: [] }),
            includedFiles: [{ path: 'package-lock.json', priority: 1, lineCount: 200 }]
        },
        {
            reviewData: normalizeReviewData({ changeSummary: '✅ 특이사항 없음', comments: [] }),
            includedFiles: [{ path: 'yarn.lock', priority: 1, lineCount: 100 }]
        }
    ]);

    // "✅ 특이사항 없음"이 두 번 반복되지 않고 한 번만 남아야 한다.
    assert.equal(merged.changeSummary, '실제 변경 요약\n\n✅ 특이사항 없음');
});

test('mergeChunkReviewData: 같은 file:line:lineType 코멘트는 중복 제거한다', () => {
    const dup = { file: 'src/a.ts', line: 10, lineType: 'ADDED', severity: 'P2', text: '🟠 같은 라인' };
    const merged = mergeChunkReviewData([
        {
            reviewData: normalizeReviewData({ changeSummary: '앞부분', comments: [dup] }),
            includedFiles: [{ path: 'src/a.ts', priority: 0, lineCount: 5 }]
        },
        {
            reviewData: normalizeReviewData({ changeSummary: '이어서', comments: [dup] }),
            includedFiles: [{ path: 'src/a.ts', priority: 0, lineCount: 5 }]
        }
    ]);

    assert.equal(merged.comments.length, 1);
});
