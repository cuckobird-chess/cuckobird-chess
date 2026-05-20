const sourceGrid = document.querySelector<HTMLDivElement>("#sourceGrid");
const appShell = document.querySelector<HTMLElement>("#appShell");
const panelToggle = document.querySelector<HTMLButtonElement>("#panelToggle");
const sourceDropdownButton = document.querySelector<HTMLButtonElement>("#sourceDropdownButton");
const selectedPreview = document.querySelector<HTMLImageElement>("#selectedPreview");
const selectedKind = document.querySelector<HTMLSpanElement>("#selectedKind");
const selectedDropdownName = document.querySelector<HTMLSpanElement>("#selectedDropdownName");
const refreshButton = document.querySelector<HTMLButtonElement>("#refreshButton");
const captureButton = document.querySelector<HTMLButtonElement>("#captureButton");
const statusText = document.querySelector<HTMLParagraphElement>("#statusText");
const selectedName = document.querySelector<HTMLSpanElement>("#selectedName");
const fenBoard = document.querySelector<HTMLDivElement>("#fenBoard");
const evaluationBar = document.querySelector<HTMLDivElement>("#evaluationBar");
const evaluationFill = document.querySelector<HTMLDivElement>("#evaluationFill");
const evaluationValue = document.querySelector<HTMLSpanElement>("#evaluationValue");
const fenOutput = document.querySelector<HTMLParagraphElement>("#fenOutput");
const boardTitle = document.querySelector<HTMLHeadingElement>("#boardTitle");
const orientationWhiteButton = document.querySelector<HTMLButtonElement>("#orientationWhiteButton");
const orientationBlackButton = document.querySelector<HTMLButtonElement>("#orientationBlackButton");
const maiaRatingInput = document.querySelector<HTMLInputElement>("#maiaRatingInput");
const stockfishMoveTimeInput = document.querySelector<HTMLInputElement>("#stockfishMoveTimeInput");
const stockfishMoveTimeRange = document.querySelector<HTMLInputElement>("#stockfishMoveTimeRange");
const hiddenModeToggle = document.querySelector<HTMLInputElement>("#hiddenModeToggle");
const hiddenModeStatus = document.querySelector<HTMLParagraphElement>("#hiddenModeStatus");
const evalEndpoint = document.querySelector<HTMLElement>("#evalEndpoint");
const endpointStatus = document.querySelector<HTMLParagraphElement>("#endpointStatus");

let selectedSource: CaptureSource | null = null;
let availableSources: CaptureSource[] = [];
let isDropdownOpen = false;
let isPanelCollapsed = false;
let isMonitoring = false;
let isCaptureInFlight = false;
let monitorTimer: number | undefined;
let stockfishSettingsTimer: number | undefined;
let maiaSettingsTimer: number | undefined;
let activeCameraStream: MediaStream | null = null;
let activeCameraSourceId: string | null = null;
let activeCameraVideo: HTMLVideoElement | null = null;
let cameraFrameCanvas: HTMLCanvasElement | null = null;
const cameraDeviceIds = new Map<string, string>();

const files = ["a", "b", "c", "d", "e", "f", "g", "h"];
type BoardOrientation = NonNullable<NonNullable<CaptureResult["board"]>["detection"]>["orientation"];
type BoardPerspective = Extract<BoardOrientation, "white" | "black">;
type BestMove = NonNullable<NonNullable<CaptureResult["board"]>["bestMove"]>;
type EngineEvaluation = NonNullable<NonNullable<CaptureResult["board"]>["evaluation"]>;

type BoardRenderState = {
  pieces: readonly string[] | null;
  fen?: string;
  detectedOrientation: BoardOrientation;
  bestMove?: BestMove;
  stockfishMove?: BestMove;
  maiaMove?: BestMove;
  evaluation?: EngineEvaluation;
};

let boardPerspectiveOverride: BoardPerspective | null = null;
let currentBoardRender: BoardRenderState = {
  pieces: null,
  detectedOrientation: "white"
};

