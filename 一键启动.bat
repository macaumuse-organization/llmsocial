@echo off
rem One-click launcher for llmsocial (source checkout) on Windows: double-click this file.
rem ASCII only above :main. This first section re-runs the file under chcp 65001 in a nested cmd:
rem a batch that switches code page itself mis-splits later lines containing Chinese.
rem Keep this file CRLF (cmd loses goto labels in LF-only files).
if "%LS_BAT_UTF8%"=="1" goto :main
setlocal
set "LS_BAT_UTF8=1"
chcp 65001 >nul
cmd /d /c ""%~f0" %*"
exit /b %errorlevel%

:main
setlocal
title llmsocial
cd /d "%~dp0"

set "PORT=8787"
for /f "tokens=1,* delims==" %%a in ('findstr /b /c:"LLMSOCIAL_PORT=" .env 2^>nul') do if not "%%b"=="" set "PORT=%%b"
rem An environment variable wins over .env, the same way the server reads it.
if defined LLMSOCIAL_PORT set "PORT=%LLMSOCIAL_PORT%"
set "URL=http://127.0.0.1:%PORT%"

if "%~1"=="--wait-and-open" goto :waitopen

where node >nul 2>nul
if errorlevel 1 goto :nonode

for /f "tokens=1,2 delims=v." %%a in ('node -v') do (set "NODE_MAJOR=%%a" & set "NODE_MINOR=%%b")
set "NODE_OLD="
if %NODE_MAJOR% LSS 22 set "NODE_OLD=1"
if %NODE_MAJOR% EQU 22 if %NODE_MINOR% LSS 18 set "NODE_OLD=1"
if defined NODE_OLD goto :oldnode

curl.exe --noproxy "*" -s -o NUL -m 2 "%URL%/api/auth/state" >nul 2>nul
if not errorlevel 1 goto :running

if exist node_modules goto :start
echo 第一次运行，先安装依赖，要几分钟...
call npm install
if errorlevel 1 goto :npmfail

:start
if not defined LLMSOCIAL_NO_BROWSER start "" /min cmd /d /c ""%~f0" --wait-and-open"
echo 正在启动 llmsocial，起来后浏览器会自动打开 %URL%
echo 这个窗口别关，关了服务就停。要停就关掉这个窗口。
echo.
call npm start
echo.
echo llmsocial 已停止。
pause
exit /b

:running
echo llmsocial 已经在运行：%URL%
if not defined LLMSOCIAL_NO_BROWSER start "" "%URL%"
ping -n 4 127.0.0.1 >nul
exit /b 0

:nonode
echo 没找到 Node.js。去 https://nodejs.org 装 LTS 版（22.18 或更新），装完再双击这个文件。
pause
exit /b 1

:oldnode
echo Node.js 版本太旧（%NODE_MAJOR%.%NODE_MINOR%），要 22.18 或更新。去 https://nodejs.org 装 LTS 版。
pause
exit /b 1

:npmfail
echo 依赖安装失败，看上面的错误。网络不通的话开一下代理再试。
pause
exit /b 1

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
