import { app, BrowserWindow, desktopCapturer, ipcMain, nativeImage, session } from "electron";
import { Chess } from "chess.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectBoardImageOrientation, detectChessboard, type BoardDetection } from "./boardDetector";
import { recognizeFen, type FenRecognition } from "./pieceRecognizer";
import type {
  CaptureResult,
  CaptureSource,
  EngineSettings,
  HiddenModeSettings,
  LocalApiSettings,
  MaiaSettings,
  SourceKind,
  StockfishSettings
} from "./types";

const projectRoot = app.getAppPath();
const appDisplayName = "Cuckobird Chess";
const appDataDirectoryName = "cuckobird-chess";
const appIconPath = path.join(__dirname, "logo.png");
const getAppIcon = () => nativeImage.createFromPath(appIconPath);
app.setName(appDisplayName);
app.setPath("userData", path.join(app.getPath("appData"), appDataDirectoryName));
const getBundledResourcePath = (...segments: string[]) =>
  app.isPackaged ? path.join(process.resourcesPath, ...segments) : path.join(projectRoot, ...segments);
const pieceModelPath = getBundledResourcePath("models", "piece-model.onnx");
const boardCropDirectory = app.isPackaged
  ? path.join(app.getPath("userData"), "temp")
  : path.join(projectRoot, "temp");
const profileDirectory = path.join(boardCropDirectory, "profile");
const boardDetectionCache = new Map<string, BoardDetection>();
type CapturedBoard = NonNullable<CaptureResult["board"]>;
const recognizedBoardCache = new Map<string, CapturedBoard>();
const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
const stockfishFallbackPaths =
  process.platform === "win32"
    ? [
        path.join(programFiles, "Stockfish", "stockfish.exe"),
        path.join(programFilesX86, "Stockfish", "stockfish.exe")
      ]
    : process.platform === "darwin"
      ? ["/opt/homebrew/bin/stockfish", "/usr/local/bin/stockfish", "/usr/bin/stockfish"]
      : ["/usr/games/stockfish", "/usr/local/bin/stockfish", "/usr/bin/stockfish"];
const lc0FallbackPaths =
  process.platform === "win32"
    ? [
        path.join(programFiles, "Lc0", "lc0.exe"),
        path.join(programFilesX86, "Lc0", "lc0.exe"),
        path.join(programFiles, "Leela Chess Zero", "lc0.exe"),
        path.join(programFilesX86, "Leela Chess Zero", "lc0.exe")
      ]
    : process.platform === "darwin"
      ? ["/opt/homebrew/bin/lc0", "/usr/local/bin/lc0", "/usr/bin/lc0"]
      : ["/usr/games/lc0", "/usr/local/bin/lc0", "/usr/bin/lc0"];
const tesseractFallbackPaths =
  process.platform === "win32"
    ? [
        path.join(programFiles, "Tesseract-OCR", "tesseract.exe"),
        path.join(programFilesX86, "Tesseract-OCR", "tesseract.exe")
      ]
    : process.platform === "darwin"
      ? ["/opt/homebrew/bin/tesseract", "/usr/local/bin/tesseract", "/usr/bin/tesseract"]
      : ["/usr/local/bin/tesseract", "/usr/bin/tesseract"];
const windowCaptureThumbnailPixels = 2048;
const screenCaptureThumbnailPixels = 3072;
const boardDiffPixels = 128;
const boardChangeThreshold = 0.01;
const boardStableFrameRequirement = 2;
const channelChangeThreshold = 18;
const boardOrientationConfidenceThreshold = 0.75;
const fenConfidenceThreshold = 0.7;
const ocrCacheLimit = 20;
const stockfishMinMoveTimeMs = 50;
const stockfishMaxMoveTimeMs = 1000;
const stockfishMoveTimeStepMs = 10;
let stockfishMoveTimeMs = 220;
const stockfishTimeoutMs = 2500;
const maiaAvailableRatings = [1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900] as const;
const maiaMinRating = maiaAvailableRatings[0];
const maiaMaxRating = maiaAvailableRatings[maiaAvailableRatings.length - 1];
const maiaRatingStep = 100;
let maiaRating = 1900;
let engineSettingsRevision = 0;
const maiaTimeoutMs = 8000;
const maiaSearchNodes = 32;
const maiaWeightsDirectory = path.join(app.getPath("userData"), "maia-weights");
const localApiPreferredPort = 7000;
const localApiHost = "localhost";
let localApiServer: Server | undefined;
let localApiPort = 0;
const hiddenModeSupported = process.platform === "darwin";
let hiddenModeEnabled = false;
const homeRankColorScoreWeight = 14;
const analyzerBuild = "orientation-coordinate-v4";
const debugMode =
  process.argv.includes("--debug-mode") ||
  process.env.CUCKOBIRD_CHESS_DEBUG === "1" ||
  process.env.DEBUG_CUCKOBIRD_CHESS === "1";

const formatMs = (startedAt: number) => `${Math.round(performance.now() - startedAt)}ms`;
const formatTimestamp = (date = new Date()) => date.toISOString().replace(/[:.]/g, "-");

const sanitizeFilenameSegment = (value: string, fallback = "unknown") => {
  const sanitized = value.replace(/[^a-z0-9_.-]+/gi, "-").replace(/^-+|-+$/g, "");
  return sanitized ? sanitized.slice(0, 70) : fallback;
};

type ProfileDetails = Record<string, string | number | boolean | null | undefined>;
type ProfileEntry = {
  name: string;
  durationMs: number;
  startedAtMs: number;
  details?: ProfileDetails;
  error?: string;
};
type CaptureProfiler = {
  id: string;
  sourceId: string;
  startedAt: string;
  startedAtMs: number;
  entries: ProfileEntry[];
};

const createProfiler = (sourceId: string): CaptureProfiler | undefined => {
  if (!debugMode) {
    return undefined;
  }

  return {
    id: formatTimestamp(),
    sourceId,
    startedAt: new Date().toISOString(),
    startedAtMs: performance.now(),
    entries: []
  };
};

const addProfileEntry = (
  profiler: CaptureProfiler | undefined,
  name: string,
  startedAtMs: number,
  details?: ProfileDetails,
  error?: unknown
) => {
  if (!profiler) {
    return;
  }

  profiler.entries.push({
    name,
    startedAtMs: Math.round((startedAtMs - profiler.startedAtMs) * 100) / 100,
    durationMs: Math.round((performance.now() - startedAtMs) * 100) / 100,
    details,
    error: error instanceof Error ? error.message : error === undefined ? undefined : String(error)
  });
};

const profileSync = <T>(
  profiler: CaptureProfiler | undefined,
  name: string,
  callback: () => T,
  details?: ProfileDetails
) => {
  if (!profiler) {
    return callback();
  }

  const startedAtMs = performance.now();

  try {
    const result = callback();
    addProfileEntry(profiler, name, startedAtMs, details);
    return result;
  } catch (error) {
    addProfileEntry(profiler, name, startedAtMs, details, error);
    throw error;
  }
};

const profileAsync = async <T>(
  profiler: CaptureProfiler | undefined,
  name: string,
  callback: () => Promise<T>,
  details?: ProfileDetails
) => {
  if (!profiler) {
    return await callback();
  }

  const startedAtMs = performance.now();

  try {
    const result = await callback();
    addProfileEntry(profiler, name, startedAtMs, details);
    return result;
  } catch (error) {
    addProfileEntry(profiler, name, startedAtMs, details, error);
    throw error;
  }
};

const saveProfiler = async (
  profiler: CaptureProfiler | undefined,
  summary: ProfileDetails = {}
) => {
  if (!profiler) {
    return undefined;
  }

  const source = sanitizeFilenameSegment(profiler.sourceId);
  const profilePath = path.join(profileDirectory, `profile-${profiler.id}-${source}.json`);

  try {
    await mkdir(profileDirectory, { recursive: true });
    await writeFile(
      profilePath,
      JSON.stringify(
        {
          savedAt: new Date().toISOString(),
          analyzerBuild,
          sourceId: profiler.sourceId,
          totalDurationMs: Math.round((performance.now() - profiler.startedAtMs) * 100) / 100,
          summary,
          entries: profiler.entries
        },
        null,
        2
      )
    );
    console.log(`[debug] saved capture profile: ${profilePath}`);
    return profilePath;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not save capture profile.";
    console.log(`[debug] capture profile save failed: ${message}`);
    return undefined;
  }
};

const getKind = (sourceId: string): SourceKind =>
  sourceId.startsWith("screen:") ? "screen" : sourceId.startsWith("camera:") ? "camera" : "window";

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const normalizeStockfishMoveTime = (moveTimeMs: number) =>
  clamp(Math.round(moveTimeMs / stockfishMoveTimeStepMs) * stockfishMoveTimeStepMs, stockfishMinMoveTimeMs, stockfishMaxMoveTimeMs);

const normalizeMaiaRating = (rating: number) =>
  clamp(Math.round(rating / maiaRatingStep) * maiaRatingStep, maiaMinRating, maiaMaxRating);

const getStockfishSettings = (): StockfishSettings => ({
  moveTimeMs: stockfishMoveTimeMs,
  minMoveTimeMs: stockfishMinMoveTimeMs,
  maxMoveTimeMs: stockfishMaxMoveTimeMs,
  stepMs: stockfishMoveTimeStepMs
});

