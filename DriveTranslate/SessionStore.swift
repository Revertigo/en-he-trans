import Foundation
import SwiftUI
import Translation

@MainActor
final class SessionStore: ObservableObject {
    @Published var currentEnglishText = ""
    @Published var currentHebrewText = ""
    @Published var recentSegments: [TranscriptSegment] = []
    @Published var listeningStatus: ListeningStatus = .idle
    @Published var isListening = false
    @Published var permissionSnapshot: PermissionSnapshot?
    @Published var translationAvailable = true

    let translationCoordinator: TranslationCoordinator
    let appMode: AppMode

    private let speechService: SpeechRecognitionServiceProtocol
    private var currentSegmentID = UUID()
    private let maxRecentSegments = 12

    init(
        speechService: SpeechRecognitionServiceProtocol,
        translationCoordinator: TranslationCoordinator,
        appMode: AppMode
    ) {
        self.speechService = speechService
        self.translationCoordinator = translationCoordinator
        self.appMode = appMode
    }

    var translationConfiguration: TranslationSession.Configuration? {
        translationCoordinator.configuration
    }

    func refreshCapabilities() async {
        guard !usesMockTranslation else {
            translationAvailable = true
            listeningStatus = .idle
            return
        }

        translationCoordinator.ensureConfiguration()
        translationAvailable = await translationCoordinator.checkLanguageSupport()

        if !translationAvailable {
            listeningStatus = .unavailable("English to Hebrew translation is not currently available on this device.")
        }
    }

    func requestPermissionsIfNeeded() async -> Bool {
        let snapshot = await speechService.requestPermissions()
        permissionSnapshot = snapshot

        if snapshot.isReady {
            return true
        }

        listeningStatus = .unavailable("Microphone or speech recognition permission was not granted.")
        return false
    }

    func toggleListening() async {
        if isListening {
            stopListening()
        } else {
            await startListening()
        }
    }

    func startListening() async {
        listeningStatus = .preparing

        guard translationAvailable || usesMockTranslation else {
            listeningStatus = .unavailable("Translation is not available yet. Open Setup and prepare languages first.")
            return
        }

        let hasPermissions = await requestPermissionsIfNeeded()
        guard hasPermissions else { return }

        isListening = true
        startRecognitionPass()
    }

    func stopListening() {
        isListening = false
        Task {
            await speechService.stopStreaming()
        }
        listeningStatus = .idle
    }

    func clearHistory() {
        recentSegments.removeAll()
    }

    func processPendingTranslation(using session: TranslationSession) async {
        guard let resolution = await translationCoordinator.performPendingTranslation(using: session) else {
            return
        }

        applyTranslation(resolution)
    }

    private func startRecognitionPass() {
        Task {
            do {
                listeningStatus = .listening

                try await speechService.startStreaming(localeIdentifier: "en-US") { [weak self] result in
                    Task { [weak self] in
                        await MainActor.run {
                            self?.handleSpeechEvent(result)
                        }
                    }
                }
            } catch {
                isListening = false
                listeningStatus = .failed(error.localizedDescription)
            }
        }
    }

    private func handleSpeechEvent(_ result: Result<SpeechRecognitionUpdate, Error>) {
        switch result {
        case .failure(let error):
            if isListening {
                listeningStatus = .failed(error.localizedDescription)
            }
        case .success(let update):
            handle(update: update)
        }
    }

    private func handle(update: SpeechRecognitionUpdate) {
        currentEnglishText = update.englishText

        if usesMockTranslation {
            currentHebrewText = MockTranslationEngine.translate(update.englishText)
        }

        let job = TranslationJob(
            segmentID: currentSegmentID,
            englishText: update.englishText,
            isFinal: update.isFinal
        )

        if !usesMockTranslation {
            translationCoordinator.queue(job: job)
        }

        if update.isFinal {
            appendOrUpdateHistory(
                id: currentSegmentID,
                englishText: update.englishText,
                hebrewText: currentHebrewText,
                isPartial: false
            )

            currentSegmentID = UUID()
            currentEnglishText = ""
            currentHebrewText = ""

            if isListening {
                startRecognitionPass()
            }
        }
    }

    private func applyTranslation(_ resolution: TranslationResolution) {
        if resolution.job.segmentID == currentSegmentID {
            currentHebrewText = resolution.hebrewText
            return
        }

        if let index = recentSegments.firstIndex(where: { $0.id == resolution.job.segmentID }) {
            recentSegments[index].hebrewText = resolution.hebrewText
        }
    }

    private func appendOrUpdateHistory(
        id: UUID,
        englishText: String,
        hebrewText: String,
        isPartial: Bool
    ) {
        if let existingIndex = recentSegments.firstIndex(where: { $0.id == id }) {
            recentSegments[existingIndex].englishText = englishText
            recentSegments[existingIndex].hebrewText = hebrewText
            recentSegments[existingIndex].isPartial = isPartial
            return
        }

        recentSegments.insert(
            TranscriptSegment(
                id: id,
                createdAt: Date(),
                englishText: englishText,
                hebrewText: hebrewText,
                isPartial: isPartial
            ),
            at: 0
        )

        if recentSegments.count > maxRecentSegments {
            recentSegments = Array(recentSegments.prefix(maxRecentSegments))
        }
    }

    private var usesMockTranslation: Bool {
        appMode == .mock
    }
}
