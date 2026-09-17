import { slackWebhookUrlQa } from '../../config/env.js';
import { slackHooksCall } from '../../lib/slackWebhook.js';
import type { SlackMessage } from '../../types/slack.js';

/**
 * 서버 종료/예외 처리 경로에서 QA Slack 채널로 장애 알림을 보낸다.
 */
export const serverDownMsg = async () => {
    const message = '🔴 PR 알람 서버에 문제가 발생 했습니다..‼️';
    const slackMessage: SlackMessage =
    {
        "text": `${message}`,
        "attachments": [
            {
                "mrkdwn_in": ["text"],
                "color": "#e10000",
                // "title": `🚨☠️☠️☠️☠️☠️☠️☠️🚨(Docker 컨테이너⛔️)`,
                // "title_link": "https://api.slack.com/",
                // "pretext": `확인해주세요.`,
                "author_name": `by Code Review Bot  `,
                // "author_email": `}`,
                // "author_link": "https://bitbucket.example.com/",
                "author_icon": "https://cdn1.iconfinder.com/data/icons/logos-1/24/developer-community-github-1024.png",

                "thumb_url": "https://cdn.icon-icons.com/icons2/2108/PNG/512/bitbucket_icon_130979.png",
                "footer": "bitbucket",
                "footer_icon": "https://cdn.icon-icons.com/icons2/2108/PNG/512/bitbucket_icon_130979.png",
                ts: Math.floor(new Date().getTime() / 1000)
            }
        ]
    };

    return await slackHooksCall(slackWebhookUrlQa, slackMessage).then(() => {
        console.log('⭐️ 앱 종료 =>');
    });
};