const getMaiaSettings = (): MaiaSettings => ({
  rating: maiaRating,
  minRating: maiaMinRating,
  maxRating: maiaMaxRating,
  stepRating: maiaRatingStep,
  availableRatings: [...maiaAvailableRatings]
});

const getEngineSettings = (): EngineSettings => ({
  stockfish: getStockfishSettings(),
  maia: getMaiaSettings()
});

const getErrorCode = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;

const getLocalApiSettings = (): LocalApiSettings => {
  const port = localApiPort || localApiPreferredPort;
  const baseUrl = `http://localhost:${port}`;

  return {
    port,
    baseUrl,
    evalUrl: `${baseUrl}/eval`
  };
};

const getHiddenModeSettings = (): HiddenModeSettings => ({
  enabled: hiddenModeSupported && hiddenModeEnabled,
  supported: hiddenModeSupported
});

const applyHiddenModeToWindow = (win: BrowserWindow) => {
  if (!hiddenModeSupported) {
    return;
  }

  win.setContentProtection(hiddenModeEnabled);
};

const applyHiddenModeToAllWindows = () => {
  for (const win of BrowserWindow.getAllWindows()) {
    applyHiddenModeToWindow(win);
  }
};

const cloneBoard = (board: CapturedBoard): CapturedBoard => ({
  ...board,
  detection: { ...board.detection },
  fen: board.fen ? { ...board.fen } : undefined,
  bestMove: board.bestMove ? { ...board.bestMove } : undefined,
  stockfishMove: board.stockfishMove ? { ...board.stockfishMove } : undefined,
  maiaMove: board.maiaMove ? { ...board.maiaMove } : undefined,
  evaluation: board.evaluation ? { ...board.evaluation } : undefined
});

const getCachedRecognizedBoard = (sourceId: string) => {
  const board = recognizedBoardCache.get(sourceId);
  return board ? cloneBoard(board) : undefined;
};

const cacheRecognizedBoard = (sourceId: string, board: CapturedBoard) => {
  if (!board.fen) {
    recognizedBoardCache.delete(sourceId);
    return;
  }

  const cachedBoard = cloneBoard(board);
  delete cachedBoard.skipped;
  delete cachedBoard.skipReason;
  delete cachedBoard.difference;
  recognizedBoardCache.set(sourceId, cachedBoard);
};

const hasCachedFen = (sourceId: string, fen: string) => recognizedBoardCache.get(sourceId)?.fen?.value === fen;

const isDetectionInsideImage = (image: Electron.NativeImage, detection: BoardDetection) => {
  const size = image.getSize();

  return (
    detection.width > 0 &&
    detection.height > 0 &&
    detection.x >= 0 &&
    detection.y >= 0 &&
    detection.x + detection.width <= size.width &&
    detection.y + detection.height <= size.height
  );
};

type BoardPerspective = Extract<BoardDetection["orientation"], "white" | "black">;
type BoardStabilityState = {
  previousFingerprint: Uint8Array;
  stableFrames: number;
  analyzedFingerprint?: Uint8Array;
};
type BoardStabilityResult = {
  status: "unstable" | "unchanged" | "stable";
  difference: number;
  stableFrames: number;
};
const bottomFileOcrCache = new Map<string, string>();
const boardStabilityCache = new Map<string, BoardStabilityState>();

const getBoardFingerprint = (image: Electron.NativeImage, detection: BoardDetection) => {
  const normalized = image.crop(detection).resize({
    width: boardDiffPixels,
    height: boardDiffPixels,
    quality: "best"
  });
  const bitmap = normalized.toBitmap({ scaleFactor: 1 });
  const fingerprint = new Uint8Array(boardDiffPixels * boardDiffPixels);

  for (let index = 0; index < fingerprint.length; index += 1) {
    const pixelOffset = index * 4;
    const blue = bitmap[pixelOffset];
    const green = bitmap[pixelOffset + 1];
    const red = bitmap[pixelOffset + 2];
    fingerprint[index] = Math.round(red * 0.299 + green * 0.587 + blue * 0.114);
  }

  return fingerprint;
};

const getBoardDifference = (previous: Uint8Array | undefined, current: Uint8Array) => {
  if (!previous || previous.length !== current.length) {
    return 1;
  }

  let changedPixels = 0;

  for (let index = 0; index < current.length; index += 1) {
    if (Math.abs(current[index] - previous[index]) > channelChangeThreshold) {
      changedPixels += 1;
    }
  }

  return changedPixels / current.length;
};

const getBoardStability = (cacheKey: string, fingerprint: Uint8Array): BoardStabilityResult => {
  const state = boardStabilityCache.get(cacheKey);

  if (!state) {
    boardStabilityCache.set(cacheKey, {
      previousFingerprint: fingerprint,
      stableFrames: 1
    });

    return {
      status: "unstable",
      difference: 1,
      stableFrames: 1
    };
  }

  const frameDifference = getBoardDifference(state.previousFingerprint, fingerprint);
  state.previousFingerprint = fingerprint;
  state.stableFrames = frameDifference <= boardChangeThreshold ? state.stableFrames + 1 : 1;

  if (state.stableFrames < boardStableFrameRequirement) {
    return {
      status: "unstable",
      difference: frameDifference,
      stableFrames: state.stableFrames
    };
  }

  const analyzedDifference = getBoardDifference(state.analyzedFingerprint, fingerprint);

  if (analyzedDifference <= boardChangeThreshold) {
    return {
      status: "unchanged",
      difference: analyzedDifference,
      stableFrames: state.stableFrames
    };
  }

  return {
    status: "stable",
    difference: frameDifference,
    stableFrames: state.stableFrames
  };
};

const resetBoardStabilityBaseline = (
  cacheKey: string | undefined,
  image: Electron.NativeImage,
  detection: BoardDetection
) => {
  if (!cacheKey) {
    return;
  }

  const fingerprint = getBoardFingerprint(image, detection);
  const state = boardStabilityCache.get(cacheKey);

  if (!state) {
    boardStabilityCache.set(cacheKey, {
      previousFingerprint: fingerprint,
      stableFrames: boardStableFrameRequirement,
      analyzedFingerprint: fingerprint
    });
  } else {
    state.previousFingerprint = fingerprint;
    state.analyzedFingerprint = fingerprint;
    state.stableFrames = Math.max(state.stableFrames, boardStableFrameRequirement);
  }
};

const checkBoardStability = (
  image: Electron.NativeImage,
  detection: BoardDetection,
  changeCacheKey: string,
  source: "cached" | "detected"
): BoardStabilityResult => {
  const stabilityStartedAt = performance.now();
  const fingerprint = getBoardFingerprint(image, detection);
  const stability = getBoardStability(changeCacheKey, fingerprint);

  console.log(
    `[capture] ${source} board stability: ${stability.status}, diff ${(stability.difference * 100).toFixed(2)}%, ` +
      `${stability.stableFrames}/${boardStableFrameRequirement} frame(s) (${formatMs(stabilityStartedAt)})`
  );

  return stability;
};

const getWindowsExecutableExtensions = () => {
  const pathExt = process.env.PATHEXT;

  if (!pathExt) {
    return [".exe", ".cmd", ".bat"];
  }

  return pathExt
    .split(path.delimiter)
    .map((extension) => extension.toLowerCase())
    .filter(Boolean);
};

const getPathCommand = (command: string) => {
  const extensions =
    process.platform === "win32" && !path.extname(command)
      ? ["", ...getWindowsExecutableExtensions()]
      : [""];

  for (const directory of process.env.PATH?.split(path.delimiter) ?? []) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);

      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return undefined;
};

const getConfiguredCommand = (environmentVariable: string) => {
  const configuredCommand = process.env[environmentVariable]?.trim();

  if (!configuredCommand) {
    return undefined;
  }

  if (path.isAbsolute(configuredCommand) || configuredCommand.includes("/") || configuredCommand.includes("\\")) {
    return existsSync(configuredCommand) ? configuredCommand : undefined;
  }

  return getPathCommand(configuredCommand) ?? configuredCommand;
};

const getOptionalExecutable = (
  command: string,
  environmentVariable: string,
  fallbackPaths: readonly string[]
) =>
  getConfiguredCommand(environmentVariable) ??
  getPathCommand(command) ??
  fallbackPaths.find((candidate) => existsSync(candidate));

const getTesseractCommand = () => {
  return getOptionalExecutable("tesseract", "TESSERACT_PATH", tesseractFallbackPaths);
};

const runTesseract = (imagePath: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const command = getTesseractCommand();

    if (!command) {
      reject(new Error("Tesseract is not installed."));
      return;
    }

    const ocr = spawn(command, [
      imagePath,
      "stdout",
      "--psm",
      "10",
      "--oem",
      "1",
      "-l",
      "eng",
      "-c",
      "tessedit_char_whitelist=abcdefghABCDEFGH"
    ]);
    let output = "";
    let errorOutput = "";
    const timeout = setTimeout(() => {
      ocr.kill();
      reject(new Error("Tesseract did not return in time."));
    }, 2500);

    ocr.stdout.setEncoding("utf8");
    ocr.stderr.setEncoding("utf8");
    ocr.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    ocr.stderr.on("data", (chunk: string) => {
      errorOutput += chunk;
    });
    ocr.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    ocr.once("close", (code) => {
      clearTimeout(timeout);

      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(errorOutput.trim() || "Tesseract failed."));
      }
    });
  });

