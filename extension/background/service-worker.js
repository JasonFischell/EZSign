const DEFAULT_QUERY =
  'has:attachment (("please sign") OR sign OR signature OR firma OR firmar OR execute OR countersign OR complete OR attachment OR return)';

const SUPPORTED_EXTENSIONS = new Set(["pdf", "doc", "docx"]);
const PDF_PREVIEW_STORAGE_PREFIX = "pdfPreview:";
const MAX_PDF_PREVIEWS = 10;
const ACCOUNT_PROFILES_KEY = "ezsignAccountProfiles";

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

  const existing = await chrome.storage.local.get({ queuedRequests: [], [ACCOUNT_PROFILES_KEY]: {} });
  const updates = {};

  if (!Array.isArray(existing.queuedRequests)) {
    updates.queuedRequests = [];
  }

  if (typeof existing[ACCOUNT_PROFILES_KEY] !== "object" || Array.isArray(existing[ACCOUNT_PROFILES_KEY])) {
    updates[ACCOUNT_PROFILES_KEY] = {};
  }

  if (Object.keys(updates).length > 0) {
    await chrome.storage.local.set(updates);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    });

  return true;
});

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "get-bootstrap-state":
      return getBootstrapState();
    case "open-side-panel":
      return openSidePanel(sender);
    case "authenticate-gmail":
      return authenticateGmail();
    case "sign-out-gmail":
      return signOutGmail();
    case "search-signature-requests":
      return searchSignatureRequests(message.payload ?? {});
    case "open-attachment-preview":
      return openAttachmentPreview(message.payload ?? {});
    case "download-attachment":
      return downloadAttachment(message.payload ?? {});
    case "queue-signing-request":
      return queueSigningRequest(message.payload ?? {});
    case "update-account-profile":
      return updateAccountProfile(message.payload ?? {});
    case "get-account-settings":
      return getAccountSettings();
    case "save-account-settings":
      return saveAccountSettings(message.payload ?? {});
    case "delete-account-signatures":
      return deleteAccountSignatures(message.payload ?? {});
    case "reply-with-signed-copy":
      return replyWithSignedCopy(message.payload ?? {});
    default:
      throw new Error("Unsupported extension message.");
  }
}

async function getBootstrapState() {
  const storage = await chrome.storage.local.get({ queuedRequests: [] });
  const authState = await getAuthState();
  const queue = filterQueueForAccount(storage.queuedRequests, authState.authenticatedEmail);

  return {
    config: {
      defaultQuery: DEFAULT_QUERY,
      oauthConfigured: isOAuthConfigured(),
      scopes: chrome.runtime.getManifest().oauth2?.scopes ?? [],
      authenticatedEmail: authState.authenticatedEmail,
      authenticatedName: authState.authenticatedName
    },
    queue,
    recentSignedDocuments: getRecentSignedDocuments(queue)
  };
}

async function openSidePanel(sender) {
  if (!sender.tab?.id) {
    throw new Error("The Gmail launcher must be opened from a browser tab.");
  }

  await chrome.sidePanel.open({ tabId: sender.tab.id });
  return {};
}

async function authenticateGmail() {
  return getConnectedIdentity(true);
}

async function signOutGmail() {
  try {
    if (typeof chrome.identity.clearAllCachedAuthTokens === "function") {
      await chrome.identity.clearAllCachedAuthTokens();
    } else {
      const token = await getAuthToken(false);
      await chrome.identity.removeCachedAuthToken({ token });
    }
  } catch {
    // If no cached token exists, treat sign-out as already complete.
  }

  return {
    authenticatedEmail: null,
    authenticatedName: ""
  };
}

