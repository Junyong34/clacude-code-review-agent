import { formatPrTitle } from '../../lib/prTitle.js';
import express from "express";
import { slackHooksCall } from "../../lib/slackWebhook.js";
import { slackWebhookUrlPrd, slackWebhookUrlQa } from "../../config/env.js";
import { extractPrContext, runCodeReview, shouldRunAutoReview } from "../../services/codeReview/prReview.js";
import type { RunCodeReviewContext } from "../../types/review.js";


const hasReviewers = (ctx: RunCodeReviewContext): boolean => ctx.prReviewers.length > 0;
const isWipTitle = (ctx: RunCodeReviewContext): boolean => (ctx.prTitle || '').toUpperCase().includes('WIP');

const triggerAutoReviewIfNeeded = (ctx: RunCodeReviewContext): void => {
    if (!shouldRunAutoReview(ctx)) {
        console.log(`[code-review] 🔎 자동 리뷰 조건 불충족 → 스킵 (PR #${ctx.prID}, target=${ctx.prToBr}, draft=${ctx.draft})`);
        return;
    }

    console.log(`[code-review] 🚀 자동 리뷰 트리거 (PR #${ctx.prID}, target=${ctx.prToBr}) — 백그라운드 실행`);
    void runCodeReview(ctx, { reviewSlackUrl: slackWebhookUrlQa, enableSymbolReferenceHints: true })
        .catch((error) => console.error('[code-review] 오류:', error.message));
};

const router = express.Router();

router.get('/health', (req, res) => {
    res.status(200).json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        service: 'bitbucket-webhook-pr-modified',
    });
});

router.post('/', async (req, res) => {
    const payload = req.body;
    const eventType = payload.eventKey;

    if (eventType !== 'pr:modified') {
        if (payload.test) {
            console.log('⭐test');
            return res.status(200).send('test');
        }

        console.log('⭐️실패');
        return res.status(400).send('전송실패');
    }

    console.log('⭐️ modified ');

    const ctx = extractPrContext(payload);

    if (ctx.isQa) {
        return res.status(200).send('QA');
    }

    if (ctx.draft === true) {
        return res.status(200).send('draft');
    }

    if (!hasReviewers(ctx) || isWipTitle(ctx)) {
        triggerAutoReviewIfNeeded(ctx);

        if (!hasReviewers(ctx)) {
            return res.status(200).send('리뷰어가 없음');
        }

        return res.status(200).send('WIP');
    }

    const slackMessage = {
        text: `🚀 PR 확인 해주세요 .${ctx.isPrd ? '[PRD]' : ''} ${ctx.isQa ? '[QA]' : ''}`,
        attachments: [
            {
                mrkdwn_in: ['text'],
                color: '#4f5aec',
                title: `Pull request <${ctx.prUrl}|#${ctx.prID}>  | (MODIFIED) ${ctx.isPrd ? '🚨' : ''}`,
                pretext: `URL: ${ctx.prUrl} (${ctx.repoName} ☑️)`,
                author_name: `by ${ctx.prUserId} / ${ctx.prAuthor}  `,
                author_email: `${ctx.prEmail}`,
                author_icon: 'https://cdn1.iconfinder.com/data/icons/logos-1/24/developer-community-github-1024.png',
                fields: [
                    {
                        value: `\`${ctx.prFromBr}\`  →  \`${ctx.prToBr}\``,
                        type: 'mrkdwn',
                        short: false
                    },
                    {
                        value: '',
                        short: false
                    },
                    {
                        value: `${formatPrTitle(ctx.prTitle || '')} `,
                        short: false
                    },
                    {
                        title: 'Description',
                        value: `${ctx.prDescription || ''}`,
                        short: false
                    },
                    {
                        title: 'Reviewers',
                        value: `<@${ctx.prUserId}> 👋  ${ctx.reviewerNameList.join(',')}`,
                        type: 'code',
                        short: false
                    },
                ],
                thumb_url: 'https://cdn.icon-icons.com/icons2/2108/PNG/512/bitbucket_icon_130979.png',
                footer: 'bitbucket',
                footer_icon: 'https://cdn.icon-icons.com/icons2/2108/PNG/512/bitbucket_icon_130979.png',
                ts: Math.floor(new Date().getTime() / 1000)
            }
        ]
    };

    const slackUrl = ctx.isPrd ? slackWebhookUrlPrd : slackWebhookUrlQa;
    const result = await slackHooksCall(slackUrl, slackMessage);
    res.status(result.status).send(result.data);

    triggerAutoReviewIfNeeded(ctx);
    return undefined;
});

export default router;
