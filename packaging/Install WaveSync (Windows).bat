@echo off
rem Double-click to install the WaveSync panel for Adobe Premiere Pro (Windows).
setlocal
set "SRC=%~dp0extension"
set "DEST=%APPDATA%\Adobe\CEP\extensions\com.wavesync.panel"

echo Installing WaveSync for Premiere Pro...
echo.

if not exist "%SRC%\CSXS\manifest.xml" (
  echo Can't find the 'extension' folder next to this installer.
  echo Unzip the whole WaveSync folder first, then run this again.
  pause
  exit /b 1
)

rem WaveSync isn't signed by Adobe, so Premiere needs permission to load it.
for %%v in (9 10 11 12 13) do reg add "HKCU\Software\Adobe\CSXS.%%v" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul

if exist "%DEST%" rmdir /s /q "%DEST%"
xcopy "%SRC%" "%DEST%\" /e /i /q /y /h >nul

echo Installed.
echo.
where ffmpeg >nul 2>nul
if %errorlevel%==0 (
  echo ffmpeg: found
) else (
  if exist "%DEST%\bin\ffmpeg.exe" (
    echo ffmpeg: found
  ) else (
    echo ffmpeg is missing. WaveSync needs it to read audio from your clips.
    echo Open Command Prompt and run:
    echo.
    echo     winget install Gyan.FFmpeg
  )
)
echo.
echo Restart Premiere Pro, then open:  Window ^> Extensions ^> WaveSync
echo.
pause