async function searchSignatureRequests({ query, maxResults = 10, useMock = false }) {
  if (useMock || !isOAuthConfigured()) {
    return {
      source: "mock",
      results: getMockSearchResults(query || DEFAULT_QUERY)
    };
  }

  const token = await getAuthToken(true);
  const searchQuery = (query || DEFAULT_QUERY).trim();
  const listResponse = await gmailFetch(
    `/gmail/v1/users/me/messages?maxResults=${encodeURIComponent(maxResults)}&q=${encodeURIComponent(searchQuery)}`,
    token
  );

  if (!Array.isArray(listResponse.messages) || listResponse.messages.length === 0) {
    return {
      source: "gmail",
      results: []
    };
  }

  const messageDetails = await Promise.all(
    listResponse.messages.map((message) =>
      gmailFetch(`/gmail/v1/users/me/messages/${encodeURIComponent(message.id)}?format=full`, token)
    )
  );

  const results = messageDetails
    .map((message) => mapMessageToResult(message))
    .filter((result) => result.attachments.length > 0);

  return {
    source: "gmail",
    results
  };
}

async function queueSigningRequest(payload) {
  const requiredFields = ["messageId", "threadId", "filename"];
  for (const field of requiredFields) {
    if (!payload[field]) {
      throw new Error(`Missing required field: ${field}`);
    }
  }

  const current = await chrome.storage.local.get({ queuedRequests: [] });
  const authState = await getAuthState();
  const nextItem = {
    id: crypto.randomUUID(),
    status: "draft",
    queuedAt: new Date().toISOString(),
    accountEmail: payload.accountEmail || authState.authenticatedEmail || null,
    accountName: payload.accountName || authState.authenticatedName || "",
    ...payload
  };

  const queuedRequests = [nextItem, ...current.queuedRequests];
  await chrome.storage.local.set({ queuedRequests });

  return {
    queue: queuedRequests
  };
}

async function downloadAttachment(payload) {
  const requiredFields = ["messageId", "filename"];
  for (const field of requiredFields) {
    if (!payload[field]) {
      throw new Error(`Missing required field: ${field}`);
    }
  }

  if (String(payload.messageId).startsWith("mock-")) {
    throw new Error("Download is only available for live Gmail attachments.");
  }

  if (!payload.attachmentId && !payload.partId) {
    throw new Error("Missing attachment metadata required for download.");
  }

  const cachedPreview = payload.previewCacheKey
    ? (await chrome.storage.session.get(payload.previewCacheKey))[payload.previewCacheKey] || null
    : null;

  const token = cachedPreview ? null : await getAuthToken(true);
  const base64UrlData = cachedPreview
    ? cachedPreview.base64UrlData
    : await getAttachmentBase64Url(payload, token);
  const mimeType = cachedPreview?.mimeType || payload.mimeType || "application/octet-stream";
  const downloadFilename = cachedPreview?.filename || payload.filename;
  const shouldOpenPdfViewer = isPdfAttachment(downloadFilename, mimeType);

  const downloadId = await chrome.downloads.download({
    url: buildDownloadDataUrl(mimeType, base64UrlData),
    filename: `EZSign/${sanitizeFilename(downloadFilename)}`,
    saveAs: true
  });

  const downloadItem = await waitForDownloadTerminalState(downloadId);
  if (downloadItem.state !== "complete") {
    return {
      downloadId,
      viewerTabId: null,
      openedViewer: false,
      canceled: true,
      queue: await getQueuedRequests()
    };
  }

  let previewCacheKey = null;
  let viewerTabId = null;
  if (shouldOpenPdfViewer) {
    const authState = cachedPreview ? null : await getAuthState();
    previewCacheKey =
      cachedPreview && payload.previewCacheKey
        ? payload.previewCacheKey
        : await cachePdfPreview({
            filename: downloadFilename,
            mimeType,
            base64UrlData,
            queueItemId: payload.queueItemId || null,
            sourceMessageId: payload.messageId,
            sourceThreadId: payload.threadId || null,
            sourceSubject: payload.subject || "",
            sourceFrom: payload.from || "",
            accountEmail: payload.accountEmail || authState?.authenticatedEmail || null,
            accountName: payload.accountName || authState?.authenticatedName || "",
            originalFilename: payload.originalFilename || payload.filename
          });
    viewerTabId = await openPdfPreviewTab(previewCacheKey);
  }

  const queue = await markQueueItemDownloaded(payload.queueItemId, {
    previewCacheKey,
    status: cachedPreview?.lastSignedAt ? "signed" : undefined,
    filename: downloadItem.filename || null
  });

  return {
    downloadId,
    viewerTabId,
    openedViewer: shouldOpenPdfViewer,
    canceled: false,
    queue
  };
}

