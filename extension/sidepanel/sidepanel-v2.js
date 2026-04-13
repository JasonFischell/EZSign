const authPill = document.getElementById("authPill");
const authHelp = document.getElementById("authHelp");
const sourcePill = document.getElementById("sourcePill");
const queueCountPill = document.getElementById("queueCountPill");
const resultsCountPill = document.getElementById("resultsCountPill");
const activityMessage = document.getElementById("activityMessage");
const queryInput = document.getElementById("queryInput");
const searchForm = document.getElementById("searchForm");
const connectButton = document.getElementById("connectButton");
const demoButton = document.getElementById("demoButton");
const queueList = document.getElementById("queueList");
const results = document.getElementById("results");

const state = {
  oauthConfigured: false,
  authenticatedEmail: null,
  queue: [],
  results: []
};

initialize().catch((error) => {
  authPill.textContent = "Error";
  authHelp.textContent = error.message;
  activityMessage.textContent = `Could not initialize EZSign: ${error.message}`;
});

searchForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await runSearch({ useMock: !state.oauthConfigured });
});

connectButton.addEventListener("click", async () => {
  authPill.textContent = "Connecting";
  authHelp.textContent = "Waiting for Google sign-in...";
  activityMessage.textContent = "Opening the Google sign-in flow...";

  try {
    const response = await sendMessage({ type: "authenticate-gmail" });
    state.authenticatedEmail = response.authenticatedEmail;
    renderAuthState();
    activityMessage.textContent = `Connected Gmail for ${response.authenticatedEmail}.`;
  } catch (error) {
    authPill.textContent = "Needs setup";
    authHelp.textContent = error.message;
    connectButton.textContent = "Connect Gmail";
    activityMessage.textContent = `Could not connect Gmail: ${error.message}`;
  }
});

demoButton.addEventListener("click", async () => {
  await runSearch({ useMock: true });
});

results.addEventListener("click", handlePanelActionClick);
queueList.addEventListener("click", handlePanelActionClick);

async function handlePanelActionClick(event) {
  const queueButton = event.target.closest("[data-queue-button]");
  if (queueButton) {
    const payload = JSON.parse(queueButton.dataset.payload);
    const response = await sendMessage({
      type: "queue-signing-request",
      payload
    });

    state.queue = response.queue;
    activityMessage.textContent = `Queued ${payload.filename} for signing.`;
    renderQueue();
    return;
  }

  const downloadButton = event.target.closest("[data-download-button]");
  if (downloadButton) {
    const originalText = downloadButton.textContent;
    const payload = JSON.parse(downloadButton.dataset.payload);

    downloadButton.disabled = true;
    downloadButton.textContent = "Downloading...";
    activityMessage.textContent = `Downloading ${payload.filename}...`;

    try {
      const response = await sendMessage({
        type: "download-attachment",
        payload
      });

      if (Array.isArray(response.queue)) {
        state.queue = response.queue;
        renderQueue();
      }

      if (response.canceled) {
        activityMessage.textContent = `Download canceled for ${payload.filename}.`;
      } else {
        activityMessage.textContent = response.openedViewer
          ? `Saved and opened ${payload.filename} in Chrome.`
          : `Saved ${payload.filename} from Gmail.`;
      }
    } catch (error) {
      activityMessage.textContent = `Could not download ${payload.filename}: ${error.message}`;
    } finally {
      if (downloadButton.isConnected) {
        downloadButton.disabled = false;
        downloadButton.textContent = originalText;
      }
    }

    return;
  }

  const openButton = event.target.closest("[data-open-button]");
  if (!openButton) {
    return;
  }

  const originalText = openButton.textContent;
  const payload = JSON.parse(openButton.dataset.payload);

  openButton.disabled = true;
  openButton.textContent = "Opening...";
  activityMessage.textContent = `Opening ${payload.filename} in Chrome...`;

  try {
    const response = await sendMessage({
      type: "open-attachment-preview",
      payload
    });

    if (Array.isArray(response.queue)) {
      state.queue = response.queue;
      renderQueue();
    }

    activityMessage.textContent = `Opened ${payload.filename} in Chrome.`;
  } catch (error) {
    activityMessage.textContent = `Could not open ${payload.filename}: ${error.message}`;
  } finally {
    if (openButton.isConnected) {
      openButton.disabled = false;
      openButton.textContent = originalText;
    }
  }
}

async function initialize() {
  const bootstrap = await sendMessage({ type: "get-bootstrap-state" });

  state.oauthConfigured = bootstrap.config.oauthConfigured;
  state.authenticatedEmail = bootstrap.config.authenticatedEmail;
  state.queue = bootstrap.queue;
  queryInput.value = bootstrap.config.defaultQuery;

  renderAuthState();
  renderQueue();
  renderResults();
}

