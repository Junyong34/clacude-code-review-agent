export interface SlackTextObject {
    type: 'mrkdwn' | 'plain_text';
    text: string;
}

export interface SlackField {
    title?: string;
    value: string;
    type?: string;
    short?: boolean;
}

export interface SlackAttachment {
    mrkdwn_in?: string[];
    color?: string;
    title?: string;
    title_link?: string;
    pretext?: string;
    text?: string;
    author_name?: string;
    author_email?: string;
    author_icon?: string;
    fields?: SlackField[];
    thumb_url?: string;
    footer?: string;
    footer_icon?: string;
    ts?: number;
}

export interface SlackBlock {
    type: string;
    text?: SlackTextObject;
    elements?: SlackTextObject[];
}

export interface SlackMessage {
    text?: string;
    blocks?: SlackBlock[];
    attachments?: SlackAttachment[];
}

export interface SlackHookResult {
    status: number;
    data: string;
}
