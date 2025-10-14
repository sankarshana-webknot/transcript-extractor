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

- **WS_BASE_URL**: Base WebSocket URL for extension endpoints (default: ws://localhost:8002)
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
  - `src/background.js` – WebSocket client with duplicate detection and sequential processing
  - `src/content.js` – Sequential pipeline: DOM monitoring → Line queue → Tokenization → Word queue
  - `src/options.html` / `src/options.js` – configure WebSocket base URL (derives both endpoints)
- `server/`: Local WebSocket ingest for development
  - `index.js` – receives and processes word batches from the extension

## Prerequisites
- Node.js 18+
- Chrome 116+ (Manifest V3)


## Setup Instructions

### 1. Install Server Dependencies
```bash
# Windows PowerShell
cd .\server
npm install

# macOS/Linux
cd server
npm install
```

### 2. Start the WebSocket Server
```bash
# Windows PowerShell
cd .\server
npm start

# macOS/Linux
cd server
npm start
```
You should see: `WebSocket ingest listening on ws://localhost:8080`

### 3. Load the Extension in Chrome
1. Open `chrome://extensions/`
2. Enable "Developer mode" (top-right toggle)
3. Click "Load unpacked" and select the `extension/` folder
4. The extension will load with default WebSocket URLs

### 4. Configure WebSocket URLs (Optional)
1. Click on the extension icon and select "Options"
2. Enter your WebSocket base URL (e.g., `wss://your-server.com`)
3. Click "Save Configuration"
4. The extension will automatically derive both endpoints:
   - Append: `wss://your-server.com/ws/append`
   - Check: `wss://your-server.com/ws/check`

### 5. Test on CaseViewNet Demo
1. Navigate to `https://www.caseviewnet.com/application.php`
2. Click "Try Demo" to start the live transcript
3. The extension will automatically:
   - Detect transcript lines as they appear
   - Process them sequentially (Line 1 → Line 2 → Line 3...)
   - Tokenize each line into words
   - Send words in batches to the WebSocket server
4. Check the server console for logs like: `[cvn-session] ln-1#3: objection`

## How the Sequential Processing Works

### Step-by-Step Flow:
1. **DOM Detection**: Extension watches for new `.div-row` elements
2. **Line Finalization**: When a new line appears, the previous line is considered "finalized"
3. **Line Queuing**: Finalized lines are added to a processing queue
4. **Sequential Processing**: Lines are processed one at a time in order (1, 2, 3...)
5. **Tokenization**: Each line is split into individual words
6. **Word Queuing**: Words are added to a word queue with metadata
7. **Dual Sending**: Words are sent to both WebSocket endpoints:
   - **Append Endpoint**: Complete batches for storage/processing
   - **Check Endpoint**: Individual words for real-time fact-checking
8. **Duplicate Prevention**: System tracks sent words to prevent duplicates

## Technical Details

### Line Finalization Strategy:
- Uses a sliding window approach: when the 4th line appears, process the 2nd line
- This ensures lines are stable before processing
- Prevents processing of incomplete or changing content

### Duplicate Prevention:
- Content script tracks sent words with unique keys
- Background script maintains duplicate detection across reconnections
- Session-based tracking prevents cross-session duplicates

### WebSocket Endpoints:
- **Append Endpoint**: For batch data (sends complete batches of words)
- **Check Endpoint**: For individual words (sends words one by one for real-time processing)
- Both endpoints maintain connection with automatic reconnection
- Words are sent to both endpoints simultaneously for different use cases
