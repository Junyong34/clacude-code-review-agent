export const createReviewer = (name = 'reviewer1', displayName = 'Reviewer One') => ({
    user: {
        name,
        displayName,
    },
});

export const createPullRequestPayload = (overrides = {}) => {
    const pullRequest = {
        id: 123,
        title: 'DEMO-1234 테스트 PR',
        description: '테스트 설명',
        draft: false,
        fromRef: {
            displayId: 'feature/demo-1234',
        },
        toRef: {
            displayId: 'master',
            repository: {
                name: 'example-app',
            },
        },
        reviewers: [createReviewer()],
        links: {
            self: [{ href: 'https://bitbucket.example.test/projects/DEMO/repos/example-app/pull-requests/123' }],
        },
        author: {
            user: {
                name: 'author1',
                displayName: 'Author One',
            },
        },
    };

    return {
        eventKey: 'pr:opened',
        actor: {
            name: 'actor1',
            displayName: 'Actor One',
            emailAddress: 'actor@example.test',
        },
        pullRequest,
        ...overrides,
    };
};

export const createOpenPr = (overrides = {}) => ({
    id: 1,
    title: 'DEMO-1234 배포 대상 PR',
    draft: false,
    fromRef: {
        displayId: 'feature/demo-1234',
    },
    toRef: {
        displayId: 'master',
    },
    links: {
        self: [{ href: 'https://bitbucket.example.test/pr/1' }],
    },
    author: {
        user: {
            displayName: 'Author One',
        },
    },
    ...overrides,
});
