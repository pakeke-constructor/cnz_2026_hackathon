@echo off
REM ---------------------------------------------------------------
REM Build + run the MEV searcher game.
REM   - installs typescript locally the first time (node_modules)
REM   - transpiles app.ts -> app.js (no bundler, plain tsc)
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

echo Opening game...
start "" "http://localhost:5173"

echo Serving on http://localhost:5173  (Ctrl+C to stop)
node serve.js
