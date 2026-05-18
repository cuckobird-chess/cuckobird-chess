import type { NativeImage } from "electron";

export type BoardOrientation = "white" | "black" | "unknown";

export type BoardDetection = {
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
  orientation: BoardOrientation;
  orientationConfidence: number;
};

type Bitmap = {
  data: Buffer;
  width: number;
  height: number;
};

type Candidate = {
  x: number;
  y: number;
  size: number;
  score: number;
  contrast: number;
  variance: number;
  gridScore: number;
  boundaryScore: number;
  patternScore: number;
  continuationPenalty: number;
};

type Color = [number, number, number];

type BoardRect = {
  x: number;
  y: number;
  size: number;
};

type RankDigit = "1" | "8" | "unknown";

type RankDigitDetection = {
  digit: RankDigit;
  confidence: number;
  ratio?: number;
  fillRatio?: number;
  leftRatio?: number;
  rightRatio?: number;
};

type FileLetter = "a" | "h" | "unknown";

type FileLetterDetection = {
  letter: FileLetter;
  confidence: number;
};

type GridFit = {
  start: number;
  size: number;
  score: number;
};

const FAST_ANALYSIS_MAX_DIMENSION = 1000;
const DETAILED_ANALYSIS_MAX_DIMENSION = 1400;
const MAX_CANDIDATES = 16;
const MAX_REFINED_CANDIDATES = 8;
const CELL_SAMPLE_OFFSETS = [0.22, 0.78] as const;
const FAST_CELL_SAMPLE_OFFSETS = CELL_SAMPLE_OFFSETS;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const colorDistance = (a: Color, b: Color) => {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];

  return Math.sqrt(dr * dr + dg * dg + db * db);
};

const edgeDistance = (a: Color, b: Color) =>
  Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);

const getColor = (bitmap: Bitmap, x: number, y: number): Color => {
  const safeX = clamp(Math.round(x), 0, bitmap.width - 1);
  const safeY = clamp(Math.round(y), 0, bitmap.height - 1);
  const index = (safeY * bitmap.width + safeX) * 4;

  return [bitmap.data[index], bitmap.data[index + 1], bitmap.data[index + 2]];
};

const getDominantColor = (
  bitmap: Bitmap,
  roi: { x: number; y: number; width: number; height: number }
): Color => {
  const buckets = new Map<string, { count: number; total: Color }>();

  for (let y = Math.round(roi.y); y < roi.y + roi.height; y += 1) {
    for (let x = Math.round(roi.x); x < roi.x + roi.width; x += 1) {
      const color = getColor(bitmap, x, y);
      const key = `${color[0] >> 4},${color[1] >> 4},${color[2] >> 4}`;
      const bucket = buckets.get(key) ?? { count: 0, total: [0, 0, 0] };
      bucket.count += 1;
      bucket.total[0] += color[0];
      bucket.total[1] += color[1];
      bucket.total[2] += color[2];
      buckets.set(key, bucket);
    }
  }

  let dominant = { count: 0, total: [0, 0, 0] as Color };

  for (const bucket of buckets.values()) {
    if (bucket.count > dominant.count) {
      dominant = bucket;
    }
  }

  return [
    dominant.total[0] / dominant.count,
    dominant.total[1] / dominant.count,
    dominant.total[2] / dominant.count
  ];
};

const getPixelIndex = (bitmap: Bitmap, x: number, y: number) => {
  const safeX = clamp(Math.round(x), 0, bitmap.width - 1);
  const safeY = clamp(Math.round(y), 0, bitmap.height - 1);

  return (safeY * bitmap.width + safeX) * 4;
};

const getContinuationPenalty = (
  bitmap: Bitmap,
  x: number,
  y: number,
  size: number,
  evenMean: Color,
  oddMean: Color
) => {
  const cellSize = size / 8;
  let continuationMargin = 0;
  let continuationSamples = 0;

  const addSample = (sampleX: number, sampleY: number, expectedEven: boolean) => {
    const color = getColor(bitmap, sampleX, sampleY);
    const expected = expectedEven ? evenMean : oddMean;
    const alternate = expectedEven ? oddMean : evenMean;
    continuationMargin += colorDistance(color, alternate) - colorDistance(color, expected);
    continuationSamples += 1;
  };

  if (x - cellSize * 0.5 >= 0) {
    for (let row = 0; row < 8; row += 1) {
      addSample(x - cellSize * 0.5, y + (row + 0.5) * cellSize, (row - 1) % 2 === 0);
    }
  }

  if (x + size + cellSize * 0.5 < bitmap.width) {
    for (let row = 0; row < 8; row += 1) {
      addSample(x + size + cellSize * 0.5, y + (row + 0.5) * cellSize, row % 2 === 0);
    }
  }

  if (y - cellSize * 0.5 >= 0) {
    for (let column = 0; column < 8; column += 1) {
      addSample(x + (column + 0.5) * cellSize, y - cellSize * 0.5, (column - 1) % 2 === 0);
    }
  }

  if (y + size + cellSize * 0.5 < bitmap.height) {
    for (let column = 0; column < 8; column += 1) {
      addSample(x + (column + 0.5) * cellSize, y + size + cellSize * 0.5, column % 2 === 0);
    }
  }

  return continuationSamples === 0 ? 0 : Math.max(0, continuationMargin / continuationSamples);
};

