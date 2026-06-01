@echo off
REM ============================================
REM Codex Bridge - Environment Setup
REM Run this before starting the server:
REM   set-env.bat && npm start
REM ============================================

REM Clear variables first (so defaults don't linger if .env is missing them)
set DEEPSEEK_API_KEY=
set MAX_TOKENS=
set MAX_INSTRUCTION_LENGTH=

REM --------------------------------------------------
REM 1. Load values from .env file if it exists
REM --------------------------------------------------
if exist .env (
    for /f "usebackq tokens=1,2 delims==" %%a in (".env") do (
        if "%%a"=="DEEPSEEK_API_KEY"        set DEEPSEEK_API_KEY=%%b
        if "%%a"=="MAX_TOKENS"              set MAX_TOKENS=%%b
        if "%%a"=="MAX_INSTRUCTION_LENGTH"  set MAX_INSTRUCTION_LENGTH=%%b
    )
)

REM --------------------------------------------------
REM 2. Prompt for API key if still not set
REM --------------------------------------------------
if "%DEEPSEEK_API_KEY%"=="" (
    echo [WARN] DEEPSEEK_API_KEY not found in .env file.
    set /p DEEPSEEK_API_KEY="Enter your DeepSeek API key: "
)

REM --------------------------------------------------
REM 3. Apply defaults for any remaining empty vars
REM --------------------------------------------------
if "%MAX_TOKENS%"==""              set MAX_TOKENS=16384
if "%MAX_INSTRUCTION_LENGTH%"==""  set MAX_INSTRUCTION_LENGTH=8000

REM --------------------------------------------------
REM 4. Display summary
REM --------------------------------------------------
echo.
echo Environment variables set:
echo   DEEPSEEK_API_KEY=sk-... (hidden^)
echo   MAX_TOKENS=%MAX_TOKENS%
echo   MAX_INSTRUCTION_LENGTH=%MAX_INSTRUCTION_LENGTH%
echo.
