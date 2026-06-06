# Windows And WSL Notes

The app can be edited, built, and tested from WSL, but the Electron GUI and USB device path are usually more reliable from native Windows.

## Recommended Windows Workflow

Use Windows PowerShell or Command Prompt:

```powershell
cd path\to\local-recorder\apps\electron
npm install
npm run dev
```

Or from the repo root:

```powershell
.\run-electron.bat
```

## WSL Workflow

Use WSL for code and build checks:

```bash
cd /home/george/code/local-recorder/apps/electron
npm install
npm run build
npm run test:run
```

Running the Electron GUI from WSL requires a working display server such as WSLg. USB access also requires USB forwarding, typically through `usbipd-win`.

For this project, native Windows is the pragmatic path when testing real device behavior.

## Rust Sidecar

Local transcription requires a Rust sidecar. Install Rust and CMake in the environment where you build or run the app:

```bash
npm run build:transcriber
```

`npm run dev`, `npm run build`, and packaged build scripts also build and verify the sidecar. If the Electron app runs from Windows, build from Windows so `native/transcriber/target/release/recorder-transcriber.exe` exists. A Linux sidecar built in WSL cannot be launched by the Windows Electron process.

Linux/WSL packaging can also require libudev development headers for the app's existing USB native module:

```bash
sudo apt install libudev-dev
```

If packaging from WSL/Linux fails while rebuilding the existing `usb` native module with `std::string_view` or `if constexpr` errors, run the package command with C++17 enabled:

```bash
CXXFLAGS="-std=c++17" npm run build:unpack
```

There is no Python or CLI fallback path. If the sidecar is missing at runtime, Local Recorder stops during startup and asks you to build the sidecar for the current OS.
