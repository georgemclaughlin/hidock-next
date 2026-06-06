#!/bin/bash
# Local Recorder - Development Run Script

echo "Starting Local Recorder..."
echo

# Navigate to script directory (project root)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if grep -qi microsoft /proc/version 2>/dev/null && [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
    echo "Warning: WSL detected without a display server."
    echo "Electron GUI and USB testing are usually more reliable from native Windows."
    echo
fi

# Check if electron app directory exists
if [ ! -d "apps/electron" ]; then
    echo "Error: apps/electron directory not found!"
    echo "Make sure the local-recorder project structure is intact."
    echo "Current directory: $(pwd)"
    exit 1
fi

# Navigate to electron app directory
cd apps/electron

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "Node modules not found. Installing dependencies..."
    npm install
    if [ $? -ne 0 ]; then
        echo
        echo "Failed to install dependencies."
        exit 1
    fi
fi

echo
echo "================================"
echo "Local Recorder"
echo "================================"
echo
echo "To stop the application, close the window or press Ctrl+C here."
echo

# Run the electron app in development mode
npm run dev
