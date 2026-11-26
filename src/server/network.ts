import type { RequestHandler } from "express";

const defaultOrigins = "http://localhost:5173,http://127.0.0.1:5173,private-network";

const hostnameOf = (value: string): string | null => {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  } catch {
    return null;
  }
};

const ipv4Parts = (hostname: string): number[] | null => {
  const parts = hostname.split(".").map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : null;
};

export const isLoopbackUrl = (value: string): boolean => {
  const hostname = hostnameOf(value);
  const parts = hostname ? ipv4Parts(hostname) : null;
  return hostname === "localhost" || hostname === "::1" || parts?.[0] === 127;
};

export const isPrivateNetworkUrl = (value: string): boolean => {
  const hostname = hostnameOf(value);
  if (!hostname) return false;
  if (isLoopbackUrl(value)) return true;
  const parts = ipv4Parts(hostname);
  if (parts) {
    const [first, second] = parts;
    return first === 10 || (first === 172 && second! >= 16 && second! <= 31) || (first === 192 && second === 168);
  }
  return /^f[cd][0-9a-f]{2}:/i.test(hostname);
};

export const isKeylessModelUrlAllowed = (
  value: string,
  configured = process.env.KEYLESS_MODEL_ORIGINS ?? ""
): boolean => {
  if (isPrivateNetworkUrl(value)) return true;
  let candidate: URL;
  try {
    candidate = new URL(value);
  } catch {
    return false;
  }
  if (candidate.protocol !== "https:") return false;
  return configured.split(",").map((item) => item.trim()).filter(Boolean).some((item) => {
    try {
      const allowed = new URL(item);
      return allowed.protocol === "https:" && allowed.origin === candidate.origin;
    } catch {
      return false;
    }
  });
};

export const isCorsOriginAllowed = (origin: string, configured = process.env.CORS_ORIGINS ?? defaultOrigins): boolean => {
  const origins = configured.split(",").map((item) => item.trim().replace(/\/$/, "")).filter(Boolean);
  const cleanOrigin = origin.replace(/\/$/, "");
  return origins.includes("*") || origins.includes(cleanOrigin) || (origins.includes("private-network") && isPrivateNetworkUrl(cleanOrigin));
};

export const cors = (): RequestHandler => (request, response, next) => {
  const origin = request.get("origin");
  const allowed = origin ? isCorsOriginAllowed(origin) : false;
  if (origin && allowed) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("access-control-allow-methods", "GET,POST,PATCH,OPTIONS");
    response.setHeader("access-control-allow-headers", "Content-Type,Authorization");
    response.setHeader("access-control-expose-headers", "Content-Disposition");
    response.vary("Origin");
    if (request.get("access-control-request-private-network") === "true") {
      response.setHeader("access-control-allow-private-network", "true");
      response.vary("Access-Control-Request-Private-Network");
    }
  }
  if (request.method !== "OPTIONS") return next();
  if (origin && !allowed) return response.status(403).json({ error: "Origin is not allowed by CORS_ORIGINS." });
  response.status(204).end();
};
