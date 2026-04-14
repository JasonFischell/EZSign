const authPill = document.getElementById("authPill");
const authHelp = document.getElementById("authHelp");
const sourcePill = document.getElementById("sourcePill");
const resultsCountPill = document.getElementById("resultsCountPill");
const activityMessage = document.getElementById("activityMessage");
const queryInput = document.getElementById("queryInput");
const searchForm = document.getElementById("searchForm");
const connectButton = document.getElementById("connectButton");
const signInCard = document.getElementById("signInCard");
const searchCard = document.getElementById("searchCard");
const documentsCard = document.getElementById("documentsCard");
const toggleSearchButton = document.getElementById("toggleSearchButton");
const searchEditor = document.getElementById("searchEditor");
const results = document.getElementById("results");
const recentSignedCard = document.getElementById("recentSignedCard");
const recentSignedList = document.getElementById("recentSignedList");
const openSettingsButton = document.getElementById("openSettingsButton");
const settingsModal = document.getElementById("settingsModal");
const closeSettingsButton = document.getElementById("closeSettingsButton");
const cancelSettingsButton = document.getElementById("cancelSettingsButton");
const saveSettingsButton = document.getElementById("saveSettingsButton");
const signOutButton = document.getElementById("signOutButton");
const signerNameInput = document.getElementById("signerNameInput");
const settingsAccountHelp = document.getElementById("settingsAccountHelp");
const signatureColorGrid = document.getElementById("signatureColorGrid");
const dateFormatGrid = document.getElementById("dateFormatGrid");
const dateColorGrid = document.getElementById("dateColorGrid");
const saveSignatureDefaultsButton = document.getElementById("saveSignatureDefaultsButton");
const saveDateDefaultsButton = document.getElementById("saveDateDefaultsButton");
const signatureManagerList = document.getElementById("signatureManagerList");
const deleteSelectedSignaturesButton = document.getElementById("deleteSelectedSignaturesButton");

const DEFAULT_PREFERENCES = {
  signatureColor: "black",
  dateFormat: "long",
  dateColor: "black"
};

const state = {
  oauthConfigured: false,
  authenticatedEmail: null,
  authenticatedName: "",
  defaultQuery: "",
  results: [],
  recentSignedDocuments: [],
  searchEditorVisible: false,
  settingsDraft: {
    signerName: "",
    preferences: { ...DEFAULT_PREFERENCES }
  },
  signatures: [],
  selectedSignatureIds: new Set()
};

initialize().catch((error) => {
  authPill.textContent = "Error";
  activityMessage.textContent = `Could not initialize EZSign: ${error.message}`;
});

searchForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await runSearch();
});

toggleSearchButton.addEventListener("click", () => {
  state.searchEditorVisible = !state.searchEditorVisible;
  renderSearchEditorState();
});

connectButton.addEventListener("click", async () => {
  authPill.textContent = "Connecting";
  activityMessage.textContent = "Opening the Google sign-in flow...";

  try {
    const response = await sendMessage({ type: "authenticate-gmail" });
    state.authenticatedEmail = response.authenticatedEmail;
    state.authenticatedName = response.authenticatedName || "";
    const bootstrap = await sendMessage({ type: "get-bootstrap-state" });
    state.recentSignedDocuments = Array.isArray(bootstrap.recentSignedDocuments) ? bootstrap.recentSignedDocuments : [];
    await loadSettings();
    renderAuthState();
    renderRecentSignedDocuments();
    activityMessage.textContent = state.authenticatedName
      ? `Connected Gmail for ${state.authenticatedName}.`
      : `Connected Gmail for ${response.authenticatedEmail}.`;
    await runSearch();
  } catch (error) {
    authPill.textContent = "Please Sign In";
    activityMessage.textContent = `Could not connect Gmail: ${error.message}`;
  }
});

openSettingsButton.addEventListener("click", async () => {
  await loadSettings();
  renderSettingsModal();
  settingsModal.hidden = false;
});

closeSettingsButton.addEventListener("click", closeSettingsModal);
cancelSettingsButton.addEventListener("click", closeSettingsModal);
saveSettingsButton.addEventListener("click", async () => saveSettings());

signOutButton.addEventListener("click", async () => {
  try {
    await sendMessage({ type: "sign-out-gmail" });
    state.authenticatedEmail = null;
    state.authenticatedName = "";
    state.results = [];
    state.recentSignedDocuments = [];
    state.signatures = [];
    state.selectedSignatureIds = new Set();
    state.settingsDraft = {
      signerName: "",
      preferences: { ...DEFAULT_PREFERENCES }
    };
    closeSettingsModal();
    renderAuthState();
    renderResults();
    renderRecentSignedDocuments();
    activityMessage.textContent = "Signed out of Gmail Assistant.";
  } catch (error) {
    activityMessage.textContent = `Could not sign out: ${error.message}`;
  }
});

