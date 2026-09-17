import axios from "axios";
import type { SlackHookResult, SlackMessage } from "../types/slack.js";

export const slackHooksCall = async (slackUrl: string | undefined, slackMsg: SlackMessage): Promise<SlackHookResult> => {
    // Slack로 JSON 데이터 전송
   return await axios.post(slackUrl as string, slackMsg)
        .then(response => {
            console.log('Slack로 메시지 전송 완료');
            return {
                status: 200,
                data: '웹훅이 성공적으로 처리되었습니다.'
            }
        })
        .catch(error => {
            console.error('Slack로 메시지 전송 실패:', error);
            return {
                status: 500,
                data: '웹훅 처리 중 오류가 발생했습니다.'
            }
        });
}
