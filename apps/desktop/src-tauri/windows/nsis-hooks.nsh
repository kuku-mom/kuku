!macro KUKU_WRITE_SHORTCUT_ICON LINK_PATH
  Delete "${LINK_PATH}"
  CreateShortcut "${LINK_PATH}" "$INSTDIR\${MAINBINARYNAME}.exe" "" "$INSTDIR\icon.ico" 0
  !insertmacro SetLnkAppUserModelId "${LINK_PATH}"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !if "${STARTMENUFOLDER}" != ""
    !insertmacro KUKU_WRITE_SHORTCUT_ICON "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
  !else
    !insertmacro KUKU_WRITE_SHORTCUT_ICON "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  !endif

  !insertmacro KUKU_WRITE_SHORTCUT_ICON "$DESKTOP\${PRODUCTNAME}.lnk"
  StrCpy $NoShortcutMode 1
!macroend
