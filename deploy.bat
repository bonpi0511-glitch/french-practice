@echo off
cd /d %~dp0
echo === git add ===
git add -A
echo === git commit ===
git commit -m "Update %date% %time%"
echo === git push ===
git push
echo.
echo === Done. Press any key to close. ===
pause >nul
