@echo off
title Planificator Traseu
cd /d "%~dp0"

echo.
echo  ================================================
echo   Planificator Traseu - Pornire
echo  ================================================
echo.

:: ── Verifica daca Docker e pornit ────────────────────────────────
docker info >nul 2>&1
if %errorlevel% neq 0 (
    echo  Docker Desktop nu este pornit. Il pornesc acum...
    echo.
    start "" "C:\Program Files\Docker\Docker\Docker Desktop.exe"
    goto :wait_docker
)
goto :start_app

:wait_docker
echo  Astept Docker sa fie gata...
timeout /t 5 /nobreak >nul
docker info >nul 2>&1
if %errorlevel% neq 0 goto :wait_docker
echo  Docker este gata!
echo.

:start_app
echo  Pornesc aplicatia...
docker compose up -d >nul 2>&1

echo.
echo  ================================================
echo   Aplicatia este gata!
echo  ================================================
echo.
echo   Adresa locala:
echo     http://localhost:8000
echo.
echo   Adresa WiFi (telefon/tableta):
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /i "IPv4" ^| findstr /v "169.254"') do (
    for /f "tokens=1" %%b in ("%%a") do echo     http://%%b:8000
)
echo.
echo   Pentru a opri: docker compose down
echo  ================================================
echo.

start "" "http://localhost:8000"

echo  Aceasta fereastra se poate inchide.
echo.
pause
