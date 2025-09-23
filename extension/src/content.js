/* Content script: observes the transcript DOM, detects finalized lines, tokenizes, and sends words to background. */

const SOURCE_URL = location.href;

// Configuration constants
// Note: Transcripts now only end when page is closed, not on timeout

let lineCounter = 0;
const finalizedNodeSet = new WeakSet();
const sentWordsSet = new Set(); // Track sent words to prevent duplicates
let transcriptContainer = null;
let transcriptEndTimer = null;
let isTranscriptActive = false;
let buttonObserver = null;
let currentSessionId = null;
let factCheckResultsBox = null;

// Sequential processing state
let processingQueue = []; // Queue of lines waiting to be processed
let isProcessingLine = false; // Flag to prevent concurrent line processing
let currentLineIndex = 0; // Track the next expected line index

// Word processing state
let wordQueue = []; // Queue of words waiting to be sent
let isSendingWords = false; // Flag to prevent concurrent word sending

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

function tokenizeLineToWordQueue(rowDetails, lineIndex) {
  const { timestamp, lineNumber, transcriptText } = rowDetails;
  
  if (!transcriptText) {
    console.log(`[Content] No text in line ${lineIndex}, skipping`);
    return;
  }
  
  const words = tokenizeWithOffsets(transcriptText);
  console.log(`[Content] Tokenizing line ${lineIndex} with ${words.length} words: "${transcriptText}"`);
  
  // Add all words from this line to the word queue
  words.forEach((word, wordIndex) => {
    // Create a unique key for this word to prevent duplicates
    const wordKey = `${currentSessionId}-ln-${lineIndex}-${word.text}-${word.indexInLine}`;
    
    // Skip if we've already queued this word
    if (sentWordsSet.has(wordKey)) {
      console.log(`[Content] Skipping duplicate word: "${word.text}" (key: ${wordKey})`);
      return;
    }
    
    // Mark as queued
    sentWordsSet.add(wordKey);
    
    // Create word event
    const wordEvent = {
      type: 'word.create',
      source: {
        url: SOURCE_URL,
        lineId: `ln-${lineIndex}`,
        lineRevision: 1,
        lineIndex,
        timestamp,
        lineNumber
      },
      word: word,
      timestampMs: Date.now()
    };
    
    // Add to word queue with sequence info
    wordQueue.push({
      ...wordEvent,
      lineIndex,
      wordIndex,
      wordKey
    });
    
    console.log(`[Content] Queued word ${wordIndex + 1}/${words.length} from line ${lineIndex}: "${word.text}"`);
  });
  
  console.log(`[Content] ✅ Completed tokenizing line ${lineIndex}, ${words.length} words queued`);
}

function addLineToQueue(rowDetails, domElement) {
  const lineIndex = ++lineCounter;
  console.log(`[Content] Adding line ${lineIndex} to processing queue: "${rowDetails.transcriptText}"`);
  
  processingQueue.push({
    lineIndex,
    rowDetails,
    domElement
  });
  
  // Start processing if not already processing
  processNextLineInQueue();
}

async function sendWordsFromQueue() {
  if (isSendingWords || wordQueue.length === 0) {
    return;
  }
  
  // Only send if transcript is active
  if (!isTranscriptActive) {
    console.log('[Transcript Extractor] Transcript not active, skipping word sending');
    return;
  }
  
  isSendingWords = true;
  
  try {
    // Send words in batches to maintain order
    const batchSize = 10; // Send 10 words at a time
    const batch = wordQueue.splice(0, batchSize);
    
    console.log(`[Content] 📤 Sending batch of ${batch.length} words to background`);
    
    // Send batch to background script
    chrome.runtime.sendMessage({ 
      type: 'word.batch', 
      items: batch.map(item => ({
        type: item.type,
        source: item.source,
        word: item.word,
        timestampMs: item.timestampMs
      }))
    });
    
    console.log(`[Content] ✅ Sent batch: ${batch.map(w => w.word.text).join(' ')}`);
    
    // Small delay before next batch
    setTimeout(() => {
      isSendingWords = false;
      if (wordQueue.length > 0) {
        sendWordsFromQueue();
      }
    }, 200);
    
  } catch (error) {
    console.error('[Content] Error sending word batch:', error);
    isSendingWords = false;
  }
}