signatureColorGrid.addEventListener("click", (event) => {
  const button = event.target.closest("[data-signature-color]");
  if (!button) {
    return;
  }

  state.settingsDraft.preferences.signatureColor = button.dataset.signatureColor;
  renderSettingsModal();
});

dateFormatGrid.addEventListener("click", (event) => {
  const button = event.target.closest("[data-date-format]");
  if (!button) {
    return;
  }

  state.settingsDraft.preferences.dateFormat = button.dataset.dateFormat;
  renderSettingsModal();
});

dateColorGrid.addEventListener("click", (event) => {
  const button = event.target.closest("[data-date-color]");
  if (!button) {
    return;
  }

  state.settingsDraft.preferences.dateColor = button.dataset.dateColor;
  renderSettingsModal();
});

saveSignatureDefaultsButton.addEventListener("click", async () => {
  await saveSettings();
  activityMessage.textContent = "Saved the default signature color.";
});

saveDateDefaultsButton.addEventListener("click", async () => {
  await saveSettings();
  activityMessage.textContent = "Saved the default date settings.";
});

signatureManagerList.addEventListener("change", (event) => {
  const checkbox = event.target.closest("[data-signature-checkbox]");
  if (!checkbox) {
    return;
  }

  const signatureId = checkbox.dataset.signatureCheckbox;
  if (checkbox.checked) {
    state.selectedSignatureIds.add(signatureId);
  } else {
    state.selectedSignatureIds.delete(signatureId);
  }
});

deleteSelectedSignaturesButton.addEventListener("click", async () => {
  if (state.selectedSignatureIds.size === 0) {
    activityMessage.textContent = "Select at least one saved signature before deleting.";
    return;
  }

  try {
    const response = await sendMessage({
      type: "delete-account-signatures",
      payload: {
        signatureIds: Array.from(state.selectedSignatureIds)
      }
    });
    state.signatures = response.profile.signatures || [];
    state.selectedSignatureIds = new Set();
    renderSettingsModal();
    activityMessage.textContent = "Deleted the selected saved signatures.";
  } catch (error) {
    activityMessage.textContent = `Could not delete signatures: ${error.message}`;
  }
});

results.addEventListener("click", async (event) => {
  const signButton = event.target.closest("[data-sign-button]");
  if (signButton) {
    const payload = JSON.parse(signButton.dataset.payload);
    await openSigningWorkspace(payload, false, signButton);
    return;
  }

  const saveAndSignButton = event.target.closest("[data-save-sign-button]");
  if (!saveAndSignButton) {
    return;
  }

  const payload = JSON.parse(saveAndSignButton.dataset.payload);
  await openSigningWorkspace(payload, true, saveAndSignButton);
});

async function initialize() {
  const bootstrap = await sendMessage({ type: "get-bootstrap-state" });
  state.oauthConfigured = bootstrap.config.oauthConfigured;
  state.authenticatedEmail = bootstrap.config.authenticatedEmail;
  state.authenticatedName = bootstrap.config.authenticatedName || "";
  state.defaultQuery = bootstrap.config.defaultQuery || "";
  state.recentSignedDocuments = Array.isArray(bootstrap.recentSignedDocuments) ? bootstrap.recentSignedDocuments : [];
  queryInput.value = state.defaultQuery;

  if (state.authenticatedEmail) {
    await loadSettings();
  }

  renderAuthState();
  renderSearchEditorState();
  renderResults();
  renderRecentSignedDocuments();

  if (state.authenticatedEmail) {
    await runSearch();
  }
}

async function loadSettings() {
  const response = await sendMessage({ type: "get-account-settings" });
  state.authenticatedEmail = response.authenticatedEmail;
  state.authenticatedName = response.authenticatedName || "";
  state.settingsDraft = {
    signerName: response.profile.signerName || response.authenticatedName || "",
    preferences: {
      ...DEFAULT_PREFERENCES,
      ...(response.profile.preferences || {})
    }
  };
  state.signatures = Array.isArray(response.profile.signatures) ? response.profile.signatures : [];
  state.selectedSignatureIds = new Set();
}

