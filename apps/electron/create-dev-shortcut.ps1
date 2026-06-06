# PowerShell script to create a Desktop shortcut for Local Recorder (Dev Mode)
# Run this script once to create the shortcut

$WshShell = New-Object -ComObject WScript.Shell

# Get paths
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $ScriptDir)
$BatchFile = Join-Path $ProjectRoot "run-electron.bat"
$IconPath = Join-Path $ScriptDir "resources\icon.png"

# Create Desktop shortcut
$DesktopPath = [Environment]::GetFolderPath("Desktop")
$ShortcutPath = Join-Path $DesktopPath "Local Recorder (Dev).lnk"

$Shortcut = $WshShell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = $BatchFile
$Shortcut.WorkingDirectory = $ScriptDir
$Shortcut.Description = "Local Recorder - Development Mode"
$Shortcut.WindowStyle = 7  # Minimized
$Shortcut.Save()

Write-Host "Desktop shortcut created at: $ShortcutPath" -ForegroundColor Green

# Create Start Menu shortcut
$StartMenuPath = [Environment]::GetFolderPath("StartMenu")
$StartMenuProgramsPath = Join-Path $StartMenuPath "Programs"
$StartMenuShortcutPath = Join-Path $StartMenuProgramsPath "Local Recorder (Dev).lnk"

$StartMenuShortcut = $WshShell.CreateShortcut($StartMenuShortcutPath)
$StartMenuShortcut.TargetPath = $BatchFile
$StartMenuShortcut.WorkingDirectory = $ScriptDir
$StartMenuShortcut.Description = "Local Recorder - Development Mode"
$StartMenuShortcut.WindowStyle = 7  # Minimized
$StartMenuShortcut.Save()

Write-Host "Start Menu shortcut created at: $StartMenuShortcutPath" -ForegroundColor Green

Write-Host ""
Write-Host "Done! You can now launch Local Recorder (Dev) from:" -ForegroundColor Cyan
Write-Host "  - Desktop" -ForegroundColor Cyan
Write-Host "  - Start Menu (search for 'Local Recorder')" -ForegroundColor Cyan
