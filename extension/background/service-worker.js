const DEFAULT_QUERY = 'has:attachment "please sign"';

const SUPPORTED_EXTENSIONS = new Set(["pdf", "doc", "docx"]);

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
          size: 143221
        }
      ]
    }
  ];
}
