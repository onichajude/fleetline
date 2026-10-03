import type { Session } from "./types";

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export const normalizeServer = (url: string) => {
  let s = url.trim().replace(/\/+$/, "");
  if (s && !/^https?:\/\//i.test(s)) s = `https://${s}`;
  return s;
};

export async function request<T>(server: string, token: string | null, method: string, path: string, body?: unknown): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  let res: Response;
  try {
    res = await fetch(`${server}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch {
    throw new ApiError(`Can't reach ${server}. Check the server address and your connection.`, 0);
  } finally {
    clearTimeout(timer);
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new ApiError((data as { error?: string } | null)?.error || `Request failed (${res.status})`, res.status);
  return data as T;
}

export const api = <T>(s: Session, method: string, path: string, body?: unknown) => request<T>(s.server, s.token, method, path, body);
