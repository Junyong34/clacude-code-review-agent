import axios from 'axios';
import { BOT_COMMENT_SIGNATURE } from '../../prompts/codeReview.js';
import { toHttpErrorLike } from '../../types/http.js';
import type {
    BitbucketActivity,
    BitbucketDiffData,
    BitbucketOpenPullRequest,
    ReviewLineType,
} from '../../types/bitbucket.js';

const BITBUCKET_API_URL = process.env.BITBUCKET_API_URL;
const AUTH_HEADER = process.env.BITBUCKET_AUTH_HEADER;
const BOT_AUTH_HEADER = process.env.BITBUCKET_BOT_AUTH_HEADER;

/**
 * PR 상세 API를 만들기 위해 open PR 목록 URL에서 query string을 제거한다.
 * 예: .../pull-requests?state=OPEN -> .../pull-requests
 */
const getPrBaseUrl = (): string => (BITBUCKET_API_URL as string).split('?')[0];

/**
 * Bitbucket에서 현재 open 상태인 PR 목록을 가져온다.
 * Daily PR reminder의 원천 데이터로 사용된다.
 */
export const fetchOpenPRs = async (): Promise<BitbucketOpenPullRequest[]> => {
    try {
        const response = await axios.get<{ values?: BitbucketOpenPullRequest[] }>(BITBUCKET_API_URL as string, {
            headers: {
                'Authorization': AUTH_HEADER,
                'Accept': 'application/json'
            }
        });
        return response.data.values || [];
    } catch (error) {
        const parsedError = toHttpErrorLike(error);
        console.error('Error fetching PRs from Bitbucket:', parsedError.message);
        throw error;
    }
};

/**
 * 특정 PR의 diff JSON을 조회한다.
 * AI 리뷰 입력 생성은 이 응답을 diffFormatter에서 다시 변환해 처리한다.
 */
export const fetchPRDiff = async (prId: number): Promise<BitbucketDiffData> => {
    const url = `${getPrBaseUrl()}/${prId}/diff`;
    console.log(`[code-review] fetchPRDiff URL: ${url}`);
    try {
        const response = await axios.get<BitbucketDiffData>(url, {
            headers: {
                'Authorization': AUTH_HEADER,
                'Accept': 'application/json'
            }
        });
        return response.data;
    } catch (error) {
        const parsedError = toHttpErrorLike(error);
        console.error('[code-review] diff 조회 실패:', parsedError.message);
        console.error('[code-review] diff 조회 실패 status:', parsedError.response?.status);
        console.error('[code-review] diff 조회 실패 body:', JSON.stringify(parsedError.response?.data));
        throw error;
    }
};

/**
 * 특정 PR의 activity 목록을 조회한다.
 * 기존 bot 코멘트 탐색은 Bitbucket `/comments`가 아니라 `/activities` 기준으로 처리한다.
 */
export const fetchPRActivities = async (prId: number, limit = 100): Promise<BitbucketActivity[]> => {
    const url = `${getPrBaseUrl()}/${prId}/activities?limit=${limit}`;
    console.log(`[code-review] fetchPRActivities URL: ${url}`);
    try {
        const response = await axios.get<{ values?: BitbucketActivity[] }>(url, {
            headers: {
                'Authorization': AUTH_HEADER,
                'Accept': 'application/json'
            }
        });
        return response.data.values || [];
    } catch (error) {
        const parsedError = toHttpErrorLike(error);
        console.error('[code-review] 코멘트 조회 실패:', parsedError.message);
        console.error('[code-review] 코멘트 조회 실패 status:', parsedError.response?.status);
        console.error('[code-review] 코멘트 조회 실패 body:', JSON.stringify(parsedError.response?.data));
        throw error;
    }
};

/**
 * PR activity 중 bot의 최종 리뷰 시그니처가 이미 남아 있는지 확인한다.
 * 자동 리뷰/재리뷰 중복 실행을 막는 1차 방어선이다.
 */
