@echo off
rem One-click launcher for llmsocial on Windows: double-click this file.
rem Keep this file CRLF and keep rem lines ASCII only (chcp 65001 mangles non-ASCII rem lines).
chcp 65001 >nul
setlocal
title llmsocial
cd /d "%~dp0"

set "PORT=8787"
for /f "tokens=1,* delims==" %%a in ('findstr /b /c:"LLMSOCIAL_PORT=" .env 2^>nul') do if not "%%b"=="" set "PORT=%%b"
set "URL=http://127.0.0.1:%PORT%"

if "%~1"=="--wait-and-open" goto :waitopen

where node >nul 2>nul
if errorlevel 1 (
  echo 没找到 Node.js。去 https://nodejs.org 装 LTS 版（22.18 或更新），装完再双击这个文件。
  pause
  exit /b 1
)

for /f "tokens=1,2 delims=v." %%a in ('node -v') do (set "NODE_MAJOR=%%a" & set "NODE_MINOR=%%b")
set "NODE_OLD="
if %NODE_MAJOR% LSS 22 set "NODE_OLD=1"
if %NODE_MAJOR% EQU 22 if %NODE_MINOR% LSS 18 set "NODE_OLD=1"
if defined NODE_OLD (
  echo Node.js 版本太旧（%NODE_MAJOR%.%NODE_MINOR%），要 22.18 或更新。去 https://nodejs.org 装 LTS 版。
  pause
  exit /b 1
)

curl.exe --noproxy "*" -s -o NUL -m 2 "%URL%/api/auth/state" >nul 2>nul
if not errorlevel 1 (
  echo llmsocial 已经在运行：%URL%
  if not defined LLMSOCIAL_NO_BROWSER start "" "%URL%"
  ping -n 4 127.0.0.1 >nul
  exit /b 0
)

if not exist node_modules (
  echo 第一次运行，先安装依赖，要几分钟...
  call npm install
  if errorlevel 1 (
    echo 依赖安装失败，看上面的错误。网络不通的话开一下代理再试。
    pause
    exit /b 1
  )
)

if not defined LLMSOCIAL_NO_BROWSER start "" /min cmd /c ""%~f0" --wait-and-open"
echo 正在启动 llmsocial，起来后浏览器会自动打开 %URL%
echo 这个窗口别关，关了服务就停。要停就关掉这个窗口。
echo.
call npm start
echo.
echo llmsocial 已停止。
pause
exit /b

:waitopen
rem Helper window: poll until the server answers, then open the browser once.
for /l %%i in (1,1,180) do (
  curl.exe --noproxy "*" -s -o NUL -m 2 "%URL%/api/auth/state" >nul 2>nul
  if not errorlevel 1 goto :opened
  ping -n 2 127.0.0.1 >nul
)
exit /b 1
:opened
start "" "%URL%"
exit /b 0
