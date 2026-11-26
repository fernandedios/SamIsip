import "./load-env.js";
import express from "express";

const port = Number(process.env.MOCK_PROVIDER_PORT ?? 8788);
const app = express();

app.use((_request, response, next) => {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-methods", "POST,OPTIONS");
  response.setHeader("access-control-allow-headers", "Content-Type,Authorization,X-API-Key,Anthropic-Version");
  next();
});
app.use(express.json({ limit: "256kb" }));
app.options(/.*/, (_request, response) => response.status(204).end());
app.post(/.*/, (request, response) => {
  const payload = JSON.stringify(request.body);
  const isSummary = payload.includes("selected summary author") || payload.includes("Create the Markdown discussion summary");
  const content = isSummary
    ? "## Overview\n\nThis local fixture confirms that SamIsip can generate and download a Markdown room summary without a cloud API key.\n\n## Decisions\n\n- Keep model traffic server-side so browser CORS rules do not block local endpoints.\n\n## Action items\n\n- Replace this fixture with an OpenAI-compatible or Anthropic-compatible local model when ready."
    : "Local fixture response received. The server-side provider proxy is working.";
  if (request.path.endsWith("/messages")) return response.json({ content: [{ type: "text", text: content }] });
  response.json({ choices: [{ message: { content } }] });
});

const server = app.listen(port, "127.0.0.1", () => {
  console.log(`SamIsip mock provider listening on http://127.0.0.1:${port}/v1`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
