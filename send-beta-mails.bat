@echo off
title EndoCraft - Beta-Mails senden
cd /d "%~dp0"

echo ============================================
echo   EndoCraft  -  Beta-Einladung senden
echo ============================================
echo.
echo   Betreff:   A thank-you - and your free beta invite
echo   Von:       marco@endocraft.app
echo   Reply-To:  theendocraft@gmail.com
echo.
echo   Du brauchst den RESEND_API_KEY (Railway -^> Variables).
echo.

set /p RESEND_API_KEY=RESEND_API_KEY einfuegen und Enter:

echo.
echo --- VORSCHAU (es wird noch NICHTS gesendet) ---
node scripts\send-campaign.js --dry

echo.
echo ============================================
set /p CONFIRM=Wirklich an alle senden? Tippe  JA  und Enter:
if /I not "%CONFIRM%"=="JA" (
  echo.
  echo Abgebrochen - es wurde nichts gesendet.
  echo.
  pause
  exit /b
)

echo.
echo --- SENDE ---
node scripts\send-campaign.js

echo.
pause
