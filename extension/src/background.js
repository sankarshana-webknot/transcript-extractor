/* Background service worker: maintains outbound WebSocket with acks, retries, and buffering. */

// Configuration constants (would normally come from config file)
const DEFAULT_WS_URL = "ws://localhost:8080";
const BATCH_SIZE = 50;
const SEND_INTERVAL = 50;
const MAX_RECONNECT_DELAY = 30000;
const RECONNECT_DELAY_BASE = 1000;

const OUTBOX_KEY = "outboxQueue";
const META_KEY = "transportMeta"; // { nextSeq, lastAckSeq, wsUrl, sessionId }

let websocket = null;
let isConnecting = false;
let reconnectAttempt = 0;
let sendTimer = null;

async function getMeta() {
  const { [META_KEY]: meta } = await chrome.storage.local.get(META_KEY);
  return (
    meta || {
      nextSeq: 1,
      lastAckSeq: 0,
      wsUrl: DEFAULT_WS_URL,
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

async function enqueue(items) {
  if (!items || !items.length) return;
  const [meta, outbox] = await Promise.all([getMeta(), getOutbox()]);
  let { nextSeq, sessionId } = meta;
  const enriched = items.map((msg) => ({ ...msg, seq: nextSeq++, sessionId }));
  await Promise.all([
    setMeta({ nextSeq }),
    setOutbox(outbox.concat(enriched))
  ]);
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
    await ensureSocket();
    return;
  }
  const outbox = await getOutbox();
  if (outbox.length === 0) return;

  // Micro-batch: send up to N at a time to avoid flooding
  const batch = outbox.slice(0, BATCH_SIZE);
  try {
    websocket.send(JSON.stringify({ type: "batch", items: batch }));
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
  const { wsUrl, sessionId } = await getMeta();

  try {
    websocket = new WebSocket(wsUrl);

    websocket.addEventListener("open", async () => {
      isConnecting = false;
      reconnectAttempt = 0;
      // Identify session on connect
      websocket.send(JSON.stringify({ type: "hello", sessionId }));
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

    websocket.addEventListener("close", () => {
      isConnecting = false;
      websocket = null;
      const delay = Math.min(RECONNECT_DELAY_BASE * 2 ** reconnectAttempt, MAX_RECONNECT_DELAY);
      reconnectAttempt += 1;
      setTimeout(() => ensureSocket(), delay);
    });

    websocket.addEventListener("error", () => {
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
      const { wsUrl } = message;
      console.log('[Background] Updating WebSocket URL to:', wsUrl);
      setMeta({ wsUrl }).then(() => {
        if (websocket) {
          try { websocket.close(); } catch {}
        } else {
          ensureSocket();
        }
      });
      break;
    }
    case "word.batch": {
      console.log('[Background] Received word batch with', message.items?.length || 0, 'items');
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
    default:
      console.log('[Background] Unknown message type:', message.type);
      break;
  }
});

// Kick off socket on startup
ensureSocket();


