import express, { Request, Response } from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";

// ---------------------------------------------------------------------------
// App & middleware
// ---------------------------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json());

const PORT = parseInt(process.env.PORT || "3000", 10);

// ---------------------------------------------------------------------------
// Serper.dev endpoint registry
// ---------------------------------------------------------------------------
interface EndpointInfo {
  url: string;
  useUrlParam?: boolean;
}

const endpoints: Record<string, EndpointInfo> = {
  serper_search:       { url: "https://google.serper.dev/search" },
  serper_images:       { url: "https://google.serper.dev/images" },
  serper_videos:       { url: "https://google.serper.dev/videos" },
  serper_places:       { url: "https://google.serper.dev/places" },
  serper_maps:         { url: "https://google.serper.dev/maps" },
  serper_reviews:      { url: "https://google.serper.dev/reviews" },
  serper_news:         { url: "https://google.serper.dev/news" },
  serper_shopping:     { url: "https://google.serper.dev/shopping" },
  serper_lens:         { url: "https://google.serper.dev/lens", useUrlParam: true },
  serper_scholar:      { url: "https://google.serper.dev/scholar" },
  serper_patents:      { url: "https://google.serper.dev/patents" },
  serper_autocomplete: { url: "https://google.serper.dev/autocomplete" },
  serper_webpage:      { url: "https://scrape.serper.dev", useUrlParam: true },
};

// ---------------------------------------------------------------------------
// Tool definitions (JSON Schema)
// ---------------------------------------------------------------------------
const genericSearchSchema = {
  type: "object" as const,
  properties: {
    q:        { type: "string", description: "Search query (required)" },
    gl:       { type: "string", description: "Country code for geo-localization (e.g. us, uk, id)" },
    hl:       { type: "string", description: "Interface language code (e.g. en, id, ja)" },
    location: { type: "string", description: "Specific location string (e.g. 'Jakarta, Indonesia')" },
    num:      { type: "number", description: "Number of results to return (1-100, default 10)" },
    page:     { type: "number", description: "Page number for pagination" },
    tbs:      { type: "string", description: "Time-based search filter (e.g. qdr:h for past hour, qdr:d for past day, qdr:w for past week, qdr:m for past month, qdr:y for past year)" },
  },
  required: ["q"],
};

const deepSearchSchema = {
  type: "object" as const,
  properties: {
    q:        { type: "string", description: "Search query (required)" },
    gl:       { type: "string", description: "Country code for geo-localization (e.g. us, uk, id)" },
    hl:       { type: "string", description: "Interface language code (e.g. en, id, ja)" },
    location: { type: "string", description: "Specific location string (e.g. 'Jakarta, Indonesia')" },
    num:      { type: "number", description: "Number of search results to return (1-100, default 5)" },
    tbs:      { type: "string", description: "Time-based search filter (e.g. qdr:d for past day, qdr:w for past week)" },
    scrape_results: { type: "number", description: "Number of top results to scrape for full content (default 3, max 5)" },
  },
  required: ["q"],
};

const urlSchema = {
  type: "object" as const,
  properties: {
    url: { type: "string", description: "Target URL to process" },
  },
  required: ["url"],
};