async function openAttachmentPreview(payload) {
  const requiredFields = ["messageId", "filename"];
  for (const field of requiredFields) {
    if (!payload[field]) {
      throw new Error(`Missing required field: ${field}`);
    }
  }

  if (!isPdfAttachment(payload.filename, payload.mimeType || "")) {
    throw new Error("Preview open is currently only available for PDF files.");
  }

  if (payload.previewCacheKey) {
    const storedPreview = await chrome.storage.session.get(payload.previewCacheKey);
    if (storedPreview[payload.previewCacheKey]) {
      const viewerTabId = await openPdfPreviewTab(payload.previewCacheKey);
      return {
        viewerTabId,
        queue: await getQueuedRequests()
      };
    }
  }

  if (String(payload.messageId).startsWith("mock-")) {
    throw new Error("Open is only available for live Gmail PDF attachments.");
  }

  if (!payload.attachmentId && !payload.partId) {
    throw new Error("Missing attachment metadata required to reopen this PDF.");
  }

  const token = await getAuthToken(true);
  const base64UrlData = await getAttachmentBase64Url(payload, token);
  const previewCacheKey = await cachePdfPreview({
    filename: payload.filename,
    mimeType: payload.mimeType || "application/pdf",
    base64UrlData,
    queueItemId: payload.queueItemId || null,
    sourceMessageId: payload.messageId,
    sourceThreadId: payload.threadId || null,
    sourceSubject: payload.subject || "",
    sourceFrom: payload.from || "",
    accountEmail: payload.accountEmail || (await getAuthState()).authenticatedEmail || null,
    accountName: payload.accountName || (await getAuthState()).authenticatedName || "",
    originalFilename: payload.originalFilename || payload.filename
  });
  const viewerTabId = await openPdfPreviewTab(previewCacheKey);
  const queue = await updateQueueItemPreviewKey(payload.queueItemId, previewCacheKey);

  return {
    viewerTabId,
    queue
  };
}

function isOAuthConfigured() {
  const clientId = chrome.runtime.getManifest().oauth2?.client_id ?? "";
  return Boolean(clientId) && !clientId.startsWith("REPLACE_WITH_");
}

async function getAuthState() {
  if (!isOAuthConfigured()) {
    return {
      authenticatedEmail: null,
      authenticatedName: ""
    };
  }

  try {
    return await getConnectedIdentity(false);
  } catch {
    return {
      authenticatedEmail: null,
      authenticatedName: ""
    };
  }
}

async function getConnectedIdentity(interactive) {
  const token = await getAuthToken(interactive);
  const gmailProfile = await gmailFetch("/gmail/v1/users/me/profile", token);
  const googleProfile = await googleProfileFetch(token);
  const authenticatedEmail = gmailProfile.emailAddress || null;
  const authenticatedName = googleProfile.name || (await getStoredAccountName(authenticatedEmail)) || "";

  if (authenticatedEmail) {
    await upsertAccountProfile(authenticatedEmail, {
      signerName: authenticatedName
    });
  }

  return {
    authenticatedEmail,
    authenticatedName
  };
}

async function getAuthToken(interactive) {
  if (!isOAuthConfigured()) {
    throw new Error(
      "Add a real Google Chrome Extension OAuth client ID to extension/manifest.json before connecting Gmail."
    );
  }

  const result = await chrome.identity.getAuthToken({ interactive });
  const token = typeof result === "string" ? result : result?.token;

  if (!token) {
    throw new Error("Google authentication completed without an access token.");
  }

  return token;
}

