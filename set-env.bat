@echo off
REM ============================================
REM Codex Bridge - Environment Setup
REM Run this before starting the server:
REM   set-env.bat && npm start
REM ============================================

REM DeepSeek API key (required)
set DEEPSEEK_API_KEY=sk-your-key-here

REM Maximum tokens for model responses (default: 16384)
set MAX_TOKENS=16384

REM Maximum instruction/message length in characters (default: 8000)
set MAX_INSTRUCTION_LENGTH=8000

echo Environment variables set:
echo   DEEPSEEK_API_KEY=sk-your-key-here
echo   MAX_TOKENS=16384
echo   MAX_INSTRUCTION_LENGTH=8000
