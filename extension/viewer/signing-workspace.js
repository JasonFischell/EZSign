import * as pdfjsLib from "../vendor/pdfjs/pdf.mjs";

const DEFAULT_SIGNATURE_WIDTH = 190;
const MIN_SIGNATURE_WIDTH = 76;
const MIN_SIGNATURE_HEIGHT = 28;
const MAX_SIGNATURE_WIDTH_RATIO = 0.36;
const MAX_RENDER_WIDTH = 920;
const MIN_RENDER_WIDTH = 540;
const POINTER_DRAG_THRESHOLD = 8;
const DATE_TEXT_PADDING_X = 18;
const DATE_TEXT_PADDING_Y = 10;
const DEFAULT_DATE_FONT_SIZE = 18;
const MIN_DATE_FONT_SIZE = 12;
const MAX_DATE_FONT_SIZE = 22;
const COLOR_OPTIONS = {
  black: { label: "Black", value: "#111111" },
  blue: { label: "Blue", value: "#1f5cb8" },
  red: { label: "Red", value: "#c62828" },
  green: { label: "Green", value: "#2e7d32" },
  yellow: { label: "Yellow", value: "#d4a900" },
  white: { label: "White", value: "#ffffff" }
};
const DATE_FORMAT_OPTIONS = {
  long: "August 1, 2026",
  short: "8/1/26",
  stamp: "01-AUG-2026",
  iso: "2026-08-01"
};
const TYPED_FONT_OPTIONS = [
  "Arial, sans-serif",
  "'Times New Roman', serif",
  "'Segoe Script', cursive",
  "'Brush Script MT', cursive",
  "'Lucida Handwriting', cursive"
];
const measurementCanvas = document.createElement("canvas");
const measurementContext = measurementCanvas.getContext("2d");