const normalizeFileLabel = (text: string) => {
  const match = /[a-h]/i.exec(text);
  return match?.[0].toLowerCase();
};

const getCachedBottomFileOcr = (hash: string) => {
  const label = bottomFileOcrCache.get(hash);

  if (label === undefined) {
    return undefined;
  }

  bottomFileOcrCache.delete(hash);
  bottomFileOcrCache.set(hash, label);
  return label;
};

const setCachedBottomFileOcr = (hash: string, label: string) => {
  if (bottomFileOcrCache.has(hash)) {
    bottomFileOcrCache.delete(hash);
  }

  bottomFileOcrCache.set(hash, label);

  while (bottomFileOcrCache.size > ocrCacheLimit) {
    const oldestHash = bottomFileOcrCache.keys().next().value;

    if (!oldestHash) {
      break;
    }

    bottomFileOcrCache.delete(oldestHash);
  }
};

const cropBottomFileLabel = (image: Electron.NativeImage, detection: BoardDetection, column: number) => {
  const cellSize = detection.width / 8;
  const crop = image.crop({
    x: Math.round(detection.x + column * cellSize),
    y: Math.round(detection.y + detection.height - cellSize * 0.28),
    width: Math.round(cellSize * 0.64),
    height: Math.round(cellSize * 0.26)
  });

  return crop.resize({
    width: 220,
    height: 120,
    quality: "best"
  });
};

const saveBoardCrop = async (
  image: Electron.NativeImage,
  detection: BoardDetection,
  context: {
    sourceId?: string;
    fen?: string;
    confidence?: number;
    reason: "recognized" | "low-confidence" | "fen-error";
  },
  profiler?: CaptureProfiler
) => {
  if (!debugMode) {
    return undefined;
  }

  const startedAtMs = performance.now();

  try {
    const crop = image.crop(detection);

    if (crop.isEmpty()) {
      return undefined;
    }

    const png = crop.toPNG();
    const sha256 = createHash("sha256").update(png).digest("hex");
    const hash = sha256.slice(0, 12);
    const source = sanitizeFilenameSegment(context.sourceId ?? "manual");
    const orientation = sanitizeFilenameSegment(detection.orientation);
    const confidence =
      context.confidence === undefined ? "unknown" : String(Math.round(context.confidence * 100)).padStart(3, "0");
    const basename = [
      "board",
      formatTimestamp(),
      context.reason,
      source,
      orientation,
      `conf-${confidence}`,
      hash
    ].join("-");
    const pngPath = path.join(boardCropDirectory, `${basename}.png`);
    const metadataPath = path.join(boardCropDirectory, `${basename}.json`);

    await mkdir(boardCropDirectory, { recursive: true });
    await Promise.all([
      writeFile(pngPath, png),
      writeFile(
        metadataPath,
        JSON.stringify(
          {
            savedAt: new Date().toISOString(),
            analyzerBuild,
            reason: context.reason,
            sourceId: context.sourceId,
            fen: context.fen,
            confidence: context.confidence,
            detection,
            image: {
              width: crop.getSize().width,
              height: crop.getSize().height,
              sha256
            }
          },
          null,
          2
        )
      )
    ]);
    console.log(`[capture] saved board crop: ${pngPath}`);
    addProfileEntry(profiler, "saveBoardCrop", startedAtMs, {
      reason: context.reason,
      orientation: detection.orientation,
      confidence: context.confidence
    });
    return pngPath;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not save board crop.";
    console.log(`[capture] board crop save failed: ${message}`);
    addProfileEntry(profiler, "saveBoardCrop", startedAtMs, { reason: context.reason }, error);
    return undefined;
  }
};

