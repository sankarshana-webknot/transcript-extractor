/* Background service worker: maintains outbound WebSocket with acks, retries, and buffering. */

// Configuration constants - these will be set from config
let APPEND_URL = "wss://overimaginatively-pellicular-temeka.ngrok-free.dev/ws/append";
let CHECK_URL = "wss://overimaginatively-pellicular-temeka.ngrok-free.dev/ws/check";
const BATCH_SIZE = 50;
const SEND_INTERVAL = 100; // Reduced from 500ms to 50ms
const MAX_RECONNECT_DELAY = 30000;
const RECONNECT_DELAY_BASE = 1000;

const OUTBOX_KEY = "outboxQueue";
const META_KEY = "transportMeta"; // { nextSeq, lastAckSeq, wsUrl, sessionId }
const SENT_WORDS_KEY = "sentWords"; // Track sent words to prevent duplicates
const CONFIG_KEY = "extensionConfig"; // Store extension configuration

let websocket = null;
let wsCheck = null;
let isConnecting = false;
let reconnectAttempt = 0;
let sendTimer = null;

// Load configuration from storage
async function loadConfig() {
  try {
    const { [CONFIG_KEY]: config } = await chrome.storage.local.get(CONFIG_KEY);
    if (config && config.wsBaseUrl) {
      APPEND_URL = `${config.wsBaseUrl}/ws/append`;
      CHECK_URL = `${config.wsBaseUrl}/ws/check`;
      console.log('[Background] Configuration loaded:', { APPEND_URL, CHECK_URL });
    } else {
      console.log('[Background] Using default configuration');
    }
  } catch (error) {
    console.error('[Background] Error loading configuration:', error);
  }
}

