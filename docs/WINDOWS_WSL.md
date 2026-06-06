# Windows And WSL Notes

The app can be edited, built, and tested from WSL, but the Electron GUI and USB device path are usually more reliable from native Windows.

## Recommended Windows Workflow

Use Windows PowerShell or Command Prompt:

```powershell
cd path\to\hidock-next\apps\electron
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
cd /home/george/code/hidock-next/apps/electron
npm install
npm run build
npm run test:run
```

Running the Electron GUI from WSL requires a working display server such as WSLg. USB access also requires USB forwarding, typically through `usbipd-win`.

For this project, native Windows is the pragmatic path when testing real HiDock device behavior.

## Python Environments

If the Electron app runs from Windows, the Parakeet Python command must point to a Windows Python executable. A WSL Python path will not be visible to the Windows Electron process.

Example Windows path:

```text
C:\Users\you\venvs\parakeet\Scripts\python.exe
```
