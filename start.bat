@echo off
title OpenLeaf
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 18+ is required: https://nodejs.org & pause & exit /b 1)
where latexmk >nul 2>nul || echo WARNING: latexmk not found on PATH. Install MiKTeX or TeX Live.
node server.js --open %*
pause
