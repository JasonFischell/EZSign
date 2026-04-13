const authPill = document.getElementById("authPill");
const authHelp = document.getElementById("authHelp");
const sourcePill = document.getElementById("sourcePill");
const queueCountPill = document.getElementById("queueCountPill");
const resultsCountPill = document.getElementById("resultsCountPill");
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
});

searchForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await runSearch({ useMock: !state.oauthConfigured });
});

connectButton.addEventListener("click", async () => {
  authPill.textContent = "Connecting";
  authHelp.textContent = "Waiting for Google sign-in...";

  try {
    const response = await sendMessage({ type: "authenticate-gmail" });
    state.authenticatedEmail = response.authenticatedEmail;
    authPill.textContent = "Connected";
    authHelp.textContent = `Authenticated as ${response.authenticatedEmail}`;
  } catch (error) {
    authPill.textContent = "Needs setup";
    authHelp.textContent = error.message;
  }
});

demoButton.addEventListener("click", async () => {
  await runSearch({ useMock: true });
});

results.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-queue-button]");
  if (!button) {
    return;
  }

  const payload = JSON.parse(button.dataset.payload);
  const response = await sendMessage({
    type: "queue-signing-request",
    payload
  });

  state.queue = response.queue;
  renderQueue();
});

async function initialize() {
  const bootstrap = await sendMessage({ type: "get-bootstrap-state" });

  state.oauthConfigured = bootstrap.config.oauthConfigured;
  state.authenticatedEmail = bootstrap.config.authenticatedEmail;
  state.queue = bootstrap.queue;
  queryInput.value = bootstrap.config.defaultQuery;

  if (state.authenticatedEmail) {
    authPill.textContent = "Connected";
    authHelp.textContent = `Authenticated as ${state.authenticatedEmail}`;
  } else if (state.oauthConfigured) {
    authPill.textContent = "Ready";
    authHelp.textContent = "OAuth is configured. You can connect Gmail and search live data.";
  } else {
    authPill.textContent = "Needs setup";
    authHelp.textContent =
      "Replace the placeholder OAuth client ID in manifest.json, then reload the extension.";
  }

  renderQueue();
  renderResults();
}

async function runSearch({ useMock }) {
  sourcePill.textContent = useMock ? "Demo" : "Searching";
  results.textContent = "Loading results...";

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
    renderResults();
  } catch (error) {
    sourcePill.textContent = "Error";
    results.textContent = error.message;
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
    .map(
      (item) => `
        <article class="queue-card">
          <h3>${escapeHtml(item.filename)}</h3>
          <p class="metadata">${escapeHtml(item.subject || "Draft signature request")} • ${escapeHtml(item.status)}</p>
        </article>
      `
    )
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
          const queuePayload = JSON.stringify({
            messageId: message.messageId,
            threadId: message.threadId,
            subject: message.subject,
            from: message.from,
            filename: attachment.filename,
            attachmentId: attachment.attachmentId,
            mimeType: attachment.mimeType,
            size: attachment.size
          });

          return `
            <div class="attachment-row">
              <div>
                <div class="attachment-name">${escapeHtml(attachment.filename)}</div>
                <div class="attachment-meta">${formatBytes(attachment.size)} • ${escapeHtml(attachment.mimeType)}</div>
              </div>
              <button class="queue-button" data-queue-button="true" data-payload='${escapeAttribute(queuePayload)}' type="button">
                Queue
              </button>
            </div>
          `;
        })
        .join("");

      return `
        <article class="message-card">
          <h3>${escapeHtml(message.subject)}</h3>
          <p class="metadata">${escapeHtml(message.from)} • ${escapeHtml(message.date || "Unknown date")}</p>
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