const detectOrientationFromBottomFiles = async (
  image: Electron.NativeImage,
  detection: BoardDetection,
  profiler?: CaptureProfiler
): Promise<{ orientation: BoardPerspective; confidence: number; labels: string[] } | undefined> => {
  if (!getTesseractCommand()) {
    return undefined;
  }

  let ocrDirectory: string | undefined;
  let cacheHits = 0;

  const getOcrDirectory = async () => {
    ocrDirectory ??= await mkdtemp(path.join(tmpdir(), "chess-board-ocr-"));
    return ocrDirectory;
  };

  try {
    const labels = await Promise.all(
      [0, 1, 2].map(async (column) => {
        const labelImage = profileSync(profiler, "cropBottomFileLabel", () => cropBottomFileLabel(image, detection, column), {
          column
        });

        if (labelImage.isEmpty()) {
          return "";
        }

        const png = labelImage.toPNG();
        const hash = createHash("sha256").update(png).digest("hex");
        const cachedLabel = getCachedBottomFileOcr(hash);

        if (cachedLabel !== undefined) {
          cacheHits += 1;
          return cachedLabel;
        }

        const labelPath = path.join(await getOcrDirectory(), `file-${column}.png`);
        await writeFile(labelPath, png);
        const text = await profileAsync(profiler, "runTesseract", () => runTesseract(labelPath), { column });
        const label = normalizeFileLabel(text) ?? "";
        setCachedBottomFileOcr(hash, label);
        return label;
      })
    );
    const whiteFiles = ["a", "b", "c"];
    const blackFiles = ["h", "g", "f"];
    const whiteVotes = labels.filter((label, index) => label === whiteFiles[index]).length;
    const blackVotes = labels.filter((label, index) => label === blackFiles[index]).length;

    console.log(
      `[capture] bottom file OCR: ${labels.map((label) => label || "?").join(",")} (${cacheHits}/3 cached)`
    );

    if (whiteVotes >= 2 || blackVotes >= 2) {
      const confidence = Math.max(whiteVotes, blackVotes) === 3 ? 1 : 0.9;

      return whiteVotes > blackVotes
        ? { orientation: "white", confidence, labels }
        : { orientation: "black", confidence, labels };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not OCR bottom file labels.";
    console.log(`[capture] bottom file OCR failed: ${message}`);
  } finally {
    if (ocrDirectory) {
      await rm(ocrDirectory, { recursive: true, force: true });
    }
  }

  return undefined;
};

const refineDetectionOrientation = async (
  image: Electron.NativeImage,
  detection: BoardDetection,
  profiler?: CaptureProfiler
) => {
  const fileOrientation = await profileAsync(
    profiler,
    "detectOrientationFromBottomFiles",
    () => detectOrientationFromBottomFiles(image, detection, profiler),
    { orientation: detection.orientation, orientationConfidence: detection.orientationConfidence }
  );

  if (!fileOrientation) {
    return detection;
  }

  console.log(
    `[capture] bottom file OCR orientation: ${fileOrientation.orientation} (${Math.round(fileOrientation.confidence * 100)}% confidence)`
  );

  return {
    ...detection,
    orientation: fileOrientation.orientation,
    orientationConfidence: Math.max(detection.orientationConfidence, fileOrientation.confidence)
  };
};

const getCandidateDetections = (detection: BoardDetection, imageSize: { width: number; height: number }) => {
  const cellSize = detection.width / 8;
  const xOffsets = [0, cellSize / 4, -cellSize / 4, cellSize / 2, -cellSize / 2];
  const candidates: BoardDetection[] = [];
  const seen = new Set<string>();

  for (const xOffset of xOffsets) {
    const x = clamp(Math.round(detection.x + xOffset), 0, Math.max(0, imageSize.width - detection.width));
    const key = `${x},${detection.y},${detection.width}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    candidates.push({ ...detection, x });
  }

  return candidates;
};

const getCandidateOrientations = (detection: BoardDetection) => {
  if (detection.orientation !== "unknown" && detection.orientationConfidence >= boardOrientationConfidenceThreshold) {
    return [detection.orientation];
  }

  if (detection.orientation === "black") {
    return ["black", "white"] as const;
  }

  return ["white", "black"] as const;
};

const refineCandidateOrientationFromBoardImage = (
  candidate: BoardDetection,
  boardImage: Electron.NativeImage,
  profiler?: CaptureProfiler
): BoardDetection => {
  if (candidate.orientation !== "unknown" && candidate.orientationConfidence >= boardOrientationConfidenceThreshold) {
    return candidate;
  }

  const orientation = profileSync(
    profiler,
    "detectBoardImageOrientation",
    () => detectBoardImageOrientation(boardImage),
    { orientation: candidate.orientation, orientationConfidence: candidate.orientationConfidence }
  );

  if (
    orientation.orientation === "unknown" ||
    orientation.orientationConfidence < boardOrientationConfidenceThreshold
  ) {
    return candidate;
  }

  console.log(
    `[capture] board crop orientation: ${orientation.orientation} ` +
      `(${Math.round(orientation.orientationConfidence * 100)}% confidence)`
  );

  return {
    ...candidate,
    orientation: orientation.orientation,
    orientationConfidence: orientation.orientationConfidence
  };
};

type RecognitionScore = {
  total: number;
  pieceCount: number;
  edgePieceScore: number;
  homeRankColorScore: number;
  leftGutterPenalty: number;
  rightGutterPenalty: number;
};

const getHomeRankColorScore = (labels: readonly number[]) => {
  let score = 0;

  for (let index = 0; index < labels.length; index += 1) {
    const label = labels[index];

    if (label === 0) {
      continue;
    }

    const rank = Math.floor(index / 8);
    const isWhitePiece = label >= 1 && label <= 6;
    const isBlackPiece = label >= 7 && label <= 12;

    if (rank <= 1) {
      score += isWhitePiece ? 1 : isBlackPiece ? -1 : 0;
    } else if (rank >= 6) {
      score += isBlackPiece ? 1 : isWhitePiece ? -1 : 0;
    }
  }

  return score;
};

const scoreRecognition = (recognition: FenRecognition): RecognitionScore => {
  const fileCounts = Array.from({ length: 8 }, () => 0);
  let pieceCount = 0;

  for (let index = 0; index < recognition.labels.length; index += 1) {
    if (recognition.labels[index] === 0) {
      continue;
    }

    pieceCount += 1;
    fileCounts[index % 8] += 1;
  }

  const leftGutterPenalty = fileCounts[0] === 0 && fileCounts[1] >= 2 ? 40 : 0;
  const rightGutterPenalty = fileCounts[7] === 0 && fileCounts[6] >= 2 ? 40 : 0;
  const edgePieceScore = Math.min(fileCounts[0], fileCounts[7]) * 10;
  const homeRankColorScore = getHomeRankColorScore(recognition.labels);

  return {
    total:
      recognition.confidence * 1000 +
      pieceCount * 8 +
      edgePieceScore +
      homeRankColorScore * homeRankColorScoreWeight -
      leftGutterPenalty -
      rightGutterPenalty,
    pieceCount,
    edgePieceScore,
    homeRankColorScore,
    leftGutterPenalty,
    rightGutterPenalty
  };
};

const getStockfishCommand = () => {
  return getOptionalExecutable("stockfish", "STOCKFISH_PATH", stockfishFallbackPaths) ?? "stockfish";
};

const getLc0Command = () => {
  return getOptionalExecutable("lc0", "LC0_PATH", lc0FallbackPaths);
};

const getMaiaWeightsPath = (rating: number) => path.join(maiaWeightsDirectory, `maia-${rating}.pb.gz`);

const getMaiaWeightsUrl = (rating: number) =>
  `https://raw.githubusercontent.com/CSSLab/maia-chess/master/maia_weights/maia-${rating}.pb.gz`;

const ensureMaiaWeights = async (rating: number) => {
  const weightsPath = getMaiaWeightsPath(rating);

  if (existsSync(weightsPath)) {
    return weightsPath;
  }

  await mkdir(maiaWeightsDirectory, { recursive: true });

  const downloadUrl = getMaiaWeightsUrl(rating);
  const temporaryPath = `${weightsPath}.download`;
  console.log(`[capture] downloading Maia ${rating} weights`);
  const response = await fetch(downloadUrl);

  if (!response.ok) {
    throw new Error(`Could not download Maia ${rating} weights (${response.status}).`);
  }

  await writeFile(temporaryPath, Buffer.from(await response.arrayBuffer()));
  await rename(temporaryPath, weightsPath);
  return weightsPath;
};

type UciMove = {
  uci: string;
  from: string;
  to: string;
  promotion?: string;
};

const getSanMove = (fen: string, move: UciMove) => {
  try {
    const chess = new Chess(fen);
    const playedMove = chess.move({
      from: move.from,
      to: move.to,
      promotion: move.promotion
    });

    return playedMove.san;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not format SAN move.";
    console.log(`[capture] SAN conversion failed for ${move.uci}: ${message}`);
    return move.uci;
  }
};

const parseBestMove = (bestMove: string, fen: string) => {
  const match = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/.exec(bestMove);

  if (!match) {
    return undefined;
  }

  const move: UciMove = {
    uci: bestMove,
    from: match[1],
    to: match[2],
    promotion: match[3]
  };

  return {
    ...move,
    san: getSanMove(fen, move)
  };
};

type BestMove = NonNullable<NonNullable<CaptureResult["board"]>["bestMove"]>;
type EngineEvaluation = NonNullable<NonNullable<CaptureResult["board"]>["evaluation"]>;
type EngineAnalysis = {
  bestMove: BestMove;
  evaluation?: EngineEvaluation;
};

type EngineAnalysisResult = {
  stockfish?: EngineAnalysis;
  maia?: EngineAnalysis;
  stockfishError?: string;
  maiaError?: string;
};

type LatestAnalysisState = {
  status: "empty" | "pending" | "ready" | "error";
  sourceId?: string;
  fen?: string;
  bestMove?: BestMove;
  stockfishMove?: BestMove;
  maiaMove?: BestMove;
  evaluation?: EngineEvaluation;
  boardSide?: BoardPerspective;
  message?: string;
  updatedAt?: string;
};

let latestAnalysisState: LatestAnalysisState = {
  status: "empty",
  message: "No board has been analyzed yet."
};

const nowIso = () => new Date().toISOString();

const getBoardSide = (orientation: BoardDetection["orientation"]): BoardPerspective | undefined =>
  orientation === "white" || orientation === "black" ? orientation : undefined;

const markLatestAnalysisPending = (
  sourceId: string,
  fen: string,
  orientation: BoardDetection["orientation"]
) => {
  const isSamePosition = latestAnalysisState.fen === fen;
  const boardSide = getBoardSide(orientation) ?? (isSamePosition ? latestAnalysisState.boardSide : undefined);

  latestAnalysisState = {
    ...(isSamePosition ? latestAnalysisState : {}),
    status: "pending",
    sourceId,
    fen,
    boardSide,
    message: isSamePosition && (latestAnalysisState.bestMove || latestAnalysisState.maiaMove || latestAnalysisState.evaluation)
      ? "Continuing analysis for the current board."
      : "Engine analysis is pending.",
    updatedAt: nowIso()
  };
};

const markLatestAnalysisReady = (
  sourceId: string,
  fen: string,
  orientation: BoardDetection["orientation"],
  analysis: EngineAnalysisResult
) => {
  latestAnalysisState = {
    status: "ready",
    sourceId,
    fen,
    bestMove: analysis.stockfish?.bestMove,
    stockfishMove: analysis.stockfish?.bestMove,
    maiaMove: analysis.maia?.bestMove,
    evaluation: analysis.stockfish?.evaluation,
    boardSide: getBoardSide(orientation),
    message: "Engine analysis is ready.",
    updatedAt: nowIso()
  };
};

const markLatestAnalysisError = (
  sourceId: string,
  fen: string,
  orientation: BoardDetection["orientation"],
  message: string
) => {
  const hasCurrentResult =
    latestAnalysisState.fen === fen &&
    (latestAnalysisState.bestMove || latestAnalysisState.maiaMove || latestAnalysisState.evaluation);
  const boardSide = getBoardSide(orientation) ?? (hasCurrentResult ? latestAnalysisState.boardSide : undefined);

  latestAnalysisState = {
    ...(hasCurrentResult ? latestAnalysisState : {}),
    status: "error",
    sourceId,
    fen,
    boardSide,
    message,
    updatedAt: nowIso()
  };
};

const clearLatestAnalysis = (message: string) => {
  latestAnalysisState = {
    status: "empty",
    message,
    updatedAt: nowIso()
  };
};

const getUnavailableStatusCode = () => {
  if (latestAnalysisState.status === "pending") {
    return 202;
  }

  if (latestAnalysisState.status === "error") {
    return 500;
  }

  return 404;
};

type LocalApiAnalysisResponse = {
  top: string | null;
  stockfish: string | null;
  maia: string | null;
  eval: string | null;
  board_side: BoardPerspective | null;
};

const getLocalApiAnalysisResponse = (): LocalApiAnalysisResponse => ({
  top: latestAnalysisState.stockfishMove?.san ?? null,
  stockfish: latestAnalysisState.stockfishMove?.san ?? null,
  maia: latestAnalysisState.maiaMove?.san ?? null,
  eval: latestAnalysisState.evaluation?.display ?? null,
  board_side: latestAnalysisState.boardSide ?? null
});

const writeTextResponse = (response: ServerResponse, statusCode: number, body: string, includeBody: boolean) => {
  response.writeHead(statusCode, {
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
    "content-type": "text/plain; charset=utf-8"
  });
  response.end(includeBody ? body : undefined);
};

const writeJsonResponse = (
  response: ServerResponse,
  statusCode: number,
  body: LocalApiAnalysisResponse,
  includeBody: boolean
) => {
  response.writeHead(statusCode, {
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8"
  });
  response.end(includeBody ? JSON.stringify(body) : undefined);
};

const handleLocalApiRequest = (request: IncomingMessage, response: ServerResponse) => {
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "GET, HEAD, OPTIONS",
      "access-control-allow-origin": "*",
      "cache-control": "no-store"
    });
    response.end();
    return;
  }

  const includeBody = request.method !== "HEAD";

  if (request.method !== "GET" && request.method !== "HEAD") {
    writeTextResponse(response, 405, "Only GET and HEAD requests are supported.", includeBody);
    return;
  }

  const requestUrl = new URL(request.url ?? "/", `http://localhost:${localApiPort || localApiPreferredPort}`);
  const pathname = requestUrl.pathname.replace(/\/$/, "") || "/";

  if (pathname === "/eval") {
    const body = getLocalApiAnalysisResponse();
    const statusCode = body.stockfish || body.maia || body.eval ? 200 : getUnavailableStatusCode();
    writeJsonResponse(response, statusCode, body, includeBody);
    return;
  }

  writeTextResponse(response, 404, "Use /eval.", includeBody);
};

