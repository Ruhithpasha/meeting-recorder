// Open models from Hugging Face (and llama.cpp from GitHub), downloaded once into
// ~/.meeting-recorder/models and run on this Mac. Nothing about a meeting is ever uploaded.
//
//   whisper  argmaxinc/whisperkit-coreml @ pinned revision, large-v3 turbo (632 MB, Core ML)
//            ~300 MB of memory, runs on the Neural Engine
//   qwen     Qwen/Qwen3-1.7B-GGUF Q8_0 (1.8 GB, SHA-256 pinned), run by llama.cpp b12202
//            (SHA-256 pinned). The model file is memory-mapped: macOS can drop and re-read those
//            pages under memory pressure, so only ~600 MB is truly held while it runs.
//
// Downloads report {"status":"downloading","percent":n} so the daemon knows the job is alive.
import AgentCore
import CryptoKit
import Foundation
import WhisperKit

enum OpenModels {
    struct Pinned { let url: String; let sha256: String; let file: String }

    static let whisperVariant = "openai_whisper-large-v3-v20240930_turbo_632MB"
    static let whisperRepo = "argmaxinc/whisperkit-coreml"
    static let llama = Pinned(
        url: "https://github.com/ggml-org/llama.cpp/releases/download/b12202/llama-b12202-bin-macos-arm64.tar.gz",
        sha256: "e70cd5918fb1db75652cee66bd6ab9c933cc0c5acf632f15df672c00829ebcaf", file: "llama-b12202.tar.gz")
    static let qwen = Pinned(
        url: "https://huggingface.co/Qwen/Qwen3-1.7B-GGUF/resolve/90862c4b9d2787eaed51d12237eafdfe7c5f6077/Qwen3-1.7B-Q8_0.gguf",
        sha256: "061b54daade076b5d3362dac252678d17da8c68f07560be70818cace6590cb1a", file: "Qwen3-1.7B-Q8_0.gguf")

    static var isAppleSilicon: Bool {
        var value: Int32 = 0
        var size = MemoryLayout<Int32>.size
        return sysctlbyname("hw.optional.arm64", &value, &size, nil, 0) == 0 && value == 1
    }

    /// Why an engine can't run here (nil when it can). Reported by --capabilities.
    static var whisperUnavailable: String? {
        isAppleSilicon ? nil : "Whisper needs a Mac with Apple silicon."
    }
    static var qwenUnavailable: String? {
        if !isAppleSilicon { return "The open summary model needs a Mac with Apple silicon." }
        if ProcessInfo.processInfo.physicalMemory < 7 << 30 { return "The open summary model needs at least 8 GB of memory." }
        return nil
    }

    // MARK: Whisper

    /// Whisper's language codes ("hi", "en", …), for the language picker on any macOS.
    static var whisperLanguages: [String] { Array(Set(Constants.languages.values)).sorted() }

    /// The Core ML model folder, downloaded on first use. Once on disk it's used as is, with no
    /// network at all (offline, or Hugging Face down, still works).
    static func whisperFolder(models: URL) async throws -> URL {
        let local = models.appendingPathComponent("whisper/models/\(whisperRepo)/\(whisperVariant)")
        if FileManager.default.fileExists(atPath: local.appendingPathComponent("AudioEncoder.mlmodelc").path),
           FileManager.default.fileExists(atPath: local.appendingPathComponent("TextDecoder.mlmodelc").path) { return local }
        var last = -1
        return try await WhisperKit.download(variant: whisperVariant, downloadBase: models.appendingPathComponent("whisper"), from: whisperRepo) { progress in
            let percent = Int(progress.fractionCompleted * 100)
            if percent >= last + 5 { last = percent; emit(["status": "downloading", "percent": percent, "what": "Whisper model"]) }
        }
    }

    // MARK: llama.cpp + Qwen

