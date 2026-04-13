import * as pdfjsLib from "../vendor/pdfjs/pdf.mjs";

const DEFAULT_SIGNATURE_WIDTH = 190;
const MIN_SIGNATURE_WIDTH = 76;
const MIN_SIGNATURE_HEIGHT = 28;
const MAX_SIGNATURE_WIDTH_RATIO = 0.36;
const MAX_RENDER_WIDTH = 920;
const MIN_RENDER_WIDTH = 540;
const POINTER_DRAG_THRESHOLD = 8;

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
    pageElements: new Map(),
    activeSignatureId: null,
    selectedPlacementId: null,
    renderPass: 0,
    isRendering: false,
    hasUnsavedChanges: false,
    pointerSession: null,
    dragGhost: null,
    highlightedStage: null,
    ignoreClickUntil: 0
  };

  let signaturePad = null;

  return {
    attachSignaturePad(pad) {
      signaturePad = pad;
    },
    async initialize() {
      if (!pdfLib?.PDFDocument) {
        throw new Error("The PDF signing library did not load correctly.");
      }

      bindEvents();
      await loadWorkspace();
      if (state.signatures.length === 0) {
        setStatus("Draw a signature to start signing this PDF.");
        requestAnimationFrame(() => openSignatureModal(true));
      } else {
        setStatus("Drag a stored signature onto any page, then save a signed copy.");
      }
    },
    showError
  };

  function bindEvents() {
    ui.addSignatureButton.addEventListener("click", () => openSignatureModal(false));
    ui.promptAddSignatureButton.addEventListener("click", () => openSignatureModal(true));
    ui.closeModalButton.addEventListener("click", closeSignatureModal);
    ui.cancelSignatureButton.addEventListener("click", closeSignatureModal);
    ui.clearSignaturePadButton.addEventListener("click", () => {
      signaturePad.clear();
      ui.signatureModalHelp.textContent =
        "Sign with your mouse, trackpad, or stylus. We will store this inside the extension.";
    });
    ui.saveSignatureButton.addEventListener("click", saveSignature);
    ui.clearPlacementsButton.addEventListener("click", clearPlacements);
    ui.saveSignedButton.addEventListener("click", saveSignedCopy);
    ui.signatureLibrary.addEventListener("click", handleLibraryClick);
    ui.signatureLibrary.addEventListener("pointerdown", handleSignaturePointerDown);
    ui.pagesContainer.addEventListener("pointerdown", handlePagePointerDown);
    ui.pagesContainer.addEventListener("click", handlePagesClick);
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
      if (event.key === "Escape" && !ui.signatureModal.hidden) {
        closeSignatureModal();
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
    if (state.signatures.length > 0) {
      state.activeSignatureId = state.signatures[0].id;
    }
    ui.fileName.textContent = state.preview.filename || "Downloaded PDF";
    document.title = `${state.preview.filename || "Downloaded PDF"} - EZSign Signing Workspace`;
    renderSignatureLibrary();
    renderPlacementSummary();
    await renderPdfDocument();
  }

  function renderSignatureLibrary() {
    ui.signatureCountChip.textContent = `${state.signatures.length} signature${state.signatures.length === 1 ? "" : "s"}`;
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
    subtitle.textContent = state.activeSignatureId === signature.id ? "Ready to place" : "Drag onto the document";
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
    const placeButton = document.createElement("button");
    placeButton.className = "secondary";
    placeButton.type = "button";
    placeButton.dataset.armSignatureId = signature.id;
    placeButton.textContent = state.activeSignatureId === signature.id ? "Selected" : "Select";
    actions.append(placeButton);

    card.append(header, swatch, actions);
    return card;
  }

  async function saveSignature() {
    const signature = signaturePad.exportSignature();
    if (!signature) {
      ui.signatureModalHelp.textContent = "Draw the signature before saving it.";
      return;
    }

    const baseName = ui.signatureNameInput.value.trim() || defaultSignatureName();
    const uniqueName = makeUniqueSignatureName(baseName);

    const nextSignature = {
      id: crypto.randomUUID(),
      name: uniqueName,
      dataUrl: signature.dataUrl,
      width: signature.width,
      height: signature.height,
      createdAt: new Date().toISOString()
    };

    state.signatures = [nextSignature, ...state.signatures];
    await helpers.saveSignatures(state.signatures);
    state.activeSignatureId = nextSignature.id;
    renderSignatureLibrary();
    closeSignatureModal();
    setStatus(`Saved ${nextSignature.name}. Drag it onto the PDF or click a page to place it.`);
  }

  function openSignatureModal(force) {
    hidePlacementTooltip();
    ui.signatureModal.hidden = false;
    ui.signatureNameInput.value = defaultSignatureName();
    ui.signatureModalHelp.textContent = force
      ? "No saved signatures were found, so add one now to start signing this PDF."
      : "Sign with your mouse, trackpad, or stylus. We will store this inside the extension.";
    signaturePad.clear();
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

    const armButton = event.target.closest("[data-arm-signature-id]");
    const signatureId = armButton?.dataset.armSignatureId;
    if (!signatureId) {
      return;
    }

    state.activeSignatureId = signatureId;
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

    if (event.target.closest("[data-remove-placement-id]")) {
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

  function handlePagesClick(event) {
    if (performance.now() < state.ignoreClickUntil) {
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
    const signature = getSignature(placement.signatureId);
    const node = document.createElement("div");
    node.className = `placed-signature${state.selectedPlacementId === placement.id ? " is-selected" : ""}`;
    node.dataset.placementId = placement.id;
    node.dataset.pageIndex = String(placement.pageIndex);
    node.style.left = `${placement.x}px`;
    node.style.top = `${placement.y}px`;
    node.style.width = `${placement.width}px`;
    node.style.height = `${placement.height}px`;
    const image = document.createElement("img");
    image.src = signature.dataUrl;
    image.alt = `${signature.name} placement`;
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

    node.append(image, removeButton, resizeHandle);
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
    setStatus(`Removed a signature from page ${placement.pageIndex + 1}.`);
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
    setStatus("Cleared all un-saved signature placements.");
  }

  function renderPlacementSummary() {
    ui.placementCountChip.textContent = `${state.placements.length} placed`;
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

    updatePlacement(placement.id, { width: nextWidth, height: nextHeight });
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
    if (!state.activeSignatureId || !ui.signatureModal.hidden) {
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

    showPlacementTooltip(event.clientX, event.clientY);
  }

  function showPlacementTooltip(clientX, clientY) {
    ui.placementTooltip.hidden = false;
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

    for (const placement of state.placements) {
      const signature = getSignature(placement.signatureId);
      const layout = state.pageLayouts[placement.pageIndex];
      const page = pages[placement.pageIndex];
      if (!signature || !layout || !page) {
        continue;
      }

      let embedded = embeddedSignatures.get(signature.id);
      if (!embedded) {
        embedded = await pdfDocument.embedPng(helpers.dataUrlToBytes(signature.dataUrl));
        embeddedSignatures.set(signature.id, embedded);
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
    cancelSignatureButton: document.getElementById("cancelSignatureButton"),
    clearPlacementsButton: document.getElementById("clearPlacementsButton"),
    clearSignaturePadButton: document.getElementById("clearSignaturePadButton"),
    closeModalButton: document.getElementById("closeModalButton"),
    documentHint: document.getElementById("documentHint"),
    errorState: document.getElementById("errorState"),
    fileName: document.getElementById("fileName"),
    pagesContainer: document.getElementById("pagesContainer"),
    pagesShell: document.querySelector(".pages-shell"),
    placementCountChip: document.getElementById("placementCountChip"),
    placementTooltip: document.getElementById("placementTooltip"),
    promptAddSignatureButton: document.getElementById("promptAddSignatureButton"),
    saveSignatureButton: document.getElementById("saveSignatureButton"),
    saveSignedButton: document.getElementById("saveSignedButton"),
    signatureCountChip: document.getElementById("signatureCountChip"),
    signatureLibrary: document.getElementById("signatureLibrary"),
    signatureModal: document.getElementById("signatureModal"),
    signatureModalHelp: document.getElementById("signatureModalHelp"),
    signatureNameInput: document.getElementById("signatureNameInput"),
    signaturePrompt: document.getElementById("signaturePrompt"),
    statusText: document.getElementById("statusText")
  };
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