const tools: Tool[] = [
  {
    name: "serper_deep_search",
    description: "Deep search: searches Google AND scrapes the top result pages to extract full content (like Tavily). Use this when you need comprehensive, detailed information — not just snippets. This is the BEST tool for research questions.",
    inputSchema: deepSearchSchema,
  },
  { name: "serper_search", description: "Quick Google search. Returns titles, URLs, and short snippets only. Use serper_deep_search instead if you need full page content.", inputSchema: genericSearchSchema },
  { name: "serper_images", description: "Search Google Images. Returns image URLs, titles, and source pages.", inputSchema: genericSearchSchema },
  { name: "serper_videos", description: "Search Google Videos (primarily YouTube). Returns video titles, URLs, thumbnails, durations, and channel info.", inputSchema: genericSearchSchema },
  { name: "serper_places", description: "Search Google Places / Local results. Returns business names, addresses, ratings, and phone numbers.", inputSchema: genericSearchSchema },
  { name: "serper_maps", description: "Search Google Maps. Returns map listings with addresses, coordinates, and ratings.", inputSchema: genericSearchSchema },
  { name: "serper_reviews", description: "Retrieve Google Reviews for businesses or places. Returns reviewer names, ratings, and review text.", inputSchema: genericSearchSchema },
  { name: "serper_news", description: "Search Google News. Returns recent news articles with titles, sources, dates, and snippets.", inputSchema: genericSearchSchema },
  { name: "serper_shopping", description: "Search Google Shopping. Returns product listings with prices, stores, ratings, and product URLs.", inputSchema: genericSearchSchema },
  { name: "serper_lens", description: "Perform a Google Lens reverse image search. Pass a URL of an image to find visually similar images.", inputSchema: urlSchema },
  { name: "serper_scholar", description: "Search Google Scholar for academic papers, citations, and research articles.", inputSchema: genericSearchSchema },
  { name: "serper_patents", description: "Search Google Patents. Returns patent titles, inventors, filing dates, and descriptions.", inputSchema: genericSearchSchema },
  { name: "serper_autocomplete", description: "Get Google Autocomplete suggestions for a query.", inputSchema: genericSearchSchema },
  { name: "serper_webpage", description: "Scrape and extract the text content of a webpage given its URL.", inputSchema: urlSchema },
];

// ---------------------------------------------------------------------------
// Helper: create an MCP Server instance bound to a specific API key
// ---------------------------------------------------------------------------
function createMcpServer(apiKey: string): Server {
  const server = new Server(
    { name: "serper-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // ---- Handle deep search (search + scrape) ----
    if (name === "serper_deep_search") {
      return await handleDeepSearch(apiKey, args as Record<string, unknown>);
    }

    const endpointInfo = endpoints[name];

    if (!endpointInfo) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    try {
      const payload: Record<string, unknown> = {};
      if (args && typeof args === "object") {
        if (endpointInfo.useUrlParam) {
          if ("url" in args) payload.url = args.url;
        } else {
          Object.assign(payload, args);
        }
      }

      const response = await axios.post(endpointInfo.url, payload, {
        headers: {
          "X-API-KEY": apiKey,
          "Content-Type": "application/json",
        },
        timeout: 30_000,
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify(response.data, null, 2),
        }],
      };
    } catch (error: unknown) {
      let message = "Unknown error";
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const detail =
          error.response?.data?.message ??
          error.response?.data?.error ??
          error.message;
        message = `Serper API error (HTTP ${status ?? "?"}): ${
          typeof detail === "object" ? JSON.stringify(detail) : String(detail)
        }`;
      } else if (error instanceof Error) {
        message = error.message;
      }
      return {
        content: [{ type: "text", text: message }],
        isError: true,
      };
    }
  });

  return server;
}

