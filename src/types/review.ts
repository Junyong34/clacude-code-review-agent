import type { ReviewLineType } from './bitbucket.js';

export type ReviewSeverity = 'P1' | 'P2' | 'P3' | 'P4' | 'P5';

export interface ReviewComment {
    file?: string;
    line?: number;
    lineType?: ReviewLineType | string;
    severity?: ReviewSeverity | string;
    text?: string;
    message?: string;
}

export interface RawReviewData {
    summary?: unknown;
    changeSummary?: unknown;
    flowRisks?: unknown;
    testPoints?: unknown;
    comments?: unknown;
}

export interface NormalizedReviewData {
    summary: string;
    changeSummary: string;
    flowRisks: string[];
    testPoints: string[];
    comments: ReviewComment[];
}

export interface IncludedReviewFile {
    path: string;
    priority: number;
    lineCount: number;
}

/**
 * diff를 문자 예산 기준으로 나눈 청크 하나.
 * 하나의 청크가 하나의 Claude 스트림 호출 입력이 된다.
 */
export interface ReviewDiffChunk {
    /** Claude에 보낼 청크 본문 ([ADD:N]/[REM:N]/[CTX:N] 라인 형식). */
    text: string;
    /** 이 청크에 포함된 파일 목록. 파일이 청크 경계에 걸치면 여러 청크에 나뉘어 등장할 수 있다. */
    includedFiles: IncludedReviewFile[];
    /** 0-based 청크 순번. */
    chunkIndex: number;
    /** 이 diff가 나뉜 전체 청크 수. */
    totalChunks: number;
}

export interface ReviewCodeResult {
    reviewData: NormalizedReviewData;
    isOutputTruncated: boolean;
}

export interface RunCodeReviewContext {
    draft: boolean;
    prAuthor?: string;
    prUserId?: string;
    prEmail?: string;
    prID?: number;
    prTitle?: string;
    prDescription?: string;
    prFromBr: string;
    prToBr: string;
    prReviewers: unknown[];
    reviewerNameList: string[];
    repoName: string;
    prUrl: string;
    isPrd: boolean;
    isQa: boolean;
}
