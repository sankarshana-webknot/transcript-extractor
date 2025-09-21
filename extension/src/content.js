/* Content script: observes the transcript DOM, detects finalized lines, tokenizes, and sends words to background. */

const SOURCE_URL = location.href;

// Configuration constants
const TRANSCRIPT_END_TIMEOUT = 5000; // 5 seconds of no new rows = transcript ended

let lineCounter = 0;
const finalizedNodeSet = new WeakSet();
let transcriptContainer = null;
let transcriptEndTimer = null;

function findTranscriptContainer() {
  // Look for CaseViewNet transcript container - likely contains div-row elements
  const candidates = [
    '.div-row', // Direct CaseViewNet transcript rows
    '[class*="transcript"]',
    '[class*="captions"]',
    '[class*="cvn"]',
    'main',
    '#content',
    'body'
  ];
  
  // Find container that has multiple .div-row children
  for (const sel of candidates) {
    const container = document.querySelector(sel);
    if (container) {
      const rows = container.querySelectorAll('.div-row');
      if (rows.length > 0) {
        return container;
      }
    }
  }
  
  // Fallback to body
  return document.body;
}

function extractRowDetails(divRowElement) {
  // Extract timestamp from .div-timestamp
  const timestampDiv = divRowElement.querySelector('.div-timestamp');
  const timestamp = timestampDiv ? timestampDiv.textContent.trim() : '';
  
  // Extract line number from .div-line-number
  const lineNumberDiv = divRowElement.querySelector('.div-line-number');
  const lineNumber = lineNumberDiv ? lineNumberDiv.textContent.trim() : '';
  
  // Extract Q/A text from .div-data element
  const dataDiv = divRowElement.querySelector('.div-data');
  let transcriptText = '';
  if (dataDiv) {
    transcriptText = dataDiv.textContent || '';
    // Remove excessive whitespace and normalize
    transcriptText = transcriptText.replace(/\s+/g, ' ').trim();
  }
  
  return {
    timestamp,
    lineNumber,
    transcriptText
  };
}
function tokenizeWithOffsets(text) {
  const words = [];
  let index = 0;
  const wordRegex = /\S+/g;
  let match;
  while ((match = wordRegex.exec(text)) !== null) {
    const token = match[0];
    const start = match.index;
    const end = start + token.length;
    words.push({ indexInLine: index++, text: token, charStart: start, charEnd: end });
  }
  return words;
}

function buildWordEventsFromLine(rowDetails, lineIndex) {
  const { timestamp, lineNumber, transcriptText } = rowDetails;
  
  if (!transcriptText) return [];
  
  const words = tokenizeWithOffsets(transcriptText);
  return words.map((w) => ({
    type: 'word.create',
    source: {
      url: SOURCE_URL,
      lineId: `ln-${lineIndex}`,
      lineRevision: 1,
      lineIndex,
      timestamp,
      lineNumber
    },
    word: w,
    timestampMs: Date.now()
  }));
}

function maybeFinalizePreviousLine(container, newChild) {
  console.log('[Transcript Extractor] Attempting to finalize previous line...');
  
  // Look for .div-row elements specifically
  const rows = Array.from(container.querySelectorAll('.div-row'));
  console.log('[Transcript Extractor] Found', rows.length, 'total .div-row elements');
  
  // Wait for at least 2 rows before starting to process
  if (rows.length < 2) {
    console.log('[Transcript Extractor] Not enough rows yet (need at least 2)');
    return;
  }
  
  // When 3rd row is added, process 1st row
  // When 4th row is added, process 2nd row
  // When 5th row is added, process 3rd row
  // etc.
  const rowToProcess = rows.length - 3; // This gives us the row to process
  
  if (rowToProcess >= 0) {
    const finalized = rows[rowToProcess];
    console.log('[Transcript Extractor] Processing row', rowToProcess, ':', finalized);
    
    if (finalizedNodeSet.has(finalized)) {
      console.log('[Transcript Extractor] Row already finalized, skipping');
      return;
    }

    // Extract all details from the row
    const rowDetails = extractRowDetails(finalized);
    console.log('[Transcript Extractor] Extracted details:', rowDetails);
    
    if (!rowDetails.transcriptText) {
      console.log('[Transcript Extractor] No transcript text found, skipping');
      return;
    }

    const currentLineIndex = ++lineCounter;
    const items = buildWordEventsFromLine(rowDetails, currentLineIndex);
    console.log('[Transcript Extractor] Built', items.length, 'word events');
    
    if (items.length) {
      console.log('[Transcript Extractor] Sending word batch to background...');
      chrome.runtime.sendMessage({ type: 'word.batch', items });
    }
    finalizedNodeSet.add(finalized);
  }
  
  // Reset transcript end timer
  resetTranscriptEndTimer();
}

