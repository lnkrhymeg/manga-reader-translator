@echo off
REM ============================================================================
REM  start-mt-web.bat — 启动 manga-translator-ui 的 web 模式（扩展的后端）
REM
REM  用法：
REM    scripts\start-mt-web.bat [manga-translator-ui 目录] [端口]
REM
REM  也可以用环境变量指定目录：
REM    set MANGA_TRANSLATOR_DIR=D:\manga-translator-ui
REM
REM  为什么必须用 web 模式：
REM    local(CLI) 模式没有监听端口，浏览器扩展无法启动本地进程、也没有东西可连；
REM    shared 模式返回 Python pickle，JS 解析不了；
REM    ws 模式是 protobuf + URL 任务协议，给远程 worker 用的。
REM    只有 web 模式提供 HTTP + PNG，并且模型常驻内存。
REM ============================================================================
setlocal EnableDelayedExpansion
set "PYTHONUTF8=1"

set "MT_DIR=%~1"
if "%MT_DIR%"=="" set "MT_DIR=%MANGA_TRANSLATOR_DIR%"
if "%MT_DIR%"=="" set "MT_DIR=D:\manga-translator-ui"

set "PORT=%~2"
if "%PORT%"=="" set "PORT=8000"

if not exist "%MT_DIR%\manga_translator\server\main.py" (
  echo [ERROR] Not a manga-translator-ui directory: "%MT_DIR%"
  echo         Pass it as the first argument, or set MANGA_TRANSLATOR_DIR.
  echo         Example: scripts\start-mt-web.bat "D:\manga-translator-ui" 8000
  pause
  exit /b 1
)

cd /d "%MT_DIR%"

REM ---- 1) bundled python ----
set "PY="
if exist "%MT_DIR%\packaging\python\python.exe" set "PY=%MT_DIR%\packaging\python\python.exe"
REM ---- 2) project venv ----
if not defined PY if exist "%MT_DIR%\.venv\Scripts\python.exe" set "PY=%MT_DIR%\.venv\Scripts\python.exe"
REM ---- 3) conda env ----
if not defined PY (
  for %%R in ("%MT_DIR%") do set "DRIVE=%%~dR"
  if exist "%MT_DIR%\Miniconda3\envs\manga-env\python.exe" set "PY=%MT_DIR%\Miniconda3\envs\manga-env\python.exe"
  if not defined PY if exist "%DRIVE%\Miniconda3\envs\manga-env\python.exe" set "PY=%DRIVE%\Miniconda3\envs\manga-env\python.exe"
)
REM ---- 4) fall back to PATH ----
if not defined PY (
  where python >nul 2>nul && set "PY=python"
)

if not defined PY (
  echo [ERROR] No Python found. Tried bundled python, .venv, Miniconda3\envs\manga-env, PATH.
  echo         Run Win-Install-or-Update.bat in the manga-translator-ui folder first.
  pause
  exit /b 1
)

echo ============================================================
echo  manga-translator-ui  web mode
echo  dir      : %MT_DIR%
echo  python   : %PY%
echo  listen   : http://0.0.0.0:%PORT%
echo.
echo  Keep this window open while reading.
echo  Extension settings -^> Manga Translator URL: http://127.0.0.1:%PORT%
echo ============================================================
echo.

"%PY%" -m manga_translator web --host 0.0.0.0 --port %PORT% --use-gpu --models-ttl 0
set "EXITCODE=%ERRORLEVEL%"

if not "%EXITCODE%"=="0" (
  echo.
  echo [ERROR] Server exited with code %EXITCODE%
  echo   If it is a GPU problem, retry without --use-gpu:
  echo     "%PY%" -m manga_translator web --host 0.0.0.0 --port %PORT% --models-ttl 0
  pause
)
exit /b %EXITCODE%
