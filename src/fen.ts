export type ActiveColor = "w" | "b";

const labelNames = " KQRBNPkqrbnp";

const shortenEmptySquares = (rank: string) => rank.replace(/1+/g, (match) => String(match.length));

const getCastlingStatus = (board64: string) => {
  const status = ["", "", "", ""];

  if (board64.length >= 64) {
    if (board64[4] === "k") {
      if (board64[0] === "r") status[3] = "q";
      if (board64[7] === "r") status[2] = "k";
    }

    if (board64[60] === "K") {
      if (board64[56] === "R") status[1] = "Q";
      if (board64[63] === "R") status[0] = "K";
    }
  }

  const castling = status.join("");
  return castling.length > 0 ? castling : "-";
};

export const labelsToFen = (labels: readonly number[], active: ActiveColor = "w") => {
  if (labels.length !== 64) {
    throw new Error("Expected 64 piece labels.");
  }

  const ranks: string[] = [];

  for (let rank = 7; rank >= 0; rank -= 1) {
    let row = "";

    for (let file = 0; file < 8; file += 1) {
      const label = labels[rank * 8 + file];
      row += label === 0 ? "1" : labelNames[label] ?? "1";
    }

    ranks.push(row);
  }

  const board64 = ranks.join("");
  const boardFen = ranks.map(shortenEmptySquares).join("/");
  const castling = getCastlingStatus(board64);

  return `${boardFen} ${active} ${castling} - 0 1`;
};

