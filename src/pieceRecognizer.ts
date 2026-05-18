import type { NativeImage } from "electron";
import fs from "node:fs";
import * as ort from "onnxruntime-node";
import { labelsToFen, type ActiveColor } from "./fen";
import type { BoardOrientation } from "./boardDetector";

export type FenRecognition = {
  fen: string;
  confidence: number;
  labels: number[];
  orientation: BoardOrientation;
  warning?: string;
};

const boardPixels = 256;
const tilePixels = 32;
const tileArea = tilePixels * tilePixels;
const labelNames = " KQRBNPkqrbnp";
const minimumConfidence = 0.9;

let sessionPromise: Promise<ort.InferenceSession> | undefined;

const getSession = (modelPath: string) => {
  if (!fs.existsSync(modelPath)) {
    throw new Error(`Piece recognition model is missing at ${modelPath}`);
  }

  sessionPromise ??= ort.InferenceSession.create(modelPath);
  return sessionPromise;
};

const getTilePosition = (rank: number, file: number, orientation: BoardOrientation) => {
  if (orientation === "black") {
    return { row: rank, column: 7 - file };
  }

  return { row: 7 - rank, column: file };
};

const imageToTileTensor = (image: NativeImage, orientation: BoardOrientation) => {
  const normalized = image.resize({ width: boardPixels, height: boardPixels, quality: "best" });
  const size = normalized.getSize();
  const bitmap = normalized.toBitmap({ scaleFactor: 1 });
  const grayscale = new Float32Array(boardPixels * boardPixels);

  if (size.width !== boardPixels || size.height !== boardPixels) {
    throw new Error("Could not normalize the board image for piece recognition.");
  }

  for (let index = 0; index < grayscale.length; index += 1) {
    const pixelIndex = index * 4;
    const blue = bitmap[pixelIndex];
    const green = bitmap[pixelIndex + 1];
    const red = bitmap[pixelIndex + 2];
    grayscale[index] = (red * 0.299 + green * 0.587 + blue * 0.114) / 255;
  }

  const tensor = new Float32Array(64 * tileArea);

  for (let rank = 0; rank < 8; rank += 1) {
    for (let file = 0; file < 8; file += 1) {
      const tileIndex = rank * 8 + file;
      const { row, column } = getTilePosition(rank, file, orientation);
      const sourceY = row * tilePixels;
      const sourceX = column * tilePixels;
      const targetOffset = tileIndex * tileArea;

      for (let y = 0; y < tilePixels; y += 1) {
        const sourceOffset = (sourceY + y) * boardPixels + sourceX;
        const targetRowOffset = targetOffset + y * tilePixels;

        for (let x = 0; x < tilePixels; x += 1) {
          tensor[targetRowOffset + x] = grayscale[sourceOffset + x];
        }
      }
    }
  }

  return tensor;
};

const getPredictions = (probabilities: Float32Array | number[]) => {
  const labels: number[] = [];
  let confidence = 1;

  for (let tile = 0; tile < 64; tile += 1) {
    const offset = tile * labelNames.length;
    let bestLabel = 0;
    let bestConfidence = Number.NEGATIVE_INFINITY;

    for (let label = 0; label < labelNames.length; label += 1) {
      const probability = Number(probabilities[offset + label]);

      if (probability > bestConfidence) {
        bestConfidence = probability;
        bestLabel = label;
      }
    }

    labels.push(bestLabel);
    confidence = Math.min(confidence, bestConfidence);
  }

  return { labels, confidence };
};

const getWarning = (orientation: BoardOrientation, confidence: number) => {
  const warnings: string[] = [];

  if (orientation === "unknown") {
    warnings.push("board orientation was unknown, so the FEN assumes White's perspective");
  }

  if (confidence < minimumConfidence) {
    warnings.push(`piece confidence was ${Math.round(confidence * 100)}%`);
  }

  return warnings.length > 0 ? warnings.join("; ") : undefined;
};

export const recognizeFen = async (
  image: NativeImage,
  orientation: BoardOrientation,
  modelPath: string,
  active: ActiveColor = "w"
): Promise<FenRecognition> => {
  const session = await getSession(modelPath);
  const input = imageToTileTensor(image, orientation);
  const output = await session.run({
    input: new ort.Tensor("float32", input, [64, 1, tilePixels, tilePixels])
  });
  const probabilities = output.probabilities?.data;

  if (!probabilities) {
    throw new Error("Piece recognition model did not return probabilities.");
  }

  const { labels, confidence } = getPredictions(probabilities as Float32Array);

  return {
    fen: labelsToFen(labels, active),
    confidence,
    labels,
    orientation,
    warning: getWarning(orientation, confidence)
  };
};

