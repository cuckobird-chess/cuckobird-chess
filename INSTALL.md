# Installation Guide

Install Node.js `22.12.0` or newer and Stockfish, then install the app dependencies from this repo. Lc0 is optional and only needed for Maia. Tesseract is optional; the commands below include it where available because it can improve board-orientation detection.

## macOS

```bash
brew install node stockfish lc0 tesseract
corepack enable
corepack prepare pnpm@9.4.0 --activate
pnpm install
pnpm start
```

On first capture, macOS may ask for Screen & System Audio Recording permission. Enable it, quit the app, and run `pnpm start` again.

## Linux

Ubuntu/Debian:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt update
sudo apt install -y nodejs stockfish tesseract-ocr
corepack enable
corepack prepare pnpm@9.4.0 --activate
pnpm install
pnpm start
```

For other distros, install Node.js `22.12.0` or newer, `stockfish`, optional `lc0`, and `tesseract` with your package manager, then run the Corepack and pnpm commands above.

## Windows

PowerShell:

```powershell
winget install -e --id OpenJS.NodeJS.LTS
winget install -e --id UB-Mannheim.TesseractOCR
corepack enable
corepack prepare pnpm@9.4.0 --activate
pnpm install
pnpm start
```

Install Stockfish from [stockfishchess.org/download](https://stockfishchess.org/download/), unzip it, then set `STOCKFISH_PATH` to the executable:

```powershell
[Environment]::SetEnvironmentVariable("STOCKFISH_PATH", "C:\Tools\stockfish\stockfish.exe", "User")
```

To use Maia on Windows, install Lc0 from [lczero.org](https://lczero.org/play/download/) and set `LC0_PATH`:

```powershell
[Environment]::SetEnvironmentVariable("LC0_PATH", "C:\Tools\lc0\lc0.exe", "User")
```

If Tesseract is not added to `PATH`, set:

```powershell
[Environment]::SetEnvironmentVariable("TESSERACT_PATH", "C:\Program Files\Tesseract-OCR\tesseract.exe", "User")
```

Restart PowerShell after changing environment variables.
