import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";

const ENV_PATH = ".env";

loadEnvFile(ENV_PATH);

const port = Number(process.env.PORT || 3000);
const vectorStoreId = process.env.OPENAI_VECTOR_STORE_ID;
const openAiApiKey = process.env.OPENAI_API_KEY;
const maxResults = Number(process.env.MAX_RESULTS || 3);
const maxContextChars = Number(process.env.MAX_CONTEXT_CHARS || 4000);
const maxSnippetChars = Number(process.env.MAX_SNIPPET_CHARS || 700);

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) {
    return;
  }

  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    const value = rawValue.replace(/^['"]|['"]$/g, "");

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
  });
  response.end(JSON.stringify(payload, null, 2));
}

function sendBinary(response, statusCode, body, headers = {}) {
  response.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    ...headers
  });
  response.end(body);
}

function normalizeQuery(body) {
  const value =
    body?.query ||
    body?.question ||
    body?.userQuery ||
    body?.input;

  return typeof value === "string" ? value.trim() : "";
}

function pickText(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  const textParts = [];

  for (const item of content) {
    if (item?.type !== "text") {
      continue;
    }

    if (typeof item.text === "string" && item.text.trim()) {
      textParts.push(item.text.trim());
      continue;
    }

    if (typeof item.text?.value === "string" && item.text.value.trim()) {
      textParts.push(item.text.value.trim());
    }
  }

  return textParts.join("\n").trim();
}

function escapeFileName(fileName) {
  return String(fileName || "document")
    .replace(/[^\w.\-() ]+/g, "_")
    .trim();
}

function compactWhitespace(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateText(value, maxChars) {
  const normalized = compactWhitespace(value);
  if (!normalized || normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trim()}…`;
}

function getDocumentUrl(publicBaseUrl, fileId) {
  if (!publicBaseUrl || !fileId) {
    return null;
  }

  return `${publicBaseUrl}/chatbase/files/${encodeURIComponent(fileId)}`;
}

function pickSourceUrl(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidates = [
    value.source_url,
    value.url,
    value.document_url,
    value.file_url,
    value.href,
    value.link
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  return null;
}

function getPublicBaseUrl(request) {
  const forwardedProto = request.headers["x-forwarded-proto"];
  const forwardedHost = request.headers["x-forwarded-host"];
  const host = forwardedHost || request.headers.host;
  const protocol = forwardedProto || "http";

  if (!host) {
    return null;
  }

  return `${protocol}://${host}`;
}

function getRequestUrl(request) {
  return new URL(request.url || "/", "http://localhost");
}

function collectRequestBody(request) {
  return new Promise((resolve, reject) => {
    let rawBody = "";

    request.on("data", (chunk) => {
      rawBody += chunk;

      if (rawBody.length > 1024 * 1024) {
        reject(new Error("Request body too large."));
        request.destroy();
      }
    });

    request.on("end", () => {
      if (!rawBody.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(rawBody));
      } catch {
        reject(new Error("Request body must be valid JSON."));
      }
    });

    request.on("error", reject);
  });
}

async function fetchOpenAiJson(path, init = {}) {
  const response = await fetch(`https://api.openai.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${openAiApiKey}`,
      "Content-Type": "application/json",
      ...(init.headers || {})
    }
  });

  const data = await response.json();

  if (!response.ok) {
    const message =
      data?.error?.message || `OpenAI request failed with ${response.status}.`;
    throw new Error(message);
  }

  return data;
}

async function fetchOpenAiResponse(path, init = {}) {
  const response = await fetch(`https://api.openai.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${openAiApiKey}`,
      ...(init.headers || {})
    }
  });

  return response;
}

async function tryFetchOpenAiFile(fileId) {
  const response = await fetchOpenAiResponse(`/v1/files/${fileId}/content`);

  if (!response.ok) {
    return null;
  }

  return {
    body: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get("content-type") || "application/octet-stream"
  };
}

function getDownloadFileName(fileName) {
  const safeFileName = escapeFileName(fileName || "document");

  if (safeFileName.toLowerCase().endsWith(".txt")) {
    return safeFileName;
  }

  return `${safeFileName}.txt`;
}

