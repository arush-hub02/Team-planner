@echo off
title Team Task Sheet — YouTrack & Jira Sync Server
echo ===================================================
echo   Starting Team Task Sheet (YouTrack & Jira Sync)...
echo ===================================================
echo.
cd /d "%~dp0"
start http://localhost:3100
node sync_server.js
pause