async function processNextLineInQueue() {
  if (isProcessingLine || processingQueue.length === 0) {
    return;
  }
  
  // Only process if transcript is active
  if (!isTranscriptActive) {
    console.log('[Transcript Extractor] Transcript not active, skipping queue processing');
    return;
  }
  
  // Check if we should process the next line in sequence
  const nextInQueue = processingQueue.find(item => item.lineIndex === currentLineIndex + 1);
  if (!nextInQueue) {
    console.log(`[Content] Waiting for line ${currentLineIndex + 1}, queue has: ${processingQueue.map(q => q.lineIndex).join(', ')}`);
    return;
  }
  
  isProcessingLine = true;
  const { lineIndex, rowDetails, domElement } = nextInQueue;
  
  console.log(`[Content] 🚀 Starting sequential processing of line ${lineIndex}`);
  
  try {
    // Tokenize line and add words to word queue
    tokenizeLineToWordQueue(rowDetails, lineIndex);
    
    // Mark DOM element as processed
    finalizedNodeSet.add(domElement);
    
    // Remove from queue
    const queueIndex = processingQueue.findIndex(item => item.lineIndex === lineIndex);
    if (queueIndex !== -1) {
      processingQueue.splice(queueIndex, 1);
    }
    
    // Update current line index
    currentLineIndex = lineIndex;
    
    console.log(`[Content] ✅ Completed line ${lineIndex}, moving to next`);
    
    // Start sending words from queue
    sendWordsFromQueue();
    
  } catch (error) {
    console.error(`[Content] Error processing line ${lineIndex}:`, error);
  } finally {
    isProcessingLine = false;
    
    // Process next line if available
    setTimeout(() => processNextLineInQueue(), 50);
  }
}

