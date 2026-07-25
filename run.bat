@echo off
REM ---------------------------------------------------------------
REM Build + run the MEV searcher game.
REM   - installs typescript locally the first time (node_modules)
REM   - transpiles app.ts -> app.js (no bundler, plain tsc)
REM   - opens index.html in the default browser
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
start "" "index.html"