function attachObserver(container) {
  console.log('[Transcript Extractor] Attaching observer to:', container);
  
  const observer = new MutationObserver((mutations) => {
    console.log('[Transcript Extractor] Mutation detected:', mutations.length, 'mutations');
    
    for (const m of mutations) {
      if (m.type === 'childList') {
        console.log('[Transcript Extractor] ChildList mutation:', m.addedNodes.length, 'nodes added');
        
        // Check if any added nodes are .div-row elements
        for (const addedNode of m.addedNodes) {
          if (addedNode.nodeType === Node.ELEMENT_NODE) {
            console.log('[Transcript Extractor] Added element:', addedNode.tagName, addedNode.className);
            
            if (addedNode.classList && addedNode.classList.contains('div-row')) {
              console.log('[Transcript Extractor] Found new .div-row element!');
              // A new transcript row was added, finalize the previous one
              maybeFinalizePreviousLine(container, addedNode);
            }
          }
        }
      }
    }
  });

  observer.observe(container, {
    childList: true,
    subtree: true, // Watch deeper for .div-row elements
    attributes: false,
    characterData: false
  });
  
  console.log('[Transcript Extractor] Observer configured and started');
}

function resetTranscriptEndTimer() {
  // Clear existing timer
  if (transcriptEndTimer) {
    clearTimeout(transcriptEndTimer);
  }
  
  // Set new timer
  transcriptEndTimer = setTimeout(() => {
    console.log('[Transcript Extractor] Transcript appears to have ended (no new rows for', TRANSCRIPT_END_TIMEOUT, 'ms)');
    
    // Send transcript end event
    chrome.runtime.sendMessage({ 
      type: 'transcript.end', 
      sessionId: `cvn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      totalLines: lineCounter,
      timestampMs: Date.now()
    });
    
    // Reset counters for next transcript
    lineCounter = 0;
    finalizedNodeSet = new WeakSet();
  }, TRANSCRIPT_END_TIMEOUT);
}

function processExistingRows(container) {
  console.log('[Transcript Extractor] Processing any existing rows...');
  
  const rows = Array.from(container.querySelectorAll('.div-row'));
  console.log('[Transcript Extractor] Found', rows.length, 'existing .div-row elements');
  
  // Only process if we have at least 3 rows (so we can process the 1st one)
  if (rows.length >= 3) {
    // Process rows following the sliding window pattern
    for (let i = 0; i <= rows.length - 3; i++) {
      const finalized = rows[i];
      
      if (finalizedNodeSet.has(finalized)) continue;

      const rowDetails = extractRowDetails(finalized);
      if (!rowDetails.transcriptText) continue;

      const currentLineIndex = ++lineCounter;
      const items = buildWordEventsFromLine(rowDetails, currentLineIndex);
      
      if (items.length) {
        console.log('[Transcript Extractor] Processing existing row', i, 'with', items.length, 'words');
        chrome.runtime.sendMessage({ type: 'word.batch', items });
      }
      finalizedNodeSet.add(finalized);
    }
    
    resetTranscriptEndTimer();
  }
}
function bootstrap() {
  console.log('[Transcript Extractor] Starting bootstrap...');
  transcriptContainer = findTranscriptContainer();
  console.log('[Transcript Extractor] Found container:', transcriptContainer);
  
  if (!transcriptContainer) {
    console.log('[Transcript Extractor] No container found, falling back to body');
    transcriptContainer = document.body;
  }
  
  // Check if there are any .div-row elements already
  const existingRows = transcriptContainer.querySelectorAll('.div-row');
  console.log('[Transcript Extractor] Found', existingRows.length, 'existing .div-row elements');
  
  // Process any existing rows
  processExistingRows(transcriptContainer);
  
  attachObserver(transcriptContainer);
  console.log('[Transcript Extractor] Observer attached');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}


