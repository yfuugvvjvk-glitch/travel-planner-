@echo off
echo ================================================
echo   Planificator Traseu - Server Local
echo ================================================
cd /d "%~dp0"

echo.
echo Adresa pentru acest calculator:
echo   http://localhost:8000
echo.
echo Adresa pentru telefon/tableta (aceeasi retea WiFi):
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /i "IPv4" ^| findstr /v "169.254"') do (
    for /f "tokens=1" %%b in ("%%a") do echo   http://%%b:8000
)
echo.
echo Nu inchide aceasta fereastra cat timp folosesti aplicatia!
echo ================================================
echo.

start "" "http://localhost:8000"
node server.js
pause
