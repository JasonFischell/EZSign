const DEFAULT_QUERY = 'has:attachment "please sign"';

const SUPPORTED_EXTENSIONS = new Set(["pdf", "doc", "docx"]);
const PDF_PREVIEW_STORAGE_PREFIX = "pdfPreview:";
const MAX_PDF_PREVIEWS = 10;

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

  const existing = await chrome.storage.local.get({ queuedRequests: [] });
  if (!Array.isArray(existing.queuedRequests)) {
    await chrome.storage.local.set({ queuedRequests: [] });
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
    case "search-signature-requests":
      return searchSignatureRequests(message.payload ?? {});
    case "open-attachment-preview":
      return openAttachmentPreview(message.payload ?? {});
    case "download-attachment":
      return downloadAttachment(message.payload ?? {});
    case "queue-signing-request":
      return queueSigningRequest(message.payload ?? {});
    default:
      throw new Error("Unsupported extension message.");
  }
}

async function getBootstrapState() {
  const storage = await chrome.storage.local.get({ queuedRequests: [] });
  const authState = await getAuthState();

  return {
    config: {
      defaultQuery: DEFAULT_QUERY,
      oauthConfigured: isOAuthConfigured(),
      scopes: chrome.runtime.getManifest().oauth2?.scopes ?? [],
      authenticatedEmail: authState.authenticatedEmail
    },
    queue: storage.queuedRequests
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
  const token = await getAuthToken(true);
  const profile = await gmailFetch("/gmail/v1/users/me/profile", token);

  return {
    authenticatedEmail: profile.emailAddress
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
  const nextItem = {
    id: crypto.randomUUID(),
    status: "draft",
    queuedAt: new Date().toISOString(),
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

  const token = await getAuthToken(true);
  const base64UrlData = await getAttachmentBase64Url(payload, token);
  const mimeType = payload.mimeType || "application/octet-stream";
  const shouldOpenPdfViewer = isPdfAttachment(payload.filename, mimeType);

  const downloadId = await chrome.downloads.download({
    url: buildDownloadDataUrl(mimeType, base64UrlData),
    filename: `EZSign/${sanitizeFilename(payload.filename)}`,
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
    previewCacheKey = await cachePdfPreview({
      filename: payload.filename,
      mimeType,
      base64UrlData
    });
    viewerTabId = await openPdfPreviewTab(previewCacheKey);
  }

  const queue = await markQueueItemDownloaded(payload.queueItemId, {
    previewCacheKey,
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
    base64UrlData
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
      authenticatedEmail: null
    };
  }

  try {
    const token = await getAuthToken(false);
    const profile = await gmailFetch("/gmail/v1/users/me/profile", token);

    return {
      authenticatedEmail: profile.emailAddress || null
    };
  } catch {
    return {
      authenticatedEmail: null
    };
  }
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

async function gmailFetch(path, token) {
  const response = await fetch(`https://gmail.googleapis.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gmail API request failed (${response.status}): ${errorText}`);
  }

  return response.json();
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
          status: "downloaded",
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

async function cachePdfPreview({ filename, mimeType, base64UrlData }) {
  const cacheKey = `${PDF_PREVIEW_STORAGE_PREFIX}${crypto.randomUUID()}`;
  await chrome.storage.session.set({
    [cacheKey]: {
      filename,
      mimeType,
      base64UrlData,
      createdAt: Date.now()
    }
  });
  await prunePdfPreviewCache();
  return cacheKey;
}

async function openPdfPreviewTab(cacheKey) {
  const tab = await chrome.tabs.create({
    url: chrome.runtime.getURL(`viewer/pdf-viewer.html?cacheKey=${encodeURIComponent(cacheKey)}`)
  });

  return tab?.id ?? null;
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
