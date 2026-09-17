import type { IncludedReviewFile, NormalizedReviewData, RawReviewData, ReviewComment } from '../../types/review.js';

/**
 * 청크 하나의 리뷰 결과. mergeChunkReviewData 입력 단위다.
 */
export interface ChunkReviewResult {
    reviewData: NormalizedReviewData;
    includedFiles: IncludedReviewFile[];
}

/**
 * 문자열이고 공백 제거 후 내용이 있는 값만 유효한 텍스트로 본다.
 */
const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

/**
 * Claude 응답의 배열 필드를 Slack/Markdown에 바로 쓸 수 있는 문자열 목록으로 정리한다.
 */
const normalizeStringList = (items: unknown): string[] => {
    if (!Array.isArray(items)) return [];
    return items
        .filter(isNonEmptyString)
        .map((item) => item.trim());
};

/**
 * Claude가 반환한 comments 필드가 배열일 때만 리뷰 코멘트 목록으로 받아들인다.
 */
const isReviewableLineType = (lineType: unknown): boolean => lineType === 'ADDED' || lineType === 'REMOVED';

const isReviewComment = (comment: unknown): comment is ReviewComment => {
    return Boolean(comment)
        && typeof comment === 'object'
        && isReviewableLineType((comment as ReviewComment).lineType);
};

const normalizeComments = (comments: unknown): ReviewComment[] => {
    if (!Array.isArray(comments)) return [];
    return comments.filter(isReviewComment);
};

/**
 * Claude 리뷰 응답을 애플리케이션 내부 표준 schema로 정규화한다.
 * 신규 `changeSummary`와 레거시 `summary` 응답을 모두 허용한다.
 */
export const normalizeReviewData = (reviewData: unknown): NormalizedReviewData => {
    const source = reviewData && typeof reviewData === 'object' ? reviewData as RawReviewData : {};
    const legacySummary = isNonEmptyString(source.summary) ? source.summary.trim() : '';
    const changeSummary = isNonEmptyString(source.changeSummary)
        ? source.changeSummary.trim()
        : (legacySummary || '✅ 특이사항 없음');

    return {
        summary: changeSummary,
        changeSummary,
        flowRisks: normalizeStringList(source.flowRisks),
        testPoints: normalizeStringList(source.testPoints),
        comments: normalizeComments(source.comments)
    };
};

/**
 * 항목이 있는 경우에만 Markdown bullet section을 만든다.
 */
const buildBulletSection = (title: string, items: string[]): string => {
    if (!items.length) return '';
    const lines = items.map((item) => `- ${item}`).join('\n');
    return `### ${title}\n${lines}`;
};

/**
 * Bitbucket PR 최상위 코멘트에 남길 리뷰 개요 Markdown을 만든다.
 */
export const buildReviewOverviewMarkdown = (reviewData: unknown): string => {
    const normalized = normalizeReviewData(reviewData);
    const sections = [
        `### 변경 요약\n${normalized.changeSummary}`,
        buildBulletSection('흐름상 체크할 점', normalized.flowRisks),
        buildBulletSection('머지 전 확인 포인트', normalized.testPoints)
    ].filter(Boolean);

    return sections.join('\n\n');
};

/**
 * Slack 알림에 들어갈 짧은 리뷰 요약을 만든다.
 * 긴 리뷰 전체 대신 변경 요약과 첫 번째 리스크/확인 포인트만 포함한다.
 */
export const buildSlackReviewSummary = (reviewData: unknown): string => {
    const normalized = normalizeReviewData(reviewData);
    const lines = [`변경: ${normalized.changeSummary}`];

    if (normalized.flowRisks.length > 0) {
        lines.push(`리스크: ${normalized.flowRisks[0]}`);
    }

    if (normalized.testPoints.length > 0) {
        lines.push(`확인: ${normalized.testPoints[0]}`);
    }

    return lines.join('\n');
};

/**
 * 여러 청크의 리뷰 결과를 하나의 리뷰 데이터로 병합한다. 추가 Claude 호출은 하지 않고 문자열만 합친다.
 *
 * - 청크가 0개면 빈(특이사항 없음) 데이터를 반환한다.
 * - 청크가 1개면 그대로 반환해 기존(단일 호출) 출력 포맷과 완전히 동일하게 유지한다(회귀 방지).
 * - 청크가 2개 이상이면:
 *   - changeSummary는 각 청크의 변경 요약 본문만 문단으로 이어붙인다(파일 그룹/경로 소제목 없음).
 *     동일한 요약(예: "✅ 특이사항 없음")이 여러 청크에서 반복되면 한 번만 남긴다.
 *   - flowRisks/testPoints는 청크 순서대로 이어붙인다.
 *   - comments는 file:line:lineType 기준으로 중복을 제거해 합친다(같은 파일이 두 청크에 걸친 경우 대비).
 */
export const mergeChunkReviewData = (chunkResults: ChunkReviewResult[]): NormalizedReviewData => {
    if (chunkResults.length === 0) return normalizeReviewData({});
    if (chunkResults.length === 1) return chunkResults[0].reviewData;

    const seenSummaries = new Set<string>();
    const changeSummary = chunkResults
        .map((result) => result.reviewData.changeSummary.trim())
        .filter((summary) => {
            if (!summary || seenSummaries.has(summary)) return false;
            seenSummaries.add(summary);
            return true;
        })
        .join('\n\n');

    const seenCommentKeys = new Set<string>();
    const comments: ReviewComment[] = [];
    for (const result of chunkResults) {
        for (const comment of result.reviewData.comments) {
            const key = `${comment.file}:${comment.line}:${comment.lineType}`;
            if (seenCommentKeys.has(key)) continue;
            seenCommentKeys.add(key);
            comments.push(comment);
        }
    }

    return {
        summary: changeSummary,
        changeSummary,
        flowRisks: chunkResults.flatMap((result) => result.reviewData.flowRisks),
        testPoints: chunkResults.flatMap((result) => result.reviewData.testPoints),
        comments,
    };
};