function maybeFinalizePreviousLine(container, newChild) {
  console.log('[Transcript Extractor] Attempting to finalize previous line...');
  
  // Only process if transcript is active
  if (!isTranscriptActive) {
    console.log('[Transcript Extractor] Transcript not active, skipping line processing');
    return;
  }
  
  // Look for .div-row elements specifically
  const rows = Array.from(container.querySelectorAll('.div-row'));
  console.log('[Transcript Extractor] Found', rows.length, 'total .div-row elements');
  
  // Wait for at least 3 rows before starting to process
  if (rows.length < 3) {
    console.log('[Transcript Extractor] Not enough rows yet (need at least 3)');
    return;
  }
  
  // When 4th row is added, process 2nd row
  // When 5th row is added, process 3rd row
  // When 6th row is added, process 4th row
  // etc.
  const rowToProcess = rows.length - 3; // This gives us the n-2th row (changed from n-1 to n-2)
  
  if (rowToProcess >= 0) {
    const finalized = rows[rowToProcess];
    console.log('[Transcript Extractor] Processing row', rowToProcess, ':', finalized);
    
    if (finalizedNodeSet.has(finalized)) {
      console.log('[Transcript Extractor] Row already finalized, skipping');
      return;
    }

    // Extract all details from the row
    const rowDetails = extractRowDetails(finalized);
    
    if (!rowDetails.transcriptText) {
      return;
    }

    // Add to sequential processing queue instead of processing immediately
    addLineToQueue(rowDetails, finalized);
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
  
  // Don't set a timer - transcript only ends when page is closed
  // This prevents premature transcript end detection
}

function handlePageLoad() {
  console.log('[Transcript Extractor] Page loaded - starting new transcript session');
  
  // Clear any existing timer to prevent old timers from firing
  if (transcriptEndTimer) {
    clearTimeout(transcriptEndTimer);
    transcriptEndTimer = null;
    console.log('[Transcript Extractor] Cleared existing timer');
  }
  
  // Generate new session ID for page load
  const newSessionId = `cvn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  currentSessionId = newSessionId;
  
  // Reset counters for new transcript but DON'T reset finalizedNodeSet
  // This prevents reprocessing of existing DOM elements
  lineCounter = 0;
  // finalizedNodeSet = new WeakSet(); // REMOVED - prevents duplicate processing
  
  // Reset sequential processing state
  processingQueue = [];
  isProcessingLine = false;
  currentLineIndex = 0;
  
  // Reset word processing state
  wordQueue = [];
  isSendingWords = false;
  
  // Send new transcript start event for page load
  chrome.runtime.sendMessage({
    type: 'transcript.start',
    sessionId: currentSessionId,
    timestamp: new Date().toLocaleTimeString(),
    lineNumber: '1-1',
    timestampMs: Date.now()
  });
  
  console.log('[Transcript Extractor] New transcript session started on page load:', currentSessionId);
}

function handlePageClose() {
  console.log('[Transcript Extractor] Page is closing - ending transcript');
    
    // Send transcript end event
    chrome.runtime.sendMessage({ 
      type: 'transcript.end', 
    sessionId: currentSessionId,
      totalLines: lineCounter,
      timestampMs: Date.now()
    });
    
  console.log('[Transcript Extractor] Transcript ended due to page close');
}

function handleNewTranscriptStart(rowDetails) {
  console.log('[Transcript Extractor] *** NEW TRANSCRIPT STARTED ***');
  
  // Generate new session ID for the new transcript
  const newSessionId = `cvn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  
  // Check if this is actually a new transcript (different session ID)
  if (currentSessionId && currentSessionId === newSessionId) {
    console.log('[Transcript Extractor] Same session ID, not a new transcript');
    return;
  }
  
  // Update session ID
  currentSessionId = newSessionId;
  
  // Reset counters for new transcript but DON'T reset finalizedNodeSet
  // This prevents reprocessing of existing DOM elements
  lineCounter = 0;
  // finalizedNodeSet = new WeakSet(); // REMOVED - prevents duplicate processing
  
  // Reset sequential processing state
  processingQueue = [];
  isProcessingLine = false;
  currentLineIndex = 0;
  
  // Reset word processing state
  wordQueue = [];
  isSendingWords = false;
  
  // Send new transcript start event
  chrome.runtime.sendMessage({
    type: 'transcript.start',
    sessionId: currentSessionId,
    timestamp: rowDetails.timestamp,
    lineNumber: rowDetails.lineNumber,
    timestampMs: Date.now()
  });
  
  console.log('[Transcript Extractor] Session:', currentSessionId, 'Line:', rowDetails.lineNumber);
}

function detectNewTranscriptBySessionId() {
  // If we don't have a current session ID, this is definitely a new transcript
  if (!currentSessionId) {
    console.log('[Transcript Extractor] No existing session ID - new transcript detected');
    const newSessionId = `cvn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return newSessionId;
  }
  
  // Check if enough time has passed since last session (indicating new transcript)
  const currentTime = Date.now();
  const lastSessionTime = parseInt(currentSessionId.split('-')[1]);
  const timeDiff = currentTime - lastSessionTime;
  
  // Increase threshold to 5 minutes to avoid unnecessary session resets
  // This prevents duplicate processing when users pause/resume or navigate
  if (timeDiff > 300000) { // 5 minutes instead of 30 seconds
    console.log('[Transcript Extractor] Long time gap detected - new transcript:', timeDiff + 'ms');
    const newSessionId = `cvn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return newSessionId;
  }
  
  // Otherwise, continue with existing session
  console.log('[Transcript Extractor] Continuing existing session:', currentSessionId);
  return currentSessionId;
}

function resumeTranscriptSession() {
  console.log('[Transcript Extractor] Resuming transcript processing');
  
  // If we just loaded the page and haven't started processing yet, this should be a new transcript start
  if (!isTranscriptActive && currentSessionId) {
    console.log('[Transcript Extractor] *** NEW TRANSCRIPT DETECTED ON RESUME ***');
    isTranscriptActive = true;
    // Send new transcript start event
    chrome.runtime.sendMessage({
      type: 'transcript.start',
      sessionId: currentSessionId,
      timestamp: new Date().toLocaleTimeString(),
      lineNumber: '1-1',
      timestampMs: Date.now()
    });
  } else {
    isTranscriptActive = true;
    // Use session ID detection to determine if this is a new transcript
    const sessionId = detectNewTranscriptBySessionId();
    
    // If we got a new session ID, this is a new transcript
    if (sessionId !== currentSessionId) {
      console.log('[Transcript Extractor] *** NEW TRANSCRIPT DETECTED BY SESSION ID ***');
      currentSessionId = sessionId;
      lineCounter = 0;
      // finalizedNodeSet = new WeakSet(); // REMOVED - prevents duplicate processing
      
      // Send new transcript start event
      chrome.runtime.sendMessage({
        type: 'transcript.start',
        sessionId: currentSessionId,
        timestamp: new Date().toLocaleTimeString(),
        lineNumber: '1-1',
        timestampMs: Date.now()
      });
    } else {
      // Send resume event for existing session
      chrome.runtime.sendMessage({
        type: 'transcript.resume',
        sessionId: currentSessionId,
        timestampMs: Date.now()
      });
    }
  }
  
  console.log('[Transcript Extractor] Transcript processing resumed for session:', currentSessionId);
}

function pauseTranscriptSession() {
  console.log('[Transcript Extractor] Pausing transcript processing');
  isTranscriptActive = false;
  
  // Clear transcript end timer
  if (transcriptEndTimer) {
    clearTimeout(transcriptEndTimer);
    transcriptEndTimer = null;
  }
  
  // Send pause event (keep session and data intact)
  chrome.runtime.sendMessage({
    type: 'transcript.pause',
    sessionId: currentSessionId,
    totalLines: lineCounter,
    timestampMs: Date.now()
  });
  
  console.log('[Transcript Extractor] Transcript processing paused for session:', currentSessionId);
}

function monitorConnectButton() {
  const button = document.getElementById('buttonConnect');
  if (!button) {
    console.log('[Transcript Extractor] Connect button not found, will retry...');
    setTimeout(monitorConnectButton, 1000);
    return;
  }
  
  console.log('[Transcript Extractor] Monitoring connect button by ID:', button.id);
  console.log('[Transcript Extractor] Initial button state:', button.textContent.trim());
  
  // Create observer for button changes (text, classes, attributes)
  buttonObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'childList' || mutation.type === 'characterData' || mutation.type === 'attributes') {
        const buttonText = button.textContent.trim();
        console.log('[Transcript Extractor] Button changed - Text:', buttonText, 'ID:', button.id);
        
        if (buttonText === 'Disconnect' && !isTranscriptActive) {
          // User clicked Connect - resume transcript processing
          console.log('[Transcript Extractor] *** CONNECT BUTTON CLICKED - RESUMING ***');
          resumeTranscriptSession();
        } else if (buttonText === 'Connect' && isTranscriptActive) {
          // User clicked Disconnect - pause transcript processing
          console.log('[Transcript Extractor] *** DISCONNECT BUTTON CLICKED - PAUSING ***');
          pauseTranscriptSession();
        }
      }
    }
  });
  
  // Observe the button for all changes
  buttonObserver.observe(button, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['class']
  });
  
  // Check initial state
  const initialText = button.textContent.trim();
  if (initialText === 'Disconnect' && !isTranscriptActive) {
    console.log('[Transcript Extractor] Initial state: Already connected, resuming processing');
    resumeTranscriptSession();
  }
}

