@echo off
rem The Coordinator Board command for agents in Orca terminals. See: coordinator-board --help
setlocal
if not defined CB_NODE goto node
set "ELECTRON_RUN_AS_NODE=1"
"%CB_NODE%" "%~dp0..\dist\cli.cjs" %*
exit /b %ERRORLEVEL%
:node
node "%~dp0..\dist\cli.cjs" %*
exit /b %ERRORLEVEL%
