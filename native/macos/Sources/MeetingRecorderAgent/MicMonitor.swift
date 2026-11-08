// Which OTHER apps are using a microphone right now (macOS 14+ CoreAudio process objects), plus the
// titles of on-screen windows while any are (browsers need a meeting-like title to count).
//
//   CoreAudio process list ─┐  property listeners (event-driven, no polling of audio state)
//   per-process IsRunningInput ─┴─▶ snapshot ──(changed?)──▶ onChange ─▶ daemon "mic" event
//   window titles: re-read every 2 s ONLY while some app uses a mic (tab switches change them)
import AgentCore
import AppKit
import CoreAudio
import ScreenCaptureKit

/// @unchecked Sendable: all mutable state is only touched on `queue` (a serial queue).
final class MicMonitor: @unchecked Sendable {
    var onChange: ((MicSnapshot) -> Void)?

    private let queue = DispatchQueue(label: "mic.monitor")
    /// Per-process listeners, removed when the process object disappears (no leak, and a reused
    /// object id gets a fresh listener).
    private var listening: [AudioObjectID: AudioObjectPropertyListenerBlock] = [:]
    private var last = MicSnapshot.empty
    /// The mic users seen by the most recent refresh. An async window-title lookup publishes only if
    /// they haven't changed since it started: a slow lookup can't resurrect "Zoom is using the mic"
    /// after the call ended, yet frequent refreshes with the same users can't starve lookups either.
    private var latestUsers: [MicUser] = []
    private var titleTimer: DispatchSourceTimer?
    private let ownPid = ProcessInfo.processInfo.processIdentifier
    /// ScreenCaptureKit's captureMicrophone reads the mic through this system service, not through
    /// our process (verified with --mic-probe), so our own recording shows up as replayd. It is
    /// never a meeting app, so it is never counted.
    static let ignoredBundleIds: Set<String> = ["com.apple.replayd"]

    func start() {
        var address = Self.address(kAudioHardwarePropertyProcessObjectList)
        AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &address, queue) { [weak self] _, _ in
            self?.refresh()
        }
        queue.async { self.refresh() }
    }

    /// Re-sends the current snapshot (after a daemon restart).
    func resend() {
        queue.async { self.onChange.map { cb in let s = self.last; DispatchQueue.main.async { cb(s) } } }
    }

    // MARK: - On `queue`

    private func refresh() {
        let users = currentUsers()
        latestUsers = MicSnapshot(users: users, windows: []).users
        if users.isEmpty {
            stopTitleTimer()
            publish(MicSnapshot(users: [], windows: []))
        } else {
            startTitleTimer()
            Task { [users] in
                let windows = await Self.windowTitles()
                self.queue.async {
                    guard MicSnapshot(users: users, windows: []).users == self.latestUsers else { return } // users changed meanwhile
                    self.publish(MicSnapshot(users: users, windows: MicSnapshot.relevantWindows(windows, whenUsers: users)))
                }
            }
        }
    }

    private func publish(_ snapshot: MicSnapshot) {
        guard snapshot != last else { return }
        last = snapshot
        DispatchQueue.main.async { self.onChange?(snapshot) }
    }

    /// Diagnostics (`--mic-probe`): every process currently capturing from a mic, bundle id or not.
    static func inputProcesses() -> [(pid: Int, bundleId: String)] {
        processObjects().compactMap { object in
            guard uint32(object, kAudioProcessPropertyIsRunningInput) == 1 else { return nil }
            let pid = Int(int32(object, kAudioProcessPropertyPID) ?? 0)
            return (pid, string(object, kAudioProcessPropertyBundleID) ?? NSRunningApplication(processIdentifier: pid_t(pid))?.bundleIdentifier ?? "(no bundle id)")
        }
    }

    private func currentUsers() -> [MicUser] {
        var users: [MicUser] = []
        let objects = Self.processObjects()
        for gone in Set(listening.keys).subtracting(objects) { unlisten(gone) }
        for object in objects {
            listen(to: object)
            guard Self.uint32(object, kAudioProcessPropertyIsRunningInput) == 1 else { continue }
            let pid = Int(Self.int32(object, kAudioProcessPropertyPID) ?? 0)
            guard pid > 0, pid != Int(ownPid) else { continue } // never count our own capture
            let bundleId = Self.string(object, kAudioProcessPropertyBundleID)
                ?? NSRunningApplication(processIdentifier: pid_t(pid))?.bundleIdentifier ?? ""
            if !bundleId.isEmpty, !Self.ignoredBundleIds.contains(bundleId) { users.append(MicUser(bundleId: bundleId, pid: pid)) }
        }
        return users
    }

    private func listen(to object: AudioObjectID) {
        guard listening[object] == nil else { return }
        let block: AudioObjectPropertyListenerBlock = { [weak self] _, _ in self?.refresh() }
        var address = Self.address(kAudioProcessPropertyIsRunningInput)
        if AudioObjectAddPropertyListenerBlock(object, &address, queue, block) == noErr { listening[object] = block }
    }

    private func unlisten(_ object: AudioObjectID) {
        guard let block = listening.removeValue(forKey: object) else { return }
        var address = Self.address(kAudioProcessPropertyIsRunningInput)
        AudioObjectRemovePropertyListenerBlock(object, &address, queue, block) // may fail if already gone; fine
    }

    private func startTitleTimer() {
        guard titleTimer == nil else { return }
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 2, repeating: 2, leeway: .milliseconds(500))
        timer.setEventHandler { [weak self] in self?.refresh() }
        timer.resume()
        titleTimer = timer
    }

    private func stopTitleTimer() {
        titleTimer?.cancel()
        titleTimer = nil
    }

    // MARK: - CoreAudio / ScreenCaptureKit helpers

    private static func address(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    }

    private static func processObjects() -> [AudioObjectID] {
        var address = address(kAudioHardwarePropertyProcessObjectList)
        var size: UInt32 = 0
        let system = AudioObjectID(kAudioObjectSystemObject)
        guard AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr, size > 0 else { return [] }
        var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
        guard AudioObjectGetPropertyData(system, &address, 0, nil, &size, &ids) == noErr else { return [] }
        return ids
    }

    private static func uint32(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> UInt32? {
        var address = address(selector)
        var value: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        return AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) == noErr ? value : nil
    }

    private static func int32(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> Int32? {
        var address = address(selector)
        var value: Int32 = 0
        var size = UInt32(MemoryLayout<Int32>.size)
        return AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) == noErr ? value : nil
    }

    private static func string(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
        var address = address(selector)
        var value: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) == noErr, let cf = value?.takeRetainedValue() else { return nil }
        let s = cf as String
        return s.isEmpty ? nil : s
    }

    /// Titles of normal on-screen windows. Needs Screen Recording permission (granted for capture).
    private static func windowTitles() async -> [WindowInfo] {
        guard let content = try? await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true) else { return [] }
        return content.windows.compactMap { window in
            guard window.windowLayer == 0, let title = window.title, !title.isEmpty,
                  let bundleId = window.owningApplication?.bundleIdentifier else { return nil }
            return WindowInfo(bundleId: bundleId, title: title)
        }
    }
}
