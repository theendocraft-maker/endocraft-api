@echo off
title EndoCraft - TEST-Mail senden
cd /d "%~dp0"

echo ============================================
echo   EndoCraft  -  TEST-Mail (nur an dich)
echo ============================================
echo.
echo   Sendet EINE Mail an theendocraft@gmail.com,
echo   damit du Layout + Darstellung pruefen kannst.
echo   Es geht NICHTS an die echten Leads.
echo.
echo   Du brauchst den RESEND_API_KEY (Railway -^> Variables).
echo.

set /p RESEND_API_KEY=RESEND_API_KEY einfuegen und Enter:

echo.
echo --- Sende Testmail ---
node scripts\send-campaign.js --test

echo.
echo Pruefe jetzt dein Postfach theendocraft@gmail.com.
echo.
pause
