# Windows And WSL Notes

The app can be edited, built, and tested from WSL, but the Electron GUI and USB device path are usually more reliable from native Windows.

## Recommended Windows Workflow

Use Windows PowerShell or Command Prompt:

```powershell
cd path\to\hidock-next\apps\electron
npm install
npm run build:transcriber
npm run dev
```

Or from the repo root:

```powershell
.\run-electron.bat
```

## WSL Workflow

Use WSL for code and build checks:

```bash
cd /home/george/code/hidock-next/apps/electron
npm install
npm run build:transcriber
npm run build
npm run test:run
```

Running the Electron GUI from WSL requires a working display server such as WSLg. USB access also requires USB forwarding, typically through `usbipd-win`.

For this project, native Windows is the pragmatic path when testing real HiDock device behavior.

## Rust Sidecar

Local transcription uses a Rust sidecar. Install Rust and CMake in the environment where you build the sidecar:

```bash
npm run build:transcriber
```

If the Electron app runs from Windows, build the sidecar from Windows so `native/transcriber/target/release/hidock-transcriber.exe` exists. A Linux sidecar built in WSL cannot be launched by the Windows Electron process.

Linux/WSL packaging can also require libudev development headers for the app's existing USB native module:

```bash
sudo apt install libudev-dev
```

If packaging from WSL/Linux fails while rebuilding the existing `usb` native module with `std::string_view` or `if constexpr` errors, run the package command with C++17 enabled:

```bash
CXXFLAGS="-std=c++17" npm run build:unpack
```

## Python Fallback

Python is only needed for the legacy Parakeet fallback path when the Rust sidecar is unavailable. If the Electron app runs from Windows, the Parakeet Python command must point to a Windows Python executable. A WSL Python path will not be visible to the Windows Electron process.

Example Windows path:

```text
C:\Users\you\venvs\parakeet\Scripts\python.exe
```
