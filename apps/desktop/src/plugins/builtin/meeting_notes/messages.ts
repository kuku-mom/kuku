import { currentLocale } from "~/i18n";

// Plugin-owned catalog; each key always has Korean, English and Japanese text.
const messages = {
  name: ["미팅노트", "Meeting notes", "ミーティングノート"],
  description: [
    "기기 안에서 회의를 전사하고 현재 문서에 기록합니다.",
    "Transcribe meetings on this device into the current document.",
    "会議をデバイス上で文字起こしし、現在の文書に記録します。",
  ],
  start: ["녹음 시작", "Start recording", "録音を開始"],
  downloadStart: ["다운로드하고 시작", "Download and start", "ダウンロードして開始"],
  startSystem: ["시스템 오디오로 시작", "Start with system audio", "システム音声で開始"],
  micUnavailable: [
    "연결된 마이크가 없습니다. 마이크를 연결하거나 시스템 오디오로 시작하세요.",
    "No microphone is connected. Connect one or start with system audio.",
    "マイクが接続されていません。マイクを接続するか、システム音声で開始してください。",
  ],
  stop: ["종료하고 저장", "Finish and save", "終了して保存"],
  cancel: ["취소", "Cancel", "キャンセル"],
  close: ["닫기", "Close", "閉じる"],
  setup: ["미팅노트 시작", "Start meeting notes", "ミーティングノートを開始"],
  source: ["녹음할 오디오", "Audio source", "録音する音声"],
  combined: ["마이크 + 시스템 오디오", "Microphone + system audio", "マイク＋システム音声"],
  microphone: ["마이크만", "Microphone only", "マイクのみ"],
  system: ["시스템 오디오만", "System audio only", "システム音声のみ"],
  idle: ["녹음 준비", "Ready to record", "録音準備完了"],
  preparing: ["전사 엔진 준비 중", "Preparing transcription", "文字起こしを準備中"],
  downloading: [
    "필요한 파일 다운로드 중",
    "Downloading required files",
    "必要なファイルをダウンロード中",
  ],
  permission: ["오디오 권한 확인 중", "Checking audio permissions", "音声の権限を確認中"],
  recording: ["녹음 중", "Recording", "録音中"],
  finalizing: [
    "문장과 화자를 정리하는 중",
    "Finalizing sentences and speakers",
    "文章と話者を整理中",
  ],
  saving: ["원래 문서에 저장 중", "Saving to the original document", "元の文書に保存中"],
  error: [
    "미팅노트를 완료하지 못했습니다",
    "Could not finish meeting notes",
    "ミーティングノートを完了できませんでした",
  ],
  unsupported: [
    "미팅노트는 Apple Silicon Mac과 macOS 15 이상이 필요합니다. 다른 Kuku 기능은 계속 사용할 수 있습니다.",
    "Meeting notes requires Apple Silicon and macOS 15 or later. Other Kuku features remain available.",
    "ミーティングノートにはApple SiliconとmacOS 15以降が必要です。他のKuku機能は引き続き使えます。",
  ],
  documentRequired: [
    "보관함에서 저장 가능한 Markdown 문서를 먼저 열어 주세요.",
    "First open a writable Markdown document in a vault.",
    "保管庫内の保存可能なMarkdown文書を開いてください。",
  ],
  saveFailed: [
    "문서를 저장하지 못했습니다. 외부 변경이나 파일 권한을 확인한 뒤 다시 시도하세요.",
    "Could not save the document. Check external changes and file permissions, then retry.",
    "文書を保存できませんでした。外部の変更や権限を確認して再試行してください。",
  ],
  privacy: [
    "음성과 전사는 이 Mac에서 처리됩니다. 문서에 저장된 내용은 보관함의 기존 동기화 설정을 따릅니다. 화면 영상은 저장하지 않습니다.",
    "Audio and transcription are processed on this Mac. Saved document content follows your vault's existing sync settings. Screen video is not saved.",
    "音声と文字起こしはこのMacで処理されます。保存した文書には保管庫の既存の同期設定が適用されます。画面映像は保存しません。",
  ],
  download: [
    "최초 사용 시 로컬 전사에 필요한 파일을 다운로드합니다.",
    "First use downloads files needed for local transcription.",
    "初回利用時にローカル文字起こしに必要なファイルをダウンロードします。",
  ],
  consent: [
    "다운로드 크기와 로컬 처리 방식을 확인했습니다.",
    "I understand the download size and local processing.",
    "ダウンロード容量とローカル処理について確認しました。",
  ],
  space: [
    "설치할 디스크 공간이 부족합니다.",
    "Not enough disk space for setup.",
    "セットアップに必要な空き容量が不足しています。",
  ],
  availableSpace: ["사용 가능한 공간", "Available space", "空き容量"],
  installedSize: ["설치 후 예상 크기", "Estimated installed size", "インストール後の推定容量"],
  technicalDetails: ["오류 상세 정보", "Error details", "エラーの詳細"],
  micDenied: [
    "마이크 권한이 필요합니다. 시스템 설정에서 Kuku의 마이크 접근을 허용하거나 시스템 오디오만 선택하세요.",
    "Microphone permission is required. Allow Kuku in System Settings or choose system audio only.",
    "マイクの権限が必要です。システム設定でKukuを許可するか、システム音声のみを選んでください。",
  ],
  systemSettings: [
    "시스템 권한 설정 열기",
    "Open system permission settings",
    "システムの権限設定を開く",
  ],
  detection: ["회의 자동 감지", "Detect meetings", "会議の自動検出"],
  detectionDescription: [
    "회의가 감지되면 시작 여부를 물어봅니다. 자동으로 녹음하지 않습니다.",
    "Ask before recording when a meeting is detected. Recording never starts automatically.",
    "会議を検出したら録音するか確認します。自動では録音しません。",
  ],
  detected: ["회의가 감지되었습니다", "Meeting detected", "会議を検出しました"],
  detectedBody: [
    "현재 문서에 이 회의의 미팅노트를 만들까요?",
    "Create meeting notes in the current document?",
    "現在の文書にこの会議のノートを作成しますか？",
  ],
  dismiss: ["이번 회의 건너뛰기", "Skip this meeting", "この会議をスキップ"],
  guard: [
    "진행 중인 회의를 종료할까요?",
    "Finish the current meeting?",
    "進行中の会議を終了しますか？",
  ],
  guardBody: [
    "전사를 확정하고 원래 문서에 저장한 뒤 이동합니다. 저장에 실패하면 현재 상태를 유지합니다.",
    "Finalize and save to the original document before continuing. If saving fails, stay here.",
    "文字起こしを確定し、元の文書に保存してから移動します。保存に失敗した場合はここに留まります。",
  ],
  stay: ["계속 녹음", "Keep recording", "録音を続ける"],
  saved: ["미팅노트를 저장했습니다.", "Meeting notes saved.", "ミーティングノートを保存しました。"],
  speakerWarning: [
    "전사를 저장했습니다. 화자가 많아 일부 화자 구분이 부정확할 수 있습니다.",
    "Transcript saved. With many speakers, some labels may be inaccurate.",
    "文字起こしを保存しました。話者が多いため、一部の話者ラベルが不正確な場合があります。",
  ],
  remove: ["로컬 데이터 삭제", "Remove local data", "ローカルデータを削除"],
  removeConfirm: [
    "다운로드한 모델과 런타임, 캐시, 임시 전사와 오디오를 삭제할까요? 다음 사용 시 다시 다운로드합니다. Markdown 문서는 유지됩니다.",
    "Delete downloaded models, runtime, caches, temporary transcripts and audio? Next use downloads them again. Markdown documents are kept.",
    "ダウンロードしたモデル、ランタイム、キャッシュ、一時的な文字起こしと音声を削除しますか？次回利用時に再ダウンロードします。Markdown文書は保持されます。",
  ],
  removed: [
    "로컬 전사 데이터를 삭제했습니다.",
    "Local transcription data removed.",
    "ローカル文字起こしデータを削除しました。",
  ],
  ready: [
    "로컬 전사 파일 준비됨",
    "Local transcription files ready",
    "ローカル文字起こしファイル準備完了",
  ],
  retry: ["저장 다시 시도", "Retry saving", "保存を再試行"],
  cancelRecording: ["녹음 중단", "Cancel recording", "録音を中止"],
  targetChanged: [
    "녹음 대상 문서가 외부에서 이동되거나 삭제되어 회의를 중단했습니다.",
    "The recording document was moved or deleted externally. Recording stopped.",
    "録音先の文書が外部で移動または削除されたため、録音を停止しました。",
  ],
  title: ["미팅", "Meeting", "会議"],
  speaker: ["화자", "Speaker", "話者"],
  pendingSave: [
    "저장을 완료하지 못했습니다. 다시 시도하세요.",
    "Saving could not complete. Please try again.",
    "保存を完了できませんでした。再試行してください。",
  ],
} as const;

export type MeetingMessage = keyof typeof messages;
export function mt(key: MeetingMessage): string {
  const locale = currentLocale();
  if (locale === "ko") return messages[key][0];
  if (locale === "ja") return messages[key][2];
  return messages[key][1];
}