    /// (llama-completion binary, model file), downloading and verifying them on first use.
    static func qwenRuntime(models: URL) async throws -> (binary: URL, model: URL) {
        let dir = models.appendingPathComponent("qwen")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let binary = dir.appendingPathComponent("llama-b12202/llama-completion")
        if !FileManager.default.isExecutableFile(atPath: binary.path) {
            let archive = try await fetch(llama, into: dir, what: "llama.cpp")
            try run("/usr/bin/tar", ["-xzf", archive.path, "-C", dir.path])
            try? FileManager.default.removeItem(at: archive)
            guard FileManager.default.isExecutableFile(atPath: binary.path) else { throw ModelError("llama.cpp archive has no llama-completion") }
        }
        let model = try await fetch(qwen, into: dir, what: "Qwen model")
        return (binary, model)
    }

    /// Downloads a pinned file once, verifies its SHA-256, then keeps it. A file that fails the
    /// check is deleted (never used). Memory stays flat: download to disk, hash in 8 MB reads.
    static func fetch(_ pinned: Pinned, into dir: URL, what: String) async throws -> URL {
        let target = dir.appendingPathComponent(pinned.file)
        if FileManager.default.fileExists(atPath: target.path) { return target } // verified when it was saved
        emit(["status": "downloading", "percent": 0, "what": what])
        let progress = DownloadProgress(what: what)
        let (temp, response) = try await URLSession.shared.download(from: URL(string: pinned.url)!, delegate: progress)
        defer { try? FileManager.default.removeItem(at: temp) }
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw ModelError("\(what) download failed (HTTP \((response as? HTTPURLResponse)?.statusCode ?? 0))") }
        guard try sha256(of: temp) == pinned.sha256 else { throw ModelError("\(what) download didn't match its fingerprint") }
        try FileManager.default.moveItem(at: temp, to: target)
        return target
    }

    static func sha256(of url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let chunk = try handle.read(upToCount: 8 << 20), !chunk.isEmpty { hasher.update(data: chunk) }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    @discardableResult
    static func run(_ path: String, _ args: [String], input: Data? = nil) throws -> Data {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = args
        let out = Pipe()
        process.standardOutput = out
        process.standardError = FileHandle.nullDevice
        try process.run()
        let data = out.fileHandleForReading.readDataToEndOfFile() // read before wait: a full pipe would block it
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { throw ModelError("\((path as NSString).lastPathComponent) exited with \(process.terminationStatus)") }
        return data
    }
}

struct ModelError: LocalizedError {
    let errorDescription: String?
    init(_ message: String) { errorDescription = message }
}

/// Emits download progress every 5%.
final class DownloadProgress: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    let what: String
    private var last = 0
    init(what: String) { self.what = what }
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData _: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        guard totalBytesExpectedToWrite > 0 else { return }
        let percent = Int(totalBytesWritten * 100 / totalBytesExpectedToWrite)
        if percent >= last + 5 { last = percent; emit(["status": "downloading", "percent": percent, "what": what]) }
    }
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {}
}

// MARK: - Whisper transcription of one track

/// Loads the model once for all tracks. Lean settings: one decoder worker, voice-activity
/// chunking (silence is skipped, which is faster and stops Whisper inventing words in silence).
final class WhisperTrackRecognizer {
    private let pipe: WhisperKit
    let language: String?

    init(models: URL, localeId: String?) async throws {
        let folder = try await OpenModels.whisperFolder(models: models)
        // tokenizerFolder: the tokenizer is cached with the model (WhisperKit's default is ~/Documents).
        pipe = try await WhisperKit(WhisperKitConfig(modelFolder: folder.path, tokenizerFolder: models.appendingPathComponent("whisper"),
                                                     verbose: false, logLevel: .none, prewarm: false, load: true, download: false))
        language = OpenModelText.whisperLanguage(localeId)
    }

    func recognize(_ pcm: URL, speaker: String) async throws -> [Transcript.Segment] {
        let options = DecodingOptions(
            task: .transcribe, language: language, temperature: 0, usePrefillPrompt: language != nil,
            detectLanguage: language == nil, skipSpecialTokens: true, withoutTimestamps: false,
            concurrentWorkerCount: 1, chunkingStrategy: .vad)
        let results = try await pipe.transcribe(audioPath: pcm.path, decodeOptions: options)
        return results.flatMap(\.segments).compactMap { segment in
            let text = OpenModelText.cleanWhisper(segment.text)
            return text.isEmpty ? nil : .init(start: Double(segment.start), end: Double(segment.end), speaker: speaker, text: text)
        }
    }
}