const pieceSymbols: Record<string, string> = {
  K: "♚",
  Q: "♛",
  R: "♜",
  B: "♝",
  N: "♞",
  P: "♟",
  k: "♚",
  q: "♛",
  r: "♜",
  b: "♝",
  n: "♞",
  p: "♟"
};

const setStatus = (message: string, tone: "neutral" | "success" | "error" = "neutral") => {
  if (!statusText) return;
  statusText.textContent = message;
  statusText.dataset.tone = tone;
};

const setEndpointStatus = (message: string, tone: "neutral" | "success" | "error" = "neutral") => {
  if (!endpointStatus) return;
  endpointStatus.textContent = message;
  endpointStatus.dataset.tone = tone;
};

const setHiddenModeStatus = (message: string, tone: "neutral" | "success" | "error" = "neutral") => {
  if (!hiddenModeStatus) return;
  hiddenModeStatus.textContent = message;
  hiddenModeStatus.dataset.tone = tone;
};

const applyHiddenModeSettings = (settings: HiddenModeSettings) => {
  if (hiddenModeToggle) {
    hiddenModeToggle.checked = settings.enabled;
    hiddenModeToggle.disabled = !settings.supported;
  }

  if (!settings.supported) {
    setHiddenModeStatus("macOS only");
  } else {
    setHiddenModeStatus(settings.enabled ? "Protected" : "Off", settings.enabled ? "success" : "neutral");
  }
};

const loadHiddenModeSettings = async () => {
  try {
    const settings = await window.screenshotApi.getHiddenModeSettings();
    applyHiddenModeSettings(settings);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load hidden mode.";
    setHiddenModeStatus(message, "error");
  }
};

const setHiddenMode = async (enabled: boolean) => {
  if (!hiddenModeToggle) return;

  hiddenModeToggle.disabled = true;
  setHiddenModeStatus("Updating...");

  try {
    const settings = await window.screenshotApi.setHiddenMode(enabled);
    applyHiddenModeSettings(settings);
  } catch (error) {
    hiddenModeToggle.checked = !enabled;
    hiddenModeToggle.disabled = false;
    const message = error instanceof Error ? error.message : "Could not update hidden mode.";
    setHiddenModeStatus(message, "error");
  }
};

const applyLocalApiSettings = (settings: LocalApiSettings) => {
  if (evalEndpoint) {
    evalEndpoint.textContent = settings.evalUrl;
  }

  setEndpointStatus(`Listening on localhost:${settings.port}.`, "success");
};

const loadLocalApiSettings = async () => {
  try {
    const settings = await window.screenshotApi.getLocalApiSettings();
    applyLocalApiSettings(settings);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load local API settings.";
    setEndpointStatus(message, "error");
  }
};

