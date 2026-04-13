const fileNameEl = document.getElementById("fileName");
const statusTextEl = document.getElementById("statusText");
const pdfFrameEl = document.getElementById("pdfFrame");
const errorStateEl = document.getElementById("errorState");

let currentBlobUrl = null;

initializeViewer().catch((error) => {
  showError(error instanceof Error ? error.message : String(error));
});

window.addEventListener("beforeunload", () => {
  if (currentBlobUrl) {
    URL.revokeObjectURL(currentBlobUrl);
  }
});

async function initializeViewer() {
  const cacheKey = new URLSearchParams(window.location.search).get("cacheKey");

  if (!cacheKey) {
    throw new Error("Missing PDF preview cache key.");
  }

  const stored = await chrome.storage.session.get(cacheKey);
  const preview = stored[cacheKey];

  if (!preview?.base64UrlData) {
    throw new Error("The PDF preview data is no longer available. Download the file again to reopen it.");
  }

  fileNameEl.textContent = preview.filename || "Downloaded PDF";
  document.title = `${preview.filename || "Downloaded PDF"} - EZSign PDF Viewer`;

  const blob = new Blob([decodeBase64Url(preview.base64UrlData)], {
    type: preview.mimeType || "application/pdf"
  });

  currentBlobUrl = URL.createObjectURL(blob);
  pdfFrameEl.src = currentBlobUrl;
  statusTextEl.textContent = "Opened in Chrome PDF viewer.";
}

function decodeBase64Url(base64UrlData) {
  const standardBase64 = String(base64UrlData).replaceAll("-", "+").replaceAll("_", "/");
  const requiredPadding = (4 - (standardBase64.length % 4)) % 4;
  const paddedBase64 = `${standardBase64}${"=".repeat(requiredPadding)}`;
  const binary = atob(paddedBase64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function showError(message) {
  fileNameEl.textContent = "PDF preview unavailable";
  statusTextEl.textContent = message;
  pdfFrameEl.hidden = true;
  errorStateEl.hidden = false;
  errorStateEl.textContent = message;
}
