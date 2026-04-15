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
echo  Uploading to GitHub...
git push origin main

echo.
echo  ================================
echo   Done! Railway updated in
echo   ca. 1-2 Minuten.
echo  ================================
echo.
pause