const listenOnLocalApiPort = (port: number) =>
  new Promise<void>((resolve, reject) => {
    const server = createServer(handleLocalApiRequest);

    const handleError = (error: Error) => {
      server.close();
      reject(error);
    };

    server.once("error", handleError);
    server.listen(port, localApiHost, () => {
      server.off("error", handleError);
      localApiServer = server;
      const address = server.address();
      localApiPort = typeof address === "object" && address ? address.port : port;
      const settings = getLocalApiSettings();
      console.log(`[local-api] listening at ${settings.baseUrl} (${settings.evalUrl})`);
      resolve();
    });
  });

const startLocalApiServer = async () => {
  try {
    await listenOnLocalApiPort(localApiPreferredPort);
  } catch (error) {
    if (getErrorCode(error) !== "EADDRINUSE") {
      throw error;
    }

    console.log(`[local-api] port ${localApiPreferredPort} is busy; choosing a random port`);
    await listenOnLocalApiPort(0);
  }
};

class SupersededEngineAnalysisError extends Error {
  constructor(engineLabel: string) {
    super(`${engineLabel} analysis was superseded by a newer position.`);
    this.name = "SupersededEngineAnalysisError";
  }
}

const getFenActiveColor = (fen: string) => (fen.trim().split(/\s+/)[1] === "b" ? "black" : "white");

const formatCentipawnEvaluation = (whiteValue: number) => {
  if (Math.abs(whiteValue) < 5) {
    return "0.0";
  }

  const pawnValue = whiteValue / 100;
  const precision = Math.abs(pawnValue) >= 10 ? 0 : 1;
  return `${pawnValue > 0 ? "+" : ""}${pawnValue.toFixed(precision)}`;
};

const formatMateEvaluation = (whiteValue: number) => {
  const mateIn = Math.abs(whiteValue);
  return `${whiteValue < 0 ? "-" : ""}M${mateIn}`;
};

const parseUciEvaluation = (line: string, fen: string): EngineEvaluation | undefined => {
  const match = /\bscore\s+(cp|mate)\s+(-?\d+)/.exec(line);

  if (!match) {
    return undefined;
  }

  const type = match[1] as EngineEvaluation["type"];
  const rawValue = Number(match[2]);

  if (!Number.isFinite(rawValue)) {
    return undefined;
  }

  const whiteValue = getFenActiveColor(fen) === "black" ? -rawValue : rawValue;

  return {
    type,
    whiteValue,
    display: type === "cp" ? formatCentipawnEvaluation(whiteValue) : formatMateEvaluation(whiteValue)
  };
};

type UciEngineLaunch = {
  command: string;
  args?: string[];
};

type UciAnalyzerOptions = {
  label: string;
  createLaunch: () => UciEngineLaunch | Promise<UciEngineLaunch>;
  getGoCommand: () => string;
  timeoutMs: number;
};

type UciEngineJob = {
  fen: string;
  resolve: (analysis: EngineAnalysis) => void;
  reject: (error: Error) => void;
  timeout?: NodeJS.Timeout;
};

class PersistentUciAnalyzer {
  private engine?: ChildProcessWithoutNullStreams;
  private bootPromise?: Promise<void>;
  private resolveBoot?: () => void;
  private rejectBoot?: (error: Error) => void;
  private output = "";
  private currentJob?: UciEngineJob;
  private currentEvaluation?: EngineEvaluation;
  private activeFen?: string;
  private queue: UciEngineJob[] = [];
  private waitingForReady = false;
  private isStopping = false;

  constructor(private readonly options: UciAnalyzerOptions) {}

  findBestMove(fen: string): Promise<EngineAnalysis> {
    return new Promise((resolve, reject) => {
      const supersededError = new SupersededEngineAnalysisError(this.options.label);
      this.rejectQueuedJobs(supersededError);
      this.queue.push({ fen, resolve, reject });

      if (this.currentJob && this.currentJob.fen !== fen) {
        console.log(`[capture] dropped ${this.options.label} analysis for superseded position`);
        this.failCurrentJob(supersededError, true);
      }

      void this.pump();
    });
  }

  dispose(error = new Error(`${this.options.label} stopped.`)) {
    this.isStopping = true;
    this.rejectQueuedJobs(error);
    this.rejectCurrentJob(error);
    this.stopEngine();
  }

  private stopEngine() {
    const engine = this.engine;
    this.engine = undefined;
    this.bootPromise = undefined;
    this.activeFen = undefined;
    this.output = "";
    this.resolveBoot = undefined;
    this.rejectBoot = undefined;
    if (engine && !engine.killed) {
      engine.kill();
    }
  }

  private rejectQueuedJobs(error: Error) {
    const jobs = this.queue;
    this.queue = [];

    for (const job of jobs) {
      if (job.timeout) {
        clearTimeout(job.timeout);
      }

      job.reject(error);
    }
  }

  private rejectCurrentJob(error: Error) {
    const job = this.currentJob;
    this.currentJob = undefined;
    this.currentEvaluation = undefined;
    this.waitingForReady = false;

    if (job?.timeout) {
      clearTimeout(job.timeout);
    }

    job?.reject(error);
  }

  private async pump() {
    if (this.currentJob || this.queue.length === 0) {
      return;
    }

    try {
      await this.ensureStarted();
    } catch (error) {
      const job = this.queue.shift();
      const message = error instanceof Error ? error.message : `Could not start ${this.options.label}.`;
      job?.reject(new Error(message));
      void this.pump();
      return;
    }

    const job = this.queue.shift();

    if (!job || !this.engine) {
      return;
    }

    this.currentJob = job;
    this.currentEvaluation = undefined;
    this.waitingForReady = true;
    job.timeout = setTimeout(() => {
      this.failCurrentJob(new Error(`${this.options.label} did not return a move in time.`), true);
    }, this.options.timeoutMs);

    if (this.activeFen !== job.fen) {
      this.engine.stdin.write("ucinewgame\n");
      this.activeFen = job.fen;
    }

    this.engine.stdin.write("isready\n");
  }

  private ensureStarted() {
    if (this.engine || this.bootPromise) {
      return this.bootPromise ?? Promise.resolve();
    }

    this.isStopping = false;
    this.output = "";
    this.bootPromise = this.startEngine().catch((error) => {
      this.engine = undefined;
      this.bootPromise = undefined;
      this.activeFen = undefined;
      this.output = "";
      this.rejectBoot = undefined;
      this.resolveBoot = undefined;
      throw error;
    });

    return this.bootPromise;
  }

  private async startEngine() {
    const launch = await this.options.createLaunch();

    if (this.isStopping) {
      throw new Error(`${this.options.label} was stopped before it started.`);
    }

    await new Promise<void>((resolve, reject) => {
      this.resolveBoot = resolve;
      this.rejectBoot = reject;

      const engine = spawn(launch.command, launch.args ?? [], { stdio: "pipe" });
      this.engine = engine;
      engine.stdout.setEncoding("utf8");
      engine.stderr.setEncoding("utf8");
      engine.stdout.on("data", (chunk: string) => this.handleOutput(chunk));
      engine.once("error", (error) => this.handleEngineFailure(engine, error));
      engine.once("close", () => this.handleEngineClosed(engine));
      engine.stdin.write("uci\n");
    });
  }

  private handleOutput(chunk: string) {
    this.output += chunk;
    const lines = this.output.split(/\r?\n/);
    this.output = lines.pop() ?? "";

    for (const line of lines) {
      this.handleLine(line.trim());
    }
  }

  private handleLine(line: string) {
    if (!line) {
      return;
    }

    if (line === "uciok") {
      this.resolveBoot?.();
      this.resolveBoot = undefined;
      this.rejectBoot = undefined;
      return;
    }

    if (line === "readyok" && this.currentJob && this.waitingForReady && this.engine) {
      this.waitingForReady = false;
      this.engine.stdin.write(`position fen ${this.currentJob.fen}\n`);
      this.engine.stdin.write(`${this.options.getGoCommand()}\n`);
      return;
    }

    if (line.startsWith("info ") && this.currentJob) {
      const evaluation = parseUciEvaluation(line, this.currentJob.fen);

      if (evaluation) {
        this.currentEvaluation = evaluation;
      }

      return;
    }

    if (line.startsWith("bestmove ") && this.currentJob) {
      const bestMove = line.split(/\s+/)[1];
      const job = this.currentJob;
      const evaluation = this.currentEvaluation;
      const parsedMove = bestMove && bestMove !== "(none)" ? parseBestMove(bestMove, job.fen) : undefined;
      this.currentJob = undefined;
      this.currentEvaluation = undefined;
      this.waitingForReady = false;

      if (job.timeout) {
        clearTimeout(job.timeout);
      }

      if (parsedMove) {
        job.resolve({ bestMove: parsedMove, evaluation });
      } else {
        job.reject(new Error(`${this.options.label} did not find a legal move.`));
      }

      void this.pump();
    }
  }

