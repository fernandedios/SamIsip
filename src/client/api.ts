const apiBase = String(import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");

export const apiUrl = (path: string) => `${apiBase}${path}`;

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(path), {
    ...init,
    headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers }
  });
  if (response.status === 204) return undefined as T;
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status}).`);
  return data;
}
