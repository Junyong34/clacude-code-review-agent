export interface HttpErrorLike {
    message?: string;
    response?: {
        status?: number;
        statusText?: string;
        data?: unknown;
    };
    stack?: string;
}

export const toHttpErrorLike = (error: unknown): HttpErrorLike => {
    if (error && typeof error === 'object') {
        return error as HttpErrorLike;
    }

    return { message: String(error) };
};
