// swift-tools-version: 6.0
// Built locally by scripts/install.sh with only the Xcode Command Line Tools (no Xcode, no
// XCTest), so logic checks are an executable: `swift run AgentCoreChecks`.
import PackageDescription

let package = Package(
    name: "MeetingRecorderAgent",
    platforms: [.macOS(.v15)],
    targets: [
        // Pure logic: wire protocol, command validation, config, capture math. No UI, no capture.
        .target(name: "AgentCore", path: "Sources/AgentCore"),
        // The menu-bar app: capture, mic detection, permissions, daemon supervision.
        .executableTarget(name: "MeetingRecorderAgent", dependencies: ["AgentCore"], path: "Sources/MeetingRecorderAgent"),
        // On-device transcription (macOS 26+ SpeechTranscriber), spawned by the daemon when idle.
        .executableTarget(name: "MeetingRecorderTranscriber", dependencies: ["AgentCore"], path: "Sources/MeetingRecorderTranscriber"),
        .executableTarget(name: "AgentCoreChecks", dependencies: ["AgentCore"], path: "Sources/AgentCoreChecks"),
    ],
    swiftLanguageModes: [.v5]
)
