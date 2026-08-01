!macro customInit
  ; Older DubbinTool versions launch the updater with /S. Force the one-click
  ; installer back to normal UI mode so users can see installation progress.
  ; The package still has no scope, directory, or Next/Back choices.
  SetSilent normal
!macroend

!macro customInstall
  DetailPrint "Đang kiểm tra Microsoft Visual C++ Runtime..."
  IfFileExists "$INSTDIR\resources\vc-redist\vc_redist.x64.exe" 0 done
  SetRegView 64
  ClearErrors
  ReadRegDWORD $1 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
  StrCmp $1 1 done
  DetailPrint "Đang cài Microsoft Visual C++ Runtime..."
  ExecWait '"$INSTDIR\resources\vc-redist\vc_redist.x64.exe" /install /quiet /norestart' $0
  ${If} $0 != 0
  ${AndIf} $0 != 3010
  ${AndIf} $0 != 1638
    MessageBox MB_OK "Không thể cài Visual C++ Redistributable (mã $0). OCR có thể cần cài Microsoft Visual C++ x64 thủ công."
  ${EndIf}
  done:
!macroend
