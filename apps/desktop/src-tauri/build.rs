fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        cc::Build::new()
            .cpp(true)
            .file("native/meeting_notes/macos_audio_capture.mm")
            .file("native/meeting_notes/macos_meeting_detector.mm")
            .flag("-fobjc-arc")
            .flag("-fblocks")
            .flag("-std=c++17")
            .compile("kuku_meeting_capture");
        for framework in [
            "AppKit",
            "AVFoundation",
            "AudioToolbox",
            "CoreAudio",
            "CoreMedia",
            "CoreVideo",
            "Foundation",
            "QuartzCore",
        ] {
            println!("cargo:rustc-link-lib=framework={framework}");
        }
        println!("cargo:rustc-link-arg=-Wl,-weak_framework,ScreenCaptureKit");
        println!("cargo:rustc-link-lib=dylib=c++");
        // Objective-C @available guards targeting older macOS versions use
        // Clang's version-check helper. rustc's linker does not add it itself.
        let runtime = std::process::Command::new("xcrun")
            .args(["clang", "--print-runtime-dir"])
            .output()
            .expect("Locate the Apple Clang runtime");
        assert!(runtime.status.success(), "Apple Clang runtime is required");
        let runtime = String::from_utf8(runtime.stdout).expect("Clang runtime path must be UTF-8");
        println!("cargo:rustc-link-search=native={}", runtime.trim());
        println!("cargo:rustc-link-lib=static=clang_rt.osx");
        println!("cargo:rerun-if-changed=native/meeting_notes");
    }
    tauri_build::build()
}