const getCameraThumbnailDataUrl = () => {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 100">
      <rect width="160" height="100" rx="10" fill="#edf2ef"/>
      <rect x="48" y="34" width="46" height="32" rx="6" fill="#2f6f67"/>
      <path d="M94 43 L118 31 V69 L94 57 Z" fill="#5a826e"/>
      <circle cx="71" cy="50" r="11" fill="#e8eed9"/>
      <circle cx="71" cy="50" r="5" fill="#a44725"/>
    </svg>`;

  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
};

const listCameraSources = async (): Promise<CaptureSource[]> => {
  if (!navigator.mediaDevices?.enumerateDevices) {
    return [];
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  const cameras = devices.filter((device) => device.kind === "videoinput");
  cameraDeviceIds.clear();

  return cameras.map((device, index) => {
    const fallbackId = `index-${index}`;
    const deviceId = device.deviceId || fallbackId;
    const sourceId = `camera:${encodeURIComponent(deviceId)}`;
    cameraDeviceIds.set(sourceId, device.deviceId);

    return {
      id: sourceId,
      name: device.label || `Camera ${index + 1}`,
      kind: "camera",
      thumbnailDataUrl: getCameraThumbnailDataUrl()
    };
  });
};

const stopCameraStream = () => {
  activeCameraStream?.getTracks().forEach((track) => track.stop());
  activeCameraStream = null;
  activeCameraSourceId = null;

  if (activeCameraVideo) {
    activeCameraVideo.pause();
    activeCameraVideo.srcObject = null;
    activeCameraVideo = null;
  }
};

const waitForCameraVideo = (video: HTMLVideoElement) =>
  new Promise<void>((resolve, reject) => {
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      resolve();
      return;
    }

    const timeout = window.setTimeout(() => {
      reject(new Error("Camera did not produce a frame in time."));
    }, 5000);

    video.addEventListener(
      "loadedmetadata",
      () => {
        window.clearTimeout(timeout);
        resolve();
      },
      { once: true }
    );
  });

const startCameraStream = async (source: CaptureSource) => {
  if (activeCameraSourceId === source.id && activeCameraVideo && activeCameraStream) {
    return activeCameraVideo;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Camera capture is not available in this environment.");
  }

  stopCameraStream();

  const deviceId = cameraDeviceIds.get(source.id);
  const videoConstraints: MediaTrackConstraints = {
    width: { ideal: 1920 },
    height: { ideal: 1080 }
  };

  if (deviceId) {
    videoConstraints.deviceId = { exact: deviceId };
  }

  activeCameraStream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: videoConstraints
  });
  activeCameraSourceId = source.id;
  activeCameraVideo = document.createElement("video");
  activeCameraVideo.muted = true;
  activeCameraVideo.playsInline = true;
  activeCameraVideo.srcObject = activeCameraStream;

  await waitForCameraVideo(activeCameraVideo);
  await activeCameraVideo.play();
  return activeCameraVideo;
};

const captureCameraFrame = async (source: CaptureSource) => {
  const video = await startCameraStream(source);

  if (video.videoWidth === 0 || video.videoHeight === 0) {
    throw new Error("Camera frame is empty.");
  }

  cameraFrameCanvas ??= document.createElement("canvas");
  cameraFrameCanvas.width = video.videoWidth;
  cameraFrameCanvas.height = video.videoHeight;

  const context = cameraFrameCanvas.getContext("2d");
  if (!context) {
    throw new Error("Could not prepare a camera frame.");
  }

  context.drawImage(video, 0, 0, cameraFrameCanvas.width, cameraFrameCanvas.height);
  return cameraFrameCanvas.toDataURL("image/jpeg", 0.92);
};

const setDropdownOpen = (isOpen: boolean) => {
  isDropdownOpen = isOpen && availableSources.length > 0;

  if (sourceGrid) {
    sourceGrid.dataset.open = String(isDropdownOpen);
  }

  if (sourceDropdownButton) {
    sourceDropdownButton.setAttribute("aria-expanded", String(isDropdownOpen));
  }
};

const setPanelCollapsed = (isCollapsed: boolean) => {
  isPanelCollapsed = isCollapsed;
  setDropdownOpen(false);

  if (appShell) {
    appShell.dataset.panelCollapsed = String(isPanelCollapsed);
  }

  if (panelToggle) {
    panelToggle.dataset.collapsed = String(isPanelCollapsed);
    panelToggle.setAttribute("aria-label", isPanelCollapsed ? "Show source panel" : "Hide source panel");
    panelToggle.setAttribute("aria-expanded", String(!isPanelCollapsed));
  }
};

const parseFenPlacement = (fen: string) => {
  const placement = fen.trim().split(/\s+/)[0];
  const ranks = placement.split("/");

  if (ranks.length !== 8) {
    return null;
  }

  const squares: string[] = [];

  for (const rank of ranks) {
    let fileCount = 0;

    for (const token of rank) {
      if (/^[1-8]$/.test(token)) {
        const emptyCount = Number(token);
        fileCount += emptyCount;

        for (let index = 0; index < emptyCount; index += 1) {
          squares.push("");
        }
      } else if (Object.prototype.hasOwnProperty.call(pieceSymbols, token)) {
        fileCount += 1;
        squares.push(token);
      } else {
        return null;
      }
    }

    if (fileCount !== 8) {
      return null;
    }
  }

  return squares.length === 64 ? squares : null;
};

const toBoardPerspective = (orientation?: BoardOrientation): BoardPerspective =>
  orientation === "black" ? "black" : "white";

const getActivePerspective = (detectedOrientation?: BoardOrientation): BoardPerspective =>
  boardPerspectiveOverride ?? toBoardPerspective(detectedOrientation);

const updateOrientationControls = (activePerspective: BoardPerspective, isEnabled: boolean) => {
  const buttons: Array<[HTMLButtonElement | null, BoardPerspective]> = [
    [orientationWhiteButton, "white"],
    [orientationBlackButton, "black"]
  ];

  for (const [button, perspective] of buttons) {
    if (!button) continue;
    const isActive = activePerspective === perspective;
    button.disabled = !isEnabled;
    button.dataset.active = String(isActive);
    button.setAttribute("aria-pressed", String(isActive));
  }
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const getEvaluationWhiteShare = (evaluation?: EngineEvaluation) => {
  if (!evaluation) {
    return 50;
  }

  if (evaluation.type === "mate") {
    if (evaluation.whiteValue === 0) {
      return 50;
    }

    return evaluation.whiteValue > 0 ? 96 : 4;
  }

  return clamp(50 + Math.tanh(evaluation.whiteValue / 600) * 46, 4, 96);
};

const getEvaluationAriaLabel = (evaluation?: EngineEvaluation) => {
  if (!evaluation) {
    return "Engine evaluation unavailable";
  }

  if (evaluation.type === "mate") {
    if (evaluation.whiteValue === 0) {
      return "Engine evaluation is mate now";
    }

    const side = evaluation.whiteValue > 0 ? "White" : "Black";
    return `${side} has mate in ${Math.abs(evaluation.whiteValue)}`;
  }

  if (Math.abs(evaluation.whiteValue) < 5) {
    return "Engine evaluation is equal";
  }

  const side = evaluation.whiteValue > 0 ? "White" : "Black";
  return `${side} is ahead by ${Math.abs(evaluation.whiteValue / 100).toFixed(1)} pawns`;
};

const renderEvaluationBar = (evaluation?: EngineEvaluation) => {
  if (evaluationBar) {
    evaluationBar.style.setProperty("--white-share", `${getEvaluationWhiteShare(evaluation)}%`);
    evaluationBar.dataset.active = String(Boolean(evaluation));
    evaluationBar.setAttribute("aria-label", getEvaluationAriaLabel(evaluation));
  }

  if (evaluationFill) {
    evaluationFill.style.height = `${getEvaluationWhiteShare(evaluation)}%`;
  }

  if (evaluationValue) {
    evaluationValue.textContent = evaluation?.display ?? "0.0";
  }
};

const applyStockfishSettings = (settings: StockfishSettings) => {
  const controls = [stockfishMoveTimeInput, stockfishMoveTimeRange];

  for (const control of controls) {
    if (!control) continue;
    control.min = String(settings.minMoveTimeMs);
    control.max = String(settings.maxMoveTimeMs);
    control.step = String(settings.stepMs);
    control.value = String(settings.moveTimeMs);
  }
};

const applyMaiaSettings = (settings: EngineSettings["maia"]) => {
  if (maiaRatingInput) {
    maiaRatingInput.min = String(settings.minRating);
    maiaRatingInput.max = String(settings.maxRating);
    maiaRatingInput.step = String(settings.stepRating);
    maiaRatingInput.value = String(settings.rating);
  }
};

const applyEngineSettings = (settings: EngineSettings) => {
  applyStockfishSettings(settings.stockfish);
  applyMaiaSettings(settings.maia);
};

const setStockfishMoveTime = (moveTimeMs: number) => {
  if (stockfishMoveTimeInput) {
    stockfishMoveTimeInput.value = String(moveTimeMs);
  }

  if (stockfishMoveTimeRange) {
    stockfishMoveTimeRange.value = String(moveTimeMs);
  }

  if (stockfishSettingsTimer !== undefined) {
    window.clearTimeout(stockfishSettingsTimer);
  }

  stockfishSettingsTimer = window.setTimeout(() => {
    stockfishSettingsTimer = undefined;
    void window.screenshotApi
      .setStockfishMoveTime(moveTimeMs)
      .then(applyStockfishSettings)
      .catch((error) => {
        const message = error instanceof Error ? error.message : "Could not update Stockfish thinking time.";
        setStatus(message, "error");
      });
  }, 120);
};

const getBoundedNumericControlValue = (control: HTMLInputElement) => {
  const value = Number(control.value);
  const min = Number(control.min);
  const max = Number(control.max);

  if (!Number.isFinite(value)) {
    return Number(control.defaultValue);
  }

  return Math.max(min, Math.min(max, value));
};

const getStockfishControlValue = (control: HTMLInputElement) => getBoundedNumericControlValue(control);

const getMaiaRatingControlValue = (control: HTMLInputElement) => getBoundedNumericControlValue(control);

const setMaiaRating = (rating: number) => {
  if (maiaRatingInput) {
    maiaRatingInput.value = String(rating);
  }

  if (maiaSettingsTimer !== undefined) {
    window.clearTimeout(maiaSettingsTimer);
  }

  maiaSettingsTimer = window.setTimeout(() => {
    maiaSettingsTimer = undefined;
    void window.screenshotApi.setMaiaRating(rating).then(applyEngineSettings).catch((error) => {
      const message = error instanceof Error ? error.message : "Could not update Maia rating.";
      setStatus(message, "error");
    });
  }, 160);
};

const getVisualSquare = (squareName: string, orientation: BoardOrientation) => {
  const file = files.indexOf(squareName[0]);
  const rank = Number(squareName[1]);

  if (file === -1 || !Number.isInteger(rank) || rank < 1 || rank > 8) {
    return null;
  }

  if (orientation === "black") {
    return { row: rank - 1, column: 7 - file };
  }

  return { row: 8 - rank, column: file };
};

type MoveArrowKind = "stockfish" | "maia";

const createMoveArrow = (move: BestMove, orientation: BoardOrientation, kind: MoveArrowKind) => {
  const from = getVisualSquare(move.from, orientation);
  const to = getVisualSquare(move.to, orientation);

  if (!from || !to) {
    return null;
  }

  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  const defs = document.createElementNS(namespace, "defs");
  const marker = document.createElementNS(namespace, "marker");
  const markerPath = document.createElementNS(namespace, "path");
  const line = document.createElementNS(namespace, "line");
  const fromDot = document.createElementNS(namespace, "circle");
  const x1 = ((from.column + 0.5) / 8) * 100;
  const y1 = ((from.row + 0.5) / 8) * 100;
  const x2 = ((to.column + 0.5) / 8) * 100;
  const y2 = ((to.row + 0.5) / 8) * 100;
  const length = Math.hypot(x2 - x1, y2 - y1) || 1;
  const offset = kind === "stockfish" ? -0.7 : 0.7;
  const offsetX = (-(y2 - y1) / length) * offset;
  const offsetY = ((x2 - x1) / length) * offset;
  const markerId = `${kind}MoveArrowHead`;

  svg.classList.add("move-arrow", `${kind}-move-arrow`);
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");

  marker.setAttribute("id", markerId);
  marker.setAttribute("markerWidth", "5");
  marker.setAttribute("markerHeight", "5");
  marker.setAttribute("refX", "4.4");
  marker.setAttribute("refY", "2.5");
  marker.setAttribute("orient", "auto");
  marker.setAttribute("markerUnits", "userSpaceOnUse");
  markerPath.setAttribute("d", "M 0 0 L 5 2.5 L 0 5 z");
  marker.append(markerPath);
  defs.append(marker);

  line.setAttribute("x1", String(x1 + offsetX));
  line.setAttribute("y1", String(y1 + offsetY));
  line.setAttribute("x2", String(x2 + offsetX));
  line.setAttribute("y2", String(y2 + offsetY));
  line.setAttribute("marker-end", `url(#${markerId})`);

  fromDot.setAttribute("cx", String(x1 + offsetX));
  fromDot.setAttribute("cy", String(y1 + offsetY));
  fromDot.setAttribute("r", "1.65");

  svg.append(defs, line, fromDot);
  return svg;
};

const renderFenBoard = (
  pieces: readonly string[] | null = null,
  fen?: string,
  orientation: BoardOrientation = "white",
  stockfishMove?: BestMove,
  maiaMove?: BestMove
) => {
  if (!fenBoard) return;

  fenBoard.innerHTML = "";
  const boardPieces = pieces ?? Array.from({ length: 64 }, () => "");
  const isBlackPerspective = orientation === "black";

  for (let squareIndex = 0; squareIndex < 64; squareIndex += 1) {
    const rankIndex = Math.floor(squareIndex / 8);
    const fileIndex = squareIndex % 8;
    const pieceRankIndex = isBlackPerspective ? 7 - rankIndex : rankIndex;
    const pieceFileIndex = isBlackPerspective ? 7 - fileIndex : fileIndex;
    const square = document.createElement("div");
    const isLight = (rankIndex + fileIndex) % 2 === 0;
    const piece = boardPieces[pieceRankIndex * 8 + pieceFileIndex];

    square.className = `board-square ${isLight ? "light-square" : "dark-square"}`;
    if (fileIndex === 0) {
      square.dataset.rank = String(isBlackPerspective ? rankIndex + 1 : 8 - rankIndex);
    }
    if (rankIndex === 7) {
      square.dataset.file = files[isBlackPerspective ? 7 - fileIndex : fileIndex];
    }

    if (piece) {
      const pieceElement = document.createElement("span");
      pieceElement.className = `piece ${piece === piece.toUpperCase() ? "white-piece" : "black-piece"}`;
      pieceElement.textContent = pieceSymbols[piece];
      square.append(pieceElement);
    }

    fenBoard.append(square);
  }

  const stockfishArrow = stockfishMove ? createMoveArrow(stockfishMove, orientation, "stockfish") : null;
  const maiaArrow = maiaMove ? createMoveArrow(maiaMove, orientation, "maia") : null;

  if (stockfishArrow) {
    fenBoard.append(stockfishArrow);
  }

  if (maiaArrow) {
    fenBoard.append(maiaArrow);
  }

  fenBoard.setAttribute("aria-label", fen ? `Chessboard from FEN ${fen}` : "Empty chessboard");
};

const renderCurrentBoard = () => {
  const activePerspective = getActivePerspective(currentBoardRender.detectedOrientation);
  renderFenBoard(
    currentBoardRender.pieces,
    currentBoardRender.fen,
    activePerspective,
    currentBoardRender.stockfishMove ?? currentBoardRender.bestMove,
    currentBoardRender.maiaMove
  );
  renderEvaluationBar(currentBoardRender.evaluation);
  updateOrientationControls(activePerspective, Boolean(currentBoardRender.pieces && currentBoardRender.fen));
};

const setBoardRenderState = (state: BoardRenderState) => {
  if (state.detectedOrientation !== currentBoardRender.detectedOrientation) {
    boardPerspectiveOverride = null;
  }

  currentBoardRender = state;
  renderCurrentBoard();
};

const setBoardState = (
  title: string,
  fenText: string,
  fen?: string,
  orientation?: BoardOrientation,
  bestMove?: BestMove,
  stockfishMove?: BestMove,
  maiaMove?: BestMove,
  evaluation?: EngineEvaluation
) => {
  if (boardTitle) {
    boardTitle.textContent = "Position";
  }

  if (fenOutput) {
    fenOutput.textContent = fenText;
  }

  const pieces = fen ? parseFenPlacement(fen) : null;
  setBoardRenderState({
    pieces,
    fen: pieces ? fen : undefined,
    detectedOrientation: orientation ?? "white",
    bestMove,
    stockfishMove,
    maiaMove,
    evaluation: pieces ? evaluation : undefined
  });
};

const showFen = (
  fen: string,
  orientation: BoardOrientation,
  bestMove?: BestMove,
  stockfishMove?: BestMove,
  maiaMove?: BestMove,
  evaluation?: EngineEvaluation
) => {
  const pieces = parseFenPlacement(fen);

  if (!pieces) {
    setBoardState("FEN could not be shown", fen);
    return;
  }

  if (boardTitle) {
    boardTitle.textContent = "Position";
  }

  if (fenOutput) {
    fenOutput.textContent = fen;
  }

  setBoardRenderState({
    pieces,
    fen,
    detectedOrientation: orientation,
    bestMove,
    stockfishMove,
    maiaMove,
    evaluation
  });
};

const setBoardPerspectiveOverride = (perspective: BoardPerspective) => {
  boardPerspectiveOverride = perspective;
  renderCurrentBoard();
};

const setSelectedSource = (source: CaptureSource | null) => {
  if (isMonitoring) {
    stopMonitoring();
  }

  if (source?.kind !== "camera" || source.id !== activeCameraSourceId) {
    stopCameraStream();
  }

  boardPerspectiveOverride = null;
  selectedSource = source;

  if (selectedName) {
    selectedName.textContent = source ? source.name : "Nothing selected";
  }

  if (captureButton) {
    captureButton.disabled = !source;
    captureButton.textContent = "Start";
  }

  if (selectedPreview) {
    if (source) {
      selectedPreview.src = source.thumbnailDataUrl;
    } else {
      selectedPreview.removeAttribute("src");
    }
  }

  if (selectedKind) {
    selectedKind.textContent = source ? source.kind : "Source";
  }

  if (selectedDropdownName) {
    selectedDropdownName.textContent = source ? source.name : "Choose a screen, window, or camera";
  }

  if (sourceDropdownButton) {
    sourceDropdownButton.dataset.hasSelection = String(Boolean(source));
  }

  document.querySelectorAll<HTMLButtonElement>(".source-option").forEach((option) => {
    const isSelected = option.dataset.sourceId === source?.id;
    option.dataset.selected = String(isSelected);
    option.setAttribute("aria-selected", String(isSelected));
  });

  setDropdownOpen(false);
  setBoardState(source ? "Ready to capture" : "No position yet", "No FEN loaded");
};

const renderSources = (sources: CaptureSource[]) => {
  if (!sourceGrid) return;

  availableSources = sources;
  sourceGrid.innerHTML = "";

  if (sourceDropdownButton) {
    sourceDropdownButton.disabled = sources.length === 0;
  }

  if (sources.length === 0) {
    sourceGrid.innerHTML = '<p class="empty-state">No screens, windows, or cameras were found.</p>';
    setDropdownOpen(false);
    return;
  }

  for (const source of sources) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "source-option";
    card.dataset.sourceId = source.id;
    card.dataset.selected = "false";
    card.setAttribute("role", "option");
    card.setAttribute("aria-selected", "false");

    const preview = document.createElement("img");
    preview.className = "source-preview";
    preview.src = source.thumbnailDataUrl;
    preview.alt = "";
    preview.loading = "lazy";

    const meta = document.createElement("span");
    meta.className = "source-meta";

    const kind = document.createElement("span");
    kind.className = "source-kind";
    kind.textContent = source.kind;

    const name = document.createElement("span");
    name.className = "source-name";
    name.textContent = source.name;

    meta.append(kind, name);
    card.append(preview, meta);
    card.addEventListener("click", () => setSelectedSource(source));

    sourceGrid.append(card);
  }
};