// ---------------------------------------------------------------------------
// Deep Search: search + scrape top results (like Tavily)
// ---------------------------------------------------------------------------
async function handleDeepSearch(
  apiKey: string,
  args: Record<string, unknown>
) {
  try {
    const query = (args.q as string) || "";
    const numResults = Math.min((args.num as number) || 5, 10);
    const scrapeCount = Math.min((args.scrape_results as number) || 3, 5);

    // Step 1: Google search
    const searchPayload: Record<string, unknown> = { q: query, num: numResults };
    if (args.gl) searchPayload.gl = args.gl;
    if (args.hl) searchPayload.hl = args.hl;
    if (args.location) searchPayload.location = args.location;
    if (args.tbs) searchPayload.tbs = args.tbs;

    const searchResponse = await axios.post(
      "https://google.serper.dev/search",
      searchPayload,
      {
        headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
        timeout: 15_000,
      }
    );

    const organicResults = searchResponse.data?.organic || [];
    const knowledgeGraph = searchResponse.data?.knowledgeGraph || null;
    const answerBox = searchResponse.data?.answerBox || null;

    // Step 2: Scrape top N result URLs in parallel
    const urlsToScrape = organicResults
      .slice(0, scrapeCount)
      .map((r: any) => r.link)
      .filter(Boolean);

    const scrapePromises = urlsToScrape.map(async (url: string) => {
      try {
        const scrapeRes = await axios.post(
          "https://scrape.serper.dev",
          { url },
          {
            headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
            timeout: 20_000,
          }
        );
        return {
          url,
          title: scrapeRes.data?.title || "",
          text: scrapeRes.data?.text || "",
          credits: scrapeRes.data?.credits,
        };
      } catch {
        // If scrape fails, fall back to snippet
        const original = organicResults.find((r: any) => r.link === url);
        return {
          url,
          title: original?.title || "",
          text: original?.snippet || "(scrape failed — snippet only)",
        };
      }
    });

    const scrapedResults = await Promise.all(scrapePromises);

    // Step 3: Build combined output
    const output: any = {
      query,
      answerBox: answerBox || undefined,
      knowledgeGraph: knowledgeGraph || undefined,
      results: scrapedResults.map((scraped, i) => {
        const organic = organicResults[i] || {};
        return {
          position: i + 1,
          title: scraped.title || organic.title,
          url: scraped.url,
          snippet: organic.snippet || "",
          content: scraped.text,
        };
      }),
      // Include remaining results (not scraped) as snippets
      additionalResults: organicResults.slice(scrapeCount).map((r: any) => ({
        title: r.title,
        url: r.link,
        snippet: r.snippet,
      })),
    };

    return {
      content: [{
        type: "text",
        text: JSON.stringify(output, null, 2),
      }],
    };
  } catch (error: unknown) {
    let message = "Deep search failed: ";
    if (axios.isAxiosError(error)) {
      message += error.response?.data?.message || error.message;
    } else if (error instanceof Error) {
      message += error.message;
    }
    return {
      content: [{ type: "text", text: message }],
      isError: true,
    };
  }
}
// ---------------------------------------------------------------------------
// Streamable HTTP transport sessions (for llama.cpp, Cursor, etc.)
// ---------------------------------------------------------------------------
interface StreamableSession {
  transport: StreamableHTTPServerTransport;
  server: Server;
  apiKey: string;
}
const streamableSessions = new Map<string, StreamableSession>();

// ---------------------------------------------------------------------------
// Legacy SSE transport sessions (for Claude Desktop, etc.)
// ---------------------------------------------------------------------------
interface SSESession {
  transport: SSEServerTransport;
  server: Server;
  apiKey: string;
}
const sseSessions = new Map<string, SSESession>();

// ---------------------------------------------------------------------------
// Helper: Extract API key from request (query param or env)
// ---------------------------------------------------------------------------
function getApiKey(req: Request): string {
  return (req.query.apiKey as string) || process.env.SERPER_API_KEY || "";
}

// ===========================================================================
// ROUTE: Health check
// ===========================================================================
app.get("/", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    message: "Serper MCP Server is running.",
    endpoints: {
      streamableHttp: "/mcp?apiKey=<key>  (POST for messages, GET for SSE stream, DELETE to close)",
      legacySSE: "/sse?apiKey=<key>  (GET to open SSE, then POST /messages?sessionId=...)",
    },
    activeSessions: {
      streamable: streamableSessions.size,
      sse: sseSessions.size,
    },
  });
});

// ===========================================================================
// ROUTE: Streamable HTTP transport  — POST /mcp, GET /mcp, DELETE /mcp
//   This is what llama.cpp, Cursor, and modern MCP clients use.
// ===========================================================================