async function googleProfileFetch(token) {
  const response = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    return {};
  }

  return response.json();
}

async function gmailFetch(path, token, options = {}) {
  const response = await fetch(`https://gmail.googleapis.com${path}`, {
    method: options.method || "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gmail API request failed (${response.status}): ${errorText}`);
  }

  return response.json();
}

async function updateAccountProfile(payload) {
  const authState = await getAuthState();
  if (!authState.authenticatedEmail) {
    throw new Error("Connect Gmail before updating your EZSign signer name.");
  }

  const signerName = String(payload.signerName || "").trim();
  await upsertAccountProfile(authState.authenticatedEmail, { signerName });

  return {
    authenticatedEmail: authState.authenticatedEmail,
    authenticatedName: signerName
  };
}

async function getAccountSettings() {
  const authState = await getAuthState();
  if (!authState.authenticatedEmail) {
    return {
      authenticatedEmail: null,
      authenticatedName: "",
      profile: {
        signerName: "",
        preferences: getDefaultPreferences(),
        signatures: []
      }
    };
  }

  const profile = await getStoredAccountProfile(authState.authenticatedEmail, authState.authenticatedName);
  return {
    authenticatedEmail: authState.authenticatedEmail,
    authenticatedName: profile.signerName || authState.authenticatedName,
    profile
  };
}

async function saveAccountSettings(payload) {
  const authState = await getAuthState();
  if (!authState.authenticatedEmail) {
    throw new Error("Connect Gmail before saving EZSign settings.");
  }

  const existingProfile = await getStoredAccountProfile(authState.authenticatedEmail, authState.authenticatedName);
  const nextProfile = {
    ...existingProfile,
    signerName: String(payload.signerName || existingProfile.signerName || "").trim(),
    preferences: sanitizePreferences({
      ...existingProfile.preferences,
      ...(payload.preferences || {})
    })
  };

  await saveStoredAccountProfile(authState.authenticatedEmail, nextProfile);

  return {
    authenticatedEmail: authState.authenticatedEmail,
    authenticatedName: nextProfile.signerName,
    profile: nextProfile
  };
}

async function deleteAccountSignatures(payload) {
  const authState = await getAuthState();
  if (!authState.authenticatedEmail) {
    throw new Error("Connect Gmail before deleting saved signatures.");
  }

  const selectedIds = new Set(Array.isArray(payload.signatureIds) ? payload.signatureIds.map(String) : []);
  const existingProfile = await getStoredAccountProfile(authState.authenticatedEmail, authState.authenticatedName);
  const nextProfile = {
    ...existingProfile,
    signatures: existingProfile.signatures.filter((signature) => !selectedIds.has(String(signature.id)))
  };

  await saveStoredAccountProfile(authState.authenticatedEmail, nextProfile);

  return {
    authenticatedEmail: authState.authenticatedEmail,
    authenticatedName: nextProfile.signerName,
    profile: nextProfile
  };
}

async function upsertAccountProfile(accountEmail, updates) {
  if (!accountEmail) {
    return;
  }

  const stored = await chrome.storage.local.get({ [ACCOUNT_PROFILES_KEY]: {} });
  const profiles = stored[ACCOUNT_PROFILES_KEY] || {};
  const accountKey = normalizeAccountKey(accountEmail);
  const existing = profiles[accountKey] || {};

  profiles[accountKey] = {
    ...existing,
    email: accountEmail,
    signerName: String(updates.signerName ?? existing.signerName ?? "").trim()
  };

  await chrome.storage.local.set({ [ACCOUNT_PROFILES_KEY]: profiles });
}

async function getStoredAccountName(accountEmail) {
  if (!accountEmail) {
    return "";
  }

  const stored = await chrome.storage.local.get({ [ACCOUNT_PROFILES_KEY]: {} });
  const profile = stored[ACCOUNT_PROFILES_KEY]?.[normalizeAccountKey(accountEmail)];
  return String(profile?.signerName || "").trim();
}

async function getStoredAccountProfile(accountEmail, fallbackName = "") {
  if (!accountEmail) {
    return {
      signerName: String(fallbackName || "").trim(),
      preferences: getDefaultPreferences(),
      signatures: []
    };
  }

  const stored = await chrome.storage.local.get({ [ACCOUNT_PROFILES_KEY]: {} });
  const profile = stored[ACCOUNT_PROFILES_KEY]?.[normalizeAccountKey(accountEmail)] || {};

  return {
    signerName: String(profile.signerName || fallbackName || "").trim(),
    preferences: sanitizePreferences(profile.preferences || {}),
    signatures: sanitizeSignatures(profile.signatures || [])
  };
}

async function saveStoredAccountProfile(accountEmail, profile) {
  const stored = await chrome.storage.local.get({ [ACCOUNT_PROFILES_KEY]: {} });
  const profiles = stored[ACCOUNT_PROFILES_KEY] || {};
  profiles[normalizeAccountKey(accountEmail)] = {
    email: accountEmail,
    signerName: String(profile.signerName || "").trim(),
    preferences: sanitizePreferences(profile.preferences || {}),
    signatures: sanitizeSignatures(profile.signatures || [])
  };
  await chrome.storage.local.set({ [ACCOUNT_PROFILES_KEY]: profiles });
}

function normalizeAccountKey(accountEmail) {
  return String(accountEmail || "").trim().toLowerCase();
}

function getDefaultPreferences() {
  return {
    signatureColor: "black",
    dateFormat: "long",
    dateColor: "black"
  };
}

function sanitizePreferences(preferences) {
  return {
    ...getDefaultPreferences(),
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

function mapMessageToResult(message) {
  const headers = message.payload?.headers ?? [];

  return {
    messageId: message.id,
    threadId: message.threadId,
    snippet: message.snippet ?? "",
    internalDate: message.internalDate,
    subject: readHeader(headers, "Subject") || "(No subject)",
    from: readHeader(headers, "From") || "Unknown sender",
    date: readHeader(headers, "Date") || "",
    attachments: collectAttachments(message.payload)
  };
}

function collectAttachments(part, attachments = []) {
  if (!part) {
    return attachments;
  }

  const filename = part.filename?.trim();
  const extension = filename?.split(".").pop()?.toLowerCase();

  if (filename && extension && SUPPORTED_EXTENSIONS.has(extension)) {
    attachments.push({
      filename,
      mimeType: part.mimeType || "application/octet-stream",
      attachmentId: part.body?.attachmentId || null,
      partId: part.partId || null,
      size: part.body?.size || 0
    });
  }

  for (const childPart of part.parts ?? []) {
    collectAttachments(childPart, attachments);
  }

  return attachments;
}

function readHeader(headers, name) {
  const header = headers.find((item) => item.name?.toLowerCase() === name.toLowerCase());
  return header?.value ?? "";
}

async function getAttachmentBase64Url(payload, token) {
  if (payload.attachmentId) {
    const attachment = await gmailFetch(
      `/gmail/v1/users/me/messages/${encodeURIComponent(payload.messageId)}/attachments/${encodeURIComponent(payload.attachmentId)}`,
      token
    );

    if (!attachment.data) {
      throw new Error("Gmail returned an attachment record without file data.");
    }

    return attachment.data;
  }

  const message = await gmailFetch(
    `/gmail/v1/users/me/messages/${encodeURIComponent(payload.messageId)}?format=full`,
    token
  );
  const attachmentPart = findPartById(message.payload, payload.partId);

  if (!attachmentPart?.body?.data) {
    throw new Error("The selected Gmail attachment could not be downloaded.");
  }

  return attachmentPart.body.data;
}

function findPartById(part, partId) {
  if (!part) {
    return null;
  }

  if (part.partId === partId) {
    return part;
  }

  for (const childPart of part.parts ?? []) {
    const match = findPartById(childPart, partId);
    if (match) {
      return match;
    }
  }

  return null;
}

function buildDownloadDataUrl(mimeType, base64UrlData) {
  return `data:${mimeType};base64,${toStandardBase64(base64UrlData)}`;
}

function toStandardBase64(base64UrlData) {
  const standardBase64 = String(base64UrlData).replaceAll("-", "+").replaceAll("_", "/");
  const requiredPadding = (4 - (standardBase64.length % 4)) % 4;
  return `${standardBase64}${"=".repeat(requiredPadding)}`;
}

async function markQueueItemDownloaded(queueItemId, metadata = {}) {
  const current = await getQueuedRequests();
  if (!queueItemId) {
    return current;
  }

  const queuedRequests = current.map((item) =>
    item.id === queueItemId
      ? {
          ...item,
          status: metadata.status || (item.status === "signed" ? "signed" : "downloaded"),
          downloadedAt: new Date().toISOString(),
          previewCacheKey: metadata.previewCacheKey || item.previewCacheKey || null,
          downloadedFilename: metadata.filename || item.downloadedFilename || null
        }
      : item
  );

  await chrome.storage.local.set({ queuedRequests });
  return queuedRequests;
}

async function updateQueueItemPreviewKey(queueItemId, previewCacheKey) {
  const current = await getQueuedRequests();
  if (!queueItemId) {
    return current;
  }

  const queuedRequests = current.map((item) =>
    item.id === queueItemId
      ? {
          ...item,
          previewCacheKey
        }
      : item
  );

  await chrome.storage.local.set({ queuedRequests });
  return queuedRequests;
}

async function getQueuedRequests() {
  const current = await chrome.storage.local.get({ queuedRequests: [] });
  return current.queuedRequests;
}

function filterQueueForAccount(queue, authenticatedEmail) {
  if (!Array.isArray(queue)) {
    return [];
  }

  if (!authenticatedEmail) {
    return queue;
  }

  return queue.filter((item) => normalizeAccountKey(item.accountEmail) === normalizeAccountKey(authenticatedEmail));
}

function getRecentSignedDocuments(queue) {
  return (Array.isArray(queue) ? queue : [])
    .filter((item) => item?.status === "signed" && item?.signedAt)
    .sort((left, right) => new Date(right.signedAt).getTime() - new Date(left.signedAt).getTime())
    .slice(0, 3)
    .map((item) => ({
      id: item.id,
      filename: item.signedFilename || item.originalFilename || item.filename || "Signed document",
      subject: item.subject || "(No subject)",
      signedAt: item.signedAt
    }));
}

function sanitizeFilename(filename) {
  const cleaned = String(filename)
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, " ");

  return cleaned || "gmail-attachment";
}

function isPdfAttachment(filename, mimeType) {
  return String(mimeType).toLowerCase().includes("pdf") || String(filename).toLowerCase().endsWith(".pdf");
}

async function cachePdfPreview({
  filename,
  mimeType,
  base64UrlData,
  queueItemId = null,
  sourceMessageId = null,
  sourceThreadId = null,
  sourceSubject = "",
  sourceFrom = "",
  accountEmail = null,
  accountName = "",
  originalFilename = null
}) {
  const cacheKey = `${PDF_PREVIEW_STORAGE_PREFIX}${crypto.randomUUID()}`;
  await chrome.storage.session.set({
    [cacheKey]: {
      filename,
      mimeType,
      base64UrlData,
      queueItemId,
      sourceMessageId,
      sourceThreadId,
      sourceSubject,
      sourceFrom,
      accountEmail,
      accountName,
      originalFilename: originalFilename || filename,
      createdAt: Date.now()
    }
  });
  await prunePdfPreviewCache();
  return cacheKey;
}

async function openPdfPreviewTab(cacheKey) {
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (activeTab?.id && activeTab.url?.startsWith("https://mail.google.com/")) {
    const storedPreview = await chrome.storage.session.get(cacheKey);
    const preview = storedPreview[cacheKey];
    if (preview) {
      await chrome.storage.session.set({
        [cacheKey]: {
          ...preview,
          gmailTabId: activeTab.id
        }
      });
    }
  }
  const tab = await chrome.tabs.create({
    url: chrome.runtime.getURL(`viewer/pdf-viewer.html?cacheKey=${encodeURIComponent(cacheKey)}`)
  });
  await maybeCloseSidePanel(activeTab?.windowId ?? tab?.windowId ?? null);

  return tab?.id ?? null;
}

async function maybeCloseSidePanel(windowId) {
  if (!windowId || typeof chrome.sidePanel?.close !== "function") {
    return;
  }

  try {
    await chrome.sidePanel.close({ windowId });
  } catch {
    // Older Chrome builds can lack close(), and close failures should not block the workspace.
  }
}

async function prunePdfPreviewCache() {
  const allSessionItems = await chrome.storage.session.get(null);
  const previewEntries = Object.entries(allSessionItems)
    .filter(([key]) => key.startsWith(PDF_PREVIEW_STORAGE_PREFIX))
    .sort(([, left], [, right]) => Number(left?.createdAt || 0) - Number(right?.createdAt || 0));

  if (previewEntries.length <= MAX_PDF_PREVIEWS) {
    return;
  }

  const keysToRemove = previewEntries
    .slice(0, previewEntries.length - MAX_PDF_PREVIEWS)
    .map(([key]) => key);

  await chrome.storage.session.remove(keysToRemove);
}

async function waitForDownloadTerminalState(downloadId) {
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

async function replyWithSignedCopy(payload) {
  const previewCacheKey = payload.previewCacheKey;
  if (!previewCacheKey) {
    throw new Error("Missing preview cache key for the signed reply.");
  }

  const storedPreview = await chrome.storage.session.get(previewCacheKey);
  const preview = storedPreview[previewCacheKey];
  if (!preview?.base64UrlData || !preview?.sourceMessageId) {
    throw new Error("The signed PDF or its source email is no longer available in this workspace.");
  }

  const token = await getAuthToken(true);
  const sourceMessage = await gmailFetch(
    `/gmail/v1/users/me/messages/${encodeURIComponent(preview.sourceMessageId)}?format=metadata&metadataHeaders=From&metadataHeaders=Reply-To&metadataHeaders=Subject&metadataHeaders=Message-Id&metadataHeaders=References`,
    token
  );
  const headers = sourceMessage.payload?.headers ?? [];
  const to = readHeader(headers, "Reply-To") || readHeader(headers, "From");
  if (!to) {
    throw new Error("The original email did not include a reply address.");
  }
  const subject = ensureReplySubject(readHeader(headers, "Subject") || preview.sourceSubject || "Signed document");
  const inReplyTo = readHeader(headers, "Message-Id");
  const references = readHeader(headers, "References");
  const signerName = preview.accountName || (await getStoredAccountName(preview.accountEmail)) || "EZSign user";
  const filename = preview.filename || buildSignedAttachmentFilename(preview.originalFilename || "signed-document.pdf");

  const raw = buildReplyMimeMessage({
    to,
    subject,
    bodyText: `Hi,\n\nAttached is the signed PDF from ${signerName}.\n\nSent with EZSign.`,
    attachmentName: filename,
    attachmentMimeType: preview.mimeType || "application/pdf",
    attachmentBase64UrlData: preview.base64UrlData,
    inReplyTo,
    references
  });

  const draft = await gmailFetch("/gmail/v1/users/me/drafts", token, {
    method: "POST",
    body: {
      message: {
        threadId: preview.sourceThreadId || sourceMessage.threadId,
        raw
      }
    }
  });

  const draftId = draft.id;
  const draftThreadId = draft.message?.threadId || preview.sourceThreadId || sourceMessage.threadId;
  const draftUrl = `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(draftThreadId)}`;
  const openedTab = await openDraftTabInGmailWindow(preview.gmailTabId, draftUrl);

  return {
    draftId,
    tabId: openedTab?.id ?? null
  };
}

async function openDraftTabInGmailWindow(gmailTabId, url) {
  if (gmailTabId) {
    try {
      const gmailTab = await chrome.tabs.get(gmailTabId);
      return chrome.tabs.create({
        windowId: gmailTab.windowId,
        index: typeof gmailTab.index === "number" ? gmailTab.index + 1 : undefined,
        url,
        active: true
      });
    } catch {
      // Fall back to a normal tab if the original Gmail tab is gone.
    }
  }

  return chrome.tabs.create({
    url,
    active: true
  });
}

function ensureReplySubject(subject) {
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}

function buildReplyMimeMessage({
  to,
  subject,
  bodyText,
  attachmentName,
  attachmentMimeType,
  attachmentBase64UrlData,
  inReplyTo,
  references
}) {
  const boundary = `ezsign-${crypto.randomUUID()}`;
  const attachmentBase64 = chunkBase64(toStandardBase64(attachmentBase64UrlData));
  const lines = [
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`] : []),
    ...(references ? [`References: ${references}`] : inReplyTo ? [`References: ${inReplyTo}`] : []),
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 7bit",
    "",
    bodyText,
    "",
    `--${boundary}`,
    `Content-Type: ${attachmentMimeType}; name="${attachmentName}"`,
    `Content-Disposition: attachment; filename="${attachmentName}"`,
    "Content-Transfer-Encoding: base64",
    "",
    attachmentBase64,
    "",
    `--${boundary}--`
  ];

  return textToBase64Url(lines.join("\r\n"));
}

function chunkBase64(base64) {
  return String(base64).match(/.{1,76}/g)?.join("\r\n") || "";
}

function textToBase64Url(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(index, index + chunkSize));
  }

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function buildSignedAttachmentFilename(filename) {
  const safeName = sanitizeFilename(filename);
  const suffix = "_Signed_with_EZSign";

  if (safeName.toLowerCase().endsWith(".pdf")) {
    const baseName = safeName.replace(/_Signed_with_EZSign(?=\.pdf$)/i, "").replace(/\.pdf$/i, "");
    return `${baseName}${suffix}.pdf`;
  }

  return `${safeName.replace(/_Signed_with_EZSign$/i, "")}${suffix}.pdf`;
}

function getMockSearchResults(query) {
  return [
    {
      messageId: "mock-message-1",
      threadId: "mock-thread-1",
      subject: "Signature needed for contractor agreement",
      from: "Legal Ops <legal@example.com>",
      date: "Mon, 13 Apr 2026 09:02:00 -0600",
      internalDate: Date.now().toString(),
      snippet: `Demo result for query: ${query}`,
      attachments: [
        {
          filename: "contractor-agreement.pdf",
          mimeType: "application/pdf",
          attachmentId: "mock-attachment-1",
          partId: "part-1",
          size: 280144
        }
      ]
    },
    {
      messageId: "mock-message-2",
      threadId: "mock-thread-2",
      subject: "Please sign and return NDA",
      from: "Partnerships <partners@example.com>",
      date: "Sun, 12 Apr 2026 16:40:00 -0600",
      internalDate: Date.now().toString(),
      snippet: "Sample Gmail result used before OAuth is configured.",
      attachments: [
        {
          filename: "mutual-nda.docx",
          mimeType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          attachmentId: "mock-attachment-2",
          partId: "part-2",
          size: 143221
        }
      ]
    }
  ];
}
