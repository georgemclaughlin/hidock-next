#!/bin/bash
# Local Recorder - Build Script

echo "Building Local Recorder..."
echo

# Navigate to script directory (project root)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Check if electron app directory exists
if [ ! -d "apps/electron" ]; then
    echo "Error: apps/electron directory not found!"
    echo "Make sure the local-recorder project structure is intact."
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
echo "Building Local Recorder Electron App"
echo "================================"
echo "Compiling required Rust sidecar, main process, and renderer..."
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
