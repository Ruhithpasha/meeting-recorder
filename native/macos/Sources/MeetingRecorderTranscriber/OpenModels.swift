// Open models from Hugging Face (and llama.cpp from GitHub), downloaded once into
// ~/.meeting-recorder/models and run on this Mac. Nothing about a meeting is ever uploaded.
//
//   whisper  argmaxinc/whisperkit-coreml @ pinned revision, large-v3 turbo (632 MB, Core ML),
//            every file SHA-256 checked (WhisperManifest.swift)
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

    /// The Core ML model folder: every file in WhisperManifest, from pinned revisions, each
    /// SHA-256 checked on download. See WhisperManifest.filesToFetch for when anything is fetched.
    static func whisperFolder(models: URL) async throws -> URL {
        let root = models.appendingPathComponent("whisper")
        let checking = WhisperManifest.files.count
        let fetch = WhisperManifest.filesToFetch(root: root, hash: { try? sha256(of: $0) }) { index in
            // Hashing ~640 MB takes a while: keep the daemon's watchdog fed.
            emit(["status": "downloading", "percent": index * 100 / checking, "what": "Checking the Whisper model"])
        }
        let total = fetch.reduce(0) { $0 + $1.size }
        var done: Int64 = 0
        for file in fetch {
            try await download(file.url, sha256: file.sha256, to: root.appendingPathComponent(file.path), what: "Whisper model", base: done, total: total)
            done += file.size
        }
        let marker = root.appendingPathComponent(WhisperManifest.marker)
        if !FileManager.default.fileExists(atPath: marker.path) { try Data().write(to: marker) }
        return root.appendingPathComponent(WhisperManifest.modelFolder)
    }

    /// Downloaded and verified (stat only after verification, like whisperFolder).
    static func whisperReady(models: URL) -> Bool {
        let root = models.appendingPathComponent("whisper")
        return FileManager.default.fileExists(atPath: root.appendingPathComponent(WhisperManifest.marker).path)
            && WhisperManifest.filesToFetch(root: root, hash: { _ in nil }).isEmpty
    }

    static func qwenReady(models: URL) -> Bool {
        let dir = models.appendingPathComponent("qwen")
        return FileManager.default.isExecutableFile(atPath: dir.appendingPathComponent("llama-b12202/llama-completion").path)
            && FileManager.default.fileExists(atPath: dir.appendingPathComponent(qwen.file).path)
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
        try await download(pinned.url, sha256: pinned.sha256, to: target, what: what)
        return target
    }

    /// One pinned file: download, check SHA-256, then move into place (a mismatch is deleted).
    static func download(_ url: String, sha256 expected: String, to target: URL, what: String, base: Int64 = 0, total: Int64 = 0) async throws {
        let progress = DownloadProgress(what: what, base: base, total: total)
        let temp: URL, response: URLResponse
        do { (temp, response) = try await URLSession.shared.download(from: URL(string: url)!, delegate: progress) }
        catch { throw DownloadError.network("Couldn't download the \(what) (\(error.localizedDescription)). It will try again later.") }
        defer { try? FileManager.default.removeItem(at: temp) }
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw DownloadError.network("Couldn't download the \(what) (HTTP \((response as? HTTPURLResponse)?.statusCode ?? 0)). It will try again later.")
        }
        guard try sha256(of: temp) == expected else { throw DownloadError.fingerprint("The downloaded \(what) didn't match its pinned fingerprint, so it wasn't used.") }
        try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? FileManager.default.removeItem(at: target)
        try FileManager.default.moveItem(at: temp, to: target)
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

/// network: try again later (exit 5, doesn't use up retries). fingerprint: never use it (exit 6).
enum DownloadError: Error {
    case network(String)
    case fingerprint(String)

    /// Exits with the matching code; other errors are rethrown.
    static func exitIfDownload(_ error: Error) {
        switch error as? DownloadError {
        case .network(let message): fail(5, message)
        case .fingerprint(let message): fail(6, message)
        case nil: return
        }
    }
}

struct ModelError: LocalizedError {
    let errorDescription: String?
    init(_ message: String) { errorDescription = message }
}

/// Emits download progress every 5%.
final class DownloadProgress: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    let what: String
    private let base: Int64, total: Int64
    private var last: Int
    /// base/total: this file's place in a multi-file download (0/0 for a single file).
    init(what: String, base: Int64 = 0, total: Int64 = 0) {
        self.what = what; self.base = base; self.total = total
        last = total > 0 ? Int(base * 100 / total) : 0
        emit(["status": "downloading", "percent": last, "what": "Downloading the \(what)"]) // a file is starting
    }
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData _: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        let percent: Int
        if total > 0 { percent = Int((base + totalBytesWritten) * 100 / total) }
        else if totalBytesExpectedToWrite > 0 { percent = Int(totalBytesWritten * 100 / totalBytesExpectedToWrite) }
        else { return }
        if percent >= last + 5 { last = percent; emit(["status": "downloading", "percent": percent, "what": "Downloading the \(what)"]) }
    }
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {}
}

// MARK: - Whisper transcription of one track

/// Loads the model once for all tracks. Lean settings: one decoder worker, voice-activity
/// chunking (silence is skipped, which is faster and stops Whisper inventing words in silence).
final class WhisperTrackRecognizer {
    private let pipe: WhisperKit
    /// Chosen in Settings, or detected on the first track (the call audio, which has the most
    /// speech) by majority over its chunks, then used for the mic too. Detecting per chunk on a
    /// mostly-quiet mic misdetects (it once guessed Icelandic) and costs a detection per chunk.
    private(set) var language: String?

    /// preparing: loading compiles the model for this Mac's Neural Engine (minutes, once); say so.
    init(models: URL, localeId: String?, preparing: Bool = false) async throws {
        let folder = try await OpenModels.whisperFolder(models: models)
        if preparing { emit(["status": "downloading", "percent": 100, "what": "Preparing Whisper for this Mac (a few minutes, once)"]) }
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
        if language == nil, let detected = OpenModelText.majorityLanguage(results.filter { !$0.segments.isEmpty }.map(\.language)) {
            language = detected
            emit(["status": "language", "language": detected])
        }
        return results.flatMap(\.segments).compactMap { segment in
            let text = OpenModelText.cleanWhisper(segment.text)
            return text.isEmpty ? nil : .init(start: Double(segment.start), end: Double(segment.end), speaker: speaker, text: text)
        }
    }
}