/** POST /mcp — JSON-RPC messages (initialize + tool calls) */
app.post("/mcp", async (req: Request, res: Response) => {
  const apiKey = getApiKey(req);
  if (!apiKey) {
    res.status(401).json({ error: "API Key is required. Pass it as ?apiKey=<key> or set SERPER_API_KEY env var." });
    return;
  }

  // Check for existing session via Mcp-Session-Id header
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (sessionId && streamableSessions.has(sessionId)) {
    // Existing session — delegate to its transport
    const session = streamableSessions.get(sessionId)!;
    await session.transport.handleRequest(req, res, req.body);
    return;
  }

  // No existing session — this must be an initialize request
  if (!isInitializeRequest(req.body)) {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32600, message: "Bad Request: No valid session found. Send an initialize request first." },
      id: req.body?.id ?? null,
    });
    return;
  }

  // Create new Streamable HTTP session
  const newSessionId = randomUUID();
  const mcpServer = createMcpServer(apiKey);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => newSessionId,
    onsessioninitialized: (id: string) => {
      console.log(`[streamable ${id}] initialized`);
      streamableSessions.set(id, { transport, server: mcpServer, apiKey });
    },
  });

  transport.onclose = () => {
    console.log(`[streamable ${newSessionId}] closed`);
    streamableSessions.delete(newSessionId);
  };

  await mcpServer.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

/** GET /mcp — SSE stream for server-initiated notifications */
app.get("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (!sessionId || !streamableSessions.has(sessionId)) {
    res.status(400).json({ error: "Invalid or missing Mcp-Session-Id header. Send a POST initialize request first." });
    return;
  }

  // Prevent buffering
  res.setHeader("X-Accel-Buffering", "no");

  const session = streamableSessions.get(sessionId)!;
  await session.transport.handleRequest(req, res);
});

/** DELETE /mcp — Close session */
app.delete("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (!sessionId || !streamableSessions.has(sessionId)) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const session = streamableSessions.get(sessionId)!;
  await session.transport.handleRequest(req, res);
  streamableSessions.delete(sessionId);
  await session.server.close().catch(() => {});
});

// ===========================================================================
// ROUTE: Legacy SSE transport  — GET /sse, POST /messages
//   This is what Claude Desktop and older MCP clients use.
// ===========================================================================

/** GET /sse — Open SSE stream (legacy) */
app.get("/sse", async (req: Request, res: Response) => {
  const apiKey = getApiKey(req);
  if (!apiKey) {
    res.status(401).json({ error: "API Key is required." });
    return;
  }

  // Prevent buffering
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Connection", "keep-alive");

  const mcpServer = createMcpServer(apiKey);

  // Build absolute URL for messages endpoint
  const protocol = req.headers["x-forwarded-proto"] || req.protocol;
  const host = req.headers["x-forwarded-host"] || req.get("host");
  const messagesUrl = `${protocol}://${host}/messages`;

  const transport = new SSEServerTransport(messagesUrl, res);

  sseSessions.set(transport.sessionId, {
    transport,
    server: mcpServer,
    apiKey,
  });

  res.on("close", () => {
    sseSessions.delete(transport.sessionId);
    mcpServer.close().catch(() => {});
    console.log(`[sse ${transport.sessionId}] closed`);
  });

  console.log(`[sse ${transport.sessionId}] connected`);
  await mcpServer.connect(transport);
});

/** POST /messages — Handle JSON-RPC messages (legacy SSE) */
app.post("/messages", async (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string;

  if (!sessionId) {
    res.status(400).json({ error: "Missing sessionId query parameter" });
    return;
  }

  const session = sseSessions.get(sessionId);
  if (!session) {
    res.status(404).json({ error: "Session not found or expired" });
    return;
  }

  await session.transport.handlePostMessage(req, res, req.body);
});

// ---------------------------------------------------------------------------
// Global error handler
// ---------------------------------------------------------------------------
app.use((err: any, _req: Request, res: Response, _next: any) => {
  console.error("Unhandled Error:", err);
  if (!res.headersSent) {
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Serper MCP Server listening on http://0.0.0.0:${PORT}`);
  console.log(`  Streamable HTTP: POST/GET/DELETE /mcp?apiKey=<key>`);
  console.log(`  Legacy SSE:      GET /sse?apiKey=<key>`);
});

export default app;