function renderAuthState() {
  const connected = Boolean(state.authenticatedEmail);
  authPill.textContent = connected ? "Connected" : "Please Sign In";
  authPill.classList.toggle("connected", connected);
  signInCard.hidden = connected;
  searchCard.hidden = !connected;
  documentsCard.hidden = !connected;
  recentSignedCard.hidden = !connected;
  authHelp.textContent = connected
    ? `Authenticated as ${state.authenticatedName || state.authenticatedEmail}`
    : "Connect your Gmail account to search for documents that need signatures.";
}

function renderSearchEditorState() {
  searchEditor.hidden = !state.searchEditorVisible;
  toggleSearchButton.textContent = state.searchEditorVisible ? "Hide Search" : "Edit Search";
}

async function runSearch() {
  if (!state.authenticatedEmail) {
    return;
  }

  sourcePill.textContent = "Searching";
  results.className = "stack empty-state";
  results.textContent = "Searching Gmail for signature-ready documents...";
  activityMessage.textContent = "Searching Gmail for documents that need signatures...";

  try {
    const response = await sendMessage({
      type: "search-signature-requests",
      payload: {
        query: queryInput.value || state.defaultQuery,
        maxResults: 20
      }
    });

    state.results = flattenResults(response.results);
    sourcePill.textContent = "Live Gmail";
    activityMessage.textContent =
      state.results.length === 0
        ? "No matching documents were found in Gmail."
        : `Found ${state.results.length} document${state.results.length === 1 ? "" : "s"} that may need signatures.`;
    renderResults();
  } catch (error) {
    sourcePill.textContent = "Error";
    results.className = "stack empty-state";
    results.textContent = error.message;
    activityMessage.textContent = `Search failed: ${error.message}`;
  }
}

function flattenResults(messages) {
  return (messages || []).flatMap((message) =>
    (message.attachments || []).map((attachment) => ({
      messageId: message.messageId,
      threadId: message.threadId,
      subject: message.subject,
      from: message.from,
      date: message.date,
      snippet: message.snippet,
      filename: attachment.filename,
      originalFilename: attachment.filename,
      attachmentId: attachment.attachmentId,
      partId: attachment.partId,
      mimeType: attachment.mimeType,
      size: attachment.size,
      accountEmail: state.authenticatedEmail,
      accountName: state.authenticatedName
    }))
  );
}

