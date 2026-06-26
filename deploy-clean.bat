@echo off
echo.
echo  ================================
echo   EndoCraft API · Clean Deploy
echo  ================================
echo.

cd /d "%~dp0"

REM 1. Lock-File loeschen falls vorhanden
if exist ".git\index.lock" (
    echo  - Removing stale index.lock
    del /F /Q ".git\index.lock"
)

REM 2. Line-Ending-only diffs zuruecksetzen (Sandbox-Verschmutzung)
echo  - Reverting line-ending-only files
git checkout -- deploy.bat package.json rarity.js supabase-migrations/ 2>nul

REM 3. NUR server.js stagen (die ECHTE Aenderung)
echo  - Staging server.js (real changes only)
git add server.js

REM 4. Commit
set TIMESTAMP=%date% %time%
git commit -m "Quality-Lock + Etsy listings + free-pack lead-magnet endpoints"

REM 5. Pull + Push
echo.
echo  Pulling latest...
git pull origin main --rebase

echo.
echo  Pushing...
git push origin main

echo.
echo  ================================
echo   Railway re-deploys in ~1 min
echo  ================================
echo.
pause
