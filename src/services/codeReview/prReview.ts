import { BITBUCKET_BOT_SLUG, CODE_REVIEW_CRG_ONLY, slackWebhookUrlQa} from '../../config/env.js';
import { BOT_COMMENT_SIGNATURE, BOT_REREVIEW_SIGNATURE } from '../../prompts/codeReview.js';
import { fetchPRDiff, checkBotCommentExists, postPRComment, postInlineComment, fetchBotInlineCommentKeys } from '../bitbucket/index.js';
import { reviewCode, GuardrailPolicyError, ClaudeBudgetExceededError } from './codeReview.js';
import { buildReviewDiffChunks, collectValidLineKeys, isBitbucketDiffTruncated } from './diffFormatter.js';
import { verifyComments } from './commentVerifier.js';
import { ensureMasterWorktreeReady } from '../contextClone/index.js';
import { buildSymbolReferenceHintText, buildSymbolReferenceMarkdown, findUnupdatedReferenceFiles } from './symbolReference.js';
import type { UnupdatedReferenceFile } from './symbolReference.js';
import { analyzeChangedSymbolInterface } from './interfaceChange.js';
import { buildReviewOverviewMarkdown, buildSlackReviewSummary, mergeChunkReviewData } from './reviewOutput.js';
import type { ChunkReviewResult } from './reviewOutput.js';
import { slackHooksCall } from '../../lib/slackWebhook.js';
import { toHttpErrorLike } from '../../types/http.js';
import type { BitbucketComment, BitbucketReviewer, BitbucketWebhookPayload } from '../../types/bitbucket.js';
import type { NormalizedReviewData, ReviewComment, RunCodeReviewContext } from '../../types/review.js';
import type { SlackMessage } from '../../types/slack.js';

type FinalCommentArgs = {
    reviewData: NormalizedReviewData;
    summary: string;
    comments: ReviewComment[];
    signature: string;
    reviewKind: string;
    truncatedNote: string;
    inlineNote: string;
    verificationNote: string;
    symbolReferenceMarkdown: string;
};

type RunCodeReviewOptions = {
    reviewSlackUrl?: string;
    signature?: string;
    skipIfAlreadyReviewed?: boolean;
    sendSlack?: boolean;
    crgOnly?: boolean;
    enableLocalVerification?: boolean;
    enableSymbolReferenceHints?: boolean;
    buildFinalComment?: (args: FinalCommentArgs) => string;
};

const reviewInProgress = new Set<number | undefined>();

/**
 * Bitbucket webhook payload에서 리뷰/Slack 알림에 필요한 공통 PR context를 추출한다.
 * 라우터별 중복 mapping을 줄이고 자동 리뷰 조건 판단의 기준값을 통일한다.
 */
export const extractPrContext = (payload: BitbucketWebhookPayload): RunCodeReviewContext => {
    const pullRequest = payload.pullRequest || {};
    const actor = payload.actor || {};
    const prReviewers: BitbucketReviewer[] = pullRequest.reviewers || [];
    const prToBr = pullRequest.toRef?.displayId || '';

    return {
        draft: pullRequest.draft === true,
        prAuthor: actor.displayName,
        prUserId: actor.name,
        prEmail: actor.emailAddress,
        prID: pullRequest.id,
        prTitle: pullRequest.title,
        prDescription: pullRequest.description,
        prFromBr: pullRequest.fromRef?.displayId || '',
        prToBr,
        prReviewers,
        reviewerNameList: prReviewers.map((reviewer) => `<@${reviewer.user.name}>`),
        repoName: pullRequest.toRef?.repository?.name || '',
        prUrl: pullRequest.links?.self?.[0]?.href || '',
        isPrd: prToBr === 'master',
        isQa: prToBr === 'release/release'
    };
};

/**
 * 자동 AI 리뷰 최종 코멘트가 이미 존재하는지 확인한다.
 */
export const hasExistingReview = async (prId: number | undefined): Promise<boolean> => checkBotCommentExists(prId as number, BOT_COMMENT_SIGNATURE);

/**
 * 수동 재리뷰 최종 코멘트가 이미 존재하는지 확인한다.
 */
export const hasExistingReReview = async (prId: number | undefined): Promise<boolean> => checkBotCommentExists(prId as number, BOT_REREVIEW_SIGNATURE);

/**
 * 자동 리뷰 실행 조건을 판단한다.
 * 현재 운영 정책은 target master이면서 draft가 아닌 PR만 자동 리뷰한다.
 */
export const shouldRunAutoReview = (ctx: RunCodeReviewContext): boolean => ctx.isPrd && ctx.draft !== true;

