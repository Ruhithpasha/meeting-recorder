// swift-tools-version: 6.0
// Built locally by scripts/install.sh with only the Xcode Command Line Tools (no Xcode, no
// XCTest), so logic checks are an executable: `swift run AgentCoreChecks`.
import PackageDescription

let package = Package(
    name: "MeetingRecorderAgent",
    platforms: [.macOS(.v15)],
    // WhisperKit (MIT, Core ML): the optional open transcription engine. Exact version: the
    // install builds from source, so every Mac gets the same, reviewed code.
    dependencies: [.package(url: "https://github.com/argmaxinc/WhisperKit.git", exact: "0.18.0")],
    targets: [
        // Pure logic and data checked by AgentCoreChecks: wire protocol, command validation, config,
        // capture math, transcript/summary text, the pinned Whisper manifest. No UI, no capture.
        .target(name: "AgentCore", path: "Sources/AgentCore"),
        // The menu-bar app: capture, mic detection, permissions, daemon supervision.
        .executableTarget(name: "MeetingRecorderAgent", dependencies: ["AgentCore"], path: "Sources/MeetingRecorderAgent"),
        // On-device transcription and summaries (Apple's models, or open models from Hugging Face)
        // and share copies; spawned by the daemon at background priority.
        .executableTarget(name: "MeetingRecorderTranscriber",
                          dependencies: ["AgentCore", .product(name: "WhisperKit", package: "WhisperKit")],
                          path: "Sources/MeetingRecorderTranscriber"),
        .executableTarget(name: "AgentCoreChecks", dependencies: ["AgentCore"], path: "Sources/AgentCoreChecks"),
    ],
    swiftLanguageModes: [.v5]
)