const scoreCandidate = (
  bitmap: Bitmap,
  x: number,
  y: number,
  size: number,
  sampleOffsets: readonly number[] = CELL_SAMPLE_OFFSETS
): Candidate | null => {
  if (x < 0 || y < 0 || x + size > bitmap.width || y + size > bitmap.height) {
    return null;
  }

  const cellSize = size / 8;
  if (cellSize < 7.5) {
    return null;
  }

  let evenR = 0;
  let evenG = 0;
  let evenB = 0;
  let evenSquared = 0;
  let evenCount = 0;
  let oddR = 0;
  let oddG = 0;
  let oddB = 0;
  let oddSquared = 0;
  let oddCount = 0;
  const cellColors: Color[] = [];

  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      let cellR = 0;
      let cellG = 0;
      let cellB = 0;
      let cellSamples = 0;

      for (const offsetX of sampleOffsets) {
        for (const offsetY of sampleOffsets) {
          const index = getPixelIndex(bitmap, x + (column + offsetX) * cellSize, y + (row + offsetY) * cellSize);
          cellR += bitmap.data[index];
          cellG += bitmap.data[index + 1];
          cellB += bitmap.data[index + 2];
          cellSamples += 1;
        }
      }

      cellR /= cellSamples;
      cellG /= cellSamples;
      cellB /= cellSamples;
      cellColors.push([cellR, cellG, cellB]);

      if ((row + column) % 2 === 0) {
        evenR += cellR;
        evenG += cellG;
        evenB += cellB;
        evenSquared += cellR * cellR + cellG * cellG + cellB * cellB;
        evenCount += 1;
      } else {
        oddR += cellR;
        oddG += cellG;
        oddB += cellB;
        oddSquared += cellR * cellR + cellG * cellG + cellB * cellB;
        oddCount += 1;
      }
    }
  }

  const lightMean: Color = [evenR / evenCount, evenG / evenCount, evenB / evenCount];
  const darkMean: Color = [oddR / oddCount, oddG / oddCount, oddB / oddCount];
  const contrast = colorDistance(lightMean, darkMean);
  const lightMeanSquared = lightMean[0] * lightMean[0] + lightMean[1] * lightMean[1] + lightMean[2] * lightMean[2];
  const darkMeanSquared = darkMean[0] * darkMean[0] + darkMean[1] * darkMean[1] + darkMean[2] * darkMean[2];
  const lightVariance = Math.sqrt(Math.max(0, evenSquared / evenCount - lightMeanSquared));
  const darkVariance = Math.sqrt(Math.max(0, oddSquared / oddCount - darkMeanSquared));
  const variance = (lightVariance + darkVariance) / 2;
  let patternAgreement = 0;

  for (let index = 0; index < cellColors.length; index += 1) {
    const expectedEven = (Math.floor(index / 8) + (index % 8)) % 2 === 0;
    const expected = expectedEven ? lightMean : darkMean;
    const alternate = expectedEven ? darkMean : lightMean;
    const color = cellColors[index];
    const margin = colorDistance(color, alternate) - colorDistance(color, expected);
    patternAgreement += clamp((margin + contrast * 0.15) / Math.max(1, contrast * 0.65), 0, 1);
  }

  const patternScore = patternAgreement / cellColors.length;
  const continuationPenalty = getContinuationPenalty(bitmap, x, y, size, lightMean, darkMean);

  return {
    x,
    y,
    size,
    contrast,
    variance,
    gridScore: 0,
    boundaryScore: 0,
    patternScore,
    continuationPenalty,
    score: contrast + patternScore * 95 - variance * 0.32 - (1 - patternScore) * 140 - continuationPenalty * 7
  };
};

const pushCandidate = (candidates: Candidate[], candidate: Candidate) => {
  const duplicate = candidates.find((existing) => {
    const centerDistance = Math.hypot(
      existing.x + existing.size / 2 - (candidate.x + candidate.size / 2),
      existing.y + existing.size / 2 - (candidate.y + candidate.size / 2)
    );
    const sizeDelta = Math.abs(existing.size - candidate.size) / Math.max(existing.size, candidate.size);

    return centerDistance < Math.min(existing.size, candidate.size) * 0.2 && sizeDelta < 0.18;
  });

  if (duplicate) {
    if (candidate.score > duplicate.score) {
      Object.assign(duplicate, candidate);
    }

    return;
  }

  candidates.push(candidate);
  candidates.sort((a, b) => b.score - a.score);

  if (candidates.length > MAX_CANDIDATES) {
    candidates.length = MAX_CANDIDATES;
  }
};

