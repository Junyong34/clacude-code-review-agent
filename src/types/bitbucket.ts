export interface BitbucketRepositoryRef {
    name?: string;
}

export interface BitbucketRef {
    displayId?: string;
    repository?: BitbucketRepositoryRef;
}

export interface BitbucketUser {
    name?: string;
    displayName?: string;
    emailAddress?: string;
}

export interface BitbucketReviewer {
    user: BitbucketUser;
}

export interface BitbucketLink {
    href?: string;
}

export interface BitbucketPullRequest {
    id?: number;
    title?: string;
    description?: string;
    draft?: boolean;
    fromRef?: BitbucketRef;
    toRef?: BitbucketRef;
    reviewers?: BitbucketReviewer[];
    links?: {
        self?: BitbucketLink[];
    };
    author?: {
        user?: BitbucketUser;
    };
}

export interface BitbucketCommentAnchor {
    path?: string;
    line?: number;
    lineType?: ReviewLineType | string;
}

export interface BitbucketComment {
    id?: number;
    text?: string;
    parent?: unknown;
    anchor?: BitbucketCommentAnchor;
    author?: BitbucketUser;
}

export interface BitbucketWebhookPayload {
    eventKey?: string;
    actor?: BitbucketUser;
    pullRequest?: BitbucketPullRequest;
    comment?: BitbucketComment;
    test?: boolean;
}

export interface BitbucketActivity {
    action?: string;
    comment?: BitbucketComment;
}

export type ReviewLineType = 'ADDED' | 'REMOVED' | 'CONTEXT';
export type TruncatedValue = boolean | 'true' | 'false';

export interface BitbucketDiffLine {
    source?: number | null;
    destination?: number | null;
    line?: string;
    truncated?: TruncatedValue;
}

export interface BitbucketDiffSegment {
    type?: ReviewLineType | string;
    lines?: BitbucketDiffLine[];
    truncated?: TruncatedValue;
}

export interface BitbucketDiffHunk {
    segments?: BitbucketDiffSegment[];
    truncated?: TruncatedValue;
}

export interface BitbucketFileDiff {
    source?: { toString?: string };
    destination?: { toString?: string };
    path?: { toString?: string };
    hunks?: BitbucketDiffHunk[];
    truncated?: TruncatedValue;
}

export interface BitbucketDiffData {
    diffs?: BitbucketFileDiff[];
    truncated?: TruncatedValue;
}

export interface BitbucketOpenPullRequest {
    id?: number;
    title?: string;
    draft?: boolean;
    fromRef?: BitbucketRef;
    toRef?: BitbucketRef;
    links?: {
        self?: BitbucketLink[];
    };
    author?: {
        user?: BitbucketUser;
    };
}