  private failCurrentJob(error: Error, restartEngine: boolean) {
    this.rejectCurrentJob(error);

    if (restartEngine) {
      this.isStopping = true;
      this.stopEngine();
    }

    void this.pump();
  }

  private handleEngineFailure(engine: ChildProcessWithoutNullStreams, error: Error) {
    if (this.engine !== engine) {
      return;
    }

    this.rejectBoot?.(error);
    this.rejectBoot = undefined;
    this.resolveBoot = undefined;
    this.engine = undefined;
    this.bootPromise = undefined;
    this.activeFen = undefined;
    this.output = "";
    this.failCurrentJob(error, false);
  }

  private handleEngineClosed(engine: ChildProcessWithoutNullStreams) {
    if (this.engine !== engine) {
      return;
    }

    const error = new Error(`${this.options.label} stopped unexpectedly.`);
    this.engine = undefined;
    this.bootPromise = undefined;
    this.activeFen = undefined;
    this.output = "";
    this.rejectBoot?.(error);
    this.rejectBoot = undefined;
    this.resolveBoot = undefined;

    if (!this.isStopping) {
      this.failCurrentJob(error, false);
    }
  }
}

const stockfish = new PersistentUciAnalyzer({
  label: "Stockfish",
  createLaunch: () => ({ command: getStockfishCommand() }),
  getGoCommand: () => `go movetime ${stockfishMoveTimeMs}`,
  timeoutMs: stockfishTimeoutMs
});

const maia = new PersistentUciAnalyzer({
  label: "Maia",
  createLaunch: async () => {
    const lc0Command = getLc0Command();

    if (!lc0Command) {
      throw new Error("Lc0 is not installed. Install lc0 or set LC0_PATH to use Maia.");
    }

    const rating = maiaRating;
    const weightsPath = await ensureMaiaWeights(rating);
    return { command: lc0Command, args: [`--weights=${weightsPath}`] };
  },
  getGoCommand: () => `go nodes ${maiaSearchNodes}`,
  timeoutMs: maiaTimeoutMs
});

const getMaiaLabel = () => `Maia ${maiaRating}`;

type BackgroundEngineTask = {
  fen: string;
  promise: Promise<void>;
};

const backgroundEngineTasks = new Map<string, BackgroundEngineTask>();

const clearCachedEngineResults = () => {
  for (const board of recognizedBoardCache.values()) {
    delete board.bestMove;
    delete board.stockfishMove;
    delete board.maiaMove;
    delete board.evaluation;
    delete board.engineError;
    delete board.stockfishError;
    delete board.maiaError;
  }

  backgroundEngineTasks.clear();
};

const markEngineSettingsChanged = () => {
  engineSettingsRevision += 1;
  clearCachedEngineResults();
  clearLatestAnalysis("Engine settings changed; waiting for the next board scan.");
};

const analyzeBoardWithEngine = async (
  sourceId: string,
  board: CapturedBoard,
  totalStartedAt: number,
  mode: "fresh" | "continued",
  profiler?: CaptureProfiler,
  shouldPublish?: () => boolean
) => {
  if (!board.fen) {
    cacheRecognizedBoard(sourceId, board);
    return true;
  }

  const fen = board.fen.value;
  const settingsRevision = engineSettingsRevision;
  const canPublish = () => engineSettingsRevision === settingsRevision && (shouldPublish?.() ?? true);
  const maiaLabel = getMaiaLabel();

  if (!canPublish()) {
    console.log("[capture] skipped stale engine analysis before start");
    return false;
  }

  const engineStartedAt = performance.now();
  delete board.engineError;
  markLatestAnalysisPending(sourceId, fen, board.detection.orientation);

  try {
    const [stockfishResult, maiaResult] = await Promise.allSettled([
      profileAsync(profiler, "findStockfishMove", () => stockfish.findBestMove(fen), {
        engine: "Stockfish",
        mode,
        fen
      }),
      profileAsync(profiler, "findMaiaMove", () => maia.findBestMove(fen), {
        engine: maiaLabel,
        mode,
        fen
      })
    ]);

    if (!canPublish()) {
      console.log("[capture] skipped stale engine result");
      return false;
    }

    if (
      (stockfishResult.status === "rejected" && stockfishResult.reason instanceof SupersededEngineAnalysisError) ||
      (maiaResult.status === "rejected" && maiaResult.reason instanceof SupersededEngineAnalysisError)
    ) {
      console.log("[capture] skipped superseded engine result");
      return false;
    }

    const stockfishAnalysis = stockfishResult.status === "fulfilled" ? stockfishResult.value : undefined;
    const maiaAnalysis = maiaResult.status === "fulfilled" ? maiaResult.value : undefined;
    const stockfishError =
      stockfishResult.status === "rejected"
        ? stockfishResult.reason instanceof Error
          ? stockfishResult.reason.message
          : "Stockfish could not find a move."
        : undefined;
    const maiaError =
      maiaResult.status === "rejected"
        ? maiaResult.reason instanceof Error
          ? maiaResult.reason.message
          : `${maiaLabel} could not find a move.`
        : undefined;

    if (!stockfishAnalysis && !maiaAnalysis) {
      board.stockfishError = stockfishError;
      board.maiaError = maiaError;
      board.engineError = [stockfishError, maiaError].filter(Boolean).join(" ");
      markLatestAnalysisError(sourceId, fen, board.detection.orientation, board.engineError);
      console.log(`[capture] engines failed: ${board.engineError}`);
      cacheRecognizedBoard(sourceId, board);
      return true;
    }

    board.stockfishMove = stockfishAnalysis?.bestMove;
    board.maiaMove = maiaAnalysis?.bestMove;
    board.bestMove = stockfishAnalysis?.bestMove;
    board.evaluation = stockfishAnalysis?.evaluation;
    board.stockfishError = stockfishError;
    board.maiaError = maiaError;
    board.engineError = [stockfishError, maiaError].filter(Boolean).join(" ") || undefined;
    markLatestAnalysisReady(sourceId, fen, board.detection.orientation, {
      stockfish: stockfishAnalysis,
      maia: maiaAnalysis,
      stockfishError,
      maiaError
    });

    const stockfishSummary = stockfishAnalysis
      ? `Stockfish ${stockfishAnalysis.bestMove.san} (${stockfishAnalysis.bestMove.uci}, ${stockfishAnalysis.evaluation?.display ?? "no eval"})`
      : `Stockfish failed (${stockfishError})`;
    const maiaSummary = maiaAnalysis
      ? `${maiaLabel} ${maiaAnalysis.bestMove.san} (${maiaAnalysis.bestMove.uci})`
      : `${maiaLabel} failed (${maiaError})`;
    console.log(
      `[capture] engine ${mode === "continued" ? "continued" : "moves"}: ` +
        `${stockfishSummary}; ${maiaSummary} (${formatMs(engineStartedAt)}, ${formatMs(totalStartedAt)} total)`
    );
    cacheRecognizedBoard(sourceId, board);
    return true;
  } catch (error) {
    if (error instanceof SupersededEngineAnalysisError) {
      console.log("[capture] skipped superseded engine result");
      return false;
    }

    if (!canPublish()) {
      console.log("[capture] skipped stale engine error");
      return false;
    }

    board.engineError = error instanceof Error ? error.message : "The engines could not find moves.";
    markLatestAnalysisError(sourceId, fen, board.detection.orientation, board.engineError);
    console.log(`[capture] engines failed: ${board.engineError}`);
    cacheRecognizedBoard(sourceId, board);
    return true;
  }
};

