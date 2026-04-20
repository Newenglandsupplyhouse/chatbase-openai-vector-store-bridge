# Chatbase + OpenAI Vector Store Bridge

This project exposes a small API endpoint that Chatbase can call as a Custom Action.

## What it does

1. Chatbase collects the user's question.
2. Chatbase calls your API endpoint.
3. Your API searches an OpenAI vector store.
4. Your API returns JSON that Chatbase can use in its reply.

## Setup

1. Create a `.env` file from `.env.example`.

2. Set:

```bash
OPENAI_API_KEY=your_openai_api_key
OPENAI_VECTOR_STORE_ID=vs_...
PORT=3010
MAX_RESULTS=3
MAX_CONTEXT_CHARS=4000
MAX_SNIPPET_CHARS=700
```

3. Start the server.

If you already have Node installed:

```bash
npm start
```

Or on this machine, use the included PowerShell launcher:

```powershell
.\run-bridge.ps1
```

4. Expose it publicly with your preferred tunnel or host.

For a quick public URL on this machine:

```powershell
.\start-live.ps1
```

If the bridge is already running on port `3000`, `start-live.ps1` now reuses it instead
of failing with `EADDRINUSE`.

To stop it later:

```powershell
.\stop-live.ps1
```

5. Verify health:

```bash
curl http://localhost:3010/health
```

## Railway deployment

This project is ready to deploy to Railway with the included
[`railway.json`](./railway.json).

1. Push this folder to a GitHub repository.
2. In Railway, create a new project from that repo.
3. Add these Railway variables:
   - `OPENAI_API_KEY`
   - `OPENAI_VECTOR_STORE_ID`
   - `MAX_RESULTS` optional
   - `MAX_CONTEXT_CHARS` optional
   - `MAX_SNIPPET_CHARS` optional
4. Do not set `PORT` manually on Railway unless you have a specific reason.
   Railway injects `PORT` automatically and the app already respects it.
5. Generate a Railway public domain under `Settings -> Networking`.

Railway will start the app with `node server.js` and use `/health` as the
deployment healthcheck.

## Chatbase configuration

In Chatbase:

1. Open your agent.
2. Go to `Actions` -> `Create action` -> `Custom action`.
3. Set:
   - Name: `search_knowledge_base`
   - When to use: Use this when the user asks about information stored in our knowledge base or documentation.
4. Add one input:
   - Name: `query`
   - Type: `text`
   - Description: The user's question to search in the knowledge base.
5. API request:
   - Method: `POST`
   - URL: `https://your-domain.com/chatbase/vector-search`
   - Header: `Content-Type: application/json`
   - JSON body:

```json
{
  "query": "{{query}}"
}
```

6. Choose `Full data access`.

## Expected response

The bridge returns JSON like:

```json
{
  "status": "success",
  "query": "What does our refund policy say?",
  "found": true,
  "answer_context": "1. Refunds are available within 30 days...",
  "documents": [
    {
      "file_id": "file_123",
      "filename": "refund-policy.pdf",
      "url": "https://example.com/refund-policy.pdf",
      "source_url": "https://example.com/refund-policy.pdf",
      "bridge_url": "https://your-domain.com/chatbase/files/file_123",
      "format": "source-url"
    }
  ],
  "results": [
    {
      "file_id": "file_123",
      "filename": "refund-policy.pdf",
      "score": 0.91,
      "text": "Refunds are available within 30 days...",
      "source_url": "https://example.com/refund-policy.pdf",
      "original_url": "https://example.com/refund-policy.pdf",
      "file_url": "https://example.com/refund-policy.pdf",
      "bridge_file_url": "https://your-domain.com/chatbase/files/file_123",
      "document_format": "source-url",
      "document_url": "https://example.com/refund-policy.pdf",
      "download_url": "https://your-domain.com/chatbase/files/file_123"
    }
  ]
}
```

If a source URL was stored on the vector-store file, the bridge returns it in
`source_url`, `file_url`, and `document_url`. The `download_url` and `bridge_file_url`
always point back to this bridge.

When that bridge file URL is opened, it first tries to return the original uploaded
file. If OpenAI does not allow downloading the original file for that upload, the
bridge falls back to a downloadable `.txt` export of the parsed document text.

## Notes

- Chatbase's docs currently show Custom Actions expecting JSON requests and JSON responses.
- Chatbase's docs also mention a maximum response size of 20KB, so this bridge trims the returned context.
- This bridge also trims each result snippet so the action response stays small enough for Chatbase.
- This bridge uses only built-in Node APIs, so it does not require `npm install`.
- Railway is configured to start Node directly so the app receives `SIGTERM` cleanly during deploys.
- OpenAI vector stores support search and are used by the Retrieval and `file_search` workflows.