/**
 * 댓글이 인라인/스레드가 아닌 PR 최상위 댓글인지 확인한다.
 */
export const isTopLevelComment = (comment: BitbucketComment | null | undefined): boolean => Boolean(comment) && !comment?.parent && !comment?.anchor;

/**
 * 수동 재리뷰 요청인지 확인한다.
 * 현재 구현 기준은 bot slug 멘션(`@slug` 또는 `[~slug]`)과 `재리뷰` 문구 존재 여부다.
 */
export const isReReviewRequestComment = (commentText: string | undefined, botSlug: string | undefined): boolean => {
    if (!commentText || !botSlug) return false;

    const hasBotMention = commentText.includes(`@${botSlug}`) || commentText.includes(`[~${botSlug}]`);
    const hasReReviewKeyword = commentText.includes('재리뷰');

    return hasBotMention && hasReReviewKeyword;
};

/**
 * Claude guardrail 차단 상황을 운영자가 볼 수 있는 Slack 메시지로 만든다.
 */
const buildGuardrailErrorSlackMessage = (ctx: RunCodeReviewContext, error: GuardrailPolicyError): SlackMessage => {
    const { prUrl, prID, prTitle = '' } = ctx;
    const matches = error.guardrailMatches ?? [];
    const matchLines = matches.length > 0
        ? matches.map((m) => `• *유형:* ${m.type}  |  *추정 텍스트:* \`${m.match}\``).join('\n')
        : '탐지된 항목 정보를 파싱할 수 없습니다.';

    return {
        text: `⚠️ AI 코드리뷰 차단 — 사내 보안정책 위반 감지 PR <${prUrl}|#${prID}>`,
        attachments: [{
            mrkdwn_in: ['text', 'pretext'],
            color: '#e10000',
            title: `AI Code Review 차단 — PR <${prUrl}|#${prID}>`,
            pretext: prTitle,
            text: [
                '사내 보안정책(Guardrail)에 의해 AI 코드리뷰가 차단되었습니다.',
                'diff에서 개인정보로 의심되는 항목이 감지되었습니다.\n',
                matchLines,
                '\n> ⚠️ 위 탐지 정보는 시스템이 추정한 것으로 실제와 다를 수 있습니다.',
            ].join('\n'),
            footer: 'claude code review',
            ts: Math.floor(Date.now() / 1000),
        }],
    };
};

/**
 * AI 리뷰 완료 후 PRD/QA Slack 채널로 보낼 요약 메시지를 만든다.
 */
const buildReviewSlackMessage = (
    ctx: RunCodeReviewContext,
    reviewData: NormalizedReviewData,
    signature: string,
): SlackMessage => ({
    text: signature === BOT_REREVIEW_SIGNATURE
        ? '🤖 AI 재리뷰가 완료되었습니다.'
        : '🤖 AI 코드리뷰가 완료되었습니다.',
    attachments: [
        {
            mrkdwn_in: ['text'],
            color: signature === BOT_REREVIEW_SIGNATURE ? '#805ad5' : '#6f42c1',
            title: `${signature === BOT_REREVIEW_SIGNATURE ? 'AI Re-Review' : 'AI Code Review'} — PR <${ctx.prUrl}|#${ctx.prID}>`,
            pretext: `${ctx.prTitle || ''}`,
            text: `${buildSlackReviewSummary(reviewData)}`,
            footer: 'claude code review',
            ts: Math.floor(new Date().getTime() / 1000)
        }
    ]
});

/**
 * Claude SDK를 호출하지 않고 CRG 결과만 확인하기 위한 임시 진단 코멘트다.
 * 완료 시그니처를 넣지 않아 사용량 복구 후 실제 AI 재리뷰를 다시 요청할 수 있게 한다.
 */
export const buildCrgOnlyComment = (
    ctx: RunCodeReviewContext,
    changedFileCount: number,
    symbolReferenceMarkdown: string,
): string => {
    const referenceSection = symbolReferenceMarkdown || '### 호출부 확인 결과\n\n외부 인터페이스 변경으로 확인이 필요한 참조 파일은 없습니다.';

    return [
        '🧭 CRG 분석 결과',
        '',
        'Claude SDK는 호출하지 않고 CRG 데이터만 조회했습니다.',
        `대상 PR: #${ctx.prID}`,
        `변경 파일: ${changedFileCount}개`,
        '',
        referenceSection,
        '',
        '> 임시 CRG 전용 모드입니다. Claude 사용량 복구 후 실제 AI 재리뷰를 실행해 주세요.',
    ].join('\n');
};

