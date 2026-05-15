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

node -e "const http=require('http'),fs=require('fs'),path=require('path');const mime={'html':'text/html','css':'text/css','js':'application/javascript','json':'application/json','png':'image/png','jpg':'image/jpeg','ico':'image/x-icon','bat':'text/plain','svg':'image/svg+xml'};http.createServer((req,res)=>{let f=path.join('.',decodeURIComponent(req.url==='/'?'/index.html':req.url));const stream=fs.createReadStream(f);const ext=path.extname(f).slice(1);stream.on('error',()=>{res.writeHead(404);res.end();});res.writeHead(200,{'Content-Type':mime[ext]||'text/plain','Access-Control-Allow-Origin':'*','Cache-Control':'no-cache'});stream.pipe(res);}).listen(8000,'0.0.0.0',()=>console.log('Server activ pe toate interfetele, port 8000'));"
pause
