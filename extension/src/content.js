/* Content script: observes the transcript DOM, detects finalized lines, tokenizes, and sends words to background. */

const SOURCE_URL = location.href;

// Configuration constants
// Note: Transcripts now only end when page is closed, not on timeout

let lineCounter = 0;
const finalizedNodeSet = new WeakSet();
let transcriptContainer = null;
let transcriptEndTimer = null;
let isTranscriptActive = false;
let buttonObserver = null;
let currentSessionId = null;

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
  
  // Send each word individually with a delay
  words.forEach((w, wordIndex) => {
    setTimeout(() => {
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
        word: w,
        timestampMs: Date.now()
      };
      
      console.log('[Content] Sending word to background:', w.text);
      chrome.runtime.sendMessage({ type: 'word.single', item: wordEvent });
    }, wordIndex * 500); // 500ms delay between each word
  });
  
  return []; // Return empty array since we're sending words individually
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

    // Session ID-based detection handles new transcript detection
    // No need to check for "1-1" here anymore

    const currentLineIndex = ++lineCounter;
    buildWordEventsFromLine(rowDetails, currentLineIndex);
    // Note: buildWordEventsFromLine now sends words individually with delays
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
  
  // Reset counters for new transcript
  lineCounter = 0;
  finalizedNodeSet = new WeakSet();
  
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
  
  // Reset counters for new transcript
  lineCounter = 0;
  finalizedNodeSet = new WeakSet();
  
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
  
  // If more than 30 seconds have passed, consider it a new transcript
  if (timeDiff > 30000) {
    console.log('[Transcript Extractor] Time gap detected - new transcript:', timeDiff + 'ms');
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
      finalizedNodeSet = new WeakSet();
      
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

      // Session ID-based detection handles new transcript detection
      // No need to check for "1-1" here anymore

      const currentLineIndex = ++lineCounter;
      buildWordEventsFromLine(rowDetails, currentLineIndex);
      // Note: buildWordEventsFromLine now sends words individually with delays
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
      finalizedNodeSet = new WeakSet();
      
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
  
  // Process any existing rows (only if transcript is active)
  processExistingRows(transcriptContainer);
  
  attachObserver(transcriptContainer);
  console.log('[Transcript Extractor] Observer attached');
  
  // Add page close event listener
  window.addEventListener('beforeunload', handlePageClose);
  console.log('[Transcript Extractor] Page close listener attached');
  
  // Send transcript start event for page load
  handlePageLoad();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}


