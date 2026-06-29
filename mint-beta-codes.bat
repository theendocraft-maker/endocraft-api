@echo off
title EndoCraft - Beta-Codes minten
cd /d "%~dp0"

echo ============================================
echo   EndoCraft  -  Beta-Codes minten
echo ============================================
echo.
echo Du brauchst zwei Werte aus Railway (Tab "Variables"):
echo    1) SUPABASE_URL
echo    2) SUPABASE_KEY   (der service_role Key)
echo.
echo Tipp: Wert kopieren, hier Rechtsklick = einfuegen, dann Enter.
echo.

set /p SUPABASE_URL=SUPABASE_URL einfuegen und Enter:
set /p SUPABASE_KEY=SUPABASE_KEY einfuegen und Enter:

echo.
echo Minte Codes... (einen pro Lead)
echo.
node scripts\gen-beta-codes.js

echo.
echo ============================================
echo   Fertig. Die Datei  beta-merge.csv
echo   liegt jetzt in diesem Ordner.
echo ============================================
echo.
pause
