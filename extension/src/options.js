const META_KEY = "transportMeta";
const CONFIG_KEY = "extensionConfig";

async function load() {
  try {
    // Load current configuration
    const { [CONFIG_KEY]: config } = await chrome.storage.local.get(CONFIG_KEY);
    const wsBaseUrl = config?.wsBaseUrl || "ws://localhost:8002";

    // Set the base URL in the input field
    document.getElementById('wsBaseUrl').value = wsBaseUrl;

    // Show derived URLs
    document.getElementById('wsAppendUrl').value = `${wsBaseUrl}/ws/append`;
    document.getElementById('wsCheckUrl').value = `${wsBaseUrl}/ws/check`;
  } catch (error) {
    console.error('Error loading configuration:', error);
  }
}

async function save() {
  try {
    const wsBaseUrl = document.getElementById('wsBaseUrl').value.trim();

    if (!wsBaseUrl) {
      alert('Please enter a WebSocket base URL');
      return;
    }

    // Validate URL format
    try {
      new URL(wsBaseUrl);
    } catch (e) {
      alert('Please enter a valid WebSocket URL (e.g., wss://example.com)');
      return;
    }

    // Save configuration
    await chrome.storage.local.set({ [CONFIG_KEY]: { wsBaseUrl } });

    // Update background script
    chrome.runtime.sendMessage({
      type: 'config.update',
      wsBaseUrl: wsBaseUrl
    });

    // Update displayed URLs
    document.getElementById('wsAppendUrl').value = `${wsBaseUrl}/ws/append`;
    document.getElementById('wsCheckUrl').value = `${wsBaseUrl}/ws/check`;

    alert('Configuration saved successfully!');
    console.log('Configuration saved:', wsBaseUrl);
  } catch (error) {
    console.error('Error saving configuration:', error);
    alert('Error saving configuration');
  }
}

async function getMeta() {
  const { [META_KEY]: meta } = await chrome.storage.local.get(META_KEY);
  return (
    meta || {
      nextSeq: 1,
      lastAckSeq: 0
    }
  );
}

document.getElementById('save').addEventListener('click', save);

load();