export function createWorkspace({ pdfWorkerUrl, helpers, pdfLib }) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

  const ui = getUi();
  const state = {
    cacheKey: null,
    preview: null,
    documentBytes: null,
    signatures: [],
    placements: [],
    pageLayouts: [],
    pageTextAnchors: [],
    pageElements: new Map(),
    activeSignatureId: null,
    selectedPlacementId: null,
    renderPass: 0,
    isRendering: false,
    hasUnsavedChanges: false,
    pointerSession: null,
    dragGhost: null,
    highlightedStage: null,
    ignoreClickUntil: 0,
    placementMode: "signature",
    signatureInputMode: "drawn",
    selectedTypedFont: TYPED_FONT_OPTIONS[0],
    currentSettings: {
      signatureColor: "black",
      dateFormat: "long",
      dateColor: "black"
    },
    settingsSnapshot: null,
    savedPreferences: {
      signatureColor: "black",
      dateFormat: "long",
      dateColor: "black"
    },
    dateEditorPlacementId: null,
    signatureEditorPlacementId: null,
    signatureEditorDraftColor: null
  };

  let signaturePad = null;

  return {
    attachSignaturePad(pad) {
      signaturePad = pad;
      signaturePad?.subscribe?.(() => renderTypedSignaturePreview());
    },
    async initialize() {
      if (!pdfLib?.PDFDocument) {
        throw new Error("The PDF signing library did not load correctly.");
      }

      bindEvents();
      await loadWorkspace();
      if (state.signatures.length === 0) {
        setStatus("Add a signature to start signing this PDF.");
        requestAnimationFrame(() => openSignatureModal(true));
      } else {
        setStatus("Drag a stored signature onto any page, then save a signed copy.");
      }
    },
    showError
  };

  function bindEvents() {
    ui.openSettingsButton.addEventListener("click", openSettingsModal);
    ui.closeSettingsButton.addEventListener("click", closeSettingsModal);
    ui.cancelSettingsButton.addEventListener("click", closeSettingsModal);
    ui.saveSettingsButton.addEventListener("click", () => void saveSettingsChanges());
    ui.saveSignatureDefaultsButton.addEventListener("click", () => saveDefaultSetting("signatureColor"));
    ui.saveDateDefaultsButton.addEventListener("click", () => saveDefaultSetting("dateSettings"));
    ui.signatureColorGrid.addEventListener("click", handleSettingsClick);
    ui.dateFormatGrid.addEventListener("click", handleSettingsClick);
    ui.dateColorGrid.addEventListener("click", handleSettingsClick);
    ui.signatureCaptureColorGrid.addEventListener("click", handleCaptureColorSelection);
    ui.addSignatureButton.addEventListener("click", () => openSignatureModal(false));
    ui.promptAddSignatureButton.addEventListener("click", () => openSignatureModal(true));
    ui.closeModalButton.addEventListener("click", closeSignatureModal);
    ui.cancelSignatureButton.addEventListener("click", closeSignatureModal);
    ui.drawSignatureModeButton.addEventListener("click", () => setSignatureInputMode("drawn"));
    ui.typedSignatureModeButton.addEventListener("click", () => setSignatureInputMode("typed"));
    ui.typedSignatureTextInput.addEventListener("input", renderTypedSignaturePreview);
    ui.typedSignatureFontGrid.addEventListener("click", handleTypedFontSelection);
    ui.clearSignaturePadButton.addEventListener("click", () => {
      signaturePad.clear();
      ui.signatureModalHelp.textContent =
        "Sign with your mouse, trackpad, stylus, or typed text. We will store this inside the extension.";
    });
    ui.saveSignatureButton.addEventListener("click", saveSignature);
    ui.clearPlacementsButton.addEventListener("click", clearPlacements);
    ui.saveSignedButton.addEventListener("click", saveSignedCopy);
    ui.signatureLibrary.addEventListener("click", handleLibraryClick);
    ui.signatureLibrary.addEventListener("pointerdown", handleSignaturePointerDown);
    ui.pagesContainer.addEventListener("pointerdown", handlePagePointerDown);
    ui.pagesContainer.addEventListener("click", handlePagesClick);
    ui.closeDateEditorButton.addEventListener("click", closeDateEditorModal);
    ui.cancelDateEditorButton.addEventListener("click", closeDateEditorModal);
    ui.saveDateEditorButton.addEventListener("click", applyDatePlacementChanges);
    ui.dateEditorFormatGrid.addEventListener("click", handleDateEditorFormatSelection);
    ui.dateEditorColorGrid.addEventListener("click", handleDateEditorColorSelection);
    ui.dateEditorInput.addEventListener("input", renderDateEditorFormatExamples);
    ui.closeSignatureEditorButton.addEventListener("click", closeSignatureEditorModal);
    ui.cancelSignatureEditorButton.addEventListener("click", closeSignatureEditorModal);
    ui.saveSignatureEditorButton.addEventListener("click", () => void applySignaturePlacementChanges());
    ui.signatureEditorColorGrid.addEventListener("click", handleSignatureEditorColorSelection);
    window.addEventListener("pointermove", handleGlobalPointerMove);
    window.addEventListener("pointerup", handleGlobalPointerUp);
    window.addEventListener("pointercancel", cancelPointerSession);
    window.addEventListener("beforeunload", (event) => {
      if (!state.hasUnsavedChanges) {
        return;
      }

      event.preventDefault();
      event.returnValue = "";
    });
    window.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") {
        return;
      }

      if (!ui.signatureModal.hidden) {
        closeSignatureModal();
        return;
      }

      if (!ui.settingsModal.hidden) {
        closeSettingsModal();
        return;
      }

      if (!ui.dateEditorModal.hidden) {
        closeDateEditorModal();
        return;
      }

      if (!ui.signatureEditorModal.hidden) {
        closeSignatureEditorModal();
      }
    });
  }

  async function loadWorkspace() {
    state.cacheKey = new URLSearchParams(window.location.search).get("cacheKey");
    if (!state.cacheKey) {
      throw new Error("Missing PDF preview cache key.");
    }

    state.preview = await helpers.loadPreviewFromCache(state.cacheKey);
    state.documentBytes = helpers.decodeBase64Url(state.preview.base64UrlData);
    state.signatures = await helpers.loadSignatures();
    state.savedPreferences = await helpers.loadPreferences();
    state.currentSettings = { ...state.savedPreferences };
    if (state.signatures.length > 0) {
      state.activeSignatureId = state.signatures[0].id;
    }
    signaturePad.setColor(getSignatureColorValue(state.currentSettings.signatureColor));
    ui.fileName.textContent = state.preview.filename || "Downloaded PDF";
    document.title = `${state.preview.filename || "Downloaded PDF"} - EZSign Signing Workspace`;
    renderSettingsState();
    renderSignatureLibrary();
    renderPlacementSummary();
    renderTypedSignaturePreview();
    await renderPdfDocument();
  }

  function renderSignatureLibrary() {
    ui.storedSignatureMeta.textContent = `${state.signatures.length} signature${state.signatures.length === 1 ? "" : "s"} stored`;
    ui.signaturePrompt.hidden = state.signatures.length > 0;

    if (state.signatures.length === 0) {
      ui.signatureLibrary.className = "signature-library empty-state";
      ui.signatureLibrary.textContent =
        "No signatures stored yet. Add one to start placing signatures on the PDF.";
      return;
    }

    if (!state.signatures.find((signature) => signature.id === state.activeSignatureId)) {
      state.activeSignatureId = state.signatures[0].id;
    }

    ui.signatureLibrary.className = "signature-library";
    ui.signatureLibrary.replaceChildren(...state.signatures.map(createSignatureCard));
  }

  function createSignatureCard(signature) {
    const card = document.createElement("article");
    card.className = `signature-card${state.activeSignatureId === signature.id ? " is-armed" : ""}`;

    const header = document.createElement("div");
    header.className = "signature-card-header";
    const copy = document.createElement("div");
    const title = document.createElement("h3");
    title.textContent = signature.name;
    const subtitle = document.createElement("p");
    subtitle.textContent = "Drag onto the document or click anywhere to sign.";
    copy.append(title, subtitle);

    const deleteButton = document.createElement("button");
    deleteButton.className = "ghost";
    deleteButton.type = "button";
    deleteButton.dataset.deleteSignatureId = signature.id;
    deleteButton.textContent = "Delete";
    header.append(copy, deleteButton);

    const swatch = document.createElement("button");
    swatch.className = "signature-swatch";
    swatch.type = "button";
    swatch.dataset.signatureDrag = "true";
    swatch.dataset.signatureId = signature.id;
    const image = document.createElement("img");
    image.alt = `${signature.name} preview`;
    image.src = signature.dataUrl;
    swatch.append(image);

    const actions = document.createElement("div");
    actions.className = "signature-card-actions";
    const dateButton = document.createElement("button");
    dateButton.className = "secondary";
    dateButton.type = "button";
    dateButton.dataset.addDateSignatureId = signature.id;
    dateButton.textContent = "Add Date";
    const placeButton = document.createElement("button");
    placeButton.className = "secondary";
    placeButton.type = "button";
    placeButton.dataset.armSignatureId = signature.id;
    placeButton.textContent = state.activeSignatureId === signature.id ? "Selected" : "Select";
    if (state.activeSignatureId === signature.id) {
      placeButton.disabled = true;
    }
    actions.append(dateButton, placeButton);

    card.append(header, swatch, actions);
    return card;
  }

  async function saveSignature() {
    const baseName = ui.signatureNameInput.value.trim() || defaultSignatureName();
    const uniqueName = makeUniqueSignatureName(baseName);
    const signature =
      state.signatureInputMode === "typed" ? buildTypedSignatureAsset() : buildDrawnSignatureAsset();
    if (!signature) {
      ui.signatureModalHelp.textContent =
        state.signatureInputMode === "typed"
          ? "Enter signature text before saving it."
          : "Draw the signature before saving it.";
      return;
    }

    const nextSignature = {
      id: crypto.randomUUID(),
      name: uniqueName,
      variant: state.signatureInputMode,
      dataUrl: signature.dataUrl,
      width: signature.width,
      height: signature.height,
      color: state.currentSettings.signatureColor,
      typedText: state.signatureInputMode === "typed" ? ui.typedSignatureTextInput.value.trim() : "",
      fontFamily: state.signatureInputMode === "typed" ? state.selectedTypedFont : "",
      createdAt: new Date().toISOString()
    };

    state.signatures = [nextSignature, ...state.signatures];
    await helpers.saveSignatures(state.signatures);
    state.activeSignatureId = nextSignature.id;
    state.placementMode = "signature";
    renderSignatureLibrary();
    closeSignatureModal();
    setStatus(`Saved ${nextSignature.name}. Drag it onto the PDF or click a page to place it.`);
  }

  function openSignatureModal(force) {
    hidePlacementTooltip();
    ui.signatureModal.hidden = false;
    ui.signatureNameInput.value = defaultSignatureName();
    ui.typedSignatureTextInput.value = "";
    state.signatureInputMode = "drawn";
    state.selectedTypedFont = TYPED_FONT_OPTIONS[0];
    renderTypedFontSelection();
    setSignatureInputMode("drawn");
    signaturePad.setColor(getSignatureColorValue(state.currentSettings.signatureColor));
    renderCaptureColorSelection();
    ui.signatureModalHelp.textContent = force
      ? "No saved signatures were found, so add one now to start signing this PDF."
      : "Sign with your mouse, trackpad, stylus, or typed text. We will store this inside the extension.";
    signaturePad.clear();
    renderTypedSignaturePreview();
    ui.signatureNameInput.focus();
  }

  function closeSignatureModal() {
    ui.signatureModal.hidden = true;
    hidePlacementTooltip();
  }

  function defaultSignatureName() {
    return state.signatures.length === 0 ? "Primary Signature" : `Signature ${state.signatures.length + 1}`;
  }

  function makeUniqueSignatureName(baseName) {
    const trimmedName = baseName.trim();
    const existingNames = new Set(state.signatures.map((signature) => signature.name.toLowerCase()));

    if (!existingNames.has(trimmedName.toLowerCase())) {
      return trimmedName;
    }

    let index = 2;
    while (existingNames.has(`${trimmedName} (${index})`.toLowerCase())) {
      index += 1;
    }

    return `${trimmedName} (${index})`;
  }

  function handleLibraryClick(event) {
    const deleteButton = event.target.closest("[data-delete-signature-id]");
    if (deleteButton) {
      void deleteSignature(deleteButton.dataset.deleteSignatureId);
      return;
    }

    const addDateButton = event.target.closest("[data-add-date-signature-id]");
    if (addDateButton) {
      state.activeSignatureId = addDateButton.dataset.addDateSignatureId;
      state.placementMode = "date";
      renderSignatureLibrary();
      setStatus("Date mode is ready. Click anywhere in the PDF to add today's date.");
      return;
    }

    const armButton = event.target.closest("[data-arm-signature-id]");
    const signatureId = armButton?.dataset.armSignatureId;
    if (!signatureId) {
      return;
    }

    state.activeSignatureId = signatureId;
    state.placementMode = "signature";
    renderSignatureLibrary();
    setStatus("Signature selected for placement.");
  }

  function handleSignaturePointerDown(event) {
    const swatch = event.target.closest("[data-signature-drag]");
    if (!swatch || event.button !== 0) {
      return;
    }

    event.preventDefault();
    state.activeSignatureId = swatch.dataset.signatureId;
    state.placementMode = "signature";
    renderSignatureLibrary();
    beginPointerSession({
      type: "library",
      pointerId: event.pointerId,
      signatureId: swatch.dataset.signatureId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      dragging: false
    });
  }

  async function deleteSignature(signatureId) {
    const signature = getSignature(signatureId);
    if (!signature || !window.confirm(`Delete "${signature.name}" from EZSign?`)) {
      return;
    }

    state.signatures = state.signatures.filter((item) => item.id !== signatureId);
    state.placements = state.placements.filter((placement) => placement.signatureId !== signatureId);
    if (state.activeSignatureId === signatureId) {
      state.activeSignatureId = state.signatures[0]?.id || null;
    }
    if (!state.placements.find((placement) => placement.id === state.selectedPlacementId)) {
      state.selectedPlacementId = null;
    }

    state.hasUnsavedChanges = state.placements.length > 0;
    await helpers.saveSignatures(state.signatures);
    renderSignatureLibrary();
    renderAllPlacements();
    renderPlacementSummary();
    updateToolbar();
    setStatus(`Removed ${signature.name}.`);
  }

  function handlePagePointerDown(event) {
    if (event.button !== 0) {
      return;
    }

    if (
      event.target.closest("[data-remove-placement-id]") ||
      event.target.closest("[data-edit-date-placement-id]") ||
      event.target.closest("[data-edit-signature-placement-id]")
    ) {
      return;
    }

    const resizeHandle = event.target.closest("[data-resize-placement-id]");
    if (resizeHandle) {
      const placement = getPlacement(resizeHandle.dataset.resizePlacementId);
      if (!placement) {
        return;
      }

      event.preventDefault();
      state.selectedPlacementId = placement.id;
      renderAllPlacements();
      beginPointerSession({
        type: "resize",
        pointerId: event.pointerId,
        placementId: placement.id,
        pageIndex: placement.pageIndex,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startWidth: placement.width,
        startHeight: placement.height,
        startFontSize: placement.fontSize || null,
        aspectRatio: placement.width / placement.height,
        dragging: false
      });
      return;
    }

    const placementEl = event.target.closest("[data-placement-id]");
    if (!placementEl) {
      return;
    }

    const placement = getPlacement(placementEl.dataset.placementId);
    const pageView = placement ? state.pageElements.get(placement.pageIndex) : null;
    if (!placement || !pageView) {
      return;
    }

    event.preventDefault();
    state.selectedPlacementId = placement.id;
    renderAllPlacements();
    const rect = pageView.stage.getBoundingClientRect();
    beginPointerSession({
      type: "move",
      pointerId: event.pointerId,
      placementId: placement.id,
      pageIndex: placement.pageIndex,
      startClientX: event.clientX,
      startClientY: event.clientY,
      offsetX: event.clientX - rect.left - placement.x,
      offsetY: event.clientY - rect.top - placement.y,
      dragging: false
    });
  }

  async function renderPdfDocument() {
    state.renderPass += 1;
    const renderPass = state.renderPass;
    state.isRendering = true;
    updateToolbar();
    ui.errorState.hidden = true;
    ui.errorState.textContent = "";
    ui.documentHint.hidden = false;
    ui.documentHint.textContent = "Rendering your PDF. This usually takes a moment.";
    ui.pagesContainer.replaceChildren();
    state.pageElements.clear();
    state.pageLayouts = [];
    state.pageTextAnchors = [];

    const pdfDocument = await pdfjsLib.getDocument({ data: state.documentBytes.slice() }).promise;
    const targetWidth = Math.max(MIN_RENDER_WIDTH, Math.min(MAX_RENDER_WIDTH, (ui.pagesContainer.clientWidth || window.innerWidth) - 40));
    const fragment = document.createDocumentFragment();

    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
      if (renderPass !== state.renderPass) {
        return;
      }

      const page = await pdfDocument.getPage(pageNumber);
      const baseViewport = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.max(0.7, Math.min(1.5, targetWidth / baseViewport.width)) });
      const pageView = buildPageView(pageNumber, viewport);
      state.pageLayouts[pageNumber - 1] = { width: viewport.width, height: viewport.height };
      state.pageTextAnchors[pageNumber - 1] = await extractTextAnchors(page, viewport);
      state.pageElements.set(pageNumber - 1, pageView);
      fragment.append(pageView.card);
    }

    ui.pagesContainer.append(fragment);

    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
      if (renderPass !== state.renderPass) {
        return;
      }

      const page = await pdfDocument.getPage(pageNumber);
      const pageView = state.pageElements.get(pageNumber - 1);
      await renderPage(page, pageView.canvas, pageView.viewport);
      renderPlacementsForPage(pageNumber - 1);
    }

    ui.documentHint.hidden = true;
    state.isRendering = false;
    updateToolbar();
  }

  function buildPageView(pageNumber, viewport) {
    const card = document.createElement("article");
    card.className = "page-card";
    const label = document.createElement("div");
    label.className = "page-label";
    label.textContent = `Page ${pageNumber}`;
    const stage = document.createElement("div");
    stage.className = "page-stage";
    stage.dataset.pageIndex = String(pageNumber - 1);
    stage.dataset.pageStage = "true";
    stage.style.width = `${viewport.width}px`;
    stage.style.height = `${viewport.height}px`;
    const canvas = document.createElement("canvas");
    canvas.className = "page-canvas";
    const overlay = document.createElement("div");
    overlay.className = "page-overlay";
    stage.append(canvas, overlay);
    card.append(label, stage);
    return { card, stage, canvas, overlay, viewport };
  }

  async function renderPage(page, canvas, viewport) {
    const outputScale = window.devicePixelRatio || 1;
    canvas.width = Math.floor(viewport.width * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    await page.render({
      canvasContext: canvas.getContext("2d"),
      transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null,
      viewport
    }).promise;
  }

  async function extractTextAnchors(page, viewport) {
    const textContent = await page.getTextContent();
    return textContent.items
      .filter((item) => typeof item.str === "string" && item.str.trim())
      .map((item) => {
        const transform = pdfjsLib.Util.transform(viewport.transform, item.transform);
        const fontSize = clamp(
          Math.hypot(transform[2], transform[3]) || Math.abs(transform[3]) || item.height || DEFAULT_DATE_FONT_SIZE,
          MIN_DATE_FONT_SIZE,
          MAX_DATE_FONT_SIZE
        );
        return {
          x: transform[4],
          y: transform[5],
          fontSize
        };
      });
  }

  function handlePagesClick(event) {
    if (performance.now() < state.ignoreClickUntil) {
      return;
    }

    const signatureEditButton = event.target.closest("[data-edit-signature-placement-id]");
    if (signatureEditButton) {
      openSignatureEditorModal(signatureEditButton.dataset.editSignaturePlacementId);
      return;
    }

    const editButton = event.target.closest("[data-edit-date-placement-id]");
    if (editButton) {
      openDateEditorModal(editButton.dataset.editDatePlacementId);
      return;
    }

    const removeButton = event.target.closest("[data-remove-placement-id]");
    if (removeButton) {
      removePlacement(removeButton.dataset.removePlacementId);
      return;
    }

    const placementEl = event.target.closest("[data-placement-id]");
    if (placementEl) {
      state.selectedPlacementId = placementEl.dataset.placementId;
      renderAllPlacements();
      return;
    }

    const stage = event.target.closest("[data-page-stage]");
    if (!stage) {
      return;
    }

    if (!state.activeSignatureId) {
      state.selectedPlacementId = null;
      renderAllPlacements();
      return;
    }

    if (state.placementMode === "date") {
      placeDate(stage, event.clientX, event.clientY, state.activeSignatureId);
      state.placementMode = "signature";
      renderSignatureLibrary();
      return;
    }

    placeSignature(stage, event.clientX, event.clientY, state.activeSignatureId);
  }

  function placeSignature(stage, clientX, clientY, signatureId) {
    const signature = getSignature(signatureId);
    const pageIndex = Number(stage.dataset.pageIndex);
    const layout = state.pageLayouts[pageIndex];
    if (!signature || !layout) {
      return;
    }

    const rect = stage.getBoundingClientRect();
    const width = Math.min(DEFAULT_SIGNATURE_WIDTH, layout.width * MAX_SIGNATURE_WIDTH_RATIO);
    const height = width * ((signature.height / signature.width) || 0.35);
    state.placements = [
      ...state.placements,
      {
        id: crypto.randomUUID(),
        pageIndex,
        signatureId,
        dataUrl: signature.dataUrl,
        x: clamp(clientX - rect.left - width / 2, 0, layout.width - width),
        y: clamp(clientY - rect.top - height / 2, 0, layout.height - height),
        width,
        height
      }
    ];
    state.selectedPlacementId = state.placements.at(-1).id;
    state.hasUnsavedChanges = true;
    renderPlacementsForPage(pageIndex);
    renderPlacementSummary();
    updateToolbar();
    setStatus(`Placed ${signature.name} on page ${pageIndex + 1}.`);
  }

  function placeDate(stage, clientX, clientY, signatureId) {
    const pageIndex = Number(stage.dataset.pageIndex);
    const layout = state.pageLayouts[pageIndex];
    if (!layout) {
      return;
    }

    const dateValue = getTodayIsoValue();
    const formatId = state.currentSettings.dateFormat;
    const rect = stage.getBoundingClientRect();
    const pointX = clientX - rect.left;
    const pointY = clientY - rect.top;
    const fontSize = getNearbyDateFontSize(pageIndex, pointX, pointY);
    const dimensions = measureDatePlacement(dateValue, formatId, fontSize);
    const placement = {
      id: crypto.randomUUID(),
      type: "date",
      pageIndex,
      signatureId,
      colorKey: state.currentSettings.dateColor,
      dateValue,
      formatId,
      fontSize,
      text: formatDateValue(dateValue, formatId),
      x: clamp(pointX - dimensions.width / 2, 0, layout.width - dimensions.width),
      y: clamp(pointY - dimensions.height / 2, 0, layout.height - dimensions.height),
      width: dimensions.width,
      height: dimensions.height
    };

    state.placements = [...state.placements, placement];
    state.selectedPlacementId = placement.id;
    state.hasUnsavedChanges = true;
    renderPlacementsForPage(pageIndex);
    renderPlacementSummary();
    updateToolbar();
    setStatus("Added today's date. Signature placement is ready again.");
  }

  function renderPlacementsForPage(pageIndex) {
    const pageView = state.pageElements.get(pageIndex);
    if (!pageView) {
      return;
    }

    pageView.overlay.replaceChildren(
      ...state.placements
        .filter((placement) => placement.pageIndex === pageIndex)
        .map((placement) => createPlacementNode(placement))
    );
  }

  function createPlacementNode(placement) {
    const node = document.createElement("div");
    node.className = `placed-signature${state.selectedPlacementId === placement.id ? " is-selected" : ""}`;
    node.dataset.placementId = placement.id;
    node.dataset.pageIndex = String(placement.pageIndex);
    node.style.left = `${placement.x}px`;
    node.style.top = `${placement.y}px`;
    node.style.width = `${placement.width}px`;
    node.style.height = `${placement.height}px`;

    if (placement.type === "date") {
      node.classList.add("placed-date");
      const editButton = document.createElement("button");
      editButton.className = "placement-edit";
      editButton.type = "button";
      editButton.dataset.editDatePlacementId = placement.id;
      editButton.textContent = "Edit";
      const text = document.createElement("div");
      text.className = "placed-date-text";
      text.textContent = placement.text;
      text.style.color = getSignatureColorValue(getPlacementDateColor(placement));
      text.style.fontSize = `${placement.fontSize}px`;
      node.append(editButton, text);
    } else {
      const signature = getSignature(placement.signatureId);
      const editButton = document.createElement("button");
      editButton.className = "placement-edit";
      editButton.type = "button";
      editButton.dataset.editSignaturePlacementId = placement.id;
      editButton.textContent = "Edit";
      const image = document.createElement("img");
      image.src = placement.dataUrl || signature.dataUrl;
      image.alt = `${signature.name} placement`;
      node.append(editButton, image);
    }

    const removeButton = document.createElement("button");
    removeButton.className = "placement-remove";
    removeButton.type = "button";
    removeButton.dataset.removePlacementId = placement.id;
    removeButton.textContent = "Remove";
    const resizeHandle = document.createElement("button");
    resizeHandle.className = "placement-resize-handle";
    resizeHandle.type = "button";
    resizeHandle.dataset.resizePlacementId = placement.id;
    resizeHandle.setAttribute("aria-label", "Resize placed signature");

    node.append(removeButton, resizeHandle);
    return node;
  }

  function renderAllPlacements() {
    for (const pageIndex of state.pageElements.keys()) {
      renderPlacementsForPage(pageIndex);
    }
  }

  function removePlacement(placementId) {
    const placement = state.placements.find((item) => item.id === placementId);
    if (!placement) {
      return;
    }

    state.placements = state.placements.filter((item) => item.id !== placementId);
    if (state.selectedPlacementId === placementId) {
      state.selectedPlacementId = null;
    }
    state.hasUnsavedChanges = state.placements.length > 0;
    renderPlacementsForPage(placement.pageIndex);
    renderPlacementSummary();
    updateToolbar();
    setStatus(`Removed a placement from page ${placement.pageIndex + 1}.`);
  }

  function clearPlacements() {
    if (state.placements.length === 0) {
      return;
    }

    state.placements = [];
    state.selectedPlacementId = null;
    state.hasUnsavedChanges = false;
    renderAllPlacements();
    renderPlacementSummary();
    updateToolbar();
    setStatus("Cleared all un-saved placements.");
  }

  function renderPlacementSummary() {
    const today = getTodayIsoValue();
    const signedCount = state.placements.filter((placement) => placement.type !== "date").length;
    const datedCount = state.placements.filter((placement) => placement.type === "date").length;
    const hasCustomDate = state.placements.some(
      (placement) => placement.type === "date" && placement.dateValue !== today
    );

    ui.signStatusChip.textContent = signedCount === 0 ? "Not yet signed" : `Signed ${formatOccurrenceCount(signedCount)}`;
    ui.dateStatusChip.textContent = datedCount === 0 ? "Not yet dated" : `Dated ${formatOccurrenceCount(datedCount)}`;
    ui.customDateChip.hidden = datedCount === 0 || !hasCustomDate;
  }

  function beginPointerSession(session) {
    cancelPointerSession();
    state.pointerSession = session;
  }

  function handleGlobalPointerMove(event) {
    const session = state.pointerSession;
    if (!session) {
      updatePlacementTooltip(event);
      return;
    }

    hidePlacementTooltip();

    if (event.pointerId !== session.pointerId) {
      return;
    }

    if (!session.dragging) {
      const distance = Math.hypot(event.clientX - session.startClientX, event.clientY - session.startClientY);
      if (distance < POINTER_DRAG_THRESHOLD) {
        return;
      }

      session.dragging = true;

      if (session.type === "library") {
        state.dragGhost = createDragGhost(session.signatureId);
      }
    }

    if (session.type === "library") {
      updateDragGhostPosition(event.clientX, event.clientY);
      setHighlightedStage(findStageAtPoint(event.clientX, event.clientY));
      autoScrollPagesShell(event.clientY);
      return;
    }

    if (session.type === "move") {
      autoScrollPagesShell(event.clientY);
      updatePlacementPosition(session, event.clientX, event.clientY);
      return;
    }

    if (session.type === "resize") {
      updatePlacementSize(session, event.clientX, event.clientY);
    }
  }

  function handleGlobalPointerUp(event) {
    const session = state.pointerSession;
    if (!session || event.pointerId !== session.pointerId) {
      return;
    }

    if (session.type === "library") {
      if (session.dragging) {
        const stage = findStageAtPoint(event.clientX, event.clientY);
        if (stage) {
          placeSignature(stage, event.clientX, event.clientY, session.signatureId);
        } else {
          setStatus("Drag a signature over the PDF page to place it.");
        }
        consumeNextClick();
      } else {
        state.activeSignatureId = session.signatureId;
        renderSignatureLibrary();
        setStatus("Signature selected for placement.");
      }

      cancelPointerSession();
      return;
    }

    if (session.dragging) {
      const placement = getPlacement(session.placementId);
      if (placement) {
        setStatus(
          session.type === "move"
            ? `Moved a signature on page ${placement.pageIndex + 1}.`
            : `Resized a signature on page ${placement.pageIndex + 1}.`
        );
      }
      consumeNextClick();
    }

    cancelPointerSession();
  }

  function cancelPointerSession() {
    state.pointerSession = null;
    if (state.dragGhost) {
      state.dragGhost.remove();
      state.dragGhost = null;
    }
    setHighlightedStage(null);
    hidePlacementTooltip();
  }

  function updatePlacementPosition(session, clientX, clientY) {
    const placement = getPlacement(session.placementId);
    const targetStage = findStageAtPoint(clientX, clientY);
    const targetPageIndex = targetStage ? Number(targetStage.dataset.pageIndex) : placement?.pageIndex;
    const pageView = typeof targetPageIndex === "number" ? state.pageElements.get(targetPageIndex) : null;
    const layout = typeof targetPageIndex === "number" ? state.pageLayouts[targetPageIndex] : null;
    if (!placement || !pageView || !layout) {
      return;
    }

    const rect = pageView.stage.getBoundingClientRect();
    const nextX = clamp(clientX - rect.left - session.offsetX, 0, layout.width - placement.width);
    const nextY = clamp(clientY - rect.top - session.offsetY, 0, layout.height - placement.height);
    const previousPageIndex = placement.pageIndex;
    updatePlacement(placement.id, { pageIndex: targetPageIndex, x: nextX, y: nextY });
    state.hasUnsavedChanges = true;
    if (previousPageIndex !== targetPageIndex) {
      renderPlacementsForPage(previousPageIndex);
    }
    renderPlacementsForPage(targetPageIndex);
    setHighlightedStage(targetStage);
  }

  function updatePlacementSize(session, clientX, clientY) {
    const placement = getPlacement(session.placementId);
    const layout = placement ? state.pageLayouts[placement.pageIndex] : null;
    if (!placement || !layout) {
      return;
    }

    const deltaX = clientX - session.startClientX;
    const deltaY = (clientY - session.startClientY) * session.aspectRatio;
    const dominantDelta = Math.abs(deltaX) >= Math.abs(deltaY) ? deltaX : deltaY;
    const maxWidth = layout.width - placement.x;
    let nextWidth = clamp(session.startWidth + dominantDelta, MIN_SIGNATURE_WIDTH, maxWidth);
    let nextHeight = nextWidth / session.aspectRatio;

    if (nextHeight > layout.height - placement.y) {
      nextHeight = layout.height - placement.y;
      nextWidth = nextHeight * session.aspectRatio;
    }

    if (nextHeight < MIN_SIGNATURE_HEIGHT) {
      nextHeight = MIN_SIGNATURE_HEIGHT;
      nextWidth = nextHeight * session.aspectRatio;
    }

    const updates =
      placement.type === "date" && session.startFontSize
        ? {
            width: nextWidth,
            height: nextHeight,
            fontSize: Math.max(14, session.startFontSize * (nextWidth / session.startWidth))
          }
        : {
            width: nextWidth,
            height: nextHeight
          };

    updatePlacement(placement.id, updates);
    state.hasUnsavedChanges = true;
    renderPlacementsForPage(placement.pageIndex);
  }

  function updatePlacement(placementId, updates) {
    state.placements = state.placements.map((placement) =>
      placement.id === placementId
        ? {
            ...placement,
            ...updates
          }
        : placement
    );
  }

  function createDragGhost(signatureId) {
    const signature = getSignature(signatureId);
    if (!signature) {
      return null;
    }

    const ghost = document.createElement("div");
    ghost.className = "signature-drag-ghost";
    const image = document.createElement("img");
    image.src = signature.dataUrl;
    image.alt = "";
    const label = document.createElement("span");
    label.textContent = signature.name;
    ghost.append(image, label);
    document.body.append(ghost);
    return ghost;
  }

  function updateDragGhostPosition(clientX, clientY) {
    if (!state.dragGhost) {
      return;
    }

    state.dragGhost.style.left = `${clientX + 14}px`;
    state.dragGhost.style.top = `${clientY + 14}px`;
  }

  function updatePlacementTooltip(event) {
    if (
      !state.activeSignatureId ||
      !ui.signatureModal.hidden ||
      !ui.settingsModal.hidden ||
      !ui.dateEditorModal.hidden ||
      !ui.signatureEditorModal.hidden
    ) {
      hidePlacementTooltip();
      return;
    }

    if (
      event.target.closest("[data-placement-id]") ||
      event.target.closest("[data-remove-placement-id]") ||
      event.target.closest("[data-resize-placement-id]")
    ) {
      hidePlacementTooltip();
      return;
    }

    const stage = event.target.closest("[data-page-stage]");
    if (!stage) {
      hidePlacementTooltip();
      return;
    }

    showPlacementTooltip(
      event.clientX,
      event.clientY,
      state.placementMode === "date" ? "Click to add today's date" : "Click to place signature"
    );
  }

  function showPlacementTooltip(clientX, clientY, text) {
    ui.placementTooltip.hidden = false;
    ui.placementTooltip.textContent = text;
    ui.placementTooltip.style.left = `${clientX + 16}px`;
    ui.placementTooltip.style.top = `${clientY + 16}px`;
  }

  function hidePlacementTooltip() {
    ui.placementTooltip.hidden = true;
  }

  function findStageAtPoint(clientX, clientY) {
    return document.elementFromPoint(clientX, clientY)?.closest("[data-page-stage]") || null;
  }

  function setHighlightedStage(stage) {
    if (state.highlightedStage === stage) {
      return;
    }

    state.highlightedStage?.classList.remove("is-drop-target");
    state.highlightedStage = stage;
    state.highlightedStage?.classList.add("is-drop-target");
  }

  function getPlacement(placementId) {
    return state.placements.find((placement) => placement.id === placementId) || null;
  }

  function consumeNextClick() {
    state.ignoreClickUntil = performance.now() + 250;
  }

  function autoScrollPagesShell(clientY) {
    const rect = ui.pagesShell.getBoundingClientRect();
    const threshold = 72;
    const maxSpeed = 28;

    if (clientY < rect.top + threshold) {
      const delta = Math.ceil(((rect.top + threshold - clientY) / threshold) * maxSpeed);
      ui.pagesShell.scrollTop -= delta;
      return;
    }

    if (clientY > rect.bottom - threshold) {
      const delta = Math.ceil(((clientY - (rect.bottom - threshold)) / threshold) * maxSpeed);
      ui.pagesShell.scrollTop += delta;
    }
  }

  function setSignatureInputMode(mode) {
    state.signatureInputMode = mode;
    const typedMode = mode === "typed";
    ui.drawSignatureModeButton.classList.toggle("is-active", !typedMode);
    ui.typedSignatureModeButton.classList.toggle("is-active", typedMode);
    ui.drawnSignatureFields.hidden = typedMode;
    ui.typedSignatureFields.hidden = !typedMode;
    ui.clearSignaturePadButton.hidden = typedMode;
    signaturePad.setColor(getSignatureColorValue(state.currentSettings.signatureColor));
    renderCaptureColorSelection();
    renderTypedSignaturePreview();
  }

  function handleTypedFontSelection(event) {
    const button = event.target.closest("[data-font-option]");
    if (!button) {
      return;
    }

    state.selectedTypedFont = button.dataset.fontOption;
    renderTypedFontSelection();
    renderTypedSignaturePreview();
  }

  function renderTypedFontSelection() {
    for (const button of ui.typedSignatureFontGrid.querySelectorAll("[data-font-option]")) {
      button.classList.toggle("is-active", button.dataset.fontOption === state.selectedTypedFont);
    }
  }

  function handleCaptureColorSelection(event) {
    const button = event.target.closest("[data-capture-signature-color]");
    if (!button) {
      return;
    }

    state.currentSettings.signatureColor = button.dataset.captureSignatureColor;
    if (state.signatureInputMode === "drawn") {
      signaturePad.recolor(getSignatureColorValue(state.currentSettings.signatureColor));
    } else {
      signaturePad.setColor(getSignatureColorValue(state.currentSettings.signatureColor));
    }
    renderCaptureColorSelection();
    renderSettingsState();
    renderTypedSignaturePreview();
  }

  function renderCaptureColorSelection() {
    for (const button of ui.signatureCaptureColorGrid.querySelectorAll("[data-capture-signature-color]")) {
      button.classList.toggle(
        "is-active",
        button.dataset.captureSignatureColor === state.currentSettings.signatureColor
      );
    }
  }

  function renderTypedSignaturePreview() {
    ui.typedSignaturePreview.replaceChildren();
    ui.typedSignaturePreview.style.fontFamily = "";
    ui.typedSignaturePreview.style.color = "";
    ui.typedSignaturePreview.style.fontSize = "";

    if (state.signatureInputMode === "typed") {
      const previewText = ui.typedSignatureTextInput.value.trim() || "Jason Fischell";
      ui.typedSignaturePreview.textContent = previewText;
      ui.typedSignaturePreview.style.fontFamily = state.selectedTypedFont;
      ui.typedSignaturePreview.style.color = getSignatureColorValue(state.currentSettings.signatureColor);
      ui.typedSignaturePreview.style.fontSize = "38px";
      return;
    }

    const previewSignature = signaturePad?.exportSignature?.();
    if (!previewSignature) {
      const placeholder = document.createElement("span");
      placeholder.className = "preview-placeholder";
      placeholder.textContent = "Draw on the pad to preview the saved signature.";
      ui.typedSignaturePreview.append(placeholder);
      return;
    }

    const image = document.createElement("img");
    image.src = previewSignature.dataUrl;
    image.alt = "Hand-drawn signature preview";
    ui.typedSignaturePreview.append(image);
  }

  function buildTypedSignatureAsset() {
    return buildTypedSignatureAssetFromConfig({
      typedText: ui.typedSignatureTextInput.value.trim(),
      fontFamily: state.selectedTypedFont,
      colorKey: state.currentSettings.signatureColor
    });
  }

  function buildDrawnSignatureAsset() {
    return signaturePad.exportSignature();
  }

  function buildTypedSignatureAssetFromConfig({ typedText, fontFamily, colorKey }) {
    if (!typedText) {
      return null;
    }

    const fontSize = 56;
    measurementContext.font = `${fontSize}px ${fontFamily}`;
    const textWidth = Math.ceil(measurementContext.measureText(typedText).width);
    const width = Math.max(260, textWidth + 36);
    const height = fontSize + 40;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    context.font = `${fontSize}px ${fontFamily}`;
    context.fillStyle = getSignatureColorValue(colorKey);
    context.textBaseline = "middle";
    context.fillText(typedText, 18, height / 2 + 2);

    return {
      dataUrl: canvas.toDataURL("image/png"),
      width,
      height
    };
  }

  function handleSettingsClick(event) {
    const colorButton = event.target.closest("[data-signature-color]");
    if (colorButton) {
      state.currentSettings.signatureColor = colorButton.dataset.signatureColor;
      signaturePad.setColor(getSignatureColorValue(state.currentSettings.signatureColor));
      renderSettingsState();
      renderCaptureColorSelection();
      renderTypedSignaturePreview();
      return;
    }

    const dateColorButton = event.target.closest("[data-date-color]");
    if (dateColorButton) {
      state.currentSettings.dateColor = dateColorButton.dataset.dateColor;
      renderSettingsState();
      return;
    }

    const formatButton = event.target.closest("[data-date-format]");
    if (!formatButton) {
      return;
    }

    state.currentSettings.dateFormat = formatButton.dataset.dateFormat;
    renderSettingsState();
  }

  async function saveDefaultSetting(key) {
    state.savedPreferences =
      key === "dateSettings"
        ? {
            ...state.savedPreferences,
            dateFormat: state.currentSettings.dateFormat,
            dateColor: state.currentSettings.dateColor
          }
        : {
            ...state.savedPreferences,
            [key]: state.currentSettings[key]
          };
    await helpers.savePreferences(state.savedPreferences);
    setStatus(
      key === "signatureColor" ? "Saved the default signature color." : "Saved the default date settings."
    );
  }

  function renderSettingsState() {
    updateDateFormatOptionLabels(ui.dateFormatGrid, "data-date-format", getTodayIsoValue());

    for (const button of ui.signatureColorGrid.querySelectorAll("[data-signature-color]")) {
      button.classList.toggle("is-active", button.dataset.signatureColor === state.currentSettings.signatureColor);
    }

    for (const button of ui.dateFormatGrid.querySelectorAll("[data-date-format]")) {
      button.classList.toggle("is-active", button.dataset.dateFormat === state.currentSettings.dateFormat);
    }

    for (const button of ui.dateColorGrid.querySelectorAll("[data-date-color]")) {
      button.classList.toggle("is-active", button.dataset.dateColor === state.currentSettings.dateColor);
    }
  }

  function openSettingsModal() {
    hidePlacementTooltip();
    state.settingsSnapshot = { ...state.currentSettings };
    renderSettingsState();
    ui.settingsModal.hidden = false;
  }

  function closeSettingsModal() {
    if (state.settingsSnapshot) {
      state.currentSettings = { ...state.settingsSnapshot };
      signaturePad.setColor(getSignatureColorValue(state.currentSettings.signatureColor));
      renderSettingsState();
      renderCaptureColorSelection();
      renderTypedSignaturePreview();
      state.settingsSnapshot = null;
    }
    ui.settingsModal.hidden = true;
  }

  async function saveSettingsChanges() {
    const previousColor = state.settingsSnapshot?.signatureColor ?? state.currentSettings.signatureColor;
    freezePlacedSignatureSnapshots();

    if (previousColor !== state.currentSettings.signatureColor) {
      state.signatures = await Promise.all(
        state.signatures.map(async (signature) => {
          const asset = await buildSignatureAssetForColor(signature, state.currentSettings.signatureColor);
          return {
            ...signature,
            color: state.currentSettings.signatureColor,
            dataUrl: asset.dataUrl,
            width: asset.width,
            height: asset.height
          };
        })
      );
      await helpers.saveSignatures(state.signatures);
      renderSignatureLibrary();
      renderAllPlacements();
    }

    signaturePad.setColor(getSignatureColorValue(state.currentSettings.signatureColor));
    renderCaptureColorSelection();
    renderTypedSignaturePreview();
    state.settingsSnapshot = null;
    ui.settingsModal.hidden = true;
    setStatus("Saved workspace settings.");
  }

  function openDateEditorModal(placementId) {
    const placement = getPlacement(placementId);
    if (!placement || placement.type !== "date") {
      return;
    }

    hidePlacementTooltip();
    state.dateEditorPlacementId = placementId;
    ui.dateEditorInput.value = placement.dateValue;
    renderDateEditorFormatExamples();
    for (const button of ui.dateEditorFormatGrid.querySelectorAll("[data-date-editor-format]")) {
      button.classList.toggle("is-active", button.dataset.dateEditorFormat === placement.formatId);
    }
    for (const button of ui.dateEditorColorGrid.querySelectorAll("[data-date-editor-color]")) {
      button.classList.toggle("is-active", button.dataset.dateEditorColor === getPlacementDateColor(placement));
    }
    ui.dateEditorModal.hidden = false;
  }

  function closeDateEditorModal() {
    state.dateEditorPlacementId = null;
    ui.dateEditorModal.hidden = true;
  }

  function handleDateEditorFormatSelection(event) {
    const button = event.target.closest("[data-date-editor-format]");
    if (!button) {
      return;
    }

    for (const option of ui.dateEditorFormatGrid.querySelectorAll("[data-date-editor-format]")) {
      option.classList.toggle("is-active", option === button);
    }
  }

  function handleDateEditorColorSelection(event) {
    const button = event.target.closest("[data-date-editor-color]");
    if (!button) {
      return;
    }

    for (const option of ui.dateEditorColorGrid.querySelectorAll("[data-date-editor-color]")) {
      option.classList.toggle("is-active", option === button);
    }
  }

  function renderDateEditorFormatExamples() {
    updateDateFormatOptionLabels(
      ui.dateEditorFormatGrid,
      "data-date-editor-format",
      ui.dateEditorInput.value || getTodayIsoValue()
    );
  }

  function applyDatePlacementChanges() {
    const placement = getPlacement(state.dateEditorPlacementId);
    if (!placement || placement.type !== "date" || !ui.dateEditorInput.value) {
      return;
    }

    const selectedFormatButton = ui.dateEditorFormatGrid.querySelector(".is-active[data-date-editor-format]");
    const selectedColorButton = ui.dateEditorColorGrid.querySelector(".is-active[data-date-editor-color]");
    const formatId = selectedFormatButton?.dataset.dateEditorFormat || placement.formatId;
    const dimensions = measureDatePlacement(ui.dateEditorInput.value, formatId, placement.fontSize);
    const layout = state.pageLayouts[placement.pageIndex];
    updatePlacement(placement.id, {
      dateValue: ui.dateEditorInput.value,
      formatId,
      colorKey: selectedColorButton?.dataset.dateEditorColor || getPlacementDateColor(placement),
      text: formatDateValue(ui.dateEditorInput.value, formatId),
      width: Math.min(dimensions.width, layout.width - placement.x),
      height: Math.min(dimensions.height, layout.height - placement.y)
    });
    state.hasUnsavedChanges = true;
    renderPlacementsForPage(placement.pageIndex);
    closeDateEditorModal();
    setStatus("Updated the placed date.");
  }

  function measureDatePlacement(dateValue, formatId, fontSize) {
    const text = formatDateValue(dateValue, formatId);
    measurementContext.font = `500 ${fontSize}px "Segoe UI", sans-serif`;
    return {
      width: Math.ceil(measurementContext.measureText(text).width) + DATE_TEXT_PADDING_X * 2,
      height: Math.ceil(fontSize * 1.25) + DATE_TEXT_PADDING_Y
    };
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

  function getTodayIsoValue() {
    const today = new Date();
    return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(
      today.getDate()
    ).padStart(2, "0")}`;
  }

  function getNearbyDateFontSize(pageIndex, x, y) {
    const anchors = state.pageTextAnchors[pageIndex] || [];
    if (anchors.length === 0) {
      return DEFAULT_DATE_FONT_SIZE;
    }

    let nearestAnchor = anchors[0];
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const anchor of anchors) {
      const distance = Math.hypot(anchor.x - x, anchor.y - y);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestAnchor = anchor;
      }
    }

    return clamp(
      Math.round((nearestAnchor.fontSize || DEFAULT_DATE_FONT_SIZE) * 0.95),
      MIN_DATE_FONT_SIZE,
      MAX_DATE_FONT_SIZE
    );
  }

  function updateDateFormatOptionLabels(container, attributeName, dateValue) {
    for (const button of container.querySelectorAll(`[${attributeName}]`)) {
      button.textContent = formatDateValue(dateValue, button.getAttribute(attributeName));
    }
  }

  function formatOccurrenceCount(count) {
    if (count === 1) {
      return "once";
    }

    if (count === 2) {
      return "twice";
    }

    return `${count} times`;
  }

  function getSignatureColorValue(colorKey) {
    return COLOR_OPTIONS[colorKey]?.value || COLOR_OPTIONS.black.value;
  }

  function getPlacementDateColor(placement) {
    return placement.colorKey || state.currentSettings.dateColor || "black";
  }

  function getPlacementSignatureColor(placement) {
    const signature = getSignature(placement.signatureId);
    return placement.colorKey || signature?.color || state.currentSettings.signatureColor;
  }

  function freezePlacedSignatureSnapshots() {
    state.placements = state.placements.map((placement) => {
      if (placement.type === "date" || placement.dataUrl) {
        return placement;
      }

      const signature = getSignature(placement.signatureId);
      return signature
        ? {
            ...placement,
            dataUrl: signature.dataUrl
          }
        : placement;
    });
  }

  function openSignatureEditorModal(placementId) {
    const placement = getPlacement(placementId);
    if (!placement || placement.type === "date") {
      return;
    }

    hidePlacementTooltip();
    state.signatureEditorPlacementId = placementId;
    state.signatureEditorDraftColor = getPlacementSignatureColor(placement);
    renderSignatureEditorState();
    ui.signatureEditorModal.hidden = false;
  }

  function closeSignatureEditorModal() {
    state.signatureEditorPlacementId = null;
    state.signatureEditorDraftColor = null;
    ui.signatureEditorActions.hidden = true;
    ui.signatureEditorModal.hidden = true;
  }

  function handleSignatureEditorColorSelection(event) {
    const button = event.target.closest("[data-signature-editor-color]");
    if (!button) {
      return;
    }

    state.signatureEditorDraftColor = button.dataset.signatureEditorColor;
    renderSignatureEditorState();
  }

  function renderSignatureEditorState() {
    const placement = getPlacement(state.signatureEditorPlacementId);
    const currentColor = placement ? getPlacementSignatureColor(placement) : null;

    for (const button of ui.signatureEditorColorGrid.querySelectorAll("[data-signature-editor-color]")) {
      button.classList.toggle("is-active", button.dataset.signatureEditorColor === state.signatureEditorDraftColor);
    }

    ui.signatureEditorActions.hidden = !placement || state.signatureEditorDraftColor === currentColor;
  }

  async function applySignaturePlacementChanges() {
    const placement = getPlacement(state.signatureEditorPlacementId);
    const signature = placement ? getSignature(placement.signatureId) : null;
    if (!placement || !signature) {
      return;
    }

    const baseColor = signature.color || state.currentSettings.signatureColor;
    const nextColor = state.signatureEditorDraftColor || baseColor;
    if (nextColor === getPlacementSignatureColor(placement)) {
      closeSignatureEditorModal();
      return;
    }

    if (nextColor === baseColor) {
      updatePlacement(placement.id, {
        colorKey: null,
        dataUrl: null
      });
    } else {
      const asset = await buildSignatureAssetForColor(signature, nextColor);
      updatePlacement(placement.id, {
        colorKey: nextColor,
        dataUrl: asset.dataUrl
      });
    }

    state.hasUnsavedChanges = true;
    renderPlacementsForPage(placement.pageIndex);
    closeSignatureEditorModal();
    setStatus("Updated the placed signature color.");
  }

  async function buildSignatureAssetForColor(signature, colorKey) {
    if (signature.variant === "typed" && signature.typedText) {
      return buildTypedSignatureAssetFromConfig({
        typedText: signature.typedText,
        fontFamily: signature.fontFamily || TYPED_FONT_OPTIONS[0],
        colorKey
      });
    }

    return {
      dataUrl: await recolorRasterDataUrl(signature.dataUrl, colorKey),
      width: signature.width,
      height: signature.height
    };
  }

  async function recolorRasterDataUrl(dataUrl, colorKey) {
    const image = await loadImageElement(dataUrl);
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth || image.width;
    canvas.height = image.naturalHeight || image.height;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    context.globalCompositeOperation = "source-in";
    context.fillStyle = getSignatureColorValue(colorKey);
    context.fillRect(0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
  }

  function loadImageElement(dataUrl) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Could not recolor the saved signature."));
      image.src = dataUrl;
    });
  }

  function updateToolbar() {
    const disabled = state.placements.length === 0 || state.isRendering;
    ui.clearPlacementsButton.disabled = disabled;
    ui.saveSignedButton.disabled = disabled;
  }

  async function saveSignedCopy() {
    if (state.placements.length === 0) {
      setStatus("Place at least one signature before saving a signed copy.");
      return;
    }

    state.isRendering = true;
    updateToolbar();
    setStatus("Embedding signatures into a signed PDF copy...");

    try {
      const signedBytes = await buildSignedPdfBytes();
      const filename = helpers.buildSignedFilename(state.preview.filename || "signed-document.pdf");
      const blobUrl = URL.createObjectURL(new Blob([signedBytes], { type: "application/pdf" }));
      const downloadId = await chrome.downloads.download({
        url: blobUrl,
        filename: `EZSign/${filename}`,
        saveAs: true
      });
      const downloadItem = await helpers.waitForDownloadTerminalState(downloadId);
      URL.revokeObjectURL(blobUrl);

      if (downloadItem.state !== "complete") {
        state.isRendering = false;
        setStatus(`Save canceled for ${filename}.`);
        updateToolbar();
        return;
      }

      state.preview = {
        ...state.preview,
        filename,
        base64UrlData: helpers.encodeBase64Url(signedBytes),
        lastSignedAt: new Date().toISOString()
      };
      state.documentBytes = signedBytes;
      await helpers.savePreviewToCache(state.cacheKey, state.preview);
      await helpers.saveQueueStatus(state.preview.queueItemId, {
        status: "signed",
        signedAt: new Date().toISOString(),
        previewCacheKey: state.cacheKey,
        signedFilename: filename
      });

      state.placements = [];
      state.selectedPlacementId = null;
      state.hasUnsavedChanges = false;
      ui.fileName.textContent = filename;
      document.title = `${filename} - EZSign Signing Workspace`;
      renderPlacementSummary();
      await renderPdfDocument();
      setStatus(`Saved signed copy as ${filename}.`);
    } catch (error) {
      state.isRendering = false;
      setStatus(`Could not save a signed copy: ${error instanceof Error ? error.message : String(error)}`);
      updateToolbar();
    }
  }

  async function buildSignedPdfBytes() {
    const pdfDocument = await pdfLib.PDFDocument.load(state.documentBytes.slice());
    const pages = pdfDocument.getPages();
    const embeddedSignatures = new Map();
    const helveticaFont = await pdfDocument.embedFont(pdfLib.StandardFonts.Helvetica);

    for (const placement of state.placements) {
      const layout = state.pageLayouts[placement.pageIndex];
      const page = pages[placement.pageIndex];
      if (!layout || !page) {
        continue;
      }

      if (placement.type === "date") {
        const pageSize = page.getSize();
        const size = (placement.fontSize / layout.height) * pageSize.height;
        const { red, green, blue } = hexToRgbComponents(getSignatureColorValue(getPlacementDateColor(placement)));
        page.drawText(placement.text, {
          x: (placement.x / layout.width) * pageSize.width,
          y: pageSize.height - ((placement.y + placement.height - 6) / layout.height) * pageSize.height,
          size,
          font: helveticaFont,
          color: pdfLib.rgb(red / 255, green / 255, blue / 255)
        });
        continue;
      }

      const signature = getSignature(placement.signatureId);
      if (!signature) {
        continue;
      }

      const signatureSource = placement.dataUrl || signature.dataUrl;
      let embedded = embeddedSignatures.get(signatureSource);
      if (!embedded) {
        embedded = await pdfDocument.embedPng(helpers.dataUrlToBytes(signatureSource));
        embeddedSignatures.set(signatureSource, embedded);
      }

      const pageSize = page.getSize();
      page.drawImage(embedded, {
        x: (placement.x / layout.width) * pageSize.width,
        y: pageSize.height - ((placement.y + placement.height) / layout.height) * pageSize.height,
        width: (placement.width / layout.width) * pageSize.width,
        height: (placement.height / layout.height) * pageSize.height
      });
    }

    return pdfDocument.save();
  }

  function getSignature(signatureId) {
    return state.signatures.find((signature) => signature.id === signatureId) || null;
  }

  function setStatus(message) {
    ui.statusText.textContent = message;
  }

  function hexToRgbComponents(hexColor) {
    const normalized = String(hexColor).replace("#", "");
    const value =
      normalized.length === 3
        ? normalized
            .split("")
            .map((char) => char + char)
            .join("")
        : normalized;

    return {
      red: Number.parseInt(value.slice(0, 2), 16),
      green: Number.parseInt(value.slice(2, 4), 16),
      blue: Number.parseInt(value.slice(4, 6), 16)
    };
  }

  function showError(message) {
    hidePlacementTooltip();
    ui.fileName.textContent = "Signing workspace unavailable";
    setStatus(message);
    ui.signaturePrompt.hidden = true;
    ui.documentHint.hidden = true;
    ui.pagesContainer.replaceChildren();
    ui.errorState.hidden = false;
    ui.errorState.textContent = message;
  }
}

function getUi() {
  return {
    addSignatureButton: document.getElementById("addSignatureButton"),
    cancelSettingsButton: document.getElementById("cancelSettingsButton"),
    cancelSignatureButton: document.getElementById("cancelSignatureButton"),
    cancelDateEditorButton: document.getElementById("cancelDateEditorButton"),
    cancelSignatureEditorButton: document.getElementById("cancelSignatureEditorButton"),
    clearPlacementsButton: document.getElementById("clearPlacementsButton"),
    clearSignaturePadButton: document.getElementById("clearSignaturePadButton"),
    closeModalButton: document.getElementById("closeModalButton"),
    closeDateEditorButton: document.getElementById("closeDateEditorButton"),
    closeSettingsButton: document.getElementById("closeSettingsButton"),
    closeSignatureEditorButton: document.getElementById("closeSignatureEditorButton"),
    customDateChip: document.getElementById("customDateChip"),
    dateColorGrid: document.getElementById("dateColorGrid"),
    dateEditorColorGrid: document.getElementById("dateEditorColorGrid"),
    dateEditorFormatGrid: document.getElementById("dateEditorFormatGrid"),
    dateEditorInput: document.getElementById("dateEditorInput"),
    dateEditorModal: document.getElementById("dateEditorModal"),
    dateStatusChip: document.getElementById("dateStatusChip"),
    dateFormatGrid: document.getElementById("dateFormatGrid"),
    documentHint: document.getElementById("documentHint"),
    drawSignatureModeButton: document.getElementById("drawSignatureModeButton"),
    drawnSignatureFields: document.getElementById("drawnSignatureFields"),
    errorState: document.getElementById("errorState"),
    fileName: document.getElementById("fileName"),
    openSettingsButton: document.getElementById("openSettingsButton"),
    pagesContainer: document.getElementById("pagesContainer"),
    pagesShell: document.querySelector(".pages-shell"),
    placementTooltip: document.getElementById("placementTooltip"),
    promptAddSignatureButton: document.getElementById("promptAddSignatureButton"),
    saveSettingsButton: document.getElementById("saveSettingsButton"),
    saveSignatureButton: document.getElementById("saveSignatureButton"),
    saveSignatureDefaultsButton: document.getElementById("saveSignatureDefaultsButton"),
    saveSignedButton: document.getElementById("saveSignedButton"),
    saveDateDefaultsButton: document.getElementById("saveDateDefaultsButton"),
    saveDateEditorButton: document.getElementById("saveDateEditorButton"),
    saveSignatureEditorButton: document.getElementById("saveSignatureEditorButton"),
    settingsModal: document.getElementById("settingsModal"),
    signStatusChip: document.getElementById("signStatusChip"),
    signatureColorGrid: document.getElementById("signatureColorGrid"),
    signatureCaptureColorGrid: document.getElementById("signatureCaptureColorGrid"),
    signatureEditorActions: document.getElementById("signatureEditorActions"),
    signatureEditorColorGrid: document.getElementById("signatureEditorColorGrid"),
    signatureEditorModal: document.getElementById("signatureEditorModal"),
    signatureLibrary: document.getElementById("signatureLibrary"),
    signatureModal: document.getElementById("signatureModal"),
    signatureModalHelp: document.getElementById("signatureModalHelp"),
    signatureNameInput: document.getElementById("signatureNameInput"),
    signaturePrompt: document.getElementById("signaturePrompt"),
    statusText: document.getElementById("statusText"),
    storedSignatureMeta: document.getElementById("storedSignatureMeta"),
    typedSignatureFields: document.getElementById("typedSignatureFields"),
    typedSignatureFontGrid: document.getElementById("typedSignatureFontGrid"),
    typedSignatureModeButton: document.getElementById("typedSignatureModeButton"),
    typedSignaturePreview: document.getElementById("typedSignaturePreview"),
    typedSignatureTextInput: document.getElementById("typedSignatureTextInput")
  };
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