function processExistingRows(container) {
  console.log('[Transcript Extractor] Processing any existing rows...');
  
  // Only process if transcript is active
  if (!isTranscriptActive) {
    console.log('[Transcript Extractor] Transcript not active, skipping existing rows processing');
    return;
  }
  
  const rows = Array.from(container.querySelectorAll('.div-row'));
  console.log('[Transcript Extractor] Found', rows.length, 'existing .div-row elements');
  
  // Only process if we have at least 3 rows (so we can process the 1st one when we have 3)
  if (rows.length >= 3) {
    // Process rows following the sliding window pattern (n-2)
    for (let i = 0; i <= rows.length - 3; i++) {
      const finalized = rows[i];
      
      if (finalizedNodeSet.has(finalized)) continue;

      const rowDetails = extractRowDetails(finalized);
      if (!rowDetails.transcriptText) continue;

      // Add to sequential processing queue instead of processing immediately
      addLineToQueue(rowDetails, finalized);
    }
    
    resetTranscriptEndTimer();
  }
}
function createFactCheckResultsBox() {
  // Add CSS styles
  const style = document.createElement('style');
  style.textContent = `
    #fact-check-results-box {
      position: fixed;
      top: 20px;
      right: 20px;
      width: 400px;
      max-height: 600px;
      background: white;
      border: 2px solid #ddd;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      z-index: 10000;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
    }
    
    .fact-check-header {
      background: #f8f9fa;
      padding: 12px 16px;
      border-bottom: 1px solid #ddd;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-radius: 6px 6px 0 0;
    }
    
    .fact-check-header h3 {
      margin: 0;
      font-size: 16px;
      color: #333;
    }
    
    .toggle-btn {
      background: #007bff;
      color: white;
      border: none;
      border-radius: 4px;
      width: 24px;
      height: 24px;
      cursor: pointer;
      font-size: 16px;
      line-height: 1;
    }
    
    .toggle-btn:hover {
      background: #0056b3;
    }
    
    .fact-check-content {
      max-height: 500px;
      overflow-y: auto;
      padding: 8px;
    }
    
    .no-results {
      text-align: center;
      color: #666;
      padding: 20px;
      font-style: italic;
    }
    
    .fact-check-result {
      border: 1px solid #e9ecef;
      border-radius: 6px;
      margin-bottom: 12px;
      background: #fafafa;
    }
    
    .result-header {
      padding: 8px 12px;
      background: #f8f9fa;
      border-bottom: 1px solid #e9ecef;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
    }
    
    .verdict {
      font-weight: bold;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 12px;
    }
    
    .verdict.support {
      background: #d4edda;
      color: #155724;
    }
    
    .verdict.refute {
      background: #f8d7da;
      color: #721c24;
    }
    
    .verdict.not-found {
      background: #fff3cd;
      color: #856404;
    }
    
    .verdict.unknown {
      background: #e2e3e5;
      color: #383d41;
    }
    
    .confidence {
      font-size: 12px;
      color: #666;
      font-weight: 500;
    }
    
    .timestamp {
      font-size: 11px;
      color: #999;
    }
    
    .result-content {
      padding: 12px;
    }
    
    .qa-pair {
      margin-bottom: 8px;
    }
    
    .question, .answer {
      margin-bottom: 4px;
      line-height: 1.4;
    }
    
    .question {
      color: #0066cc;
    }
    
    .answer {
      color: #333;
    }
    
    .explanation {
      background: white;
      padding: 8px;
      border-radius: 4px;
      border-left: 3px solid #007bff;
      margin-bottom: 8px;
      font-size: 13px;
      line-height: 1.4;
    }
    
    .result-meta {
      display: flex;
      justify-content: space-between;
      font-size: 11px;
      color: #666;
      flex-wrap: wrap;
      gap: 8px;
    }
    
    .result-meta span {
      background: #e9ecef;
      padding: 2px 6px;
      border-radius: 3px;
    }
  `;
  document.head.appendChild(style);
  
  // Create the results box
  factCheckResultsBox = document.createElement('div');
  factCheckResultsBox.id = 'fact-check-results-box';
  factCheckResultsBox.innerHTML = `
    <div class="fact-check-header">
      <h3>🔍 Fact Check Results</h3>
      <button id="toggle-fact-check" class="toggle-btn">−</button>
    </div>
    <div class="fact-check-content" id="fact-check-content">
      <div class="no-results">No fact-check results yet...</div>
    </div>
  `;
  
  // Add to page
  document.body.appendChild(factCheckResultsBox);
  
  // Add toggle functionality
  const toggleBtn = factCheckResultsBox.querySelector('#toggle-fact-check');
  const content = factCheckResultsBox.querySelector('#fact-check-content');
  
  toggleBtn.addEventListener('click', () => {
    if (content.style.display === 'none') {
      content.style.display = 'block';
      toggleBtn.textContent = '−';
    } else {
      content.style.display = 'none';
      toggleBtn.textContent = '+';
    }
  });
  
  console.log('[Transcript Extractor] Fact-check results box created');
}

