@echo off
REM ---------------------------------------------------------------
REM Build + run the MEV searcher game.
REM   - installs typescript locally the first time (node_modules)
REM   - transpiles app.ts -> app.js once, up front (catches errors)
REM   - launches tsc --watch in its OWN window so every save to app.ts
REM     auto-recompiles app.js (no more stale builds)
REM   - serves over http://localhost:5173 (no file:/// quirks)
REM   - opens the browser at that URL
REM ---------------------------------------------------------------

if not exist node_modules (
  echo Installing typescript...
  call npm install
)

echo Building...
call npx tsc
if errorlevel 1 (
  echo Build failed.
  exit /b 1
)

echo Starting TypeScript watcher (recompiles app.js on every save)...
start "tsc --watch" cmd /k npx tsc --watch

echo Opening game...
start "" "http://localhost:5173"

echo Serving on http://localhost:5173  (Ctrl+C to stop the server)
echo Close the "tsc --watch" window to stop the compiler.
node serve.js
