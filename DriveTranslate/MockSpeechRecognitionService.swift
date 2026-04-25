import Foundation
import Speech

@MainActor
final class MockSpeechRecognitionService: SpeechRecognitionServiceProtocol {
    private let sampleLines = [
        "The story opens on a quiet road just before sunrise.",
        "You can hear the narrator slow down when the scene becomes tense.",
        "Sometimes a single unfamiliar phrase changes the meaning of the whole paragraph.",
        "This mock mode lets us verify the English and Hebrew screens before testing on a real phone."
    ]

    private var streamTask: Task<Void, Never>?
    private var nextLineIndex = 0
    private(set) var isStreaming = false

    func requestPermissions() async -> PermissionSnapshot {
        PermissionSnapshot(
            microphoneGranted: true,
            speechStatus: .authorized
        )
    }

    func startStreaming(
        localeIdentifier: String,
        onUpdate: @escaping (Result<SpeechRecognitionUpdate, Error>) -> Void
    ) async throws {
        guard !isStreaming else {
            throw SpeechRecognitionServiceError.duplicateStart
        }

        isStreaming = true
        let line = sampleLines[nextLineIndex % sampleLines.count]
        nextLineIndex += 1

        streamTask = Task {
            let words = line.split(separator: " ").map(String.init)

            for index in words.indices {
                if Task.isCancelled { return }

                let partial = words[0...index].joined(separator: " ")
                let isFinal = index == words.index(before: words.endIndex)

                onUpdate(
                    .success(
                        SpeechRecognitionUpdate(
                            englishText: partial,
                            isFinal: isFinal,
                            timestamp: Date()
                        )
                    )
                )

                if !isFinal {
                    try? await Task.sleep(for: .milliseconds(550))
                }
            }

            await MainActor.run {
                self.isStreaming = false
            }
        }
    }

    func stopStreaming() async {
        streamTask?.cancel()
        streamTask = nil
        isStreaming = false
    }
}