function extractParsedText(fileContentResponse) {
  const content = Array.isArray(fileContentResponse?.data)
    ? fileContentResponse.data
    : [];

  return content
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

async function fetchVectorStoreFileContent(fileId) {
  return fetchOpenAiJson(
    `/v1/vector_stores/${vectorStoreId}/files/${fileId}/content`
  );
}

async function fetchVectorStoreFile(fileId) {
  return fetchOpenAiJson(`/v1/vector_stores/${vectorStoreId}/files/${fileId}`);
}

async function searchVectorStore(query, publicBaseUrl) {
  const data = await fetchOpenAiJson(`/v1/vector_stores/${vectorStoreId}/search`, {
    method: "POST",
    body: JSON.stringify({
      query,
      max_num_results: maxResults
    })
  });

  const rawResults = (Array.isArray(data?.data) ? data.data : []);
  const fileIds = [...new Set(rawResults.map((item) => item?.file_id).filter(Boolean))];
  const fileDetailsEntries = await Promise.all(
    fileIds.map(async (fileId) => {
      try {
        const details = await fetchVectorStoreFile(fileId);
        return [fileId, details];
      } catch {
        return [fileId, null];
      }
    })
  );
  const fileDetailsById = new Map(fileDetailsEntries);

  const results = rawResults
    .map((item) => {
      const fileId = item.file_id || null;
      const filename = item.filename || null;
      const bridgeFileUrl = getDocumentUrl(publicBaseUrl, fileId);
      const fileDetails = fileId ? fileDetailsById.get(fileId) : null;
      const sourceUrl = pickSourceUrl(fileDetails?.attributes);

      return {
        file_id: fileId,
        filename,
        score: item.score ?? null,
        text: truncateText(pickText(item), maxSnippetChars),
        source_url: sourceUrl,
        original_url: sourceUrl,
        file_url: sourceUrl || bridgeFileUrl,
        bridge_file_url: bridgeFileUrl,
        document_format: sourceUrl ? "source-url" : "bridge-file",
        document_url: sourceUrl || bridgeFileUrl,
        download_url: bridgeFileUrl,
        document:
          fileId
            ? {
                file_id: fileId,
                filename,
                url: sourceUrl || bridgeFileUrl,
                source_url: sourceUrl,
                bridge_url: bridgeFileUrl,
                format: sourceUrl ? "source-url" : "bridge-file"
              }
            : null
      };
    })
    .filter((item) => item.text);

  const answerContext = results
    .map((item, index) => `${index + 1}. ${item.text}`)
    .join("\n\n")
    .slice(0, maxContextChars);

  const documents = results
    .filter((item) => item.document)
    .map((item) => item.document)
    .filter((item, index, items) =>
      items.findIndex((candidate) => candidate.file_id === item.file_id) === index
    );

  return {
    status: "success",
    query,
    found: results.length > 0,
    answer_context: answerContext,
    documents,
    results
  };
}

const server = createServer(async (request, response) => {
  const requestUrl = getRequestUrl(request);
  const pathname = requestUrl.pathname;

  if (request.method === "OPTIONS") {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "GET" && pathname === "/") {
    sendJson(response, 200, {
      name: "chatbase-openai-vector-store-bridge",
      endpoints: {
        health: "/health",
        search: "/chatbase/vector-search",
        files: "/chatbase/files/:fileId"
      }
    });
    return;
  }

  if (request.method === "GET" && pathname === "/health") {
    sendJson(response, 200, {
      ok: true,
      vectorStoreConfigured: Boolean(vectorStoreId),
      openAiConfigured: Boolean(openAiApiKey),
      maxResults,
      maxContextChars
    });
    return;
  }

  if (request.method === "POST" && pathname === "/chatbase/vector-search") {
    try {
      if (!openAiApiKey) {
        sendJson(response, 500, {
          status: "error",
          error: "Missing OPENAI_API_KEY"
        });
        return;
      }

      if (!vectorStoreId) {
        sendJson(response, 500, {
          status: "error",
          error: "Missing OPENAI_VECTOR_STORE_ID"
        });
        return;
      }

      const body = await collectRequestBody(request);
      const query = normalizeQuery(body);

      if (!query) {
        sendJson(response, 400, {
          status: "error",
          error: "Missing query string in request body."
        });
        return;
      }

      const publicBaseUrl = getPublicBaseUrl(request);
      const result = await searchVectorStore(query, publicBaseUrl);
      sendJson(response, 200, result);
      return;
    } catch (error) {
      sendJson(response, 500, {
        status: "error",
        error: error instanceof Error ? error.message : "Unknown error"
      });
      return;
    }
  }

  const fileRouteMatch = pathname.match(/^\/chatbase\/files\/([^/]+)$/);
  if (request.method === "GET" && fileRouteMatch) {
    try {
      if (!openAiApiKey) {
        sendJson(response, 500, {
          status: "error",
          error: "Missing OPENAI_API_KEY"
        });
        return;
      }

      const fileId = decodeURIComponent(fileRouteMatch[1]);
      const metadata = await fetchOpenAiJson(`/v1/files/${fileId}`);
      const serveInline =
        requestUrl.searchParams.get("inline") === "1" ||
        requestUrl.searchParams.get("download") === "0";
      const contentDispositionType = serveInline ? "inline" : "attachment";
      const originalFile = await tryFetchOpenAiFile(fileId);

      if (originalFile) {
        const fileName = escapeFileName(metadata?.filename || `${fileId}.bin`);

        sendBinary(response, 200, originalFile.body, {
          "Content-Type": originalFile.contentType,
          "Content-Disposition": `${contentDispositionType}; filename="${fileName}"`,
          "Cache-Control": "private, max-age=300"
        });
        return;
      }

      const fileContent = await fetchVectorStoreFileContent(fileId);
      const text = extractParsedText(fileContent);
      const fileName = getDownloadFileName(metadata?.filename || fileId);

      if (!text) {
        sendJson(response, 404, {
          status: "error",
          error: "No parsed text content is available for this document."
        });
        return;
      }

      sendBinary(response, 200, Buffer.from(text, "utf8"), {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `${contentDispositionType}; filename="${fileName}"`,
        "Cache-Control": "private, max-age=300"
      });
      return;
    } catch (error) {
      sendJson(response, 500, {
        status: "error",
        error: error instanceof Error ? error.message : "Unknown error"
      });
      return;
    }
  }

  sendJson(response, 404, {
    status: "error",
    error: "Not found"
  });
});

server.listen(port, () => {
  console.log(`Bridge server listening on http://localhost:${port}`);
});

function shutdown(signal) {
  console.log(`Received ${signal}, shutting down bridge server.`);
  server.close(() => {
    process.exit(0);
  });

  // Avoid hanging forever if open connections do not close on their own.
  setTimeout(() => {
    process.exit(1);
  }, 10000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
