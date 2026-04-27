@echo off
echo.
echo  ================================
echo   EndoCraft API Deploy
echo  ================================
echo.

cd /d "%~dp0"

echo  Dateien die hochgeladen werden:
git status --short
echo.

git add .

set TIMESTAMP=%date% %time%
git commit -m "Deploy: %TIMESTAMP%"

echo.
echo  Pulling remote changes (rebase) ...
git pull --rebase origin main
if errorlevel 1 (
  echo.
  echo  ================================
  echo   FEHLER: Rebase-Konflikt!
  echo   - Rebase abbrechen:  git rebase --abort
  echo   - Konflikt loesen + git rebase --continue
  echo  ================================
  echo.
  pause
  exit /b 1
)

echo.
echo  Uploading to GitHub...
git push origin main
if errorlevel 1 (
  echo.
  echo  ================================
  echo   FEHLER: Push abgelehnt.
  echo   Nochmal manuell pruefen.
  echo  ================================
  echo.
  pause
  exit /b 1
)

echo.
echo  ================================
echo   Done! Railway updated in
echo   ca. 1-2 Minuten.
echo  ================================
echo.
pause