function renderAuthState() {
  if (state.authenticatedEmail) {
    authPill.textContent = "Connected";
    authHelp.textContent = `Authenticated as ${state.authenticatedEmail}`;
    connectButton.textContent = "Reconnect Gmail";
    return;
  }

  connectButton.textContent = "Connect Gmail";

  if (state.oauthConfigured) {
    authPill.textContent = "Ready";
    authHelp.textContent = "OAuth is configured. You can connect Gmail and search live data.";
    return;
  }

  authPill.textContent = "Needs setup";
  authHelp.textContent =
    "Replace the placeholder OAuth client ID in manifest.json, then reload the extension.";
}

async function runSearch({ useMock }) {
  sourcePill.textContent = useMock ? "Demo" : "Searching";
  results.textContent = "Loading results...";
  activityMessage.textContent = useMock
    ? "Loading demo attachment matches..."
    : "Searching Gmail for signature-related attachments...";

  try {
    const response = await sendMessage({
      type: "search-signature-requests",
      payload: {
        query: queryInput.value,
        useMock,
        maxResults: 10
      }
    });

    state.results = response.results;
    sourcePill.textContent = response.source === "gmail" ? "Live Gmail" : "Demo";
    activityMessage.textContent =
      response.results.length === 0
        ? "Search completed, but no matching attachments were found."
        : `Loaded ${response.results.length} matching message${response.results.length === 1 ? "" : "s"}.`;
    renderResults();
  } catch (error) {
    sourcePill.textContent = "Error";
    results.textContent = error.message;
    activityMessage.textContent = `Search failed: ${error.message}`;
  }
}

function renderQueue() {
  queueCountPill.textContent = `${state.queue.length} item${state.queue.length === 1 ? "" : "s"}`;

  if (state.queue.length === 0) {
    queueList.className = "stack empty-state";
    queueList.textContent = "No documents have been queued yet.";
    return;
  }

  queueList.className = "stack";
  queueList.innerHTML = state.queue
    .map((item) => {
      const downloadPayload = JSON.stringify({
        queueItemId: item.id,
        messageId: item.messageId,
        attachmentId: item.attachmentId,
        partId: item.partId,
        filename: item.filename,
        mimeType: item.mimeType,
        previewCacheKey: item.previewCacheKey || null
      });
      const buttonLabel = item.status === "downloaded" ? "Download Again" : "Download";
      const showOpenButton =
        item.status === "downloaded" &&
        String(item.filename || "").toLowerCase().endsWith(".pdf");

      return `
        <article class="queue-card">
          <h3>${escapeHtml(item.filename)}</h3>
          <p class="metadata">${escapeHtml(item.subject || "Draft signature request")} &middot; ${escapeHtml(item.status)}</p>
          <div class="queue-actions">
            ${showOpenButton
              ? `<button class="secondary" data-open-button="true" data-payload='${escapeAttribute(downloadPayload)}' type="button">
              Open
            </button>`
              : ""}
            <button class="secondary" data-download-button="true" data-payload='${escapeAttribute(downloadPayload)}' type="button">
              ${buttonLabel}
            </button>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderResults() {
  resultsCountPill.textContent = `${state.results.length} found`;

  if (state.results.length === 0) {
    results.className = "stack empty-state";
    results.textContent = "Run a search or load demo results.";
    return;
  }

  results.className = "stack";
  results.innerHTML = state.results
    .map((message) => {
      const attachmentsMarkup = message.attachments
        .map((attachment) => {
          const payload = JSON.stringify({
            messageId: message.messageId,
            threadId: message.threadId,
            subject: message.subject,
            from: message.from,
            filename: attachment.filename,
            attachmentId: attachment.attachmentId,
            partId: attachment.partId,
            mimeType: attachment.mimeType,
            size: attachment.size
          });

          return `
            <div class="attachment-row">
              <div>
                <div class="attachment-name">${escapeHtml(attachment.filename)}</div>
                <div class="attachment-meta">${formatBytes(attachment.size)} &middot; ${escapeHtml(attachment.mimeType)}</div>
              </div>
              <div class="attachment-actions">
                <button class="secondary" data-download-button="true" data-payload='${escapeAttribute(payload)}' type="button">
                  Download
                </button>
                <button class="queue-button" data-queue-button="true" data-payload='${escapeAttribute(payload)}' type="button">
                  Queue
                </button>
              </div>
            </div>
          `;
        })
        .join("");

      return `
        <article class="message-card">
          <h3>${escapeHtml(message.subject)}</h3>
          <p class="metadata">${escapeHtml(message.from)} &middot; ${escapeHtml(message.date || "Unknown date")}</p>
          <p class="message-snippet">${escapeHtml(message.snippet || "No message snippet available.")}</p>
          <div class="attachments">${attachmentsMarkup}</div>
        </article>
      `;
    })
    .join("");
}

function formatBytes(size) {
  if (!size) {
    return "Unknown size";
  }

  if (size < 1024) {
    return `${size} B`;
  }

  if (size < 1024 * 1024) {
    return `${Math.round(size / 1024)} KB`;
  }

  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

async function sendMessage(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) {
    throw new Error(response?.error || "The extension did not return a valid response.");
  }

  return response;
}
