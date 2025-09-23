const META_KEY = "transportMeta";

async function load() {
  // URLs are hardcoded in the extension
  document.getElementById('wsAppendUrl').value = "wss://overimaginatively-pellicular-temeka.ngrok-free.dev/ws/append";
  document.getElementById('wsCheckUrl').value = "wss://overimaginatively-pellicular-temeka.ngrok-free.dev/ws/check";
}

async function save() {
  // URLs are hardcoded, no need to save them
  console.log('URLs are hardcoded in the extension');
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


