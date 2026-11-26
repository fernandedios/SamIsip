import type { RequestHandler } from "express";

const defaultOrigins = "http://localhost:5173,http://127.0.0.1:5173";

export const isLoopbackUrl = (value: string): boolean => {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
  } catch {
    return false;
  }
};

export const isCorsOriginAllowed = (origin: string, configured = process.env.CORS_ORIGINS ?? defaultOrigins): boolean => {
  const origins = configured.split(",").map((item) => item.trim().replace(/\/$/, "")).filter(Boolean);
  return origins.includes("*") || origins.includes(origin.replace(/\/$/, ""));
};

export const cors = (): RequestHandler => (request, response, next) => {
  const origin = request.get("origin");
  const allowed = origin ? isCorsOriginAllowed(origin) : false;
  if (origin && allowed) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("access-control-allow-methods", "GET,POST,PATCH,OPTIONS");
    response.setHeader("access-control-allow-headers", "Content-Type,Authorization");
    response.setHeader("access-control-expose-headers", "Content-Disposition");
    response.setHeader("vary", "Origin");
    if (request.get("access-control-request-private-network") === "true") {
      response.setHeader("access-control-allow-private-network", "true");
    }
  }
  if (request.method !== "OPTIONS") return next();
  if (origin && !allowed) return response.status(403).json({ error: "Origin is not allowed by CORS_ORIGINS." });
  response.status(204).end();
};
