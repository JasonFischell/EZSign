import { createWorkspace } from "./signing-workspace.js";
import { createSignaturePad } from "./signature-pad.js";
import {
  buildSignedFilename,
  dataUrlToBytes,
  decodeBase64Url,
  encodeBase64Url,
  loadAccountProfile,
  loadPreferences,
  loadPreviewFromCache,
  loadSignerName,
  loadSignatures,
  saveAccountProfile,
  savePreferences,
  savePreviewToCache,
  saveQueueStatus,
  saveSignerName,
  saveSignatures,
  waitForDownloadTerminalState
} from "./viewer-utils.js";

const workspace = createWorkspace({
  pdfWorkerUrl: chrome.runtime.getURL("vendor/pdfjs/pdf.worker.mjs"),
  helpers: {
    buildSignedFilename,
    dataUrlToBytes,
    decodeBase64Url,
    encodeBase64Url,
    loadAccountProfile,
    loadPreferences,
    loadPreviewFromCache,
    loadSignerName,
    loadSignatures,
    saveAccountProfile,
    savePreferences,
    savePreviewToCache,
    saveQueueStatus,
    saveSignerName,
    saveSignatures,
    waitForDownloadTerminalState
  },
  pdfLib: window.PDFLib
});

const signaturePad = createSignaturePad(document.getElementById("signaturePad"));

workspace.attachSignaturePad(signaturePad);
workspace
  .initialize()
  .catch((error) => workspace.showError(error instanceof Error ? error.message : String(error)));
