const META_KEY = "transportMeta";

async function load() {
  const { [META_KEY]: meta } = await chrome.storage.local.get(META_KEY);
  const wsUrl = meta?.wsUrl || "ws://localhost:8080";
  document.getElementById('wsUrl').value = wsUrl;
}

async function save() {
  const wsUrl = document.getElementById('wsUrl').value.trim();
  await chrome.storage.local.set({ [META_KEY]: { ...(await getMeta()), wsUrl } });
  chrome.runtime.sendMessage({ type: 'config.update', wsUrl });
}

async function getMeta() {
  const { [META_KEY]: meta } = await chrome.storage.local.get(META_KEY);
  return (
    meta || {
      nextSeq: 1,
      lastAckSeq: 0,
      wsUrl: "ws://localhost:8080"
    }
  );
}

document.getElementById('save').addEventListener('click', save);

load();


