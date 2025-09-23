/* Background service worker: maintains outbound WebSocket with acks, retries, and buffering. */

// Configuration constants
const APPEND_URL = "wss://07ca0616485e.ngrok-free.app/ws/append";
const CHECK_URL = "wss://07ca0616485e.ngrok-free.app/ws/check";
const BATCH_SIZE = 50;
const SEND_INTERVAL = 50;
const MAX_RECONNECT_DELAY = 30000;
const RECONNECT_DELAY_BASE = 1000;

const OUTBOX_KEY = "outboxQueue";
const META_KEY = "transportMeta"; // { nextSeq, lastAckSeq, wsUrl, sessionId }

let websocket = null;
let wsCheck = null;
let isConnecting = false;
let reconnectAttempt = 0;
let sendTimer = null;

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

async function clearCachedData() {
  console.log('[Background] Clearing cached transcript data');
  await chrome.storage.local.remove([OUTBOX_KEY]);
  console.log('[Background] Cached data cleared');
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
  const [meta, outbox] = await Promise.all([getMeta(), getOutbox()]);
  let { nextSeq, sessionId } = meta;
  const enriched = items.map((msg) => ({ ...msg, seq: nextSeq++, sessionId }));
  await Promise.all([
    setMeta({ nextSeq }),
    setOutbox(outbox.concat(enriched))
  ]);
  console.log(`[Background] Queue now has ${outbox.length + enriched.length} items`);
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
  
  // Send individual words to both endpoints
  const batch = outbox.slice(0, BATCH_SIZE);
  try {
    for (const item of batch) {
      // Extract the word text from the item structure
      const wordText = item.word?.text || item.data?.word?.text || 'unknown';
      
      console.log(`[Background] Processing word: "${wordText}"`);
      
      // Send to append endpoint
      if (websocket && websocket.readyState === WebSocket.OPEN) {
        websocket.send(JSON.stringify({ word: wordText }));
        console.log(`[Background] ✅ Sent word to append: "${wordText}"`);
      } else {
        console.log(`[Background] ❌ Append WebSocket not ready (state: ${websocket?.readyState})`);
      }
      
      // Send to check endpoint
      if (wsCheck && wsCheck.readyState === WebSocket.OPEN) {
        wsCheck.send(JSON.stringify({ word: wordText }));
        console.log(`[Background] ✅ Sent word to check: "${wordText}"`);
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

  // Optimistic resend policy: keep items until acked
  // Schedule next send if more remain
  if (outbox.length > BATCH_SIZE) scheduleSend();
}

async function handleAck(ackSeq) {
  if (typeof ackSeq !== "number") return;
  const [meta, outbox] = await Promise.all([getMeta(), getOutbox()]);
  const trimmed = outbox.filter((item) => item.seq > ackSeq);
  await Promise.all([
    setMeta({ lastAckSeq: Math.max(meta.lastAckSeq, ackSeq) }),
    setOutbox(trimmed)
  ]);
  if (trimmed.length) scheduleSend();
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

chrome.runtime.onMessage.addListener((message, _sender, _sendResponse) => {
  console.log('[Background] Received message:', message);
  
  if (!message || !message.type) return;

  switch (message.type) {
    case "config.update": {
      console.log('[Background] Config update received - URLs are hardcoded');
      // URLs are hardcoded, no need to update them
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
console.log('[Background] Append URL:', APPEND_URL);
console.log('[Background] Check URL:', CHECK_URL);
ensureSocket();