export const checkBotCommentExists = async (prId: number, signature = BOT_COMMENT_SIGNATURE): Promise<boolean> => {
    const url = `${getPrBaseUrl()}/${prId}/activities?limit=100`;
    console.log(`[code-review] checkBotCommentExists URL: ${url}`);
    try {
        const activities = await fetchPRActivities(prId);
        const comments = activities
            .filter(a => a.action === 'COMMENTED')
            .map(a => a.comment?.text || '');
        console.log(`[code-review] 코멘트 수: ${comments.length}`);
        return comments.some(text => text.includes(signature));
    } catch (error) {
        const parsedError = toHttpErrorLike(error);
        console.error('[code-review] 코멘트 조회 실패:', parsedError.message);
        console.error('[code-review] 코멘트 조회 실패 status:', parsedError.response?.status);
        console.error('[code-review] 코멘트 조회 실패 body:', JSON.stringify(parsedError.response?.data));
        throw error;
    }
};

/**
 * bot이 이미 남긴 인라인 코멘트의 file:line:lineType 키를 수집한다.
 * 같은 라인에 동일한 인라인 코멘트를 반복 작성하지 않도록 사용한다.
 */
export const fetchBotInlineCommentKeys = async (prId: number, botSlug: string | undefined): Promise<Set<string>> => {
    const activities = await fetchPRActivities(prId);
    const keys = new Set<string>();
    for (const activity of activities) {
        if (activity.action !== 'COMMENTED') continue;
        const comment = activity.comment;
        if (!comment?.anchor?.path || comment.author?.name !== botSlug) continue;
        keys.add(`${comment.anchor.path}:${comment.anchor.line}:${comment.anchor.lineType}`);
    }
    return keys;
};

/**
 * Bitbucket PR diff의 특정 파일/라인에 인라인 코멘트를 작성한다.
 * 삭제 라인은 원본 파일(FROM), 추가/컨텍스트 라인은 대상 파일(TO)에 anchor를 건다.
 */
export const postInlineComment = async (prId: number, file: string, line: number, lineType: ReviewLineType | string, text: string): Promise<void> => {
    const url = `${getPrBaseUrl()}/${prId}/comments`;
    // REMOVED 라인은 원본 파일(FROM), 나머지는 대상 파일(TO)
    const fileType = lineType === 'REMOVED' ? 'FROM' : 'TO';
    console.log(`[code-review] 인라인 코멘트 작성 중: ${file}:${line} (${lineType})`);
    try {
        await axios.post(url, {
            text,
            anchor: { line, lineType, fileType, path: file }
        }, {
            headers: {
                'Authorization': BOT_AUTH_HEADER,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        });
    } catch (error) {
        const parsedError = toHttpErrorLike(error);
        console.error(`[code-review] 인라인 코멘트 작성 실패 (${file}:${line}):`, parsedError.message);
        console.error('[code-review] 인라인 코멘트 실패 body:', JSON.stringify(parsedError.response?.data));
        // 인라인 코멘트 실패는 전체 중단 없이 계속 진행
    }
};

/**
 * PR 최상위 코멘트를 작성한다.
 * 리뷰 스킵 안내, 최종 리뷰 요약, 재리뷰 제한 안내에 공통으로 사용된다.
 */
export const postPRComment = async (prId: number, commentText: string): Promise<void> => {
    const url = `${getPrBaseUrl()}/${prId}/comments`;
    console.log(`[code-review] postPRComment URL: ${url}`);
    try {
        await axios.post(url, { text: commentText }, {
            headers: {
                'Authorization': BOT_AUTH_HEADER,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        });
    } catch (error) {
        const parsedError = toHttpErrorLike(error);
        console.error('[code-review] 코멘트 작성 실패:', parsedError.message);
        console.error('[code-review] 코멘트 작성 실패 status:', parsedError.response?.status);
        console.error('[code-review] 코멘트 작성 실패 body:', JSON.stringify(parsedError.response?.data));
        throw error;
    }
};

/**
 * Daily PR 알림 대상만 남긴다.
 * 현재 운영 기준은 draft 제외, WIP 제목 제외, target master만 포함이다.
 */
export const filterPRs = (prs: BitbucketOpenPullRequest[]): BitbucketOpenPullRequest[] => {
    return prs.filter(pr => {
        const isDraft = pr.draft === true;
        const isWip = (pr.title as string).toUpperCase().includes('WIP');
        const isMaster = (pr.toRef as { displayId: string }).displayId === 'master';
        return !isDraft && !isWip && isMaster;
    });
};
