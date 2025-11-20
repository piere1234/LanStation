@echo off
setlocal

echo =====================================
echo LanStation setup and server launcher
echo =====================================

REM ===============================
REM 1) CHECK FOR NODE
REM ===============================
where node >nul 2>nul
if errorlevel 1 goto :NoNode

echo Node.js is installed.

REM ===============================
REM 2) OPTIONAL: CHECK PSQL
REM ===============================
where psql >nul 2>nul
if errorlevel 1 (
    echo.
    echo [WARN] PostgreSQL client ^(psql^) not found in PATH.
    echo Not that big of a deal. psql is in its install location, you just can't reach it from CMD. It will still work as long as the PostgreSQL service is running.
) else (
    echo PostgreSQL client ^(psql^) is available.
)

REM ===============================
REM 3) CREATE .env IF NEEDED
REM ===============================
if exist ".env" goto :HaveEnv

echo.
echo No .env found. Let's create one.
echo Please enter the SAME PostgreSQL values you used during installation.
echo If you are not sure, open pgAdmin or psql and check.
echo.

REM --- Ask user for connection info ---
set "PGUSER="
set "PGPASSWORD="
set "PGDB="
set "PGPORT="
set "SESSION_SECRET="
set "ADMIN_CODE="
set "HOST="

set /p PGUSER=PostgreSQL username [default: postgres]: 
if "%PGUSER%"=="" set "PGUSER=postgres"

set /p PGPASSWORD=PostgreSQL password (exactly as you set it): 

set /p PGDB=Database name [default: lanstation]: 
if "%PGDB%"=="" set "PGDB=lanstation"

set /p PGPORT=PostgreSQL port [default: 5432]: 
if "%PGPORT%"=="" set "PGPORT=5432"

echo.
set /p SESSION_SECRET=Session secret (any random string) [default: change_me]: 
if "%SESSION_SECRET%"=="" set "SESSION_SECRET=change_me"

set /p ADMIN_CODE=Admin setup code [default: change_me]: 
if "%ADMIN_CODE%"=="" set "ADMIN_CODE=change_me"

set /p HOST=Host/IP for Node server to bind [default: 0.0.0.0]: 
if "%HOST%"=="" set "HOST=0.0.0.0"

REM --- Write .env ---
>  ".env" echo DATABASE_URL=postgres://%PGUSER%:%PGPASSWORD%@localhost:%PGPORT%/%PGDB%
>> ".env" echo SESSION_SECRET=%SESSION_SECRET%
>> ".env" echo ADMIN_CODE=%ADMIN_CODE%
>> ".env" echo HOST=%HOST%

echo.
echo .env created with:
echo   DATABASE_URL=postgres://%PGUSER%:****@localhost:%PGPORT%/%PGDB%
echo   SESSION_SECRET=%SESSION_SECRET%
echo   ADMIN_CODE=%ADMIN_CODE%
echo   HOST=%HOST%

goto :HaveEnv

:HaveEnv
echo.
echo Using existing .env (not modifying it).

REM ===============================
REM 4) START SERVER
REM ===============================
echo.
echo Starting server: node server.js
echo ^(Press CTRL+C to stop^)
echo.

node server.js

echo.
echo Node process exited.
pause
endlocal
goto :EOF

:NoNode
echo.
echo [ERROR] Node.js is not installed or not in PATH.
echo Please install Node.js LTS from nodejs.org, then re-run this script.
pause
endlocal
goto :EOF