const getInternalGridScores = (bitmap: Bitmap, candidate: Candidate) => {
  const cellSize = candidate.size / 8;
  const edgeOffset = clamp(cellSize * 0.08, 1, 4);
  const offGridOffset = cellSize * 0.35;
  let score = 0;
  let samples = 0;
  const boundaryLines = {
    left: { score: 0, samples: 0 },
    right: { score: 0, samples: 0 },
    top: { score: 0, samples: 0 },
    bottom: { score: 0, samples: 0 }
  };

  for (let column = 0; column <= 8; column += 1) {
    const x = candidate.x + column * cellSize;

    for (let row = 0; row < 8; row += 1) {
      const y = candidate.y + (row + 0.5) * cellSize;
      const onGrid = edgeDistance(getColor(bitmap, x - edgeOffset, y), getColor(bitmap, x + edgeOffset, y));
      const beforeGrid = edgeDistance(
        getColor(bitmap, x - offGridOffset - edgeOffset, y),
        getColor(bitmap, x - offGridOffset + edgeOffset, y)
      );
      const afterGrid = edgeDistance(
        getColor(bitmap, x + offGridOffset - edgeOffset, y),
        getColor(bitmap, x + offGridOffset + edgeOffset, y)
      );
      const lineScore = onGrid - (beforeGrid + afterGrid) / 2;
      score += lineScore;
      samples += 1;

      if (column === 0 || column === 8) {
        const side = column === 0 ? boundaryLines.left : boundaryLines.right;
        side.score += lineScore;
        side.samples += 1;
      }
    }
  }

  for (let row = 0; row <= 8; row += 1) {
    const y = candidate.y + row * cellSize;

    for (let column = 0; column < 8; column += 1) {
      const x = candidate.x + (column + 0.5) * cellSize;
      const onGrid = edgeDistance(getColor(bitmap, x, y - edgeOffset), getColor(bitmap, x, y + edgeOffset));
      const beforeGrid = edgeDistance(
        getColor(bitmap, x, y - offGridOffset - edgeOffset),
        getColor(bitmap, x, y - offGridOffset + edgeOffset)
      );
      const afterGrid = edgeDistance(
        getColor(bitmap, x, y + offGridOffset - edgeOffset),
        getColor(bitmap, x, y + offGridOffset + edgeOffset)
      );
      const lineScore = onGrid - (beforeGrid + afterGrid) / 2;
      score += lineScore;
      samples += 1;

      if (row === 0 || row === 8) {
        const side = row === 0 ? boundaryLines.top : boundaryLines.bottom;
        side.score += lineScore;
        side.samples += 1;
      }
    }
  }

  const averageScore = samples === 0 ? 0 : score / samples;
  const availableBoundaryScores = [
    candidate.x > edgeOffset * 2 ? boundaryLines.left : null,
    candidate.x + candidate.size < bitmap.width - edgeOffset * 2 ? boundaryLines.right : null,
    candidate.y > edgeOffset * 2 ? boundaryLines.top : null,
    candidate.y + candidate.size < bitmap.height - edgeOffset * 2 ? boundaryLines.bottom : null
  ]
    .filter((line): line is { score: number; samples: number } => line !== null && line.samples > 0)
    .map((line) => line.score / line.samples);
  const boundaryScore =
    availableBoundaryScores.length === 0 ? 24 : Math.max(0, Math.min(...availableBoundaryScores));

  return {
    gridScore: Math.max(0, averageScore + boundaryScore * 0.8),
    boundaryScore
  };
};

const addGridEvidence = (bitmap: Bitmap, candidate: Candidate): Candidate => {
  const { gridScore, boundaryScore } = getInternalGridScores(bitmap, candidate);

  return {
    ...candidate,
    gridScore,
    boundaryScore,
    score: candidate.score + Math.min(gridScore, 220) * 0.18
  };
};

const chooseBetterCandidate = (current: Candidate, possible: Candidate) => {
  const currentUsable = isUsableCandidate(current);
  const possibleUsable = isUsableCandidate(possible);

  if (possibleUsable !== currentUsable) {
    return possibleUsable ? possible : current;
  }

  if (possible.boundaryScore > current.boundaryScore + 12) {
    return possible;
  }

  return possible.score > current.score ? possible : current;
};

const adjustCandidateToBoundary = (bitmap: Bitmap, candidate: Candidate) => {
  const cellSize = candidate.size / 8;
  let best = addGridEvidence(bitmap, candidate);

  for (const xOffset of [-cellSize, 0, cellSize]) {
    for (const yOffset of [-cellSize, 0, cellSize]) {
      if (xOffset === 0 && yOffset === 0) {
        continue;
      }

      const possible = scoreCandidate(bitmap, candidate.x + xOffset, candidate.y + yOffset, candidate.size);

      if (!possible) {
        continue;
      }

      best = chooseBetterCandidate(best, addGridEvidence(bitmap, possible));
    }
  }

  return best;
};

