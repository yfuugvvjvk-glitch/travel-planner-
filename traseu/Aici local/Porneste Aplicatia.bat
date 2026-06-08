@echo off
cd /d "%~dp0"
title Planificator Traseu

:: Verifica Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo  EROARE: Node.js nu este instalat.
    echo  Descarca de la: https://nodejs.org
    echo.
    pause
    exit /b 1
)

:: Porneste serverul (el deschide browserul automat)
:: Daca portul e deja ocupat, serverul afiseaza mesaj si iese
node server.js