/**
 * 자동 리뷰와 수동 재리뷰의 공통 실행 파이프라인이다.
 * diff 조회 → truncate 검사 → 청크 분할 → 청크별 Claude 스트림 호출(순차) → 결과 병합 →
 * 인라인 코멘트 작성 → 최종 코멘트/Slack 전송을 순서대로 처리한다.
 *
 * 실패 정책: 청크 하나라도 실패하면(guardrail 포함 모든 원인) 리뷰 전체를 중단한다.
 * 인라인 코멘트는 모든 청크가 성공한 뒤에만 한 번에 작성하므로, 중단 시 부분 코멘트가 남지 않는다.
 */
export const runCodeReview = async (ctx: RunCodeReviewContext, options: RunCodeReviewOptions = {}): Promise<boolean> => {
    const {
        reviewSlackUrl = slackWebhookUrlQa,
        signature = BOT_COMMENT_SIGNATURE,
        skipIfAlreadyReviewed = true,
        sendSlack = true,
        crgOnly = CODE_REVIEW_CRG_ONLY,
        enableLocalVerification = false,
        enableSymbolReferenceHints = false,
        buildFinalComment,
    } = options;
    const { prID } = ctx;
    const reviewKind = signature === BOT_REREVIEW_SIGNATURE ? '재리뷰' : '리뷰';

    if (reviewInProgress.has(prID)) {
        console.log(`[code-review] PR #${prID} 이미 ${reviewKind} 진행 중, 스킵`);
        return false;
    }
    reviewInProgress.add(prID);

    const reviewStartedAt = Date.now();
    // catch 블록(Claude 예산 초과 시 CRG 결과만 게시)에서도 참조해야 해서 try 밖에 선언한다.
    let changedFileCount = 0;
    let symbolReferenceMarkdown = '';
    try {
        console.log(`[code-review] ===== PR #${prID} ${reviewKind} 시작 (${ctx.repoName}, target: ${ctx.prToBr}) =====`);

        if (skipIfAlreadyReviewed) {
            console.log('[code-review] 기존 bot 코멘트 확인 중...');
            const exists = await checkBotCommentExists(prID as number, signature);
            if (exists) {
                console.log(`[code-review] 이미 ${reviewKind} 코멘트 존재, 스킵`);
                return false;
            }
        }

        // 실패/스킵 안내 코멘트는 완료 시그니처(BOT_COMMENT_SIGNATURE 등)를 절대 포함하지 않는다.
        // 포함하면 checkBotCommentExists(text.includes(signature))가 이를 '이미 리뷰 완료'로 오인해
        // 이후 자동 리뷰/재리뷰가 영구 차단되기 때문이다. 완료 시그니처는 오직 성공한 최종 코멘트에만 붙인다.
        let diffData;
        try {
            diffData = await fetchPRDiff(prID as number);
        } catch (error) {
            await postPRComment(prID as number, `⚠️ diff를 가져올 수 없어 AI ${reviewKind}를 건너뜁니다.`)
                .catch((postError: Error) => console.error('[code-review] 오류:', postError.message));
            return false;
        }

        // Bitbucket이 이미 잘라 보낸 diff는 신뢰할 수 없으므로 top-level 안내만 남기고 건너뛴다.
        if (isBitbucketDiffTruncated(diffData)) {
            await postPRComment(prID as number, `⚠️ diff가 너무 커서 AI ${reviewKind}를 건너뜁니다 (Bitbucket truncated).`)
                .catch((postError: Error) => console.error('[code-review] 오류:', postError.message));
            return false;
        }

        // 심볼 참조 힌트: 마스터 워크트리(상시 유지, code-review-graph 포함)를 최신화하고, 이번 diff가
        // 변경한 함수/컴포넌트를 참조하지만 diff에는 포함되지 않은 파일("미갱신 참조 파일")을 찾는다.
        // 실패(바이너리 없음, 네트워크 오류 등)해도 리뷰 전체를 막지 않고 힌트 없이 계속 진행한다.
        changedFileCount = (diffData?.diffs ?? []).length;
        let symbolReferenceEntries: UnupdatedReferenceFile[] = [];
        if (enableSymbolReferenceHints || crgOnly) {
            try {
                const masterWorktreePath = await ensureMasterWorktreeReady();
                symbolReferenceEntries = await findUnupdatedReferenceFiles(masterWorktreePath, diffData);
                symbolReferenceEntries = symbolReferenceEntries.map((entry) => {
                    const interfaceChange = analyzeChangedSymbolInterface(masterWorktreePath, diffData, entry);
                    console.log(`[code-review] CRG 인터페이스 판정: ${entry.definitionFile}::${entry.symbol} → ${interfaceChange.kind} (${interfaceChange.summary})`);
                    return { ...entry, interfaceChange };
                });
            } catch (error) {
                console.error('[code-review] 심볼 참조 힌트 실패(무시):', (error as Error).message);
            }
        }
        const referenceHintText = buildSymbolReferenceHintText(symbolReferenceEntries);
        symbolReferenceMarkdown = buildSymbolReferenceMarkdown(symbolReferenceEntries);

        if (crgOnly) {
            console.log(`[code-review] PR #${prID} ${reviewKind}: Claude SDK 호출 스킵, CRG 결과만 게시`);
            await postPRComment(prID as number, buildCrgOnlyComment(ctx, changedFileCount, symbolReferenceMarkdown));
            console.log(`[code-review] PR #${prID} ${reviewKind}: CRG 전용 코멘트 작성 완료`);
            return true;
        }

        // diff를 문자 예산(기본 50,000자) 기준 청크로 나눈다. 작은 PR은 1개, 큰 PR은 여러 개가 된다.
        console.log(`[code-review] diff 조회 완료 (변경 파일 ${changedFileCount}개) → 청크 분할 시작`);
        const chunks = buildReviewDiffChunks(diffData);
        if (chunks.length === 0) {
            await postPRComment(prID as number, `⚠️ 리뷰할 변경 내용이 없어 AI ${reviewKind}를 건너뜁니다.`)
                .catch((postError: Error) => console.error('[code-review] 오류:', postError.message));
            return false;
        }
        console.log(`[code-review] 📦 diff를 청크 ${chunks.length}개로 분할:`);
        for (const chunk of chunks) {
            const fileList = chunk.includedFiles.map((f) => `${f.path}(${f.lineCount}줄)`).join(', ');
            console.log(`[code-review]    └ 청크 ${chunk.chunkIndex + 1}/${chunk.totalChunks}: ${chunk.text.length}자, 파일 ${chunk.includedFiles.length}개 [${fileList}]`);
        }

        // 청크를 순차 처리하며 결과를 누적한다. 하나라도 실패하면 throw되어 아래 catch에서 리뷰 전체가 중단된다.
        const chunkResults: ChunkReviewResult[] = [];
        let anyOutputTruncated = false;
        for (const chunk of chunks) {
            const chunkLabel = `[PR #${prID} ${reviewKind} 청크 ${chunk.chunkIndex + 1}/${chunk.totalChunks}]`;
            console.log(`[code-review] ${chunkLabel} 리뷰 시작 (${chunk.text.length}자, 파일 ${chunk.includedFiles.length}개)`);
            const { reviewData, isOutputTruncated } = await reviewCode(chunk.text, chunkLabel, ctx.prDescription, referenceHintText);
            anyOutputTruncated = anyOutputTruncated || isOutputTruncated;
            chunkResults.push({ reviewData, includedFiles: chunk.includedFiles });
            console.log(`[code-review] ${chunkLabel} 리뷰 완료 (코멘트 ${reviewData.comments.length}개)`);
        }

        // 모든 청크가 성공한 경우에만 여기 도달한다. 결과를 병합해 기존 게시 로직을 그대로 탄다.
        const normalizedReviewData = mergeChunkReviewData(chunkResults);
        const { summary, comments = [] } = normalizedReviewData;
        console.log(`[code-review] 🧩 청크 ${chunkResults.length}개 병합 완료 (코멘트 ${comments.length}개, flowRisks ${normalizedReviewData.flowRisks.length}, testPoints ${normalizedReviewData.testPoints.length})`);

        const existingInlineKeys = await fetchBotInlineCommentKeys(prID as number, BITBUCKET_BOT_SLUG);
        let newComments = comments.filter((c) => !existingInlineKeys.has(`${c.file}:${c.line}:${c.lineType}`));
        const skippedCount = comments.length - newComments.length;
        if (skippedCount > 0) {
            console.log(`[code-review] 인라인 코멘트 중복 ${skippedCount}개 스킵`);
        }

        // 로컬 검증: AI가 만든 코멘트의 line이 실제 diff ADD/REM에 존재하는지 코드로 확인한다(LLM 재호출 없음).
        // 검증 실패 코멘트는 게시하지 않고 최종 코멘트에만 안내를 남긴다.
        let verificationNote = '';
        if (enableLocalVerification) {
            const validLineKeys = collectValidLineKeys(diffData);
            const { verified, rejected } = verifyComments(newComments, validLineKeys);
            newComments = verified;
            if (rejected.length > 0) {
                console.log(`[code-review] 로컬 검증 실패로 ${rejected.length}개 코멘트 제외`);
                verificationNote = `\n\n> ⚠️ 코멘트 ${rejected.length}개가 diff 라인과 위치가 맞지 않아 로컬 검증에서 제외됐습니다.`;
            }
        }

        console.log(`[code-review] 💬 인라인 코멘트 ${newComments.length}개 작성 시작`);
        for (const comment of newComments) {
            console.log(`[code-review]    → ${comment.file}:${comment.line} (${comment.lineType}, ${comment.severity})`);
            await postInlineComment(prID as number, comment.file as string, comment.line as number, comment.lineType as string, comment.text as string);
        }
        console.log('[code-review] 인라인 코멘트 작성 완료');

        // 청크 중 하나라도 출력 토큰 한도로 잘렸으면 최종 코멘트에 안내를 덧붙인다.
        const truncatedNote = anyOutputTruncated
            ? '\n\n> ⚠️ AI 응답이 출력 토큰 한도에서 잘려 일부 인라인 코멘트가 누락됐을 수 있습니다. 재리뷰를 요청하거나 변경 범위를 줄여 주세요.'
            : '';
        const inlineNote = newComments.length > 0
            ? `\n\n인라인 코멘트 **${newComments.length}개**를 확인해 주세요. 🙏`
            : '';
        const symbolReferenceSection = symbolReferenceMarkdown ? `\n\n${symbolReferenceMarkdown}` : '';
        const finalComment = typeof buildFinalComment === 'function'
            ? buildFinalComment({ reviewData: normalizedReviewData, summary, comments: newComments, signature, reviewKind, truncatedNote, inlineNote, verificationNote, symbolReferenceMarkdown })
            : `${signature}\n\n${buildReviewOverviewMarkdown(normalizedReviewData)}${symbolReferenceSection}${inlineNote}${verificationNote}${truncatedNote}`;

        await postPRComment(prID as number, finalComment);
        console.log(`[code-review] PR ${reviewKind} 최종 코멘트 작성 완료`);

        if (sendSlack && reviewSlackUrl) {
            const slackMessage = buildReviewSlackMessage(ctx, normalizedReviewData, signature);
            await slackHooksCall(reviewSlackUrl, slackMessage);
            console.log(`[code-review] Slack ${reviewKind} 요약 전송 완료`);
        }

        console.log(`[code-review] ===== PR #${prID} ${reviewKind} 전체 완료 (${Date.now() - reviewStartedAt}ms) =====`);
        return true;
    } catch (error) {
        if (error instanceof GuardrailPolicyError) {
            console.error(`[code-review] PR #${prID} Guardrail 차단:`, error.message, error.guardrailMatches);
            if (reviewSlackUrl) {
                await slackHooksCall(reviewSlackUrl, buildGuardrailErrorSlackMessage(ctx, error))
                    .catch((e: Error) => console.error('[code-review] Guardrail Slack 전송 실패:', e.message));
            }
            return false;
        }

        // Claude 예산(budget) 초과: 재시도해도 예산이 복구되기 전까지 계속 실패하므로, 범용 에러 문구 대신
        // 이미 계산해둔 CRG 결과(있다면)만 게시한다. 완료 시그니처가 없어 예산 복구 후 재리뷰 요청이 다시 가능하다.
        if (error instanceof ClaudeBudgetExceededError) {
            console.error(`[code-review] PR #${prID} ${reviewKind} 실패(Claude 예산 초과) → CRG 결과만 게시:`, error.rawMessage);
            await postPRComment(prID as number, buildCrgOnlyComment(ctx, changedFileCount, symbolReferenceMarkdown))
                .catch((postError: Error) => console.error('[code-review] 오류:', postError.message));
            return false;
        }

        // guardrail 외 실패(네트워크/파싱 등): 청크 하나라도 실패하면 전체 중단.
        // 인라인 코멘트는 아직 게시 전이라 부분 코멘트가 남지 않는다. PR에 스킵 안내만 남기고 Slack은 보내지 않는다.
        // 안내 코멘트에 완료 시그니처를 넣지 않아, 일시 오류였다면 다음 이벤트에서 재시도가 정상적으로 다시 트리거된다.
        const apiError = toHttpErrorLike(error);
        console.error(`[code-review] PR #${prID} ${reviewKind} 실패로 중단:`, apiError.message);
        await postPRComment(prID as number, `⚠️ AI ${reviewKind} 처리 중 오류가 발생해 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.`)
            .catch((postError: Error) => console.error('[code-review] 오류:', postError.message));
        return false;
    } finally {
        reviewInProgress.delete(prID);
    }
};
