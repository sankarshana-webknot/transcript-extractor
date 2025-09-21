# Transcript Extractor (CaseViewNet demo)

This project contains a Chrome MV3 extension that captures finalized transcript lines from the CaseViewNet Browser Edition demo page and streams each word to a local WebSocket ingest server.

## Configuration

The server uses environment variables for configuration. Copy `.env.example` to `.env` in the root folder and modify as needed:

```bash
# Copy example configuration
cp .env.example .env

# Edit configuration
nano .env
```

### Available Configuration Options:

- **WS_URL**: Complete WebSocket server URL (default: ws://localhost:8080)
- **TRANSCRIPT_END_TIMEOUT**: Timeout for transcript end detection in ms (default: 5000)
- **BATCH_SIZE**: Number of messages to batch together (default: 50)
- **SEND_INTERVAL**: Interval between batch sends in ms (default: 50)
- **LOG_LEVEL**: Logging level (default: info)
- **LOG_FORMAT**: Log format (default: compact)
- **SESSION_TIMEOUT**: Session timeout in ms (default: 300000)
- **MAX_RECONNECT_ATTEMPTS**: Maximum reconnection attempts (default: 10)
- **RECONNECT_DELAY_BASE**: Base delay for reconnection in ms (default: 1000)

## Components
- `extension/`: Chrome extension (MV3)
  - `manifest.json` – registers background service worker, content script, and options page
  - `src/background.js` – resilient outbound WebSocket client with acks and buffering
  - `src/content.js` – MutationObserver to detect line finalization and tokenize words
  - `src/options.html` / `src/options.js` – configure WebSocket server URL
- `server/`: Local WebSocket ingest for development
  - `index.js` – prints received words and acks highest `seq`

## Prerequisites
- Node.js 18+
- Chrome 116+ (Manifest V3)

## Setup
1. Install server deps:
   - Windows PowerShell:
     - `cd .\server; npm install`
   - macOS/Linux:
     - `cd server && npm install`
2. Start the server:
   - Windows PowerShell:
     - `cd .\server; npm start`
   - macOS/Linux:
     - `cd server && npm start`
   - You should see: `WebSocket ingest listening on ws://localhost:8080`.

## Load the extension in Chrome
1. Open `chrome://extensions/`
2. Enable “Developer mode” (top-right).
3. Click “Load unpacked” and select the `extension/` folder.
4. Open the extension’s Options page and set the WebSocket URL (default `ws://localhost:8080`).

## Try it on CaseViewNet
1. Navigate to `https://www.caseviewnet.com/application.php`.
2. Click “Try Demo” so live transcript begins.
3. The content script observes the transcript container. When a new line is appended, the previous line is considered finalized. It tokenizes into words and streams them to the background, which batches and sends them to the local server.
4. In the server console, you should see logs like: `[cvn-<session>] ln-128#5: objection`.

## Notes
- Heuristic: A line is finalized when a new sibling line is appended. Adjust or add debounce if the site’s DOM differs.
- The background service worker maintains a persistent WebSocket with sequence numbers and ack-based trimming.
- If the tab or extension is suspended, the worker will reconnect and resend unacked messages.

## Next steps
- Add a DevTools network listener to prefer authoritative “final” flags from the site’s WS/SSE.
- Add correction handling (`lineRevision` > 1) if the site edits earlier lines.
- Persist unsent queue to IndexedDB on the background side for robustness across restarts.
