import assert from "node:assert/strict";
import test from "node:test";
import type { Request, Response } from "express";
import { cors } from "../src/server/network.js";

test("CORS middleware accepts a private LAN browser preflight", () => {
  const previous = process.env.CORS_ORIGINS;
  process.env.CORS_ORIGINS = "private-network";
  const requestHeaders: Record<string, string> = {
    origin: "http://192.168.1.50:5173",
    "access-control-request-private-network": "true"
  };
  const responseHeaders = new Map<string, string>();
  let statusCode = 200;
  let ended = false;
  let response: Response;
  const request = {
    method: "OPTIONS",
    get: (name: string) => requestHeaders[name.toLowerCase()]
  } as unknown as Request;
  response = {
    setHeader: (name: string, value: string) => {
      responseHeaders.set(name.toLowerCase(), value);
      return response;
    },
    vary: (name: string) => {
      responseHeaders.set("vary", [responseHeaders.get("vary"), name].filter(Boolean).join(", "));
      return response;
    },
    status: (value: number) => {
      statusCode = value;
      return response;
    },
    json: () => response,
    end: () => {
      ended = true;
      return response;
    }
  } as unknown as Response;
  try {
    cors()(request, response, () => undefined);
    assert.equal(statusCode, 204);
    assert.equal(ended, true);
    assert.equal(responseHeaders.get("access-control-allow-origin"), "http://192.168.1.50:5173");
    assert.equal(responseHeaders.get("access-control-allow-private-network"), "true");
    assert.match(responseHeaders.get("vary") ?? "", /Origin/);
  } finally {
    if (previous === undefined) delete process.env.CORS_ORIGINS;
    else process.env.CORS_ORIGINS = previous;
  }
});
