import { WebSocketServer } from 'ws';
import { appConfig } from './config.js';

const WS_URL = appConfig.getWsUrl();
const url = new URL(WS_URL);
const PORT = parseInt(url.port) || (url.protocol === 'wss:' ? 443 : 80);
const HOST = url.hostname;

const wss = new WebSocketServer({ port: PORT, host: HOST });

console.log(`WebSocket ingest listening on ${WS_URL}`);
// console.log('Configuration:', {
//   wsUrl: WS_URL,
//   transcriptEndTimeout: appConfig.getTranscriptEndTimeout(),
//   batchSize: appConfig.getBatchSize(),
//   sendInterval: appConfig.getSendInterval()
// });

const clientState = new Map(); // ws -> { lastAckSeqBySession: Map }

wss.on('connection', (ws) => {
  clientState.set(ws, { sessions: new Set(), lastAckSeq: 0 });

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg?.type === 'hello') {
      // Identify session
      clientState.get(ws).sessions.add(msg.sessionId);
      ws.send(JSON.stringify({ type: 'hello_ack', ok: true }));
      return;
    }

    if (msg?.type === 'batch' && Array.isArray(msg.items)) {
      // Persist/print incoming items and ack highest seq
      let maxSeq = 0;
      for (const item of msg.items) {
        if (typeof item.seq === 'number') maxSeq = Math.max(maxSeq, item.seq);
        // In a real server, upsert idempotently using (sessionId, lineId, lineRevision, word.indexInLine)
        // For demo, log compactly with metadata
        const s = item.sessionId || 'unknown';
        if (item.type === 'word.create') {
          const src = item.source || {};
          const w = item.word || {};
          const timestamp = src.timestamp || '';
          const lineNumber = src.lineNumber || '';
          console.log(`[${s}] - ${timestamp}, ${lineNumber}: ${w.text}`);
        } else if (item.type === 'transcript.start') {
          console.log(`[${s}] *** NEW TRANSCRIPT STARTED *** at ${new Date(item.timestampMs).toISOString()}`);
          console.log(`[${s}] First line: ${item.lineNumber} - ${item.timestamp}`);
        } else if (item.type === 'transcript.resume') {
          console.log(`[${s}] Transcript session RESUMED at ${new Date(item.timestampMs).toISOString()}`);
        } else if (item.type === 'transcript.pause') {
          console.log(`[${s}] Transcript session PAUSED at ${new Date(item.timestampMs).toISOString()} (${item.totalLines} lines processed)`);
        } else if (item.type === 'transcript.end') {
          console.log(`[${s}] Transcript ended at ${new Date(item.timestampMs).toISOString()} (${item.totalLines} lines)`);
        }
      }
      clientState.get(ws).lastAckSeq = maxSeq;
      ws.send(JSON.stringify({ ackSeq: maxSeq }));
      return;
    }
  });

  ws.on('close', () => {
    clientState.delete(ws);
  });
});
