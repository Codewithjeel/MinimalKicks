@echo off
title MinimalKicks Store Server
cd /d "%~dp0"
echo ========================================================
echo       MinimalKicks - Dynamic Sneaker Storefront
echo ========================================================
echo.
echo Starting server at http://localhost:3000 ...
echo.
start "" http://localhost:3000
node server.js
pause
