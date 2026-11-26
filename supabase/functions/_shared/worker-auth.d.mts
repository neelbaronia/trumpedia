export function signWorkRequest(input: { token: string; now?: number }): Promise<Record<string, string>>;
export function verifyWorkRequest(input: { token?: string; timestamp?: string | null; signature?: string | null; now?: number }): Promise<boolean>;
