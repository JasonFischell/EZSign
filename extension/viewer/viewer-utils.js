const ACCOUNT_PROFILES_KEY = "ezsignAccountProfiles";
const DEFAULT_PREFERENCES = {
  signatureColor: "black",
  dateFormat: "long",
  dateColor: "black"
};

export async function loadPreviewFromCache(cacheKey) {
  const stored = await chrome.storage.session.get(cacheKey);
  const preview = stored[cacheKey];
  if (!preview?.base64UrlData) {
    throw new Error("This PDF is no longer cached. Download or open the document again.");
  }

  return preview;
}

export async function savePreviewToCache(cacheKey, preview) {
  await chrome.storage.session.set({ [cacheKey]: preview });
}

export async function loadSignatures(accountEmail) {
  const profile = await loadAccountProfile(accountEmail);
  return profile.signatures;
}

export async function saveSignatures(accountEmail, signatures) {
  const profile = await loadAccountProfile(accountEmail);
  await saveAccountProfile(accountEmail, {
    ...profile,
    signatures: sanitizeSignatures(signatures)
  });
}

export async function loadPreferences(accountEmail) {
  const profile = await loadAccountProfile(accountEmail);
  return profile.preferences;
}

export async function savePreferences(accountEmail, preferences) {
  const profile = await loadAccountProfile(accountEmail);
  await saveAccountProfile(accountEmail, {
    ...profile,
    preferences: sanitizePreferences(preferences)
  });
}

export async function loadSignerName(accountEmail, fallbackName = "") {
  const profile = await loadAccountProfile(accountEmail, fallbackName);
  return profile.signerName;
}

export async function saveSignerName(accountEmail, signerName) {
  const profile = await loadAccountProfile(accountEmail);
  await saveAccountProfile(accountEmail, {
    ...profile,
    signerName: String(signerName || "").trim()
  });
}

export async function loadAccountProfile(accountEmail, fallbackName = "") {
  const accountKey = normalizeAccountKey(accountEmail);
  const stored = await chrome.storage.local.get({ [ACCOUNT_PROFILES_KEY]: {} });
  const profiles = stored[ACCOUNT_PROFILES_KEY] || {};
  const profile = profiles[accountKey] || {};

  return {
    email: accountEmail || "",
    signerName: String(profile.signerName || fallbackName || "").trim(),
    signatures: sanitizeSignatures(profile.signatures || []),
    preferences: sanitizePreferences(profile.preferences || {})
  };
}

export async function saveAccountProfile(accountEmail, profile) {
  const accountKey = normalizeAccountKey(accountEmail);
  const stored = await chrome.storage.local.get({ [ACCOUNT_PROFILES_KEY]: {} });
  const profiles = stored[ACCOUNT_PROFILES_KEY] || {};

  profiles[accountKey] = {
    email: accountEmail || "",
    signerName: String(profile.signerName || "").trim(),
    signatures: sanitizeSignatures(profile.signatures || []),
    preferences: sanitizePreferences(profile.preferences || {})
  };

  await chrome.storage.local.set({ [ACCOUNT_PROFILES_KEY]: profiles });
}

export async function saveQueueStatus(queueItemId, updates) {
  if (!queueItemId) {
    return;
  }

  const stored = await chrome.storage.local.get({ queuedRequests: [] });
  if (!Array.isArray(stored.queuedRequests)) {
    return;
  }

  const queuedRequests = stored.queuedRequests.map((item) =>
    item.id === queueItemId
      ? {
          ...item,
          ...updates
        }
      : item
  );

  await chrome.storage.local.set({ queuedRequests });
}

export async function waitForDownloadTerminalState(downloadId) {
  const existing = await chrome.downloads.search({ id: downloadId });
  if (existing[0]?.state === "complete" || existing[0]?.state === "interrupted") {
    return existing[0];
  }

  return new Promise((resolve) => {
    const handleChange = async (delta) => {
      if (delta.id !== downloadId) {
        return;
      }

      if (delta.state?.current === "complete" || delta.state?.current === "interrupted") {
        chrome.downloads.onChanged.removeListener(handleChange);
        const latest = await chrome.downloads.search({ id: downloadId });
        resolve(latest[0] || { id: downloadId, state: delta.state.current });
      }
    };

    chrome.downloads.onChanged.addListener(handleChange);
  });
}

export function decodeBase64Url(base64UrlData) {
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

export function encodeBase64Url(bytes) {
  let binary = "";
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(index, index + chunkSize));
  }

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

export function dataUrlToBytes(dataUrl) {
  const [, base64 = ""] = String(dataUrl).split(",");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

export function buildSignedFilename(filename) {
  const safeName = sanitizeFilename(filename);
  const suffix = "_Signed_with_EZSign";

  if (safeName.toLowerCase().endsWith(".pdf")) {
    const baseName = safeName.replace(/_Signed_with_EZSign(?=\.pdf$)/i, "").replace(/\.pdf$/i, "");
    return `${baseName}${suffix}.pdf`;
  }

  return `${safeName.replace(/_Signed_with_EZSign$/i, "")}${suffix}.pdf`;
}

function sanitizeFilename(filename) {
  const cleaned = String(filename)
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, " ");

  return cleaned || "signed-document.pdf";
}

function normalizeAccountKey(accountEmail) {
  return String(accountEmail || "__default__").trim().toLowerCase();
}

function sanitizePreferences(preferences) {
  return {
    ...DEFAULT_PREFERENCES,
    ...(preferences || {})
  };
}

function sanitizeSignatures(signatures) {
  if (!Array.isArray(signatures)) {
    return [];
  }

  return signatures
    .filter((signature) => signature?.id && (signature?.dataUrl || signature?.variant === "typed"))
    .map((signature) => ({
      id: String(signature.id),
      name: String(signature.name || "Saved Signature"),
      variant: signature.variant === "typed" ? "typed" : "drawn",
      dataUrl: signature.dataUrl ? String(signature.dataUrl) : "",
      width: Number(signature.width || 320),
      height: Number(signature.height || 120),
      color: String(signature.color || "black"),
      typedText: signature.typedText ? String(signature.typedText) : "",
      fontFamily: signature.fontFamily ? String(signature.fontFamily) : "",
      createdAt: signature.createdAt || new Date().toISOString()
    }));
}
