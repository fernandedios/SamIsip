import { existsSync, readFileSync } from "node:fs";

if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match?.[1] || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2]?.replace(/^['"]|['"]$/g, "") ?? "";
  }
}
