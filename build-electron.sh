#!/bin/bash
# HiDock Local - Build Script

echo "Building HiDock Local..."
echo

# Navigate to script directory (project root)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Check if electron app directory exists
if [ ! -d "apps/electron" ]; then
    echo "Error: apps/electron directory not found!"
    echo "Make sure the hidock-next project structure is intact."
    echo "Current directory: $(pwd)"
    exit 1
fi

# Navigate to electron app directory
cd apps/electron

# Install/update dependencies
echo "Installing dependencies..."
# Use npm ci for clean, reproducible installs from package-lock.json
# Falls back to npm install if package-lock.json doesn't exist
if [ -f "package-lock.json" ]; then
    npm ci
else
    npm install
fi
if [ $? -ne 0 ]; then
    echo
    echo "Failed to install dependencies."
    exit 1
fi
echo "Dependencies installed successfully."
echo

echo
echo "================================"
echo "Building HiDock Local Electron App"
echo "================================"
echo "Compiling local transcription sidecar..."
echo

npm run build:transcriber

if [ $? -ne 0 ]; then
    echo
    echo "Sidecar build failed. Please check the error messages above."
    exit 1
fi

echo "Compiling main process (backend) and renderer (frontend)..."
echo
npm run build

if [ $? -eq 0 ]; then
    echo
    echo "================================"
    echo "Build completed successfully!"
    echo "================================"
    echo "Output directory: apps/electron/out/"
    echo "  - Main process: out/main/"
    echo "  - Renderer: out/renderer/"
    echo "  - Preload: out/preload/"
    echo
else
    echo
    echo "Build failed. Please check the error messages above."
    exit 1
fi