async function getMeta() {
  const { [META_KEY]: meta } = await chrome.storage.local.get(META_KEY);
  return (
    meta || {
      nextSeq: 1,
      lastAckSeq: 0,
      sessionId: `cvn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    }
  );
}

async function setMeta(update) {
  const meta = await getMeta();
  const merged = { ...meta, ...update };
  await chrome.storage.local.set({ [META_KEY]: merged });
  return merged;
}

async function getOutbox() {
  const { [OUTBOX_KEY]: outbox } = await chrome.storage.local.get(OUTBOX_KEY);
  return Array.isArray(outbox) ? outbox : [];
}

async function setOutbox(queue) {
  await chrome.storage.local.set({ [OUTBOX_KEY]: queue });
}

async function removeItemFromQueue(seqToRemove) {
  const outbox = await getOutbox();
  const filtered = outbox.filter(item => item.seq !== seqToRemove);
  await setOutbox(filtered);
  console.log(`[Background] Removed item with seq ${seqToRemove} from queue. Queue size: ${filtered.length}`);
}

async function getSentWords() {
  const { [SENT_WORDS_KEY]: sentWords } = await chrome.storage.local.get(SENT_WORDS_KEY);
  return sentWords || new Set();
}

async function setSentWords(sentWords) {
  await chrome.storage.local.set({ [SENT_WORDS_KEY]: Array.from(sentWords) });
}

async function clearCachedData() {
  console.log('[Background] Clearing cached transcript data');
  await chrome.storage.local.remove([OUTBOX_KEY, SENT_WORDS_KEY]);
  console.log('[Background] Cached data cleared');
}

async function cleanupOldSentWords() {
  // Clean up old sent words to prevent memory bloat
  // Keep only words from the last 1000 entries
  const sentWords = await getSentWords();
  if (sentWords.length > 1000) {
    const recentWords = sentWords.slice(-1000);
    await setSentWords(recentWords);
    console.log(`[Background] Cleaned up old sent words, kept ${recentWords.length} recent entries`);
  }
}

async function ensureCheckSocket() {
  if (wsCheck && wsCheck.readyState === WebSocket.OPEN) return;
  
  console.log('[Background] Connecting to check endpoint:', CHECK_URL);
  
  try {
    wsCheck = new WebSocket(CHECK_URL);
    
    wsCheck.addEventListener("open", () => {
      console.log('[Background] Check WebSocket connected');
    });
    
    wsCheck.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        console.log('[Background] Check WebSocket message:', msg);
        
        // Handle fact-check results
        if (msg.type === 'fact_check_result') {
          console.log('[Background] 📊 FACT_CHECK_RESULT received:', msg);
          
          // Send result to content script for display
          chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
            if (tabs[0]) {
              chrome.tabs.sendMessage(tabs[0].id, {
                type: 'fact_check_result',
                data: msg
              });
            }
          });
        }
      } catch (e) {
        console.log('[Background] Non-JSON check message:', ev.data);
      }
    });
    
    wsCheck.addEventListener("close", (ev) => {
      console.log('[Background] Check WebSocket closed:', ev.code, ev.reason);
      wsCheck = null;
    });
    
    wsCheck.addEventListener("error", (err) => {
      console.error('[Background] Check WebSocket error:', err);
    });
  } catch (e) {
    console.error('[Background] Failed to create check WebSocket:', e);
  }
}

async function enqueue(items) {
  if (!items || !items.length) return;
  console.log(`[Background] Enqueuing ${items.length} items`);
  
  const [meta, outbox, sentWords] = await Promise.all([getMeta(), getOutbox(), getSentWords()]);
  let { nextSeq, sessionId } = meta;
  
  // Filter out duplicate words
  const uniqueItems = [];
  const newSentWords = new Set(sentWords);
  
  for (const msg of items) {
    if (msg.type === 'word.create' && msg.word?.text) {
      const wordKey = `${sessionId}-${msg.source?.lineId}-${msg.word.text}-${msg.word.indexInLine}`;
      if (!newSentWords.has(wordKey)) {
        newSentWords.add(wordKey);
        uniqueItems.push(msg);
      } else {
        console.log(`[Background] Skipping duplicate word: "${msg.word.text}"`);
      }
    } else {
      // Non-word items (transcript events) are always added
      uniqueItems.push(msg);
    }
  }
  
  if (uniqueItems.length === 0) {
    console.log(`[Background] All items were duplicates, nothing to enqueue`);
    return;
  }
  
  const enriched = uniqueItems.map((msg) => ({ ...msg, seq: nextSeq++, sessionId }));
  await Promise.all([
    setMeta({ nextSeq }),
    setOutbox(outbox.concat(enriched)),
    setSentWords(newSentWords)
  ]);
  console.log(`[Background] Queue now has ${outbox.length + enriched.length} items (${items.length - uniqueItems.length} duplicates filtered)`);
  
  // Periodically clean up old sent words
  if (Math.random() < 0.1) { // 10% chance to cleanup
    cleanupOldSentWords();
  }
  
  scheduleSend();
}

function scheduleSend() {
  if (sendTimer) return;
  sendTimer = setTimeout(async () => {
    sendTimer = null;
    await flushOutbox();
  }, SEND_INTERVAL);
}

async function flushOutbox() {
  if (!websocket || websocket.readyState !== WebSocket.OPEN) {
    console.log('[Background] WebSocket not ready, ensuring connection...');
    await ensureSocket();
    return;
  }
  const outbox = await getOutbox();
  if (outbox.length === 0) return;

  console.log(`[Background] Processing ${outbox.length} items from outbox`);
  
  // Send batch to append endpoint (main server expects batch format)
  const batch = outbox.slice(0, BATCH_SIZE);
  try {
    // Send batch to append endpoint
    if (websocket && websocket.readyState === WebSocket.OPEN) {
      const batchMessage = { type: 'batch', items: batch };
      websocket.send(JSON.stringify(batchMessage));
      console.log(`[Background] ✅ Sent batch of ${batch.length} items to append endpoint`);
    } else {
      console.log(`[Background] ❌ Append WebSocket not ready (state: ${websocket?.readyState})`);
    }
    
    // Send individual words to check endpoint (for real-time checking)
    // Process words sequentially to maintain order
    for (let i = 0; i < batch.length; i++) {
      const item = batch[i];
      const wordText = item.word?.text || item.data?.word?.text || 'unknown';
      
      if (wsCheck && wsCheck.readyState === WebSocket.OPEN) {
        const checkMessage = { word: wordText };
        wsCheck.send(JSON.stringify(checkMessage));
        console.log(`[Background] ✅ Sent word ${i + 1}/${batch.length} to check: "${wordText}"`);
        console.log(`[Background] 📤 CHECK_WS_SEND:`, {
          message: checkMessage
        });
        
        // Remove this item from the queue after sending
        await removeItemFromQueue(item.seq);
        
        // Reduced delay for faster processing
        if (i < batch.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 30));
        }
      } else {
        console.log(`[Background] ❌ Check WebSocket not ready (state: ${wsCheck?.readyState})`);
      }
    }
  } catch (err) {
    console.error("WebSocket send error", err);
    // Will reconnect on close; keep items in queue
    websocket.close();
    return;
  }

  // Items are now removed after sending to check endpoint
  // No need to reschedule since items are removed individually
}

async function handleAck(ackSeq) {
  if (typeof ackSeq !== "number") return;
  const [meta, outbox] = await Promise.all([getMeta(), getOutbox()]);
  
  // Remove all items with seq <= ackSeq (acknowledged items)
  const trimmed = outbox.filter((item) => item.seq > ackSeq);
  const removedCount = outbox.length - trimmed.length;
  
  await Promise.all([
    setMeta({ lastAckSeq: Math.max(meta.lastAckSeq, ackSeq) }),
    setOutbox(trimmed)
  ]);
  
  console.log(`[Background] Acknowledged ${removedCount} items up to seq ${ackSeq}, ${trimmed.length} items remaining`);
  
  // Schedule next send if more items remain
  if (trimmed.length > 0) {
    scheduleSend();
  }
}

async function ensureSocket() {
  if (websocket && websocket.readyState === WebSocket.OPEN) return;
  if (isConnecting) return;
  isConnecting = true;
  const { sessionId } = await getMeta();
  
  console.log('[Background] Connecting to append endpoint:', APPEND_URL);

  try {
    websocket = new WebSocket(APPEND_URL);

    websocket.addEventListener("open", async () => {
      isConnecting = false;
      reconnectAttempt = 0;
      
      // Clear cached data on server restart/reconnect
      console.log('[Background] Append WebSocket connected - clearing cached data');
      await clearCachedData();
      
      // Start check socket
      await ensureCheckSocket();
      
      scheduleSend();
    });

    websocket.addEventListener("message", async (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (typeof msg?.ackSeq === "number") {
          await handleAck(msg.ackSeq);
        }
      } catch (e) {
        // ignore non-JSON frames
      }
    });

    websocket.addEventListener("close", (ev) => {
      isConnecting = false;
      websocket = null;
      console.log('[Background] Append WebSocket closed:', ev.code, ev.reason);
      const delay = Math.min(RECONNECT_DELAY_BASE * 2 ** reconnectAttempt, MAX_RECONNECT_DELAY);
      reconnectAttempt += 1;
      setTimeout(() => ensureSocket(), delay);
    });

    websocket.addEventListener("error", (err) => {
      console.error('[Background] Append WebSocket error:', err);
      // close triggers reconnect
    });
  } catch (e) {
    isConnecting = false;
    const delay = Math.min(RECONNECT_DELAY_BASE * 2 ** reconnectAttempt, MAX_RECONNECT_DELAY);
    reconnectAttempt += 1;
    setTimeout(() => ensureSocket(), delay);
  }
}

chrome.runtime.onMessage.addListener(async (message, _sender, _sendResponse) => {
  console.log('[Background] Received message:', message);
  
  if (!message || !message.type) return;

  switch (message.type) {
    case "config.update": {
      console.log('[Background] Config update received:', message);
      if (message.wsBaseUrl) {
        await chrome.storage.local.set({ [CONFIG_KEY]: { wsBaseUrl: message.wsBaseUrl } });
        await loadConfig();
        console.log('[Background] Configuration updated:', { APPEND_URL, CHECK_URL });
      }
      break;
    }
    case "word.single": {
      // Handle individual word events with delays
      console.log('[Background] Received word.single message:', message.item);
      enqueue([message.item]);
      break;
    }
    case "word.batch": {
      // Expect message.items: array of word events already structured
      enqueue(message.items);
      break;
    }
    case "transcript.end": {
      console.log('[Background] Transcript ended:', message);
      // Send transcript end event to server
      enqueue([{
        type: 'transcript.end',
        sessionId: message.sessionId,
        totalLines: message.totalLines,
        timestampMs: message.timestampMs
      }]);
      break;
    }
    case "transcript.resume": {
      console.log('[Background] Transcript processing resumed:', message.sessionId);
      // Update session ID in meta
      setMeta({ sessionId: message.sessionId });
      // Send resume event to server
      enqueue([{
        type: 'transcript.resume',
        sessionId: message.sessionId,
        timestampMs: message.timestampMs
      }]);
      break;
    }
    case "transcript.pause": {
      console.log('[Background] Transcript processing paused:', message.sessionId);
      // Send pause event to server (keep data intact)
      enqueue([{
        type: 'transcript.pause',
        sessionId: message.sessionId,
        totalLines: message.totalLines,
        timestampMs: message.timestampMs
      }]);
      // Don't clear outbox - keep data for when we resume
      console.log('[Background] Transcript paused, data preserved');
      break;
    }
    case "transcript.start": {
      console.log('[Background] New transcript started:', message.sessionId);
      // Update session ID in meta
      setMeta({ sessionId: message.sessionId });
      // Send transcript start event to server
      enqueue([{
        type: 'transcript.start',
        sessionId: message.sessionId,
        timestamp: message.timestamp,
        lineNumber: message.lineNumber,
        timestampMs: message.timestampMs
      }]);
      console.log('[Background] New transcript session started');
      break;
    }
    default:
      console.log('[Background] Unknown message type:', message.type);
      break;
  }
});

// Kick off both sockets on startup
console.log('[Background] Extension starting up...');
loadConfig().then(() => {
  console.log('[Background] Append URL:', APPEND_URL);
  console.log('[Background] Check URL:', CHECK_URL);
  ensureSocket();
});