const scheduleBackgroundEngineContinuation = (sourceId: string, board: CapturedBoard) => {
  if (!board.fen) {
    return;
  }

  const fen = board.fen.value;
  const existingTask = backgroundEngineTasks.get(sourceId);

  if (existingTask) {
    console.log(
      `[capture] engine continuation already running for ${existingTask.fen === fen ? "this" : "a superseded"} board`
    );
    return;
  }

  const backgroundBoard = cloneBoard(board);
  const backgroundStartedAt = performance.now();
  const backgroundProfiler = createProfiler(`${sourceId}:engines`);
  let didAnalyzeLatestBoard = false;
  let thrownError: unknown;
  const task: BackgroundEngineTask = { fen, promise: Promise.resolve() };

  task.promise = (async () => {
    try {
      didAnalyzeLatestBoard = await analyzeBoardWithEngine(
        sourceId,
        backgroundBoard,
        backgroundStartedAt,
        "continued",
        backgroundProfiler,
        () => hasCachedFen(sourceId, fen)
      );
    } catch (error) {
      thrownError = error;
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[capture] background engines failed: ${message}`);
    } finally {
      if (backgroundEngineTasks.get(sourceId) === task) {
        backgroundEngineTasks.delete(sourceId);
      }

      await saveProfiler(backgroundProfiler, {
        status: thrownError
          ? "background-error"
          : didAnalyzeLatestBoard
            ? "background-completed"
            : "background-superseded",
        profileKind: "background-engine",
        sourceKind: getKind(sourceId),
        boardStatus: "board",
        boardSide: backgroundBoard.detection.orientation,
        fen,
        error: thrownError instanceof Error ? thrownError.message : thrownError ? String(thrownError) : undefined
      });
    }
  })();

  backgroundEngineTasks.set(sourceId, task);
  void task.promise;
};

const recognizeBestFen = async (
  image: Electron.NativeImage,
  detection: BoardDetection,
  profiler?: CaptureProfiler
) => {
  const imageSize = image.getSize();
  let best: { detection: BoardDetection; recognition: FenRecognition; score: number } | undefined;

  const candidates = profileSync(profiler, "getCandidateDetections", () => getCandidateDetections(detection, imageSize), {
    orientation: detection.orientation,
    orientationConfidence: detection.orientationConfidence
  });

  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
    const candidate = candidates[candidateIndex];
    const boardImage = profileSync(profiler, "cropCandidateBoard", () => image.crop(candidate), { candidateIndex });

    if (boardImage.isEmpty()) {
      continue;
    }

    const orientedCandidate = refineCandidateOrientationFromBoardImage(candidate, boardImage, profiler);

    for (const orientation of getCandidateOrientations(orientedCandidate)) {
      const candidateWithOrientation: BoardDetection = { ...orientedCandidate, orientation };
      const activeColor = orientation === "black" ? "b" : "w";
      const recognition = await profileAsync(
        profiler,
        "recognizeFen",
        () => recognizeFen(boardImage, orientation, pieceModelPath, activeColor),
        { candidateIndex, orientation }
      );
      const scoreStartedAt = profiler ? performance.now() : 0;
      const recognitionScore = scoreRecognition(recognition);
      addProfileEntry(profiler, "scoreRecognition", scoreStartedAt, {
        candidateIndex,
        orientation,
        confidence: recognition.confidence,
        score: recognitionScore.total,
        pieceCount: recognitionScore.pieceCount,
        edgePieceScore: recognitionScore.edgePieceScore,
        homeRankColorScore: recognitionScore.homeRankColorScore,
        leftGutterPenalty: recognitionScore.leftGutterPenalty,
        rightGutterPenalty: recognitionScore.rightGutterPenalty
      });
      const score = recognitionScore.total;

      if (!best || score > best.score) {
        best = { detection: candidateWithOrientation, recognition, score };
      }
    }
  }

  if (!best) {
    throw new Error("Could not recognize the board position.");
  }

  return best;
};

const analyzeBoard = async (
  image: Electron.NativeImage,
  hint?: BoardDetection,
  changeCacheKey?: string,
  profiler?: CaptureProfiler
): Promise<NonNullable<CaptureResult["board"]> | undefined> => {
  const startedAt = performance.now();
  let usedCachedPrecheck = false;

  if (changeCacheKey && hint && isDetectionInsideImage(image, hint)) {
    const stability = profileSync(
      profiler,
      "checkBoardStability.cached",
      () => checkBoardStability(image, hint, changeCacheKey, "cached"),
      { sourceId: changeCacheKey }
    );

    if (stability.status === "unstable" || stability.status === "unchanged") {
      return {
        detection: hint,
        skipped: true,
        skipReason: stability.status,
        difference: stability.difference
      };
    }

    usedCachedPrecheck = true;
  }

  let detection = profileSync(profiler, "detectChessboard", () => detectChessboard(image, hint), {
    hasHint: Boolean(hint)
  });

  if (!detection) {
    console.log(`[capture] board detection: none (${formatMs(startedAt)})`);
    return undefined;
  }

  let detectedBoard = detection;

  if (changeCacheKey && !usedCachedPrecheck) {
    const stability = profileSync(
      profiler,
      "checkBoardStability.detected",
      () => checkBoardStability(image, detectedBoard, changeCacheKey, "detected"),
      { sourceId: changeCacheKey }
    );

    if (stability.status === "unstable" || stability.status === "unchanged") {
      return {
        detection: detectedBoard,
        skipped: true,
        skipReason: stability.status,
        difference: stability.difference
      };
    }
  }

  detectedBoard = await profileAsync(
    profiler,
    "refineDetectionOrientation",
    () => refineDetectionOrientation(image, detectedBoard, profiler),
    { orientation: detectedBoard.orientation, orientationConfidence: detectedBoard.orientationConfidence }
  );

  console.log(
    `[capture] board detection: found ${detectedBoard.width}x${detectedBoard.height}, orientation ${detectedBoard.orientation} (${formatMs(startedAt)})`
  );

  const fenStartedAt = performance.now();

  try {
    const { detection: recognizedDetection, recognition: recognized } = await profileAsync(
      profiler,
      "recognizeBestFen",
      () => recognizeBestFen(image, detectedBoard, profiler),
      { orientation: detectedBoard.orientation, orientationConfidence: detectedBoard.orientationConfidence }
    );
    console.log(
      `[capture] FEN recognition: ${recognized.fen} (${Math.round(recognized.confidence * 100)}% confidence, ${formatMs(fenStartedAt)})`
    );

    if (recognized.confidence < fenConfidenceThreshold) {
      await saveBoardCrop(
        image,
        recognizedDetection,
        {
          sourceId: changeCacheKey,
          fen: recognized.fen,
          confidence: recognized.confidence,
          reason: "low-confidence"
        },
        profiler
      );
      resetBoardStabilityBaseline(changeCacheKey, image, recognizedDetection);
      return {
        fenError: `Piece confidence was only ${Math.round(recognized.confidence * 100)}%, so the FEN was not shown.`,
        detection: recognizedDetection
      };
    }

    await saveBoardCrop(
      image,
      recognizedDetection,
      {
        sourceId: changeCacheKey,
        fen: recognized.fen,
        confidence: recognized.confidence,
        reason: "recognized"
      },
      profiler
    );
    resetBoardStabilityBaseline(changeCacheKey, image, recognizedDetection);
    return {
      fen: {
        value: recognized.fen,
        confidence: recognized.confidence,
        warning: recognized.warning
      },
      detection: recognizedDetection
    };
  } catch (error) {
    const fenError = error instanceof Error ? error.message : "Could not recognize the board position.";
    console.log(`[capture] FEN recognition failed: ${fenError} (${formatMs(startedAt)})`);

    await saveBoardCrop(
      image,
      detectedBoard,
      {
        sourceId: changeCacheKey,
        reason: "fen-error"
      },
      profiler
    );
    resetBoardStabilityBaseline(changeCacheKey, image, detectedBoard);
    return { fenError, detection: detectedBoard };
  }
};

const cropBoardFile = async (imagePath: string): Promise<NonNullable<CaptureResult["board"]>> => {
  const resolvedPath = path.resolve(imagePath);
  const image = nativeImage.createFromPath(resolvedPath);
  const profiler = createProfiler(`file:${resolvedPath}`);

  if (image.isEmpty()) {
    throw new Error(`Could not read image: ${resolvedPath}`);
  }

  try {
    const board = await profileAsync(profiler, "analyzeBoard", () => analyzeBoard(image, undefined, undefined, profiler));
    if (!board) {
      throw new Error(`Could not detect a chessboard in: ${resolvedPath}`);
    }

    await saveProfiler(profiler, {
      status: "completed",
      orientation: board.detection.orientation,
      fen: board.fen?.value
    });
    return board;
  } catch (error) {
    await saveProfiler(profiler, {
      status: "error",
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
};

const createWindow = async () => {
  const appIcon = getAppIcon();
  const win = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 820,
    minHeight: 560,
    title: appDisplayName,
    icon: appIcon.isEmpty() ? undefined : appIcon,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  applyHiddenModeToWindow(win);
  await win.loadFile(path.join(__dirname, "index.html"));
};

const listSources = async (): Promise<CaptureSource[]> => {
  const sources = await desktopCapturer.getSources({
    types: ["screen", "window"],
    thumbnailSize: { width: 180, height: 112 },
    fetchWindowIcons: false
  });

  return sources.map((source) => ({
    id: source.id,
    name: source.name,
    kind: getKind(source.id),
    thumbnailDataUrl: source.thumbnail.toDataURL()
  }));
};

const analyzeCapturedImage = async (
  image: Electron.NativeImage,
  sourceId: string,
  totalStartedAt: number,
  profiler?: CaptureProfiler
): Promise<CaptureResult> => {
  if (image.isEmpty()) {
    console.log(`[capture] failed: empty image (${formatMs(totalStartedAt)} total)`);
    clearLatestAnalysis("The selected source returned an empty image.");
    return { boardError: "The selected source returned an empty image." };
  }

  try {
    const board = await profileAsync(
      profiler,
      "analyzeBoard",
      () => analyzeBoard(image, boardDetectionCache.get(sourceId), sourceId, profiler),
      { sourceId }
    );

    if (board) {
      boardDetectionCache.set(sourceId, board.detection);

      if (board.skipped) {
        const difference = board.difference ?? 0;
        const reason = board.skipReason ?? "unchanged";

        if (reason === "unchanged") {
          const cachedBoard = getCachedRecognizedBoard(sourceId);

          if (cachedBoard?.fen) {
            cachedBoard.detection = { ...board.detection };
            console.log(
              `[capture] unchanged board; reusing FEN and continuing engine search in the background ` +
                `(${(difference * 100).toFixed(2)}%)`
            );
            scheduleBackgroundEngineContinuation(sourceId, cachedBoard);

            console.log(`[capture] finished (${formatMs(totalStartedAt)} total)`);
            return { board: cachedBoard };
          }
        }

        console.log(
          `[capture] skipped ${reason} board (${(difference * 100).toFixed(2)}%, ${formatMs(totalStartedAt)} total)`
        );
        clearLatestAnalysis(
          reason === "unstable"
            ? "Board is changing; waiting for a stable position."
            : "No analyzed board is cached yet."
        );
        return { skipped: { reason, difference } };
      }

      if (board.fen) {
        const didAnalyzeLatestBoard = await analyzeBoardWithEngine(sourceId, board, totalStartedAt, "fresh", profiler);

        if (!didAnalyzeLatestBoard) {
          return { skipped: { reason: "superseded", difference: 0 } };
        }
      } else {
        clearLatestAnalysis(board.fenError ?? "No FEN was created for the current board.");
        cacheRecognizedBoard(sourceId, board);
      }
    }

    console.log(`[capture] finished (${formatMs(totalStartedAt)} total)`);

    if (board) {
      return { board };
    }

    recognizedBoardCache.delete(sourceId);
    clearLatestAnalysis("No chessboard was detected in this image.");
    return { boardError: "No chessboard was detected in this image." };
  } catch (error) {
    const boardError = error instanceof Error ? error.message : "Could not crop a chessboard from this image.";
    console.log(`[capture] failed: ${boardError} (${formatMs(totalStartedAt)} total)`);
    clearLatestAnalysis(boardError);
    return { boardError };
  }
};

const captureSource = async (_event: Electron.IpcMainInvokeEvent, sourceId: string): Promise<CaptureResult> => {
  const totalStartedAt = performance.now();
  const profiler = createProfiler(sourceId);
  const sourceKind = getKind(sourceId);
  const captureThumbnailPixels =
    sourceKind === "screen" ? screenCaptureThumbnailPixels : windowCaptureThumbnailPixels;
  console.log(`[capture] started for source ${sourceId}`);

  let result: CaptureResult | undefined;
  let thrownError: unknown;

  try {
    if (sourceKind === "camera") {
      throw new Error("Camera sources must be captured from the camera frame pipeline.");
    }

    const sourceStartedAt = performance.now();
    let sources: Electron.DesktopCapturerSource[];

    try {
      sources = await profileAsync(
        profiler,
        "desktopCapturer.getSources",
        () =>
          desktopCapturer.getSources({
            types: [sourceKind],
            thumbnailSize: { width: captureThumbnailPixels, height: captureThumbnailPixels },
            fetchWindowIcons: false
          }),
        { sourceKind, captureThumbnailPixels }
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not fetch screenshot sources.";
      console.log(`[capture] source fetch failed: ${message}`);
      throw error;
    }

    console.log(`[capture] screenshot source fetch: ${sources.length} source(s) (${formatMs(sourceStartedAt)})`);

    const source = sources.find((item) => item.id === sourceId);
    if (!source) {
      console.log(`[capture] failed: source not found (${formatMs(totalStartedAt)} total)`);
      throw new Error("That screen or window is no longer available. Refresh and try again.");
    }

    if (source.thumbnail.isEmpty()) {
      console.log(`[capture] failed: empty screenshot (${formatMs(totalStartedAt)} total)`);
      throw new Error("Electron returned an empty screenshot for this source.");
    }

    result = await analyzeCapturedImage(source.thumbnail, sourceId, totalStartedAt, profiler);
    return result;
  } catch (error) {
    thrownError = error;
    throw error;
  } finally {
    await saveProfiler(profiler, {
      status: thrownError ? "error" : "completed",
      sourceKind,
      boardStatus: result?.board ? "board" : result?.skipped ? "skipped" : "none",
      boardSide: result?.board?.detection.orientation,
      fen: result?.board?.fen?.value,
      error: thrownError instanceof Error ? thrownError.message : thrownError ? String(thrownError) : undefined
    });
  }
};

const captureImageDataUrl = async (
  _event: Electron.IpcMainInvokeEvent,
  sourceId: string,
  _sourceKind: SourceKind,
  imageDataUrl: string,
  frameCaptureMs?: number
): Promise<CaptureResult> => {
  const totalStartedAt = performance.now();
  const profiler = createProfiler(sourceId);
  console.log(`[capture] started for image source ${sourceId}`);
  let result: CaptureResult | undefined;
  let thrownError: unknown;

  try {
    if (Number.isFinite(frameCaptureMs)) {
      console.log(`[capture] image frame captured in ${Math.round(Number(frameCaptureMs))}ms`);
      addProfileEntry(profiler, "captureCameraFrame.renderer", performance.now() - Number(frameCaptureMs), {
        frameCaptureMs: Math.round(Number(frameCaptureMs))
      });
    }

    const image = profileSync(profiler, "nativeImage.createFromDataURL", () => nativeImage.createFromDataURL(imageDataUrl));

    result = await analyzeCapturedImage(image, sourceId, totalStartedAt, profiler);
    return result;
  } catch (error) {
    thrownError = error;
    throw error;
  } finally {
    await saveProfiler(profiler, {
      status: thrownError ? "error" : "completed",
      sourceKind: _sourceKind,
      boardStatus: result?.board ? "board" : result?.skipped ? "skipped" : "none",
      boardSide: result?.board?.detection.orientation,
      fen: result?.board?.fen?.value,
      error: thrownError instanceof Error ? thrownError.message : thrownError ? String(thrownError) : undefined
    });
  }
};

const setStockfishMoveTime = (_event: Electron.IpcMainInvokeEvent, moveTimeMs: number): StockfishSettings => {
  if (Number.isFinite(moveTimeMs)) {
    const nextMoveTimeMs = normalizeStockfishMoveTime(moveTimeMs);

    if (nextMoveTimeMs !== stockfishMoveTimeMs) {
      stockfishMoveTimeMs = nextMoveTimeMs;
      markEngineSettingsChanged();
    }
  }

  return getStockfishSettings();
};

const setMaiaRating = (_event: Electron.IpcMainInvokeEvent, rating: number): EngineSettings => {
  if (Number.isFinite(rating)) {
    const nextRating = normalizeMaiaRating(rating);

    if (nextRating !== maiaRating) {
      maiaRating = nextRating;
      maia.dispose(new Error("Maia rating changed."));
      markEngineSettingsChanged();
    }
  }

  return getEngineSettings();
};

const setHiddenMode = (_event: Electron.IpcMainInvokeEvent, enabled: boolean): HiddenModeSettings => {
  hiddenModeEnabled = hiddenModeSupported && enabled;
  applyHiddenModeToAllWindows();
  return getHiddenModeSettings();
};

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "media");
  });

  if (debugMode) {
    console.log(`[debug] enabled; writing artifacts to ${boardCropDirectory}`);
  }

  const appIcon = getAppIcon();
  if (process.platform === "darwin" && !appIcon.isEmpty()) {
    app.dock?.setIcon(appIcon);
  }

  await startLocalApiServer();

  const cropBoardIndex = process.argv.indexOf("--crop-board");
  if (cropBoardIndex !== -1) {
    const imagePath = process.argv.slice(cropBoardIndex + 1).find((argument) => argument !== "--");

    if (!imagePath) {
      console.error("Usage: pnpm run crop-board -- path/to/screenshot.png");
      process.exitCode = 1;
      app.exit(1);
      return;
    }

    try {
      const board = await cropBoardFile(imagePath);
      console.log(
        `Orientation: ${board.detection.orientation} (${Math.round(board.detection.orientationConfidence * 100)}% confidence)`
      );
      if (board.fen) {
        console.log(`FEN: ${board.fen.value}`);
        console.log(`Piece confidence: ${Math.round(board.fen.confidence * 100)}%`);
        if (board.fen.warning) {
          console.log(`Warning: ${board.fen.warning}`);
        }
      } else if (board.fenError) {
        console.log(`FEN was not created: ${board.fenError}`);
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Could not crop the chessboard.");
      process.exitCode = 1;
    }

    app.exit(typeof process.exitCode === "number" ? process.exitCode : 0);
    return;
  }

  ipcMain.handle("sources:list", listSources);
  ipcMain.handle("source:capture", captureSource);
  ipcMain.handle("source:capture-image-data-url", captureImageDataUrl);
  ipcMain.handle("engine:get-settings", getEngineSettings);
  ipcMain.handle("engine:set-maia-rating", setMaiaRating);
  ipcMain.handle("stockfish:get-settings", getStockfishSettings);
  ipcMain.handle("stockfish:set-move-time", setStockfishMoveTime);
  ipcMain.handle("local-api:get-settings", getLocalApiSettings);
  ipcMain.handle("hidden-mode:get-settings", getHiddenModeSettings);
  ipcMain.handle("hidden-mode:set-enabled", setHiddenMode);

  await createWindow();

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  localApiServer?.close();
  stockfish.dispose();
  maia.dispose();
});