function displayFactCheckResult(result) {
  const content = document.getElementById('fact-check-content');
  const noResults = content.querySelector('.no-results');
  
  // Remove "no results" message if it exists
  if (noResults) {
    noResults.remove();
  }
  
  // Create result element
  const resultElement = document.createElement('div');
  resultElement.className = 'fact-check-result';
  
  // Determine verdict color and icon
  let verdictClass = 'unknown';
  let verdictIcon = '❓';
  switch (result.verdict) {
    case 'SUPPORT':
      verdictClass = 'support';
      verdictIcon = '✅';
      break;
    case 'REFUTE':
      verdictClass = 'refute';
      verdictIcon = '❌';
      break;
    case 'NOT_FOUND':
      verdictClass = 'not-found';
      verdictIcon = '🔍';
      break;
    case 'UNKNOWN':
      verdictClass = 'unknown';
      verdictIcon = '❓';
      break;
  }
  
  resultElement.innerHTML = `
    <div class="result-header">
      <span class="verdict ${verdictClass}">${verdictIcon} ${result.verdict}</span>
      <span class="confidence">${result.confidence}% confidence</span>
      <span class="timestamp">${new Date(result.timestamp).toLocaleTimeString()}</span>
    </div>
    <div class="result-content">
      <div class="qa-pair">
        <div class="question"><strong>Q:</strong> ${result.question}</div>
        <div class="answer"><strong>A:</strong> ${result.answer}</div>
      </div>
      <div class="explanation">${result.explanation}</div>
      <div class="result-meta">
        <span class="evidence-count">${result.evidence_count} evidence sources</span>
        <span class="processing-time">${result.processing_time_ms}ms</span>
        <span class="pair-id">Pair: ${result.pair_id}</span>
      </div>
    </div>
  `;
  
  // Add to top of results
  content.insertBefore(resultElement, content.firstChild);
  
  // Limit to 10 results
  const results = content.querySelectorAll('.fact-check-result');
  if (results.length > 10) {
    results[results.length - 1].remove();
  }
  
  console.log('[Transcript Extractor] Fact-check result displayed:', result.verdict);
}

