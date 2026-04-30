# Serper MCP Server

A production-ready Model Context Protocol (MCP) server for Google Search via Serper.dev. This server supports both modern **Streamable HTTP** transport and legacy **SSE** (Server-Sent Events) transport, making it compatible with a wide range of MCP clients like Claude Desktop, Cursor, and llama.cpp.

## Features

- **Google Search Suite**: Web, Images, Videos, News, Shopping, Scholar, and Patents search.
- **Deep Search**: A powerful `serper_deep_search` tool that combines search with automated scraping (similar to Tavily) to provide full page content instead of just snippets.
- **Local Search**: Specialized tools for Places and Maps.
- **Visual Search**: Google Lens reverse image search via URL.
- **Web Scraper**: Extract clean text content from any webpage.
- **Dual Transport Support**:
  - **Streamable HTTP**: Modern protocol used by Cursor, llama.cpp, etc.
  - **SSE (Legacy)**: Standard protocol used by Claude Desktop.
- **Dynamic API Key**: Pass your Serper API key via query parameters for flexible deployment.

## Deployment (Railway)

1. Fork/Clone this repository to GitHub.
2. Create a new project on **Railway.app** and connect it to your repository.
3. Railway will automatically detect the `Procfile` and deploy the server.
4. Once deployed, you will get a public URL (e.g., `https://serper-mcp.up.railway.app`).

## Local Installation (Your PC)

If you prefer to run the server on your own machine:

1. Clone this repository.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Build the project:
   ```bash
   npm run build
   ```
4. Start the server:
   ```bash
   npm start
   ```
The server will be active at `http://localhost:3000/mcp?apiKey=YOUR_SERPER_API_KEY`.

## Connecting to Clients

### Modern Clients (Cursor, llama.cpp, etc.)
Use the following URL:
```
https://your-domain.railway.app/mcp?apiKey=YOUR_SERPER_API_KEY
```

### Legacy Clients (Claude Desktop)
Add this to your `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "serper-remote": {
      "url": "https://your-domain.railway.app/sse?apiKey=YOUR_SERPER_API_KEY"
    }
  }
}
```

## Available Tools

- **`serper_deep_search`**: (Recommended for Research) Searches Google and scrapes top results for full page content.
- `serper_search`: Standard Google search (titles and snippets).
- `serper_images`: Google Images search.
- `serper_videos`: Google Videos search.
- `serper_places`: Local business information.
- `serper_maps`: Location-based search.
- `serper_news`: Recent news articles.
- `serper_shopping`: Product and price search.
- `serper_lens`: Reverse image search.
- `serper_scholar`: Academic research search.
- `serper_patents`: Patent search.
- `serper_autocomplete`: Search suggestions.
- `serper_webpage`: Scrape text content from a URL.

## License

MIT