const classifyRankDigitInRoi = (
  bitmap: Bitmap,
  roi: { x: number; y: number; width: number; height: number }
): RankDigitDetection => {
  if (roi.x + roi.width < 0 || roi.y + roi.height < 0 || roi.x >= bitmap.width || roi.y >= bitmap.height) {
    return { digit: "unknown", confidence: 0 };
  }

  const background = getDominantColor(bitmap, roi);
  const threshold = 70;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let foregroundPixels = 0;

  for (let y = Math.round(roi.y); y < roi.y + roi.height; y += 1) {
    for (let x = Math.round(roi.x); x < roi.x + roi.width; x += 1) {
      if (edgeDistance(getColor(bitmap, x, y), background) < threshold) {
        continue;
      }

      foregroundPixels += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  const minPixels = Math.max(6, roi.width * roi.height * 0.012);
  if (foregroundPixels < minPixels) {
    return { digit: "unknown", confidence: 0 };
  }

  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  const fillRatio = foregroundPixels / Math.max(1, roi.width * roi.height);
  if (fillRatio > 0.34 || width > roi.width * 0.92) {
    return { digit: "unknown", confidence: 0 };
  }

  const ratio = width / Math.max(1, height);
  const sizeConfidence = clamp(foregroundPixels / Math.max(1, roi.width * roi.height * 0.09), 0, 1);
  let leftPixels = 0;
  let rightPixels = 0;

  for (let y = Math.round(roi.y); y < roi.y + roi.height; y += 1) {
    for (let x = Math.round(roi.x); x < roi.x + roi.width; x += 1) {
      if (edgeDistance(getColor(bitmap, x, y), background) < threshold) {
        continue;
      }

      const normalizedX = (x - minX) / Math.max(1, width);
      if (normalizedX < 0.35) leftPixels += 1;
      if (normalizedX > 0.65) rightPixels += 1;
    }
  }

  const leftRatio = leftPixels / foregroundPixels;
  const rightRatio = rightPixels / foregroundPixels;

  if (
    (leftRatio < 0.18 && rightRatio < 0.28) ||
    (leftRatio > 0.35 && rightRatio < 0.16) ||
    (rightRatio > 0.35 && leftRatio < 0.2 && ratio < 0.62)
  ) {
    return {
      digit: "1",
      confidence: clamp((0.28 - leftRatio) / 0.2, 0.35, 1) * sizeConfidence,
      ratio,
      fillRatio,
      leftRatio,
      rightRatio
    };
  }

  if (ratio <= 0.44) {
    return {
      digit: "1",
      confidence: clamp((0.5 - ratio) / 0.28, 0.2, 1) * sizeConfidence,
      ratio,
      fillRatio,
      leftRatio,
      rightRatio
    };
  }

  if (ratio >= 0.52 || leftRatio >= 0.22 || rightRatio >= 0.3) {
    return {
      digit: "8",
      confidence: clamp((ratio - 0.46) / 0.3, 0.2, 1) * sizeConfidence,
      ratio,
      fillRatio,
      leftRatio,
      rightRatio
    };
  }

  return { digit: "unknown", confidence: 0 };
};

const getForegroundBounds = (
  bitmap: Bitmap,
  roi: { x: number; y: number; width: number; height: number },
  threshold: number
) => {
  if (roi.x + roi.width < 0 || roi.y + roi.height < 0 || roi.x >= bitmap.width || roi.y >= bitmap.height) {
    return null;
  }

  const background = getDominantColor(bitmap, roi);
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let foregroundPixels = 0;
  const points: Array<{ x: number; y: number }> = [];

  for (let y = Math.round(roi.y); y < roi.y + roi.height; y += 1) {
    for (let x = Math.round(roi.x); x < roi.x + roi.width; x += 1) {
      if (edgeDistance(getColor(bitmap, x, y), background) < threshold) {
        continue;
      }

      foregroundPixels += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      points.push({ x, y });
    }
  }

  if (foregroundPixels === 0) {
    return null;
  }

  return { minX, minY, maxX, maxY, foregroundPixels, points };
};

const classifyInsideRankDigitAtY = (
  bitmap: Bitmap,
  board: BoardRect,
  y: number,
  side: "left" | "right"
): RankDigitDetection => {
  const cellSize = board.size / 8;
  const x = side === "left" ? board.x + cellSize * 0.02 : board.x + board.size - cellSize * 0.22;

  return classifyRankDigitInRoi(bitmap, {
    x,
    y,
    width: cellSize * 0.2,
    height: cellSize * 0.24
  });
};

const classifyInsideRankDigit = (
  bitmap: Bitmap,
  board: BoardRect,
  row: 0 | 7,
  side: "left" | "right"
): RankDigitDetection => {
  const cellSize = board.size / 8;
  return classifyInsideRankDigitAtY(bitmap, board, board.y + row * cellSize + cellSize * 0.02, side);
};

const classifyOutsideRankDigit = (bitmap: Bitmap, board: BoardRect, row: 0 | 7): RankDigitDetection => {
  const cellSize = board.size / 8;

  return classifyRankDigitInRoi(bitmap, {
    x: board.x - cellSize * 0.45,
    y: board.y + row * cellSize + cellSize * 0.25,
    width: cellSize * 0.38,
    height: cellSize * 0.52
  });
};

const classifyFileLetterInRoi = (
  bitmap: Bitmap,
  roi: { x: number; y: number; width: number; height: number }
): FileLetterDetection => {
  const bounds = getForegroundBounds(bitmap, roi, 52);

  if (!bounds) {
    return { letter: "unknown", confidence: 0 };
  }

  const minPixels = Math.max(6, roi.width * roi.height * 0.01);
  if (bounds.foregroundPixels < minPixels) {
    return { letter: "unknown", confidence: 0 };
  }

  const width = bounds.maxX - bounds.minX + 1;
  const height = bounds.maxY - bounds.minY + 1;
  const fillRatio = bounds.foregroundPixels / Math.max(1, roi.width * roi.height);

  if (fillRatio > 0.32 || width > roi.width * 0.9 || height > roi.height * 0.94) {
    return { letter: "unknown", confidence: 0 };
  }

  const ratio = width / Math.max(1, height);
  const relativeHeight = height / Math.max(1, roi.height);
  let upperLeftPixels = 0;
  let upperPixels = 0;

  for (const point of bounds.points) {
    const normalizedX = (point.x - bounds.minX) / Math.max(1, width);
    const normalizedY = (point.y - bounds.minY) / Math.max(1, height);

    if (normalizedY < 0.45) {
      upperPixels += 1;
    }

    if (normalizedX < 0.4 && normalizedY < 0.55) {
      upperLeftPixels += 1;
    }
  }

  const upperRatio = upperPixels / bounds.foregroundPixels;
  const upperLeftRatio = upperLeftPixels / bounds.foregroundPixels;
  const hScore =
    clamp((0.76 - ratio) / 0.24, 0, 1) * 0.45 +
    clamp((relativeHeight - 0.48) / 0.24, 0, 1) * 0.25 +
    clamp((upperLeftRatio - 0.12) / 0.2, 0, 1) * 0.2 +
    clamp((upperRatio - 0.28) / 0.18, 0, 1) * 0.1;
  const aScore =
    clamp((ratio - 0.68) / 0.28, 0, 1) * 0.5 +
    clamp((0.72 - relativeHeight) / 0.24, 0, 1) * 0.2 +
    clamp((0.27 - upperLeftRatio) / 0.2, 0, 1) * 0.2 +
    clamp((0.5 - upperRatio) / 0.25, 0, 1) * 0.1;

  if (hScore > aScore && hScore >= 0.35) {
    return { letter: "h", confidence: hScore };
  }

  if (aScore > hScore && aScore >= 0.35) {
    return { letter: "a", confidence: aScore };
  }

  return { letter: "unknown", confidence: 0 };
};

const classifyBottomFileLetter = (
  bitmap: Bitmap,
  board: BoardRect,
  column: 0 | 7,
  side: "left" | "right"
): FileLetterDetection => {
  const cellSize = board.size / 8;
  const xOffset = side === "left" ? cellSize * 0.02 : cellSize * 0.62;

  return classifyFileLetterInRoi(bitmap, {
    x: board.x + column * cellSize + xOffset,
    y: board.y + board.size - cellSize * 0.24,
    width: cellSize * 0.34,
    height: cellSize * 0.22
  });
};

const addOrientationEvidence = (
  topRank: RankDigitDetection,
  bottomRank: RankDigitDetection,
  weight: number,
  scores: { white: number; black: number }
) => {
  if (topRank.digit === "8") scores.white += topRank.confidence * weight;
  if (topRank.digit === "1") scores.black += topRank.confidence * weight;
  if (bottomRank.digit === "1") scores.white += bottomRank.confidence * weight;
  if (bottomRank.digit === "8") scores.black += bottomRank.confidence * weight;
};

const addFileOrientationEvidence = (
  leftFile: FileLetterDetection,
  rightFile: FileLetterDetection,
  weight: number,
  scores: { white: number; black: number }
) => {
  if (leftFile.letter === "a") scores.white += leftFile.confidence * weight;
  if (leftFile.letter === "h") scores.black += leftFile.confidence * weight;
  if (rightFile.letter === "h") scores.white += rightFile.confidence * weight;
  if (rightFile.letter === "a") scores.black += rightFile.confidence * weight;
};

const detectBoardOrientation = (
  bitmap: Bitmap,
  board: BoardRect
): { orientation: BoardOrientation; orientationConfidence: number } => {
  const scores = { white: 0, black: 0 };
  const outsideTopRank = classifyOutsideRankDigit(bitmap, board, 0);
  const outsideBottomRank = classifyOutsideRankDigit(bitmap, board, 7);
  const insideLeftTopRank = classifyInsideRankDigit(bitmap, board, 0, "left");
  const insideLeftBottomRank = classifyInsideRankDigit(bitmap, board, 7, "left");
  const insideRightTopRank = classifyInsideRankDigit(bitmap, board, 0, "right");
  const insideRightBottomRank = classifyInsideRankDigit(bitmap, board, 7, "right");
  const bottomLeftFileLeft = classifyBottomFileLetter(bitmap, board, 0, "left");
  const bottomLeftFileRight = classifyBottomFileLetter(bitmap, board, 0, "right");
  const bottomRightFileLeft = classifyBottomFileLetter(bitmap, board, 7, "left");
  const bottomRightFileRight = classifyBottomFileLetter(bitmap, board, 7, "right");
  addOrientationEvidence(outsideTopRank, outsideBottomRank, 1.25, scores);
  addOrientationEvidence(insideLeftTopRank, insideLeftBottomRank, 0.75, scores);
  addOrientationEvidence(insideRightTopRank, insideRightBottomRank, 0.75, scores);
  addFileOrientationEvidence(bottomLeftFileLeft, bottomRightFileLeft, 1.5, scores);
  addFileOrientationEvidence(bottomLeftFileRight, bottomRightFileRight, 1.5, scores);

  if (process.env.DEBUG_BOARD_DETECTOR) {
    const formatRank = (rank: RankDigitDetection) =>
      `${rank.digit}:${rank.confidence.toFixed(2)}:${(rank.ratio ?? 0).toFixed(2)}:${(rank.leftRatio ?? 0).toFixed(2)}:${(rank.rightRatio ?? 0).toFixed(2)}`;
    console.log(
      `[detect] orientation ranks outside=${formatRank(outsideTopRank)}/${formatRank(outsideBottomRank)} ` +
        `inside-left=${formatRank(insideLeftTopRank)}/${formatRank(insideLeftBottomRank)} ` +
        `inside-right=${formatRank(insideRightTopRank)}/${formatRank(insideRightBottomRank)} ` +
        `files-left=${bottomLeftFileLeft.letter}/${bottomRightFileLeft.letter} ` +
        `files-right=${bottomLeftFileRight.letter}/${bottomRightFileRight.letter} ` +
        `scores white=${scores.white.toFixed(2)} black=${scores.black.toFixed(2)}`
    );
  }

  const totalScore = scores.white + scores.black;
  const difference = Math.abs(scores.white - scores.black);

  if (totalScore < 0.35 || difference < 0.18) {
    return { orientation: "unknown", orientationConfidence: 0 };
  }

  return {
    orientation: scores.white > scores.black ? "white" : "black",
    orientationConfidence: clamp((difference / totalScore) * (totalScore / 1.2), 0, 1)
  };
};

const findPromisingCandidates = (bitmap: Bitmap): Candidate[] => {
  const minSide = Math.min(bitmap.width, bitmap.height);
  const minSize = Math.max(64, minSide * 0.055);
  const maxSize = minSide;
  const candidates: Candidate[] = [];
  const fullImageCandidate =
    Math.abs(bitmap.width - bitmap.height) / minSide <= 0.03
      ? scoreCandidate(bitmap, (bitmap.width - minSide) / 2, (bitmap.height - minSide) / 2, minSide)
      : null;

  if (fullImageCandidate) {
    pushCandidate(candidates, fullImageCandidate);
  }

  for (let size = minSize; size <= maxSize; size += Math.max(5, size * 0.065)) {
    const positionStep = Math.max(5, size / 13);

    for (let y = 0; y <= bitmap.height - size; y += positionStep) {
      for (let x = 0; x <= bitmap.width - size; x += positionStep) {
        const candidate = scoreCandidate(bitmap, x, y, size, FAST_CELL_SAMPLE_OFFSETS);

        if (candidate && candidate.score > 25) {
          pushCandidate(candidates, candidate);
        }
      }
    }
  }

  return candidates;
};

const refineCandidate = (bitmap: Bitmap, candidate: Candidate): Candidate => {
  let refinedBest = candidate;

  for (const step of [6, 3, 1]) {
    const radius = Math.max(8, step * 5);
    let refined: Candidate = refinedBest;

    for (let size = refinedBest.size - radius; size <= refinedBest.size + radius; size += Math.max(1, step)) {
      for (let y = refinedBest.y - radius; y <= refinedBest.y + radius; y += step) {
        for (let x = refinedBest.x - radius; x <= refinedBest.x + radius; x += step) {
          const possibleCandidate = scoreCandidate(bitmap, x, y, size);

          if (possibleCandidate && possibleCandidate.score > refined.score) {
            refined = possibleCandidate;
          }
        }
      }
    }

    refinedBest = refined;
  }

  return adjustCandidateToBoundary(bitmap, snapCandidateToEdges(bitmap, refinedBest));
};

const isUsableCandidate = (candidate: Candidate) =>
  candidate.contrast >= 38 &&
  candidate.gridScore >= 22 &&
  candidate.boundaryScore >= 16 &&
  candidate.score >= 48 &&
  candidate.variance <= candidate.contrast * 1.25;

const findBestCandidate = (bitmap: Bitmap): Candidate | null => {
  const candidates = findPromisingCandidates(bitmap);

  if (candidates.length === 0) {
    return null;
  }

  const refinedCandidates = candidates.slice(0, MAX_REFINED_CANDIDATES).map((candidate) => refineCandidate(bitmap, candidate));
  refinedCandidates.sort((a, b) => b.score - a.score);

  if (process.env.DEBUG_BOARD_DETECTOR) {
    console.log(
      refinedCandidates
        .slice(0, 5)
        .map(
          (candidate) =>
            `[detect] candidate ${Math.round(candidate.x)},${Math.round(candidate.y)} ${Math.round(candidate.size)} score=${candidate.score.toFixed(1)} contrast=${candidate.contrast.toFixed(1)} variance=${candidate.variance.toFixed(1)} pattern=${candidate.patternScore.toFixed(2)} continuation=${candidate.continuationPenalty.toFixed(1)} grid=${candidate.gridScore.toFixed(1)} boundary=${candidate.boundaryScore.toFixed(1)}`
        )
        .join("\n")
    );
  }

  return refinedCandidates.find(isUsableCandidate) ?? null;
};

const horizontalEdgeScore = (bitmap: Bitmap, y: number, xStart: number, xEnd: number) => {
  const step = Math.max(1, Math.floor((xEnd - xStart) / 180));
  let score = 0;
  let samples = 0;

  for (let x = xStart; x <= xEnd; x += step) {
    score += edgeDistance(getColor(bitmap, x, y), getColor(bitmap, x, y - 1));
    samples += 1;
  }

  return samples === 0 ? 0 : score / samples;
};

const verticalEdgeScore = (bitmap: Bitmap, x: number, yStart: number, yEnd: number) => {
  const step = Math.max(1, Math.floor((yEnd - yStart) / 180));
  let score = 0;
  let samples = 0;

  for (let y = yStart; y <= yEnd; y += step) {
    score += edgeDistance(getColor(bitmap, x, y), getColor(bitmap, x - 1, y));
    samples += 1;
  }

  return samples === 0 ? 0 : score / samples;
};

const fitGridAxis = (
  getScore: (position: number) => number,
  approxStart: number,
  approxSize: number,
  minStart: number,
  maxStart: number,
  minSize: number,
  maxSize: number,
  maxPosition: number
): GridFit | null => {
  let best: GridFit | null = null;
  const startFrom = Math.ceil(clamp(minStart, 1, maxPosition - 2));
  const startTo = Math.floor(clamp(maxStart, 1, maxPosition - 2));
  const sizeFrom = Math.ceil(Math.max(16, minSize));
  const sizeTo = Math.floor(Math.max(sizeFrom, maxSize));
  const scoreCache = new Map<number, number>();
  const scoreFrom = Math.floor(clamp(startFrom, 1, maxPosition - 2));
  const scoreTo = Math.ceil(clamp(startTo + sizeTo, 1, maxPosition - 2));

  for (let position = scoreFrom; position <= scoreTo; position += 1) {
    scoreCache.set(position, getScore(position));
  }

  for (let start = startFrom; start <= startTo; start += 1) {
    for (let size = sizeFrom; size <= sizeTo; size += 1) {
      if (start + size > maxPosition - 1) {
        continue;
      }

      let score = 0;
      let minLineScore = Number.POSITIVE_INFINITY;

      for (let line = 0; line <= 8; line += 1) {
        const linePosition = Math.round(start + (line * size) / 8);
        const lineScore = scoreCache.get(linePosition) ?? 0;
        score += lineScore;
        minLineScore = Math.min(minLineScore, lineScore);
      }

      const startPenalty = Math.abs(start - approxStart) * 0.18;
      const sizePenalty = Math.abs(size - approxSize) * 0.08;
      const finalScore = score + minLineScore * 1.4 - startPenalty - sizePenalty;

      if (!best || finalScore > best.score) {
        best = { start, size, score: finalScore };
      }
    }
  }

  return best;
};

const findHorizontalEdge = (
  bitmap: Bitmap,
  from: number,
  to: number,
  xStart: number,
  xEnd: number
): number | null => {
  let bestY = 0;
  let bestScore = 0;

  const start = clamp(Math.round(Math.min(from, to)), 1, bitmap.height - 1);
  const end = clamp(Math.round(Math.max(from, to)), 1, bitmap.height - 1);

  for (let y = start; y <= end; y += 1) {
    const score = horizontalEdgeScore(bitmap, y, xStart, xEnd);

    if (score > bestScore) {
      bestScore = score;
      bestY = y;
    }
  }

  return bestScore > 12 ? bestY : null;
};

const findVerticalEdge = (
  bitmap: Bitmap,
  from: number,
  to: number,
  yStart: number,
  yEnd: number
): number | null => {
  let bestX = 0;
  let bestScore = 0;

  const start = clamp(Math.round(Math.min(from, to)), 1, bitmap.width - 1);
  const end = clamp(Math.round(Math.max(from, to)), 1, bitmap.width - 1);

  for (let x = start; x <= end; x += 1) {
    const score = verticalEdgeScore(bitmap, x, yStart, yEnd);

    if (score > bestScore) {
      bestScore = score;
      bestX = x;
    }
  }

  return bestScore > 12 ? bestX : null;
};

const snapCandidateToEdges = (bitmap: Bitmap, candidate: Candidate): Candidate => {
  const cellSize = candidate.size / 8;
  const inset = cellSize * 0.08;
  const xStart = clamp(Math.round(candidate.x + inset), 0, bitmap.width - 1);
  const xEnd = clamp(Math.round(candidate.x + candidate.size - inset), 0, bitmap.width - 1);
  const yStart = clamp(Math.round(candidate.y + inset), 0, bitmap.height - 1);
  const yEnd = clamp(Math.round(candidate.y + candidate.size - inset), 0, bitmap.height - 1);
  const topFit = fitGridAxis(
    (position) => horizontalEdgeScore(bitmap, Math.round(position), xStart, xEnd),
    candidate.y,
    candidate.size,
    candidate.y - cellSize * 1.2,
    candidate.y + cellSize * 0.45,
    candidate.size - cellSize * 0.8,
    candidate.size + cellSize * 0.8,
    bitmap.height
  );
  const leftFit = fitGridAxis(
    (position) => verticalEdgeScore(bitmap, Math.round(position), yStart, yEnd),
    candidate.x,
    candidate.size,
    candidate.x - cellSize * 1.2,
    candidate.x + cellSize * 0.45,
    candidate.size - cellSize * 0.8,
    candidate.size + cellSize * 0.8,
    bitmap.width
  );

  if (topFit && leftFit) {
    const size = Math.min(topFit.size, leftFit.size);

    return {
      ...candidate,
      x: leftFit.start,
      y: topFit.start,
      size
    };
  }

  const left = findVerticalEdge(bitmap, candidate.x - 2, candidate.x + cellSize * 0.35, yStart, yEnd) ?? candidate.x;
  const top =
    findHorizontalEdge(bitmap, candidate.y - 2, candidate.y + cellSize * 0.35, xStart, xEnd) ?? candidate.y;
  const right =
    findVerticalEdge(
      bitmap,
      candidate.x + candidate.size - cellSize * 0.15,
      candidate.x + candidate.size + cellSize * 0.2,
      yStart,
      yEnd
    ) ?? candidate.x + candidate.size;
  const bottom =
    findHorizontalEdge(
      bitmap,
      candidate.y + candidate.size - cellSize * 0.15,
      candidate.y + candidate.size + cellSize * 0.2,
      xStart,
      xEnd
    ) ?? candidate.y + candidate.size;

  const width = right - left;
  const height = bottom - top;

  if (width <= 0 || height <= 0 || Math.abs(width - height) / Math.min(width, height) > 0.08) {
    return candidate;
  }

  const size = Math.min(width, height);

  return {
    ...candidate,
    x: left,
    y: top,
    size
  };
};

const createAnalysisBitmap = (image: NativeImage, maxDimension: number) => {
  const originalSize = image.getSize();
  const analysisScale = Math.min(1, maxDimension / Math.max(originalSize.width, originalSize.height));
  const analysisSize = {
    width: Math.max(1, Math.round(originalSize.width * analysisScale)),
    height: Math.max(1, Math.round(originalSize.height * analysisScale))
  };
  const analysisImage = analysisScale === 1 ? image : image.resize(analysisSize);
  const bitmap: Bitmap = {
    ...analysisImage.getSize(),
    data: analysisImage.toBitmap({ scaleFactor: 1 })
  };

  return { bitmap, originalSize };
};

const finishAnalysis = (bitmap: Bitmap, candidate: Candidate) => {
  const snapped = candidate;
  const { orientation, orientationConfidence } = detectBoardOrientation(bitmap, {
    x: snapped.x,
    y: snapped.y,
    size: snapped.size
  });

  return { bitmap, bestCandidate: candidate, snapped, orientation, orientationConfidence };
};

const analyzeImage = (image: NativeImage, maxDimension: number) => {
  const { bitmap } = createAnalysisBitmap(image, maxDimension);
  const bestCandidate = findBestCandidate(bitmap);
  if (!bestCandidate) {
    return null;
  }

  return finishAnalysis(bitmap, bestCandidate);
};

const analyzeImageNearHint = (image: NativeImage, maxDimension: number, hint: BoardDetection) => {
  const { bitmap, originalSize } = createAnalysisBitmap(image, maxDimension);
  const scaleX = bitmap.width / originalSize.width;
  const scaleY = bitmap.height / originalSize.height;
  const hintedCandidate = scoreCandidate(
    bitmap,
    hint.x * scaleX,
    hint.y * scaleY,
    Math.min(hint.width * scaleX, hint.height * scaleY)
  );

  if (!hintedCandidate) {
    return null;
  }

  const refinedCandidate = refineCandidate(bitmap, hintedCandidate);

  if (!isUsableCandidate(refinedCandidate)) {
    return null;
  }

  return finishAnalysis(bitmap, refinedCandidate);
};

export const detectChessboard = (image: NativeImage, hint?: BoardDetection): BoardDetection | null => {
  const originalSize = image.getSize();

  if (originalSize.width < 160 || originalSize.height < 160) {
    return null;
  }

  const hintedAnalysis = hint ? analyzeImageNearHint(image, FAST_ANALYSIS_MAX_DIMENSION, hint) : null;
  const fastAnalysis = hintedAnalysis ?? analyzeImage(image, FAST_ANALYSIS_MAX_DIMENSION);
  const analysis =
    fastAnalysis ??
    (Math.max(originalSize.width, originalSize.height) > FAST_ANALYSIS_MAX_DIMENSION
      ? analyzeImage(image, DETAILED_ANALYSIS_MAX_DIMENSION)
      : null);

  if (!analysis) {
    return null;
  }

  const { bitmap, bestCandidate, snapped, orientation, orientationConfidence } = analysis;
  const scaleX = originalSize.width / bitmap.width;
  const scaleY = originalSize.height / bitmap.height;
  const x = clamp(Math.round(snapped.x * scaleX), 0, originalSize.width - 1);
  const y = clamp(Math.round(snapped.y * scaleY), 0, originalSize.height - 1);
  const width = clamp(Math.round(snapped.size * scaleX), 1, originalSize.width - x);
  const height = clamp(Math.round(snapped.size * scaleY), 1, originalSize.height - y);
  const side = Math.min(width, height);
  const confidence = clamp((bestCandidate.score - 35) / 180, 0, 1);

  return {
    x,
    y,
    width: side,
    height: side,
    confidence,
    orientation,
    orientationConfidence
  };
};

export const detectBoardImageOrientation = (
  image: NativeImage
): { orientation: BoardOrientation; orientationConfidence: number } => {
  const originalSize = image.getSize();

  if (originalSize.width < 160 || originalSize.height < 160) {
    return { orientation: "unknown", orientationConfidence: 0 };
  }

  const { bitmap } = createAnalysisBitmap(image, DETAILED_ANALYSIS_MAX_DIMENSION);
  const size = Math.min(bitmap.width, bitmap.height);
  const centeredCandidate = scoreCandidate(bitmap, (bitmap.width - size) / 2, (bitmap.height - size) / 2, size);
  const board = centeredCandidate ? snapCandidateToEdges(bitmap, centeredCandidate) : {
    x: (bitmap.width - size) / 2,
    y: (bitmap.height - size) / 2,
    size
  };

  return detectBoardOrientation(bitmap, board);
};