// Listen for fact-check results from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'fact_check_result') {
    console.log('[Transcript Extractor] Received fact-check result:', message.data);
    displayFactCheckResult(message.data);
  }
});

function bootstrap() {
  console.log('[Transcript Extractor] Starting bootstrap...');
  transcriptContainer = findTranscriptContainer();
  console.log('[Transcript Extractor] Found container:', transcriptContainer);
  
  if (!transcriptContainer) {
    console.log('[Transcript Extractor] No container found, falling back to body');
    transcriptContainer = document.body;
  }
  
  // Create fact-check results box
  createFactCheckResultsBox();
  
  // Start monitoring the connect button
  monitorConnectButton();
  
  // Check if there are any .div-row elements already
  const existingRows = transcriptContainer.querySelectorAll('.div-row');
  console.log('[Transcript Extractor] Found', existingRows.length, 'existing .div-row elements');
  
  // If we have existing rows, this might be a new transcript
  if (existingRows.length > 0) {
    console.log('[Transcript Extractor] Existing transcript content detected - checking for new session');
    // Use session ID detection to determine if this is a new transcript
    const sessionId = detectNewTranscriptBySessionId();
    if (sessionId !== currentSessionId) {
      console.log('[Transcript Extractor] *** NEW TRANSCRIPT DETECTED ON PAGE LOAD ***');
      currentSessionId = sessionId;
      lineCounter = 0;
      // finalizedNodeSet = new WeakSet(); // REMOVED - prevents duplicate processing
      
      // Send new transcript start event
      chrome.runtime.sendMessage({
        type: 'transcript.start',
        sessionId: currentSessionId,
        timestamp: new Date().toLocaleTimeString(),
        lineNumber: '1-1',
        timestampMs: Date.now()
      });
    }
  }
  
  // Attach observer first to catch any new rows
  attachObserver(transcriptContainer);
  console.log('[Transcript Extractor] Observer attached');
  
  // Add page close event listener
  window.addEventListener('beforeunload', handlePageClose);
  console.log('[Transcript Extractor] Page close listener attached');
  
  // Send transcript start event for page load
  handlePageLoad();
  
  // Process any existing rows AFTER setting up the session and observer
  // This prevents race conditions and ensures proper sequencing
  setTimeout(() => {
    processExistingRows(transcriptContainer);
  }, 100); // Small delay to ensure everything is set up
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}