const loadSources = async () => {
  if (refreshButton) refreshButton.disabled = true;
  availableSources = [];
  setSelectedSource(null);
  setStatus("Looking for available screens, windows, and cameras...");

  try {
    const [desktopSources, cameraSources] = await Promise.all([
      window.screenshotApi.listSources(),
      listCameraSources().catch(() => [])
    ]);
    const sources = [...desktopSources, ...cameraSources];
    renderSources(sources);
    setStatus(`Found ${sources.length} source${sources.length === 1 ? "" : "s"}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not list sources.";
    renderSources([]);
    setStatus(message, "error");
  } finally {
    if (refreshButton) refreshButton.disabled = false;
  }
};

sourceDropdownButton?.addEventListener("click", () => {
  setDropdownOpen(!isDropdownOpen);
});

panelToggle?.addEventListener("click", () => {
  setPanelCollapsed(!isPanelCollapsed);
});

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Node)) return;

  if (!sourceDropdownButton?.contains(target) && !sourceGrid?.contains(target)) {
    setDropdownOpen(false);
  }
});

window.addEventListener("keydown", (event) => {
  if (event.key === "<") {
    setPanelCollapsed(true);
  }

  if (event.key === ">") {
    setPanelCollapsed(false);
  }
});

const captureSelectedSource = async () => {
  if (!selectedSource || !captureButton) return;
  if (isCaptureInFlight) return;

  isCaptureInFlight = true;
  const sourceId = selectedSource.id;

  try {
    let result: CaptureResult;

    if (selectedSource.kind === "camera") {
      const frameStartedAt = performance.now();
      const imageDataUrl = await captureCameraFrame(selectedSource);
      const frameCaptureMs = performance.now() - frameStartedAt;
      result = await window.screenshotApi.captureImageDataUrl(sourceId, "camera", imageDataUrl, frameCaptureMs);
    } else {
      result = await window.screenshotApi.captureSource(sourceId);
    }

    if (selectedSource?.id !== sourceId) {
      return;
    }

    if (result.skipped) {
      return;
    }

    if (result.board) {
      if (result.board.fen) {
        showFen(
          result.board.fen.value,
          result.board.detection.orientation,
          result.board.bestMove,
          result.board.stockfishMove,
          result.board.maiaMove,
          result.board.evaluation
        );
      } else {
        setBoardState("Board detected", result.board.fenError ?? "No FEN created");
      }
    } else {
      setBoardState("No board detected", result.boardError ?? "No FEN loaded");
    }
  } catch (error) {
    const message = selectedSource?.kind === "camera" && error instanceof Error ? error.message : "No FEN loaded";
    setBoardState("Capture failed", message);
  } finally {
    isCaptureInFlight = false;
    captureButton.disabled = !selectedSource;
  }
};

function stopMonitoring() {
  isMonitoring = false;
  stopCameraStream();

  if (monitorTimer !== undefined) {
    window.clearInterval(monitorTimer);
    monitorTimer = undefined;
  }

  if (captureButton) {
    captureButton.textContent = "Start";
    captureButton.disabled = !selectedSource;
  }
}

const startMonitoring = () => {
  if (!selectedSource || !captureButton) return;

  isMonitoring = true;
  setPanelCollapsed(true);
  captureButton.textContent = "Stop";
  captureButton.disabled = false;

  void captureSelectedSource();
  monitorTimer = window.setInterval(() => {
    void captureSelectedSource();
  }, 500);
};

const toggleMonitoring = () => {
  if (isMonitoring) {
    stopMonitoring();
  } else {
    startMonitoring();
  }
};

refreshButton?.addEventListener("click", loadSources);
captureButton?.addEventListener("click", toggleMonitoring);
orientationWhiteButton?.addEventListener("click", () => setBoardPerspectiveOverride("white"));
orientationBlackButton?.addEventListener("click", () => setBoardPerspectiveOverride("black"));
maiaRatingInput?.addEventListener("change", () => setMaiaRating(getMaiaRatingControlValue(maiaRatingInput)));
stockfishMoveTimeInput?.addEventListener("change", () => setStockfishMoveTime(getStockfishControlValue(stockfishMoveTimeInput)));
stockfishMoveTimeRange?.addEventListener("input", () => setStockfishMoveTime(getStockfishControlValue(stockfishMoveTimeRange)));
hiddenModeToggle?.addEventListener("change", () => {
  void setHiddenMode(hiddenModeToggle.checked);
});

setPanelCollapsed(false);
renderCurrentBoard();
void window.screenshotApi.getEngineSettings().then(applyEngineSettings).catch((error) => {
  const message = error instanceof Error ? error.message : "Could not load engine settings.";
  setStatus(message, "error");
});
void loadHiddenModeSettings();
void loadLocalApiSettings();
void loadSources();
