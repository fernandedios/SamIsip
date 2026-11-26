# SamIsip

SamIsip is a persistent collaboration room for humans and configurable AI models. Mention `@ai-sol`, another configured agent username, or `@all-ai` to enqueue AI turns in the room.

## Start locally

```bash
npm install
cp .env.example .env
npm run dev
```

Open `http://localhost:5173`. The API runs on `http://localhost:8787` and stores local data in `data/samisip.sqlite`.

## Scripts

- `npm run dev` — run React and Express with live reload
- `npm run build` — type-check and create production builds
- `npm test` — run the orchestration tests
- `npm start` — serve the built API and React client

The design and engineering documentation lives in `/Users/macmini/Personal/SamIsip Notes`.
# SamIsip
