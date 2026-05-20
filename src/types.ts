export type SourceKind = "screen" | "window" | "camera";

export type CaptureSource = {
  id: string;
  name: string;
  kind: SourceKind;
  thumbnailDataUrl: string;
};

export type EngineMove = {
  uci: string;
  san: string;
  from: string;
  to: string;
  promotion?: string;
};

export type CaptureResult = {
  skipped?: {
    reason: "unchanged" | "unstable" | "superseded";
    difference: number;
  };
  board?: {
    skipped?: boolean;
    skipReason?: "unchanged" | "unstable";
    difference?: number;
    fen?: {
      value: string;
      confidence: number;
      warning?: string;
    };
    bestMove?: EngineMove;
    stockfishMove?: EngineMove;
    maiaMove?: EngineMove;
    evaluation?: {
      type: "cp" | "mate";
      whiteValue: number;
      display: string;
    };
    engineError?: string;
    stockfishError?: string;
    maiaError?: string;
    fenError?: string;
    detection: {
      x: number;
      y: number;
      width: number;
      height: number;
      confidence: number;
      orientation: "white" | "black" | "unknown";
      orientationConfidence: number;
    };
  };
  boardError?: string;
};

export type StockfishSettings = {
  moveTimeMs: number;
  minMoveTimeMs: number;
  maxMoveTimeMs: number;
  stepMs: number;
};

export type MaiaSettings = {
  rating: number;
  minRating: number;
  maxRating: number;
  stepRating: number;
  availableRatings: number[];
};

export type EngineSettings = {
  stockfish: StockfishSettings;
  maia: MaiaSettings;
};

export type LocalApiSettings = {
  port: number;
  baseUrl: string;
  evalUrl: string;
};

export type HiddenModeSettings = {
  enabled: boolean;
  supported: boolean;
};

export type ScreenshotApi = {
  listSources: () => Promise<CaptureSource[]>;
  captureSource: (sourceId: string) => Promise<CaptureResult>;
  captureImageDataUrl: (
    sourceId: string,
    sourceKind: SourceKind,
    imageDataUrl: string,
    frameCaptureMs?: number
  ) => Promise<CaptureResult>;
  getEngineSettings: () => Promise<EngineSettings>;
  setMaiaRating: (rating: number) => Promise<EngineSettings>;
  getStockfishSettings: () => Promise<StockfishSettings>;
  setStockfishMoveTime: (moveTimeMs: number) => Promise<StockfishSettings>;
  getLocalApiSettings: () => Promise<LocalApiSettings>;
  getHiddenModeSettings: () => Promise<HiddenModeSettings>;
  setHiddenMode: (enabled: boolean) => Promise<HiddenModeSettings>;
};