function renderResults() {
  resultsCountPill.textContent = `${state.results.length} found`;

  if (state.results.length === 0) {
    results.className = "stack empty-state";
    results.textContent = state.authenticatedEmail
      ? "No matching documents were found. Try Search Gmail or Edit Search."
      : "Sign in with Gmail to load documents.";
    return;
  }

  results.className = "document-list";
  results.innerHTML = state.results
    .map((item) => {
      const payload = escapeAttribute(JSON.stringify(item));
      return `
        <article class="document-card">
          <h3>${escapeHtml(item.filename)}</h3>
          <p class="doc-meta">${escapeHtml(item.subject || "(No subject)")} &middot; ${escapeHtml(item.from || "Unknown sender")}</p>
          <p class="document-snippet">${escapeHtml(item.snippet || "No message snippet available.")}</p>
          <div class="document-actions">
            <button class="secondary" data-sign-button="true" data-payload="${payload}" type="button">Sign</button>
            <button class="primary-action" data-save-sign-button="true" data-payload="${payload}" type="button">Save and Sign</button>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderRecentSignedDocuments() {
  if (!state.authenticatedEmail) {
    recentSignedList.className = "stack empty-state";
    recentSignedList.textContent = "Sign in with Gmail to see recently signed documents.";
    return;
  }

  if (state.recentSignedDocuments.length === 0) {
    recentSignedList.className = "stack empty-state";
    recentSignedList.textContent = "Your 3 most recently signed documents will appear here.";
    return;
  }

  recentSignedList.className = "recent-signed-list";
  recentSignedList.innerHTML = state.recentSignedDocuments
    .map(
      (item) => `
        <article class="recent-signed-item">
          <h3>${escapeHtml(item.filename || "Signed document")}</h3>
          <p class="doc-meta">${escapeHtml(item.subject || "(No subject)")}</p>
          <p class="muted">Signed ${escapeHtml(formatSignedAt(item.signedAt))}</p>
        </article>
      `
    )
    .join("");
}

async function openSigningWorkspace(payload, saveFirst, button) {
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = saveFirst ? "Saving..." : "Opening...";
  activityMessage.textContent = saveFirst
    ? `Saving and opening ${payload.filename}...`
    : `Opening ${payload.filename} in the signing workspace...`;

  try {
    const response = await sendMessage({
      type: saveFirst ? "download-attachment" : "open-attachment-preview",
      payload
    });
    activityMessage.textContent = saveFirst
      ? response.canceled
        ? `Save canceled for ${payload.filename}.`
        : `Saved and opened ${payload.filename} in the signing workspace.`
      : `Opened ${payload.filename} in the signing workspace.`;
  } catch (error) {
    activityMessage.textContent = `Could not open ${payload.filename}: ${error.message}`;
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

function renderSettingsModal() {
  signerNameInput.value = state.settingsDraft.signerName || "";
  settingsAccountHelp.textContent = state.authenticatedEmail
    ? `Connected Gmail account: ${state.authenticatedEmail}`
    : "Sign in with Gmail to manage assistant settings.";
  signOutButton.hidden = !state.authenticatedEmail;

  for (const button of signatureColorGrid.querySelectorAll("[data-signature-color]")) {
    button.classList.toggle("is-active", button.dataset.signatureColor === state.settingsDraft.preferences.signatureColor);
  }

  updateDateFormatExamples();

  for (const button of dateFormatGrid.querySelectorAll("[data-date-format]")) {
    button.classList.toggle("is-active", button.dataset.dateFormat === state.settingsDraft.preferences.dateFormat);
  }

  for (const button of dateColorGrid.querySelectorAll("[data-date-color]")) {
    button.classList.toggle("is-active", button.dataset.dateColor === state.settingsDraft.preferences.dateColor);
  }

  renderSignatureManager();
}

function renderSignatureManager() {
  if (!state.authenticatedEmail) {
    signatureManagerList.className = "signature-manager empty-state";
    signatureManagerList.textContent = "Sign in with Gmail to manage saved signatures.";
    return;
  }

  if (state.signatures.length === 0) {
    signatureManagerList.className = "signature-manager empty-state";
    signatureManagerList.textContent = "No saved signatures are tied to this Gmail account yet.";
    return;
  }

  signatureManagerList.className = "signature-manager";
  signatureManagerList.innerHTML = state.signatures
    .map(
      (signature) => `
        <label class="signature-manager-item">
          <input type="checkbox" data-signature-checkbox="${escapeAttribute(signature.id)}" />
          <div class="signature-manager-copy">
            <h4>${escapeHtml(signature.name)}</h4>
            <p>${escapeHtml(signature.variant === "typed" ? "Typed signature" : "Hand-drawn signature")}</p>
          </div>
          <img src="${escapeAttribute(signature.dataUrl)}" alt="${escapeAttribute(signature.name)} preview" />
        </label>
      `
    )
    .join("");
}

async function saveSettings() {
  try {
    const response = await sendMessage({
      type: "save-account-settings",
      payload: {
        signerName: signerNameInput.value.trim(),
        preferences: state.settingsDraft.preferences
      }
    });

    state.authenticatedEmail = response.authenticatedEmail;
    state.authenticatedName = response.authenticatedName || "";
    state.settingsDraft = {
      signerName: response.profile.signerName || "",
      preferences: {
        ...DEFAULT_PREFERENCES,
        ...(response.profile.preferences || {})
      }
    };
    closeSettingsModal();
    renderAuthState();
    activityMessage.textContent = "Saved Gmail assistant settings.";
  } catch (error) {
    activityMessage.textContent = `Could not save settings: ${error.message}`;
  }
}

function updateDateFormatExamples() {
  const dateValue = getTodayIsoValue();
  for (const button of dateFormatGrid.querySelectorAll("[data-date-format]")) {
    button.textContent = formatDateValue(dateValue, button.dataset.dateFormat);
  }
}

function formatSignedAt(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "recently";
  }

  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function closeSettingsModal() {
  settingsModal.hidden = true;
}

function getTodayIsoValue() {
  const today = new Date();
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(
    today.getDate()
  ).padStart(2, "0")}`;
}

function formatDateValue(dateValue, formatId) {
  const date = new Date(`${dateValue}T12:00:00`);
  if (Number.isNaN(date.getTime())) {
    return dateValue;
  }

  switch (formatId) {
    case "short":
      return `${date.getMonth() + 1}/${date.getDate()}/${String(date.getFullYear()).slice(-2)}`;
    case "stamp":
      return `${String(date.getDate()).padStart(2, "0")}-${date
        .toLocaleString("en-US", { month: "short" })
        .toUpperCase()}-${date.getFullYear()}`;
    case "iso":
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
        date.getDate()
      ).padStart(2, "0")}`;
    case "long":
    default:
      return date.toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric"
      });
  }
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
